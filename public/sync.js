// @ts-check
/**
 * sync.js —— 学习状态同步：脏检查 → 防抖 → 串行队列 → 退避重试 → 关页补发
 *
 * 从 app.js 抽出（拆分第 2 步）。这段代码每一条路径都关乎"会不会丢数据"，
 * 因此原样保留了行内注释：为什么快照 seen、为什么失败不清脏、为什么 keepalive 要截断。
 *
 * 依赖方向单向：sync.js → state / storage / core / session-guard / vocab-auth。
 * **sync.js 绝不 import app.js**（成环会让 Node 端 import 直接炸，见 check 第 1 节）；
 * 需要页面刷新"同步状态灯"时走 setSyncNotifier(renderSync)，而不是反向依赖页面。
 */
import { state } from "./state.js";
import { saveLocal } from "./storage.js";
import { cloudSettingsPayload, stateKey } from "./core.js";
import { createSessionGuard } from "./session-guard.js";
import Auth from "./vocab-auth.js";

/** 账号世代：切换账号时自增；旧请求 / 旧队列 / 旧重试一律丢弃结果 */
export let userEpoch = 0;
export const sessionGuard = createSessionGuard();

/** 页面订阅"同步状态变化"（app.js 传 renderSync）：避免 sync.js 反向 import app.js */
let notifySyncChange = () => {};
/** @param {() => void} fn */
export function setSyncNotifier(fn) {
  notifySyncChange = typeof fn === "function" ? fn : () => {};
}

/** 串行队列里等上一轮落地用的短睡眠 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ============ 队列：脏标记 / 防抖 / 上限 ============ */

export function markDirty(chapter, word) {
  state.sync.dirty.add(stateKey(chapter, word));
  scheduleFlush();
}

/** 防抖上限：防抖定时器被连续作答不断重置时，最多等这么久也必须发出去 */
const FLUSH_MAX_WAIT = 4000;

/**
 * 普通改动走防抖（最多等待 FLUSH_MAX_WAIT）；失败重试/让位重调度则使用完整 delay，
 * 不能再次被 firstDirtyAt 截成 0ms，否则持续失败或长事务时会变成零延迟热循环。
 * @param {number} [delay]
 * @param {boolean} [retry]
 */
export function scheduleFlush(delay = 800, retry = false) {
  window.clearTimeout(state.sync.timer);
  if (retry) {
    state.sync.timer = window.setTimeout(() => void flush(), Math.max(0, delay));
    return;
  }
  if (!state.sync.firstDirtyAt) state.sync.firstDirtyAt = Date.now();
  // 防抖上限：连续作答会不断重置定时器，超过 FLUSH_MAX_WAIT 强制发出，避免同步被"饿死"
  const elapsed = Date.now() - state.sync.firstDirtyAt;
  const capped = Math.min(delay, Math.max(0, FLUSH_MAX_WAIT - elapsed));
  state.sync.timer = window.setTimeout(() => void flush(), capped);
}

export function serializableSettings() {
  return cloudSettingsPayload(state.settings);
}

export async function flush() {
  if (!Auth.isLoggedIn()) {
    // 未登录：只保留在内存/本机，等登录后由 applyUser() 统一上报
    state.sync.dirty.clear();
    state.sync.settingsDirty = false;
    state.sync.firstDirtyAt = 0;
    window.clearTimeout(state.sync.timer);
    return true;
  }
  if (state.sync.inFlight) {
    // 已有另一轮 flush 在飞：本轮没有执行，必须如实报 false，
    // 否则"重置前先排空队列"的保护会被并发窗口绕过（防抖重试仍会补发）。
    scheduleFlush(600, true);
    return false;
  }
  const stateKey = state.userKey;
  const stateRevision = Auth.revision();
  const runEpoch = userEpoch;
  const runUserKey = stateKey;
  const runAuthRevision = stateRevision;
  const runToken = sessionGuard.capture(runUserKey, runAuthRevision);
  const isCurrent = () => currentUserEpoch(runEpoch, runUserKey, runAuthRevision) && sessionGuard.isCurrent(runToken, runUserKey, runAuthRevision);
  const keys = [...state.sync.dirty];
  const settingsDirty = state.sync.settingsDirty;
  const settingsSnapshot = settingsDirty ? JSON.stringify(serializableSettings()) : "";
  if (!keys.length && !settingsDirty) {
    state.sync.firstDirtyAt = 0;
    notifySyncChange();
    return true;
  }
  // 快照每条的 seen：上传期间同一词又被作答（seen 变大）时不能把它从脏集合里删掉，否则丢更新
  const seenSnapshot = new Map(keys.map((key) => [key, Number(state.words[key]?.seen) || 0]));

  const token = { epoch: runEpoch, userKey: runUserKey, authRevision: runAuthRevision };
  state.sync.inFlight = token;
  let failed = false;

  try {
    // 服务端单次最多 800 条，这里按 500 条切块，避免"登录后一次性上报"被 413 拒掉
    const CHUNK = 500;
    for (let i = 0; i < keys.length; i += CHUNK) {
      const slice = keys.slice(i, i + CHUNK);
      const changes = slice
        .map((key) => state.words[key])
        .filter(Boolean)
        .map((w) => ({ c: w.c, w: w.w, s: w.s, cs: w.cs, wc: w.wc, seen: w.seen, due: w.due }));
      if (!changes.length) {
        if (!isCurrent()) return false;
        for (const key of slice) state.sync.dirty.delete(key);
        continue;
      }
      const res = await Auth.pushWords(changes);
      if (!isCurrent()) return false;
      if (res?.ok && Auth.isLoggedIn()) {
        for (const key of slice) {
          const now = Number(state.words[key]?.seen) || 0;
          if (now === (seenSnapshot.get(key) ?? now)) state.sync.dirty.delete(key);
          // seen 变了 = 上传期间又有新作答 → 保留在脏集合，下一轮再发
        }
      } else {
        // 失败或期间掉线（401/清会话）：整条队列保留，绝不能标成"已同步"
        failed = true;
        state.sync.lastError = res?.msg || "同步失败";
        break;
      }
    }

    if (!failed && settingsDirty) {
      const settings = serializableSettings();
      const res = await Auth.putSettings(settings);
      if (!isCurrent()) return false;
      if (res?.ok && Auth.isLoggedIn() && JSON.stringify(serializableSettings()) === settingsSnapshot) state.sync.settingsDirty = false;
      else {
        failed = true;
        state.sync.lastError = res?.msg || "设置同步失败";
      }
    }
  } finally {
    if (state.sync.inFlight === token) state.sync.inFlight = null;
  }
  if (failed) {
    state.sync.backoff = Math.min(30000, Math.max(1000, state.sync.backoff * 2));
    scheduleFlush(state.sync.backoff, true);
  } else {
    state.sync.backoff = 0;
    state.sync.lastError = null;
    state.sync.firstDirtyAt = 0;
  }
  notifySyncChange();
  return !failed;
}

/** 把当前所有词状态标记为待上传（登录后、导入备份后调用） */
export function markAllDirty() {
  let count = 0;
  for (const key of Object.keys(state.words)) {
    const word = state.words[key];
    if (!word || !Number.isFinite(Number(word.c)) || !Number.isFinite(Number(word.w))) continue;
    state.sync.dirty.add(key);
    count++;
  }
  if (count) scheduleFlush(400);
  return count;
}

export function markSettingsDirty() {
  state.sync.settingsDirty = true;
  // 同时落本机：以前只挂云端同步，未登录（或离线、或改完立刻刷新）就会退回旧设置——
  // 主题色点了、刷新又变回天蓝就是这么来的（冒烟 5.6）。saveLocal 自带微任务合并，不会放大写入。
  saveLocal();
  scheduleFlush(1200);
}

/** 关页补发只发一次（pagehide 与 beforeunload 可能都触发），页面重新可见时复位 */
let leaveFlushSent = false;

/**
 * 「答完最后一题立刻关页」的尾巴：防抖还没到点（800ms）页面就被销毁，普通 fetch 会被浏览器中止。
 * 这里把脏数据交给 keepalive 请求——由浏览器接管，页面销毁后仍能发完。
 * 读不到响应，所以**不清脏集合**：下次进页面会随 markAllDirty 一并重发，补发只是抢时间。
 * @returns {boolean} 是否已交给浏览器
 */
export function flushOnLeave() {
  if (leaveFlushSent || !Auth.isLoggedIn() || !state.sync.dirty.size) return false;
  /** @type {Array<{c:number,w:number,s:string,cs:number,wc:number,seen:number,due:number}>} */
  const changes = [];
  let size = 2; // 外层 {"changes":[]} 的骨架
  for (const key of state.sync.dirty) {
    const w = state.words[key];
    if (!w) continue;
    const item = { c: w.c, w: w.w, s: w.s, cs: w.cs, wc: w.wc, seen: w.seen, due: w.due };
    const next = JSON.stringify(item).length + 1;
    // keepalive 单包上限 64KB：超了就截断，剩下的等下次重发（序号在前，先保住最早作答的）
    if (size + next > 58_000) break;
    size += next;
    changes.push(item);
  }
  if (!changes.length) return false;
  leaveFlushSent = Auth.pushWordsKeepalive(changes);
  return leaveFlushSent;
}

/* ============ 会话世代与请求守卫 ============ */

/** 把当前会话的同步操作绑定到账号切换世代；旧请求完成后只能丢弃结果。 */
export function currentUserEpoch(epoch, userKey, authRevision = Auth.revision()) {
  const token = sessionGuard.snapshot();
  const loggedIn = Auth.isLoggedIn();
  return (
    epoch === userEpoch &&
    state.userKey === userKey &&
    token.epoch === epoch &&
    token.userKey === userKey &&
    token.authRevision === authRevision &&
    Auth.revision() === authRevision &&
    (loggedIn ? `u${Auth.userId()}` === userKey : userKey === "guest")
  );
}

export function captureUiSession() {
  const authRevision = Auth.revision();
  return {
    epoch: userEpoch,
    userKey: state.userKey,
    userId: Auth.userId(),
    authRevision,
    token: sessionGuard.capture(state.userKey, authRevision),
  };
}

export function uiSessionCurrent(run) {
  return (
    currentUserEpoch(run.epoch, run.userKey, run.authRevision) &&
    sessionGuard.isCurrent(run.token, run.userKey, run.authRevision) &&
    Auth.userId() === run.userId
  );
}

export async function flushForSession(run) {
  while (state.sync.inFlight && uiSessionCurrent(run)) await sleep(50);
  if (!uiSessionCurrent(run)) return false;
  return await flush();
}

/**
 * 切换账号：推进世代并重置同步队列/游标/退避。
 * 页面侧的浮层关闭、计时器停表由 app.js 的 transitionUserSession 负责（那里还持有 loadEpoch）。
 * @param {string} nextKey
 * @param {number} [authRevision]
 */
export function beginSyncSession(nextKey, authRevision = Auth.revision()) {
  userEpoch++;
  sessionGuard.transition(nextKey, authRevision);
  window.clearTimeout(state.sync.timer);
  state.sync.timer = 0;
  state.sync.inFlight = null;
  state.sync.backoff = 0;
  state.sync.lastError = null;
  state.sync.pulledOnce = false;
  state.sync.cursor = 0;
}
