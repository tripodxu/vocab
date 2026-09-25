// @ts-check
// PWA：Service Worker（仅 https 与本机回环；typeof 守卫保证 Node 里 import 本文件不炸）
if (
  typeof navigator !== "undefined" &&
  "serviceWorker" in navigator &&
  (location.protocol === "https:" || ["localhost", "127.0.0.1"].includes(location.hostname))
) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

/**
 * app.js —— 刷词页（练习）
 *
 * 这一版解决的旧问题：
 *  1) 手机上无法输入：用隐藏 input + inputmode=latin 打通软键盘，桌面键盘照旧
 *  2) 云端会丢数据：恢复流程改成"先拉云端再渲染"，本地存档按账号命名空间隔离
 *  3) 每次按键 6 个请求：脏检查 + 800ms 防抖 + 串行队列 + 失败退避重试
 *  4) 破坏性操作无确认：统一确认弹窗 + 6 秒撤销
 *  5) 错题本只增不减：连续答对 2 次判定掌握并移出
 *  6) 正确率会 >100%：统计口径改为"本轮尝试 / 本轮正确"
 *  7) 打字时整排槽位闪烁：槽位 DOM 只创建一次，按键只改文本与类名
 *
 * 两种答法（见 quiz.js / docs/选择题资料生成规范.md）：
 *  · 拼写（spell）：看中文/听音写单词，要求"会写"
 *  · 认词（choice）：看英文选中文，只要求"认识"
 * 掌握状态与同步协议两种答法共用；分模式成绩记在本机台账 modes 里，
 * 避免"只做过选择题"的词在拼写模式里被当成已掌握。
 */

import {
  STATUS,
  PRACTICE,
  analyzeWord,
  judgeAnswer,
  applyResult,
  mergeWordStates,
  pickNewer,
  stateKey,
  statesForChapter,
  dueReviewIds,
  insertAhead,
  chapterProgress,
  computeStats,
  localDateKey,
  currentStreak,
  recordDaily,
  resetDaily,
  mergeDailySync,
  mergeDailyBackup,
  buildDeck,
  normalizeSettings,
  ACCENTS,
  ACCENT_HEX,
  applyAccent,
  shuffle,
  cloudSettingsPayload,
  canMergeGuestInto,
  normalizeModeLedger,
  mergeModeLedgers,
  recordModeResult,
  modeStats,
  masteredForPractice,
  chapterPracticeStats,
  applyWeightResult,
  weightInsertCount,
  normalizeWeights,
  mix,
} from "./core.js";
import {
  buildChoiceQuestion,
  gradeChoice,
  optionLabel,
  explainChoice,
  QUIZ_KIND_LABEL,
  questionKey,
  seededRng,
} from "./quiz.js";
import { CHAPTERS, chapterTitle, CHAPTER_BY_ID } from "./chapters.js";
import Auth from "./vocab-auth.js";
import { createStarSync } from "./star-sync.js";
import { activeStarsKey, starRecordsKey } from "./star-store.js";
import { createSessionGuard } from "./session-guard.js";
import {
  $,
  $$,
  el,
  escapeHTML,
  icon,
  iconHTML,
  toast,
  confirmDialog,
  promptDialog,
  openSheet,
  theme,
  initTheme,
  announce,
  flash,
  formatClock,
  appearanceMirrorWrite,
  buildAccountSection,
  openAuthSheet as openSharedAuthSheet,
  openPasswordSheet as openSharedPasswordSheet,
} from "./ui.js";

const LS_PREFIX = "vocab:v3:";
/** 记录"未登录期间的进度"已经并入过哪个账号，避免换账号时串号 */
const GUEST_MERGED_KEY = "vocab:guest-merged-into";
const FLUSH_MAX_WAIT = 4000;

/* ============ 全局状态 ============ */

const state = {
  /** 本地存档命名空间：guest 或 u<userId> */
  userKey: "guest",
  settings: normalizeSettings(null),
  /** 易错词权重（本机，随存档持久化；系统无权移除，只有用户手动删除） */
  weights: {},
  /** @type {Record<string, any>} 'c:w' → 词状态 */
  words: {},
  chapter: 1,
  /** @type {any[]} */
  chapterWords: [],
  /** @type {Map<number, any>} */
  wordById: new Map(),
  /** @type {number[]} */
  deck: [],
  index: 0,
  /** @type {{ ids: number[], source: string } | null} 复习会话 */
  review: null,
  session: { attempts: 0, correct: 0 },
  // 当前词
  slots: /** @type {{ ch: string, sep: boolean }[]} */ ([]),
  editables: /** @type {number[]} */ ([]),
  values: /** @type {string[]} */ ([]),
  hintIdx: /** @type {Set<number>} */ (new Set()),
  cursor: 0,
  answered: false,
  lastResult: /** @type {null | "ok" | "bad"} */ (null),
  timedOut: false,
  roundDone: false,
  /** 从讲义页深链跳进来时高亮一次槽位 */
  jumpHighlight: false,
  /** 深链显式指定的章节（>0 时优先级最高，云端 resume 不能覆盖它） */
  deepLinkChapter: 0,
  /** 当前题面：spell → chinese/audio；choice → en/audio */
  promptKind: /** @type {"chinese" | "audio" | "en"} */ ("chinese"),
  /** 认词题源：quiz-<chapter>.json；没有题源时用同章词自动生成干扰项 */
  quiz: {
    chapter: 0,
    items: /** @type {Record<string, any>} */ ({}),
    /** 本章是否有精编题源 */
    available: false,
    /** 本章题源是否已经尝试加载过（避免反复请求） */
    loaded: false,
  },
  /** 认词题目缓存（同一轮回插/重渲染时选项位置不变） */
  questions: /** @type {Map<string, any>} */ (new Map()),
  question: /** @type {any} */ (null),
  /** 认词模式选中的选项下标 */
  chosen: -1,
  /** 分模式台账（本机，不上云）：'c:w' → { spell:{c,w}, choice:{c,w} } */
  modes: /** @type {Record<string, any>} */ ({}),
  /** 自动跳下一题的定时器 */
  autoNextHandle: 0,
  loading: false,
  loadError: /** @type {string|null} */ (null),
  loadingMessage: "正在加载词库…",
  // 同步
  sync: {
    dirty: /** @type {Set<string>} */ (new Set()),
    settingsDirty: false,
    timer: 0,
    /** 第一次变脏的时刻：防抖被连续作答不断重置时，最迟 FLUSH_MAX_WAIT 也必须发出去 */
    firstDirtyAt: 0,
    inFlight: /** @type {{ epoch: number, userKey: string, authRevision: number } | null} */ (null),
    backoff: 0,
    lastError: /** @type {string|null} */ (null),
    pulledOnce: false,
    cursor: 0,
  },
  // 计时
  timer: { deadline: 0, handle: 0, hiddenAt: 0 },
  // DOM 缓存
  dom: /** @type {Record<string, any>} */ ({}),
};

/** App-owned sheets are closed when the account session changes. */
const appSheets = new Set();

/**
 * Keep account-bound sheets traceable so a stale auth transition cannot leave
 * controls from the previous namespace open.
 * @param {{ title?: string, mode?: "dialog" | "sheet", onClose?: () => void }} [opts]
 */
function openAppSheet(opts = {}) {
  const sheet = openAppSheetBase(opts);
  appSheets.add(sheet);
  return sheet;
}

/** @param {{ title?: string, mode?: "dialog" | "sheet", onClose?: () => void }} opts */
function openAppSheetBase(opts) {
  const sheet = openSheet({
    ...opts,
    onClose: () => {
      appSheets.delete(sheet);
      opts.onClose?.();
    },
  });
  return sheet;
}

function closeAppSheets() {
  for (const sheet of [...appSheets]) sheet.close();
  appSheets.clear();
}

const starSync = createStarSync({
  getUserKey: () => state.userKey,
  onChange: () => {
    if (state.dom.stageHead) {
      render();
      renderSync();
    }
  },
});

/* ============ 本地存储 ============ */

const storageKey = () => LS_PREFIX + state.userKey;

function storageGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key, value) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function storageRemove(key) {
  try {
    localStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

function saveLocal() {
  try {
    localStorage.setItem(
      storageKey(),
      JSON.stringify({
        v: 3,
        settings: state.settings,
        words: state.words,
        modes: state.modes,
        weights: state.weights,
        chapter: state.chapter,
        deck: state.deck,
        index: state.index,
        session: state.session,
        review: state.review,
        savedAt: Date.now(),
      })
    );
  } catch (err) {
    // 超出配额时降级：至少保住学习状态
    try {
      localStorage.setItem(
        storageKey(),
        JSON.stringify({ v: 3, settings: state.settings, words: state.words, modes: state.modes, chapter: state.chapter })
      );
    } catch {
      toast("本地存储空间不足，本次进度只保留在内存中", { type: "bad" });
    }
  }
}

/**
 * 读取本机存档。
 * 注意：**只读自己的命名空间**（用户的存档不会回退到 guest，否则换账号会把别人的数据并进来）；
 * 只有未登录档才允许回退到旧版 key 做一次迁移。
 * @param {string} key
 */
function loadLocal(key) {
  const candidates =
    key === "guest" ? [LS_PREFIX + "guest", "vocab-tool-state"] : [LS_PREFIX + key];
  for (const candidate of candidates) {
    const raw = storageGet(candidate);
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") continue;
      return parsed;
    } catch {
      continue;
    }
  }
  return null;
}

const canMergeGuest = (userId) => canMergeGuestInto(storageGet(GUEST_MERGED_KEY), userId);

const markGuestMerged = (userId) => {
  storageSet(GUEST_MERGED_KEY, String(userId));
};

/* ============ 同步：脏检查 + 防抖 + 串行队列 ============ */

function markDirty(chapter, word) {
  state.sync.dirty.add(stateKey(chapter, word));
  scheduleFlush();
}

/**
 * 普通改动走防抖（最多等待 FLUSH_MAX_WAIT）；失败重试/让位重调度则使用完整 delay，
 * 不能再次被 firstDirtyAt 截成 0ms，否则持续失败或长事务时会变成零延迟热循环。
 * @param {number} [delay]
 * @param {boolean} [retry]
 */
function scheduleFlush(delay = 800, retry = false) {
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

function serializableSettings() {
  return cloudSettingsPayload(state.settings);
}

async function flush() {
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
    renderSync();
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
  renderSync();
  return !failed;
}

/** 把当前所有词状态标记为待上传（登录后、导入备份后调用） */
function markAllDirty() {
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

function markSettingsDirty() {
  state.sync.settingsDirty = true;
  scheduleFlush(1200);
}

/**
 * 从云端拉取并合并。
 * 关键点：**无论本地有没有存档都要拉**（旧版本地无存档时直接 return，导致新设备永远拿不到云端数据）
 * @param {{ full?: boolean }} [opts]
 */
let userEpoch = 0;
const sessionGuard = createSessionGuard();

/** 切换账号时统一推进世代：旧请求、旧队列和旧重试都不能污染新账号。 */
function transitionUserSession(nextKey, authRevision = Auth.revision()) {
  closeAppSheets();
  if (state.dom.quickMenu) {
    state.dom.quickMenu.hidden = true;
    state.dom.moreBtn?.setAttribute("aria-expanded", "false");
  }
  userEpoch++;
  loadEpoch++;
  sessionGuard.transition(nextKey, authRevision);
  window.clearTimeout(state.sync.timer);
  state.sync.timer = 0;
  state.sync.inFlight = null;
  state.sync.backoff = 0;
  state.sync.lastError = null;
  state.sync.pulledOnce = false;
  state.sync.cursor = 0;
  clearAutoNext();
  stopTimer();
  state.timer = { deadline: 0, handle: 0, hiddenAt: 0 };
}

/** 把当前会话的同步操作绑定到账号切换世代；旧请求完成后只能丢弃结果。 */
function currentUserEpoch(epoch, userKey, authRevision = Auth.revision()) {
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

function captureUiSession() {
  const authRevision = Auth.revision();
  return {
    epoch: userEpoch,
    userKey: state.userKey,
    userId: Auth.userId(),
    authRevision,
    token: sessionGuard.capture(state.userKey, authRevision),
  };
}

function uiSessionCurrent(run) {
  return (
    currentUserEpoch(run.epoch, run.userKey, run.authRevision) &&
    sessionGuard.isCurrent(run.token, run.userKey, run.authRevision) &&
    Auth.userId() === run.userId
  );
}

async function flushForSession(run) {
  while (state.sync.inFlight && uiSessionCurrent(run)) await sleep(50);
  if (!uiSessionCurrent(run)) return false;
  return await flush();
}

async function syncPull(opts = {}) {
  if (!Auth.isLoggedIn()) return false;
  const stateKey = state.userKey;
  const stateRevision = Auth.revision();
  const runEpoch = userEpoch;
  const runUserKey = stateKey;
  const runAuthRevision = stateRevision;
  const runToken = sessionGuard.capture(runUserKey, runAuthRevision);
  const isCurrent = () => currentUserEpoch(runEpoch, runUserKey, runAuthRevision) && sessionGuard.isCurrent(runToken, runUserKey, runAuthRevision);
  const since = opts.full || !state.sync.pulledOnce ? 0 : Math.max(0, state.sync.cursor - 60_000);
  const localSettingsSnapshot = JSON.stringify(state.settings);
  const data = await Auth.pullWords(since);
  if (!isCurrent()) return false;
  if (!data || !Array.isArray(data.words)) {
    state.sync.lastError = "云端数据拉取失败";
    renderSync();
    return false;
  }
  const settings = await Auth.getSettings();
  if (!isCurrent()) return false;
  // 两次请求都完成后才提交合并，避免设置请求期间切换账号把旧词写进新命名空间。
  let resetChanged = false;
  const resets = data.resets && typeof data.resets === "object" && !Array.isArray(data.resets) ? data.resets : {};
  for (const [rawChapter, rawAt] of Object.entries(resets)) {
    if (!/^[1-9]\d*$/.test(rawChapter)) continue;
    const chapter = Number(rawChapter);
    const cutoff = Number(rawAt);
    if (!Number.isSafeInteger(chapter) || chapter > 999 || !Number.isSafeInteger(cutoff) || cutoff <= 0) continue;
    for (const [key, word] of Object.entries(state.words)) {
      if (!key.startsWith(`${chapter}:`)) continue;
      const seen = Number(word?.seen) || 0;
      if (seen > cutoff) continue;
      delete state.words[key];
      delete state.weights[key];
      state.sync.dirty.delete(key);
      resetChanged = true;
    }
    // A dirty key with no local state is an older queued record; the reset supersedes it.
    for (const key of [...state.sync.dirty]) {
      const [c] = key.split(":");
      if (Number(c) === chapter && !state.words[key]) state.sync.dirty.delete(key);
    }
  }
  const changed = mergeWordStates(state.words, data.words);
  state.sync.pulledOnce = true;
  if (Number.isSafeInteger(Number(data.serverTime)) && Number(data.serverTime) > 0) state.sync.cursor = Math.max(state.sync.cursor, Number(data.serverTime));
  state.sync.lastError = null;
  if (settings) {
    const settingsChangedDuringPull = JSON.stringify(state.settings) !== localSettingsSnapshot;
    if (!settingsChangedDuringPull) {
      const localDaily = state.settings.daily;
      state.settings = normalizeSettings({
        ...state.settings,
        ...settings,
        // 每日目标：resetAt（手动重置）较新者胜，否则同日取更大计数，避免多端把当天进度改小
        daily: mergeDailySync(settings.daily, localDaily, localDateKey()),
      });
    }
  }
  if (changed || resetChanged || (settings && JSON.stringify(state.settings) === localSettingsSnapshot)) {
    persistSettingsToUi();
    saveLocal();
  }
  renderSync();
  return changed > 0 || resetChanged;
}

async function syncAccountUi(run, { full = false, flushFirst = false } = {}) {
  if (!uiSessionCurrent(run) || !Auth.isLoggedIn()) return false;
  try {
    if (flushFirst) {
      const flushed = await flushForSession(run);
      if (!uiSessionCurrent(run) || !flushed) return false;
    }
    await syncPull({ full });
    if (!uiSessionCurrent(run)) return false;
    await starSync.pull();
    if (!uiSessionCurrent(run)) return false;
    await starSync.flush();
    return uiSessionCurrent(run);
  } catch (err) {
    if (uiSessionCurrent(run)) {
      state.sync.lastError = err instanceof Error ? err.message : "同步失败";
      renderSync();
    }
    return false;
  }
}

function renderSync() {
  const node = state.dom.syncBtn;
  if (!node) return;
  const pending = state.sync.dirty.size + (state.sync.settingsDirty ? 1 : 0) + starSync.dirtySize();
  const error = state.sync.lastError || starSync.lastError();
  if (!Auth.isLoggedIn()) {
    // 图标 + 文案都走 token 化的 SVG（不再用 emoji）
    node.replaceChildren(icon("user"));
    node.title = "未登录：数据只保存在本机";
    node.classList.remove("spinning");
    return;
  }
  if (error && (pending || !state.sync.inFlight)) {
    node.replaceChildren(icon("alert"));
    node.title = `${error}（点此重试）`;
  } else if (state.sync.inFlight || pending) {
    node.replaceChildren(icon("refresh"));
    node.title = `同步中… 待上传 ${pending} 项`;
  } else {
    node.replaceChildren(icon("check-circle"));
    node.title = `已同步 · ${Auth.email()}`;
  }
}

/* ============ 声音 ============ */

let audioCtx = /** @type {AudioContext|null} */ (null);
let voices = /** @type {SpeechSynthesisVoice[]} */ ([]);

function tone(freq, dur, type = "sine") {
  if (!state.settings.sfx) return;
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.16, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + dur);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + dur);
  } catch {
    /* 音频不可用不影响学习 */
  }
}

const sfxOk = () => {
  tone(880, 0.08);
  window.setTimeout(() => tone(1180, 0.1), 90);
};
const sfxBad = () => {
  tone(300, 0.14, "square");
  window.setTimeout(() => tone(200, 0.18, "square"), 140);
};

function loadVoices() {
  return new Promise((resolve) => {
    const list = window.speechSynthesis ? window.speechSynthesis.getVoices() : [];
    if (list && list.length) {
      voices = list;
      resolve(voices);
      return;
    }
    if (!window.speechSynthesis) {
      resolve([]);
      return;
    }
    window.speechSynthesis.addEventListener(
      "voiceschanged",
      () => {
        voices = window.speechSynthesis.getVoices();
        resolve(voices);
      },
      { once: true }
    );
    window.setTimeout(() => resolve(window.speechSynthesis.getVoices()), 1500);
  });
}

/**
 * 朗读单词。返回是否真的开始播放（iOS 需要用户手势，未播放时调用方给降级提示）
 * @param {string} word
 */
async function speak(word) {
  if (!state.settings.speech || !window.speechSynthesis || !word) return false;
  try {
    if (!voices.length) await loadVoices();
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(word);
    utter.lang = "en-US";
    utter.rate = state.settings.rate;
    const preferred =
      voices.find((v) => v.lang === "en-US") || voices.find((v) => v.lang?.startsWith("en")) || null;
    if (preferred) utter.voice = preferred;
    const btn = state.dom.speakBtn;
    utter.onstart = () => btn?.classList.add("speaking");
    utter.onend = () => btn?.classList.remove("speaking");
    utter.onerror = () => btn?.classList.remove("speaking");
    window.speechSynthesis.speak(utter);
    btn?.classList.remove("unsupported");
    return true;
  } catch {
    return false;
  }
}

/* ============ 练习方式：拼写 / 认词 ============ */

/** @returns {"spell" | "choice"} */
function practiceMode() {
  return state.settings.answer === PRACTICE.choice ? PRACTICE.choice : PRACTICE.spell;
}

/** 题源里的 need 字段：read = 只认不拼，不进拼写牌堆（见 docs/选择题资料生成规范.md） */
function wordNeed(wordId) {
  return state.quiz.items?.[String(wordId)]?.need === "read" ? "read" : "spell";
}

function quizItem(wordId) {
  return state.quiz.items?.[String(wordId)] || null;
}

/** 本章精编题源覆盖了多少词 */
const quizCoverage = () => Object.keys(state.quiz.items || {}).length;

/* ============ 认词题源（public/quiz-N.json） ============ */

const QUIZ_INDEX_URL = "quiz-index.json";
/** @type {Set<number> | null} */
let quizIndexCache = null;
/** @type {Promise<Set<number>> | null} */
let quizIndexPromise = null;

/**
 * 题源清单：只列出"确实有精编题源"的章节。
 * 有清单才能做到：没有题源的章节一次多余请求都不发（也不会在控制台留 404）。
 */
async function quizIndex() {
  if (quizIndexCache) return quizIndexCache;
  if (quizIndexPromise) return quizIndexPromise;
  quizIndexPromise = (async () => {
    try {
      const res = await fetch(QUIZ_INDEX_URL, { headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const doc = await res.json();
      const list = Array.isArray(doc?.chapters) ? doc.chapters : [];
      quizIndexCache = new Set(list.map(Number).filter((n) => Number.isInteger(n) && n > 0));
    } catch {
      quizIndexCache = new Set(); // 拿不到清单就当没有题源，继续用自动生成的干扰项
    }
    return quizIndexCache;
  })();
  return quizIndexPromise;
}

/**
 * 加载本章题源。**永远不抛错**：拿不到就用同章词自动生成干扰项，
 * 认词模式不会因为少一个文件而不可用。
 * @param {number} chapterId
 */
async function loadQuiz(chapterId) {
  const id = Number(chapterId);
  if (state.quiz.chapter === id && state.quiz.loaded) return state.quiz;
  const epoch = ++quizEpoch;
  state.quiz = { chapter: id, items: {}, available: false, loaded: false };
  const index = await quizIndex();
  if (epoch !== quizEpoch) return state.quiz; // 已有更新的加载在进行，本结果作废
  if (!index.has(id)) {
    state.quiz.loaded = true;
    return state.quiz;
  }
  try {
    const res = await fetch(`quiz-${id}.json`, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const doc = await res.json();
    if (epoch !== quizEpoch) return state.quiz;
    const items = doc?.items && typeof doc.items === "object" ? doc.items : {};
    state.quiz = { chapter: id, items, available: Object.keys(items).length > 0, loaded: true };
  } catch {
    if (epoch === quizEpoch) state.quiz = { chapter: id, items: {}, available: false, loaded: true };
  }
  return state.quiz;
}

/**
 * 切换练习方式：换的是"答法"，词状态与同步协议都不变。
 * 换完重新开一轮（牌堆口径不同：只认不拼的词不进拼写牌堆）。
 * @param {"spell" | "choice"} next
 */
async function switchPractice(next, opts = {}) {
  const value = next === "choice" ? "choice" : "spell";
  const runEpoch = userEpoch;
  const runUserKey = state.userKey;
  const runAuthRevision = Auth.revision();
  const runToken = sessionGuard.capture(runUserKey, runAuthRevision);
  const isCurrent = () =>
    currentUserEpoch(runEpoch, runUserKey, runAuthRevision) &&
    sessionGuard.isCurrent(runToken, runUserKey, runAuthRevision);
  if (state.settings.answer === value) return;
  state.settings.answer = value;
  markSettingsDirty();
  clearAutoNext();
  if (value === "choice") await loadQuiz(state.chapter);
  if (!isCurrent()) return;
  state.questions.clear();
  renderModeSeg(true);
  if (opts.restart !== false && state.chapterWords.length) startRound({ fresh: true, focus: value === "spell" });
  else render();
  toast(value === "choice" ? "已切到认词：看英文选中文" : "已切回拼写：看中文/听音写单词", { type: "ok" });
}

/* ============ 章节加载 ============ */

const CHAPTER_FETCH_ATTEMPTS = 3;
const CHAPTER_CACHE_PREFIX = "vocab:cache:";
const CHAPTER_CACHE_KEEP = 2;
/** 章节/题源加载的并发守卫：新一轮加载开始后，旧请求的结果直接丢弃（防止旧响应覆盖新章节） */
let loadEpoch = 0;
let quizEpoch = 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 把底层报错翻译成用户看得懂的话（原来直接把 "Failed to fetch" 甩给用户） */
function describeChapterError(err, attempts) {
  const raw = err instanceof Error ? err.message : String(err);
  const tail = `（已自动重试 ${attempts} 次）`;
  if (/^HTTP 404/.test(raw)) return "词库文件不存在（404）：这次部署里可能缺少 data-*.json 文件";
  if (/^HTTP /.test(raw)) return `服务器返回 ${raw.replace("HTTP ", "HTTP ")}${tail}`;
  if (/JSON|Unexpected token|Unexpected end|parse/i.test(raw)) return `词库数据解析失败${tail}`;
  if (/Failed to fetch|NetworkError|Load failed|network|fetch/i.test(raw)) return `网络连接中断${tail}`;
  return `${raw}${tail}`;
}

/** 词库本地缓存：网络抖动时兜底，最多留最近 2 章 */
function cacheChapter(chapterId, list) {
  const key = CHAPTER_CACHE_PREFIX + chapterId;
  try {
    localStorage.setItem(key, JSON.stringify({ at: Date.now(), list }));
    const entries = Object.keys(localStorage)
      .filter((k) => k.startsWith(CHAPTER_CACHE_PREFIX))
      .map((k) => {
        try {
          return { k, at: Number(JSON.parse(localStorage.getItem(k) || "{}").at) || 0 };
        } catch {
          return { k, at: 0 };
        }
      })
      .sort((a, b) => b.at - a.at);
    for (const stale of entries.slice(CHAPTER_CACHE_KEEP)) localStorage.removeItem(stale.k);
  } catch {
    // 配额不足：清掉词库缓存再试一次，仍失败就放弃（不影响正常使用）
    try {
      for (const k of Object.keys(localStorage)) if (k.startsWith(CHAPTER_CACHE_PREFIX)) localStorage.removeItem(k);
      localStorage.setItem(key, JSON.stringify({ at: Date.now(), list }));
    } catch {
      /* ignore */
    }
  }
}

function readChapterCache(chapterId) {
  try {
    const raw = localStorage.getItem(CHAPTER_CACHE_PREFIX + chapterId);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.list) && parsed.list.length ? parsed.list : null;
  } catch {
    return null;
  }
}

/** 取词库：失败自动重试（重试时绕过缓存） */
async function fetchChapterList(chapterId) {
  let lastError = new Error("未知错误");
  for (let attempt = 1; attempt <= CHAPTER_FETCH_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(`data-${Number(chapterId)}.json`, {
        headers: { accept: "application/json" },
        cache: attempt === 1 ? "default" : "reload",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const list = await res.json();
      if (!Array.isArray(list) || !list.length) throw new Error("词库内容为空");
      return list;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < CHAPTER_FETCH_ATTEMPTS) {
        state.loadingMessage = `加载失败，正在重试（${attempt + 1}/${CHAPTER_FETCH_ATTEMPTS}）…`;
        render();
        await sleep(400 * attempt);
      }
    }
  }
  throw lastError;
}

async function loadChapter(chapterId, opts = {}) {
  const id = Number(chapterId);
  const epoch = ++loadEpoch;
  state.loading = true;
  state.loadError = null;
  state.loadingMessage = "正在加载词库…";
  render();

  let list = null;
  let fromCache = false;
  try {
    list = await fetchChapterList(id);
  } catch (err) {
    const cached = readChapterCache(id);
    if (cached) {
      list = cached;
      fromCache = true;
    } else {
      if (epoch !== loadEpoch) return false;
      state.loading = false;
      state.loadError = describeChapterError(err, CHAPTER_FETCH_ATTEMPTS);
      render();
      return false;
    }
  }
  // 期间又发起了新一轮加载：旧请求的结果全部作废（否则会把新章节覆盖回旧章节）
  if (epoch !== loadEpoch) return false;

  state.loading = false;
  state.chapter = id;
  state.chapterWords = list;
  state.wordById = new Map(list.map((w) => [Number(w.id), w]));
  state.review = null;
  state.questions.clear();
  if (!fromCache) cacheChapter(id, list);
  // 认词模式需要题源（只认不拼的词表 + 精编干扰项）；拼写模式不必加载，省一次请求
  if (practiceMode() === "choice") await loadQuiz(id);
  if (epoch !== loadEpoch) return false;
  startRound(opts);
  if (fromCache) toast("网络异常，正在使用本机缓存的词库", { type: "bad", duration: 4500 });
  return true;
}

/** 本章在拼写模式下要练的词（题源里标了 need:"read" 的词只认不拼） */
function spellPoolIds() {
  return state.chapterWords
    .filter((w) => wordNeed(w.id) !== "read")
    .map((w) => Number(w.id));
}

/** 开始本轮（会重建牌堆） */
function startRound(opts = {}) {
  const chapterId = state.chapter;
  if (opts.fresh) state.review = null; // 「再练一轮」= 回到章节练习，不残留复习态
  const practice = practiceMode();
  const allIds = practice === "spell" ? spellPoolIds() : state.chapterWords.map((w) => Number(w.id));
  const deckPool = allIds.length ? allIds : state.chapterWords.map((w) => Number(w.id));
  const inPool = new Set(deckPool);
  const due = dueReviewIds(state.words, chapterId, Date.now()).filter((id) => inPool.has(Number(id)));
  const mastered = statesForChapter(state.words, chapterId)
    .filter((s) => inPool.has(Number(s.w)))
    .filter((s) => masteredForPractice(s, state.modes[stateKey(s.c, s.w)], practice))
    .map((s) => Number(s.w));

  const resume = state.settings.resume;
  const canResume =
    !opts.fresh &&
    resume &&
    Number(resume.chapter) === chapterId &&
    (!resume.practice || resume.practice === practice) &&
    Array.isArray(resume.deck) &&
    resume.deck.length;

  if (canResume) {
    const valid = /** @type {number[]} */ (resume.deck).filter((id) => state.wordById.has(Number(id)) && inPool.has(Number(id)));
    state.deck = valid.length ? valid : buildDeck(deckPool, due, mastered);
    state.index = Math.min(Math.max(0, Number(resume.index) || 0), Math.max(0, state.deck.length - 1));
    state.session = {
      attempts: Math.max(0, Number(resume.attempts) || 0),
      correct: Math.max(0, Number(resume.correct) || 0),
    };
  } else {
    state.deck = buildDeck(deckPool, due, mastered);
    // 易错权重落地：权重决定复现频率 —— 有权重记录的词按 weightInsertCount(1~3) 额外回插，
    // 打散后均匀并入牌堆（总量以牌堆长度为上限，防止牌堆爆炸；续做时不动 resume 的牌堆）
    const extras = [];
    for (const id of deckPool) {
      const entry = state.weights[stateKey(chapterId, id)];
      if (!entry) continue;
      const extra = weightInsertCount(entry);
      for (let i = 0; i < extra; i++) extras.push(id);
    }
    if (extras.length > state.deck.length) extras.length = state.deck.length;
    if (extras.length) {
      const scattered = shuffle(extras);
      const step = Math.max(1, Math.floor(state.deck.length / (scattered.length + 1)));
      scattered.forEach((id, i) => state.deck.splice(Math.min(state.deck.length, (i + 1) * step), 0, id));
    }
    state.index = 0;
    state.session = { attempts: 0, correct: 0 };
  }

  if (opts.jumpTo) {
    const target = Number(opts.jumpTo);
    if (state.wordById.has(target)) {
      const at = state.deck.indexOf(target);
      if (at >= 0) {
        [state.deck[state.index], state.deck[at]] = [state.deck[at], state.deck[state.index]];
      } else {
        state.deck[state.index] = target;
      }
      state.jumpHighlight = true;
    }
  }

  state.roundDone = false;
  renderWord({ focus: opts.focus !== false });
}

/** 进入错题 + 生词复习会话（可随时退出，不影响章节进度） */
function startReview() {
  const wrong = Object.keys(state.weights || {})
    .filter((key) => key.startsWith(`${state.chapter}:`))
    .map((key) => Number(key.split(":")[1]));
  const stars = loadStars();
  const starIds = (stars[state.chapter] || []).filter((id) => !wrong.includes(id));
  const ids = [...wrong, ...starIds].filter((id) => state.wordById.has(id));
  if (!ids.length) {
    toast("当前章节还没有错题或生词", { type: "bad" });
    return false;
  }
  state.review = { ids, source: chapterTitle(state.chapter) };
  state.deck = shuffle(ids);
  state.index = 0;
  state.session = { attempts: 0, correct: 0 };
  state.roundDone = false;
  renderWord({ focus: true });
  return true;
}

function exitReview() {
  state.review = null;
  startRound({ fresh: true, focus: false });
  toast("已退出复习，回到章节练习");
}

/* ============ 生词本（与讲义页共用同一份 key，随设置一起同步） ============ */

/** @returns {Record<string, number[]>} */
function loadStars() {
  return starSync.active(state.chapter);
}

/** @param {Record<string, number[]>} stars */
function saveStars(stars) {
  starSync.replace(stars);
}

const starIdsFor = (chapter) => loadStars()[chapter] || [];

function toggleStar(chapter, wordId) {
  const current = loadStars();
  const list = new Set(current[chapter] || []);
  const added = !list.has(Number(wordId));
  starSync.set(chapter, Number(wordId), added);
  return added;
}

/* ============ 当前词与渲染 ============ */

function currentWord() {
  const id = state.deck[state.index];
  return id ? state.wordById.get(Number(id)) ?? null : null;
}

/** 当前题的题面类型（拼写：chinese/audio；认词：en/audio），"随机"档每题重抽 */
function pickPromptKind() {
  const practice = practiceMode();
  const setting = practice === "choice" ? state.settings.quizPrompt : state.settings.mode;
  const pool = practice === "choice" ? ["en", "zh", "audio"] : ["chinese", "audio"];
  state.promptKind = /** @type {any} */ (
    setting === "random" || !pool.includes(setting) ? pool[Math.floor(Math.random() * pool.length)] : setting
  );
  return state.promptKind;
}

/**
 * 取当前词的认词题目。题目按 `chapter:word` 缓存 ——
 * 答错回插、切设置重渲染都不会让选项跳位（跳位比答错更让人恼火）。
 * @param {any} word
 */
function ensureQuestion(word) {
  const key = questionKey(state.chapter, Number(word.id), state.promptKind === "zh" ? "zh" : "en");
  let question = state.questions.get(key);
  if (!question) {
    question = buildChoiceQuestion({
      chapter: state.chapter,
      entry: word,
      pool: state.chapterWords,
      rng: seededRng(key),
      curated: quizItem(word.id),
      promptKind: state.promptKind === "zh" ? "zh" : "en",
    });
    state.questions.set(key, question);
  }
  return question;
}

/** @param {{ focus?: boolean }} [opts] */
function renderWord(opts = {}) {
  clearAutoNext();
  const word = currentWord();
  if (!word) {
    render();
    return;
  }
  const practice = practiceMode();
  const analysis = analyzeWord(word.word);
  state.slots = analysis.slots;

  // 提示位：按设置档位生成（首字母 or 随机 N 个）——只有拼写模式用得上
  state.hintIdx = new Set();
  if (practice === "spell") {
    const letterIndexes = analysis.slots.map((s, i) => (s.sep ? -1 : i)).filter((i) => i >= 0);
    const hintCount = Math.min(state.settings.hint, letterIndexes.length - 1);
    if (hintCount > 0) {
      if (state.settings.hint === 1) {
        state.hintIdx.add(letterIndexes[0]);
      } else {
        for (const idx of shuffle(letterIndexes).slice(0, hintCount)) state.hintIdx.add(idx);
      }
    }
  }

  state.editables = analysis.slots
    .map((s, i) => (s.sep || state.hintIdx.has(i) ? -1 : i))
    .filter((i) => i >= 0);
  state.values = new Array(state.editables.length).fill("");
  // 提示字母直接显示（不可编辑）
  state.cursor = 0;
  state.answered = false;
  state.lastResult = null;
  state.timedOut = false;
  state.roundDone = false;
  state.chosen = -1;

  // 每题重新抽一次题面（随机档）
  const kind = pickPromptKind();
  state.question = practice === "choice" ? ensureQuestion(word) : null;

  render();
  announce(
    practice === "choice"
      ? kind === "audio"
        ? "请听音选择正确的释义"
        : kind === "zh"
          ? `请选择「${word.meaningCN}」对应的英文单词`
          : `请选择「${word.word}」的释义`
      : kind === "chinese"
        ? `请拼写：${word.meaningCN}`
        : "请听音拼写当前单词"
  );

  if (kind === "audio") {
    void speak(word.word).then((played) => {
      if (!played && state.dom.speakBtn) {
        state.dom.promptHint.textContent = "点喇叭播放（浏览器可能要求先点一下）";
      }
    });
  }
  startTimer();
  if (opts.focus !== false && practice === "spell") focusInput();
  saveLocal();
}

/** 把当前进度写进设置（断点续做） */
function persistResume() {
  state.settings.resume = {
    chapter: state.chapter,
    index: state.index,
    deck: state.deck.slice(0, 600),
    attempts: state.session.attempts,
    correct: state.session.correct,
    practice: practiceMode(),
    at: Date.now(),
  };
}

function render() {
  renderTopbar();
  renderStage();
  renderSync();
}

function renderTopbar() {
  const { brandSub } = state.dom;
  if (brandSub) {
    brandSub.textContent = state.review
      ? `复习：${state.review.source}`
      : `${chapterTitle(state.chapter)}`;
  }
  // 顶栏今日目标环（SVG stroke-dashoffset；数据就是 settings.daily）
  const daily = state.settings.daily || {};
  const count = Math.max(0, Number(daily.count) || 0);
  const target = Math.max(1, Number(daily.target) || 50);
  const C = 62.83; // 2πr（r=10）
  const pct = Math.min(1, count / target);
  const ringFg = $("#goalRing .ring-fg");
  const goalNum = state.dom.goalNum;
  const goal = state.dom.goal;
  if (ringFg) ringFg.style.strokeDashoffset = String(C * (1 - pct));
  if (goalNum) goalNum.textContent = String(count);
  if (goal) {
    goal.classList.toggle("done", pct >= 1);
    goal.title = `今日目标 ${count}/${target}${daily.achieved ? "（已达成）" : ""}`;
    goal.setAttribute("aria-label", `今日目标 ${count}/${target}，点击查看详情或重置`);
  }
}

function renderStage() {
  const dom = state.dom;
  const head = dom.stageHead;
  if (!head) return;

  if (state.loading) {
    // 加载中/重试中也保留章节按钮，避免用户被卡在加载页
    head.hidden = false;
    dom.loading.hidden = false;
    dom.loadingText.textContent = state.loadingMessage || "正在加载词库…";
    dom.loadError.hidden = true;
    dom.body.hidden = true;
    return;
  }
  if (state.loadError) {
    // 出错时同样保留章节按钮：用户可以直接换一章，而不是只能死等重试
    head.hidden = false;
    dom.loading.hidden = true;
    dom.loadError.hidden = false;
    dom.body.hidden = true;
    dom.loadErrorText.textContent = state.loadError;
    return;
  }
  head.hidden = false;
  dom.loading.hidden = true;
  dom.loadError.hidden = true;
  dom.body.hidden = false;

  const word = currentWord();
  const total = state.deck.length || 1;
  const done = Math.min(state.index + (state.answered ? 1 : 0), total);
  dom.meta.textContent = `${done}/${total}`;
  dom.progressFill.style.transform = `scaleX(${Math.min(1, state.index / total)})`;
  dom.chapterBtn.replaceChildren(icon("book-open"), document.createTextNode(` ${chapterTitle(state.chapter)}`));
  dom.chapterBtn.title = state.review ? "复习模式：点此返回章节" : "切换章节";
  dom.reviewBanner.hidden = !state.review;

  const chart = chapterProgress(state.words, state.chapter, CHAPTER_BY_ID.get(state.chapter)?.count || 0);
  dom.chapterBtn.setAttribute(
    "aria-label",
    `${chapterTitle(state.chapter)}，已掌握 ${chart.mastered} 词，错题 ${chart.wrong} 词，点击切换章节`
  );

  // 主题调色盘（幂等：状态未变时是空操作）
  applyAccentSettings();

  // 练习方式 + 出题方式分段控件
  const practice = practiceMode();
  syncPracticeSeg();
  renderModeSeg(false);
  syncModeSeg();

  // 提示与计时状态：提示档位在主界面常驻（与设置抽屉里的同一项保持同步）
  dom.timerChip.hidden = !state.settings.timerEnabled;
  dom.hintSelect.value = String(state.settings.hint);
  dom.hintPick.classList.toggle("on", state.settings.hint > 0);
  dom.hintPick.hidden = practice === "choice"; // 认词不涉及打字，字母提示无意义
  for (const btn of $$('[data-seg="hint"] button')) {
    btn.setAttribute("aria-pressed", String(Number(btn.dataset.value) === state.settings.hint));
  }

  // 两种答法各自的答题区
  dom.spellArea.hidden = practice === "choice";
  dom.choiceArea.hidden = practice !== "choice";
  dom.quizNote.hidden = true;

  if (!word) return;

  // 题干
  const kind = state.promptKind;
  if (practice === "choice") {
    // 听音/看中文出题时先藏英文词，答完再揭示（否则等于直接给答案）
    const showEn = (kind !== "audio" && kind !== "zh") || state.answered;
    dom.promptAudio.hidden = !(kind === "audio" && !state.answered);
    dom.promptWord.hidden = !showEn;
    if (kind === "zh") {
      // 反向题：大字显示中文释义，答对后揭示英文词
      dom.promptCn.hidden = state.answered;
      dom.promptCn.textContent = word.meaningCN;
      if (state.answered) {
        dom.promptWordEn.textContent = word.word;
        dom.promptPhonetic.textContent = word.phonetic || "";
      } else {
        dom.promptHint.textContent = "看中文选单词 · 键盘 1-4 / A-D";
      }
    } else if (showEn) {
      dom.promptCn.hidden = true;
      dom.promptWordEn.textContent = word.word;
      dom.promptPhonetic.textContent = word.phonetic || "";
    } else {
      dom.promptCn.hidden = true;
      dom.promptHint.textContent = "听音选意思 · 可重复播放";
    }
  } else if (kind === "audio") {
    dom.promptWord.hidden = true;
    dom.promptCn.hidden = true;
    dom.promptAudio.hidden = false;
    dom.promptHint.textContent = "听音拼写 · 可重复播放";
  } else {
    dom.promptWord.hidden = true;
    dom.promptAudio.hidden = true;
    dom.promptCn.hidden = false;
    dom.promptCn.textContent = word.meaningCN;
    dom.promptHint.textContent = ""; // 清掉上一题音频分支留下的提示文案
  }

  if (practice === "choice") renderOptions();
  else {
    renderSlots();
    // 离开认词模式时把选项清掉，避免隐藏的旧选项留在 DOM 里
    if (dom.options.childElementCount) dom.options.replaceChildren();
  }
  if (state.jumpHighlight) {
    state.jumpHighlight = false;
    flash(state.dom.slotsWrap);
  }

  // 反馈：SVG 图标 + 文案（不再用 emoji）
  dom.feedback.className = "feedback";
  dom.feedback.replaceChildren();
  if (state.lastResult === "ok") {
    dom.feedback.classList.add("ok");
    dom.feedback.append(icon("check-circle"), document.createTextNode(" 正确"));
  } else if (state.lastResult === "bad") {
    dom.feedback.classList.add("bad");
    if (practice === "choice") {
      const revAnswer = state.question?.dir === "zh";
      dom.feedback.innerHTML = `${iconHTML(state.timedOut ? "timer" : "x-circle")} ${state.timedOut ? "时间到" : "选错了"} · ${revAnswer ? "正确答案" : "正确释义"} <b class="answer-word">${escapeHTML(
        revAnswer ? word.word : word.meaningCN
      )}</b>`;
    } else {
      dom.feedback.innerHTML = `${iconHTML(state.timedOut ? "timer" : "x-circle")} ${state.timedOut ? "时间到" : "拼写错误"} · 正确答案 <b class="answer-word">${escapeHTML(
        word.word
      )}</b>`;
    }
  }
  if (practice === "choice") renderQuizNote();
  if (state.answered && word.exampleEN) {
    dom.example.hidden = false;
    dom.exampleEn.textContent = word.exampleEN;
    dom.exampleCn.textContent = word.exampleCN || "";
  } else {
    dom.example.hidden = true;
  }

  // 主按钮：文案随状态变化（不带箭头符号，键位提示在脚注）
  if (state.roundDone) {
    dom.primaryBtn.textContent = "查看本轮报告";
  } else if (state.answered) {
    dom.primaryBtn.textContent = state.index + 1 >= total ? "完成本轮" : "下一题";
  } else if (practice === "choice") {
    dom.primaryBtn.textContent = state.promptKind === "zh" ? "请选出对应的单词" : "请选择一个释义";
  } else {
    dom.primaryBtn.textContent = "提交";
  }
  renderPrimaryState(); // 与打字/作答时的可用性判断共用一份逻辑（原先这里重复了一遍）
  dom.choiceHint.textContent = state.answered
    ? "按 Enter 进入下一题 · 空格重读"
    : "点选项作答 · 键盘 1-4 / A-D";
  dom.starBtn.setAttribute("aria-pressed", String(starIdsFor(state.chapter).includes(Number(word.id))));
  dom.starBtn.textContent = dom.starBtn.getAttribute("aria-pressed") === "true" ? "★ 已收藏" : "☆ 生词";
  if (dom.dontBtn) dom.dontBtn.hidden = !(practiceMode() === PRACTICE.choice && !state.answered);
  if (dom.prevBtn) dom.prevBtn.disabled = state.index <= 0;
}

/* ============ 认词：选项与辨析 ============ */

/** 选项列表（答完锁定并标出对错；干扰项的 why 就是"辨析"） */
/** 反向选项的音标小字（按选项词查当前章词库） */
function phoneticOf(option) {
  const t = String(option?.text || "").toLowerCase();
  if (!t) return "";
  const entry = (state.chapterWords || []).find((x) => String(x.word || "").toLowerCase() === t);
  return entry?.phonetic || "";
}

function renderOptions() {
  const host = state.dom.options;
  const question = state.question;
  if (!host) return;
  if (!question) {
    host.replaceChildren();
    return;
  }
  const answered = state.answered;
  const rev = question.dir === "zh";
  host.replaceChildren();
  question.options.forEach((option, index) => {
    const isCorrect = index === question.correctIndex;
    const picked = state.chosen === index;
    const classes = ["option"];
    if (rev) classes.push("rev");
    if (answered) classes.push(isCorrect ? "ok" : picked ? "bad" : "dim");
    const node = el(
      "button",
      {
        class: classes.join(" "),
        type: "button",
        role: "radio",
        "aria-checked": String(picked),
        "aria-disabled": String(answered),
        disabled: answered,
        dataset: { index: String(index) },
      },
      [
        el("span", { class: "key", text: answered && isCorrect ? "✓" : answered && picked ? "✗" : optionLabel(index) }),
        el("span", { class: "body" }, [
          el("span", { class: "text", text: option.text }),
          rev && option.word && option.word.toLowerCase() === option.text.toLowerCase()
            ? el("span", { class: "why", text: phoneticOf(option) })
            : null,
          answered && picked && !isCorrect && option.why
            ? el("span", { class: "why", text: `辨析：${option.why}` })
            : null,
        ]),
      ]
    );
    host.append(node);
  });
}

/** 答后的辨析卡片：答错逐条讲清差在哪，答对给词根记忆 */
function renderQuizNote() {
  const dom = state.dom;
  const word = currentWord();
  const question = state.question;
  if (!word || !question || !state.answered) {
    dom.quizNote.hidden = true;
    return;
  }
  const correct = state.chosen === question.correctIndex;
  dom.quizNote.hidden = false;

  dom.quizNoteHead.replaceChildren();
  dom.quizNoteList.replaceChildren();

  if (correct) {
    dom.quizNoteHead.append(
      el("span", { class: "tag", text: "记忆" }),
      // 优先用精编题源的 note（词根拆解/记忆钩子），没有再退回词库的 root 字段
      el("span", { text: question.note || word.root || `「${word.word}」= ${word.meaningCN}` })
    );
  } else {
    dom.quizNoteHead.append(
      el("span", { class: "tag", text: "辨析" }),
      el("span", { text: explainChoice(question, state.chosen) })
    );
    // 所有干扰项逐条给出 why（选中的那条排最前，用红色标出）
    const others = question.options
      .map((option, index) => ({ option, index }))
      .filter((item) => item.index !== question.correctIndex)
      .sort((a, b) => Number(b.index === state.chosen) - Number(a.index === state.chosen));
    for (const { option, index } of others) {
      dom.quizNoteList.append(
        el("li", { class: index === state.chosen ? "picked" : "" }, [
          el("b", { text: `${optionLabel(index)} ${option.text}` }),
          el("span", {
            text: option.why
              ? ` —— ${option.why}`
              : option.kind && QUIZ_KIND_LABEL[option.kind]
                ? ` —— ${QUIZ_KIND_LABEL[option.kind]}`
                : "",
          }),
        ])
      );
    }
    if (!others.length) dom.quizNoteList.append(el("li", { text: "这个词没有可对比的干扰项" }));
  }

  // 🚩 报错入口：题目可疑（选项过于相近/答案有误等）随时反馈，后台可导出
  if (dom.reportBtn) {
    dom.reportBtn.hidden = false;
    dom.reportBtn.onclick = () => openReportSheet(word);
  }

  const coverage = quizCoverage();
  dom.quizNoteFoot.textContent = state.quiz.available
    ? `干扰项来源：${question.dir === "zh" ? "精编 rev 题源（反向）" : "精编题源"}（本章 ${coverage} 词已精编${question.generatedCount ? `，另有 ${question.generatedCount} 个自动生成` : ""}）`
    : "干扰项来源：同章词自动生成（本章暂无精编题源）";
}

/** 🚩 报错弹层：类型 + 备注，登录用户提交到 /api/quiz/report */
function openReportSheet(word) {
  const run = captureUiSession();
  const chapter = state.chapter;
  const wordId = Number(word.id);
  const isCurrent = () => uiSessionCurrent(run) && state.chapter === chapter;
  const sheet = openAppSheet({ title: `报错 · ${word.word}` });
  let kind = "similar";
  const kindSeg = el("div", { class: "seg", role: "group", "aria-label": "问题类型" }, [
    ["similar", "选项过于相近"],
    ["options-wrong", "选项有误"],
    ["meaning-wrong", "释义有误"],
    ["other", "其他"],
  ].map(([value, label]) =>
    el("button", { class: "chip-btn", type: "button", text: label, dataset: { kind: value }, onclick: () => { kind = value; for (const b of kindSeg.querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.kind === kind)); } })
  ));
  for (const b of kindSeg.querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.kind === kind));
  const note = el("textarea", { class: "report-note", placeholder: "补充说明（可选，500 字内）", rows: 3 });
  const submit = el("button", { class: "btn btn-primary", type: "button", text: "提交反馈" });
  submit.addEventListener("click", async () => {
    if (!isCurrent()) return;
    submit.disabled = true;
    const res = await Auth.reportQuestion(chapter, wordId, kind, note.value.slice(0, 500));
    if (!isCurrent()) return;
    submit.disabled = false;
    if (res.auth === false) { toast("请先登录后再提交反馈", { type: "bad" }); return; }
    toast(res.ok ? res.msg || "已收到反馈" : res.msg || "提交失败", { type: res.ok ? "ok" : "bad" });
    if (res.ok) sheet.close();
  });
  sheet.body.append(
    el("div", { class: "setting-row" }, [el("div", { class: "label" }, [el("b", { text: "问题类型" })]), kindSeg]),
    el("div", { class: "setting-row" }, [el("div", { class: "label" }, [el("b", { text: "补充说明" })]), note]),
    submit,
  );
}

/** 槽位 DOM 只创建一次，按键只改文本/类名（修掉"每次按键整排闪烁"） */
function renderSlots() {
  const host = state.dom.slots;
  const word = currentWord();
  if (!host || !word) return;

  if (host.childElementCount !== state.slots.length) {
    host.replaceChildren();
    state.slots.forEach((slot, index) => {
      const node = el("div", {
        class: `slot${slot.sep ? " sep" : ""}`,
        dataset: { index: String(index) },
      });
      // 入场动效只在换词时跑一次（打字时只改文本/类名，避免整排闪烁）
      node.classList.add("enter");
      node.style.animationDelay = `${Math.min(index * 18, 200)}ms`;
      host.append(node);
    });
    state.dom.slotNodes = Array.from(host.children);
    const fresh = /** @type {HTMLElement[]} */ (state.dom.slotNodes);
    window.setTimeout(() => {
      for (const node of fresh) {
        node.classList.remove("enter");
        node.style.animationDelay = "";
      }
    }, 650);
  }

  const nodes = /** @type {HTMLElement[]} */ (state.dom.slotNodes);
  state.slots.forEach((slot, index) => {
    const node = nodes[index];
    if (!node) return;
    node.classList.remove("cursor", "hint", "filled", "ok", "bad", "sep");
    if (slot.sep) {
      node.classList.add("sep");
      node.textContent = slot.ch === " " ? "␣" : slot.ch;
      return;
    }
    if (state.hintIdx.has(index)) {
      node.textContent = slot.ch.toLowerCase();
      node.classList.add("hint");
      return;
    }
    const pos = state.editables.indexOf(index);
    const value = pos >= 0 ? state.values[pos] || "" : "";
    node.textContent = value;
    if (value) node.classList.add("filled");
    if (!state.answered && pos === state.cursor) node.classList.add("cursor");
    if (state.answered) {
      const expected = slot.ch.toLowerCase();
      node.classList.add(value && value === expected ? "ok" : "bad");
    }
  });

  if (state.dom.tapHint) {
    const focused = document.activeElement === state.dom.answerInput;
    state.dom.tapHint.textContent = state.answered
      ? ""
      : focused || window.matchMedia("(pointer: fine)").matches
        ? ""
        : "点这里调出键盘开始输入";
  }
}

/** 当前输入是否已填满（判分前置条件） */
function inputComplete() {
  return state.values.length > 0 && state.values.every(Boolean);
}

/** 组装与 slots 对齐的输入数组，供 core.judgeAnswer 使用 */
function slotChars() {
  const out = state.slots.map((slot) => (slot.sep ? slot.ch : ""));
  for (let i = 0; i < state.editables.length; i++) {
    out[state.editables[i]] = state.values[i] || "";
  }
  return out;
}

/* ============ 输入 ============ */

function focusInput() {
  const input = state.dom.answerInput;
  if (!input) return;
  // 桌面端自动聚焦；触屏设备由用户点击触发（避免一进页面就弹键盘）
  try {
    input.focus({ preventScroll: true });
  } catch {
    /* ignore */
  }
}

/** @param {string} ch */
function typeLetter(ch) {
  if (state.answered) return;
  if (state.cursor >= state.editables.length) return;
  state.values[state.cursor] = ch.toLowerCase();
  const node = state.dom.slotNodes?.[state.editables[state.cursor]];
  if (node) {
    node.classList.remove("pop");
    void node.offsetWidth;
    node.classList.add("pop");
  }
  state.cursor += 1;
  renderSlots();
  renderPrimaryState();
}

function backspace() {
  if (state.answered) return;
  if (state.cursor <= 0) return;
  state.cursor -= 1;
  state.values[state.cursor] = "";
  renderSlots();
  renderPrimaryState();
}

function clearAtCursor() {
  if (state.answered) return;
  if (state.cursor >= state.editables.length) return;
  state.values[state.cursor] = "";
  renderSlots();
  renderPrimaryState();
}

function renderPrimaryState() {
  const btn = state.dom.primaryBtn;
  if (!btn) return;
  btn.disabled = practiceMode() === "choice" ? !state.answered && !state.roundDone : !state.answered && !inputComplete();
}

/* ============ 判分与推进 ============ */

/** 认词：点选项即作答（选择题不该还要再按一次提交） */
function chooseOption(index) {
  if (state.answered || state.roundDone) return;
  const question = state.question;
  if (!question) return;
  const picked = Number(index);
  if (!(picked >= 0 && picked < question.options.length)) return;
  stopTimer();
  state.chosen = picked;
  finalize(gradeChoice(question, picked).correct, false);
}

/** 认词模式答对后自动下一题（答错会停下来让你看辨析） */
function scheduleAutoNext() {
  clearAutoNext();
  state.autoNextHandle = window.setTimeout(() => {
    state.autoNextHandle = 0;
    if (state.answered && !state.roundDone) advance();
  }, 1100);
}

function clearAutoNext() {
  if (state.autoNextHandle) {
    window.clearTimeout(state.autoNextHandle);
    state.autoNextHandle = 0;
  }
}

function submit() {
  if (state.answered || state.roundDone) return;
  const word = currentWord();
  if (!word) return;
  if (!inputComplete()) {
    state.dom.feedback.className = "feedback warn";
    state.dom.feedback.textContent = "先把单词补完整";
    return;
  }
  stopTimer();
  finalize(judgeAnswer(state.slots, slotChars(), word.word), false);
}
function handleTimeout() {
  if (state.answered) return;
  finalize(false, true);
}

/**
 * @param {boolean} correct
 * @param {boolean} timedOut
 */
function finalize(correct, timedOut) {
  const word = currentWord();
  if (!word) return;
  clearAutoNext();
  const practice = practiceMode();
  state.answered = true;
  state.timedOut = timedOut;
  state.lastResult = correct ? "ok" : "bad";

  const now = Date.now();
  const key = stateKey(state.chapter, Number(word.id));
  const prev = state.words[key];
  // 认词=快速识别：答对一次即掌握（streakStep=2）；拼写保持连对 2 次
  const next = applyResult(prev, correct, now, practice === "choice" ? { streakStep: 2 } : {});
  const becameMastered = next.s === STATUS.mastered && prev?.s !== STATUS.mastered;
  // 易错权重：错升对降，永不为 0；错过的词永久留在易错池（只有用户手动删除才移除）
  state.weights = state.weights || {};
  state.weights[key] = applyWeightResult(state.weights[key], correct, now);
  const leftWrongBook = prev?.s === STATUS.wrong && next.s !== STATUS.wrong;

  state.words[key] = { c: state.chapter, w: Number(word.id), ...next };
  // 分模式台账只在本机：云端仍然按词 LWW 存一份全局掌握状态
  state.modes[key] = recordModeResult(state.modes[key], practice, correct);
  markDirty(state.chapter, Number(word.id));

  state.session.attempts += 1;
  if (correct) state.session.correct += 1;

  if (correct) sfxOk();
  else sfxBad();

  if (!correct) {
    // 当天即再遇一次（回插到本轮的后面）
    state.deck = insertAhead(state.deck, state.index, Number(word.id));
  }

  const { daily, achievedNow } = recordDaily(state.settings.daily, localDateKey());
  state.settings.daily = daily;
  markSettingsDirty();
  if (achievedNow) {
    toast(`今日目标达成！连续 ${currentStreak(daily, localDateKey())} 天`, { type: "ok", duration: 5000 });
  }

  if (becameMastered) {
    toast("已掌握（词仍留在易错池，权重已下调）", { type: "ok" });
  } else if (leftWrongBook) {
    toast("状态已更新，词保留在易错池（可手动删除）", { type: "ok" });
  }

  persistResume();
  void speak(word.word);
  render();
  // 认词是快速识别训练：答对后自动进入下一题（答错则停住，让人看完辨析）
  if (practice === PRACTICE.choice && correct && state.settings.autoNext && !state.roundDone) scheduleAutoNext();
}

function advance() {
  if (state.roundDone) {
    showReport();
    return;
  }
  if (!state.answered) return;
  const total = state.deck.length;
  if (state.index + 1 >= total) {
    finishRound();
    return;
  }
  state.index += 1;
  persistResume();
  saveLocal();
  renderWord();
}

function finishRound() {
  state.roundDone = true;
  persistResume();
  saveLocal();
  render();
  showReport();
}

function skip() {
  if (state.roundDone) return;
  if (state.index + 1 >= state.deck.length) {
    finishRound();
    return;
  }
  state.index += 1;
  persistResume();
  saveLocal();
  renderWord();
}

/* ============ 计时器（基于时间戳，标签页切走不误判） ============ */

function startTimer() {
  stopTimer();
  if (!state.settings.timerEnabled || state.answered) return;
  state.timer.deadline = performance.now() + state.settings.timerSeconds * 1000;
  tickTimer();
}

function stopTimer() {
  if (state.timer.handle) {
    window.clearTimeout(state.timer.handle);
    state.timer.handle = 0;
  }
}

function tickTimer() {
  if (!state.settings.timerEnabled || state.answered) return;
  if (document.hidden) {
    // 后台不判超时（否则切走一会儿回来就被判错并计入易错池）：停表并记录隐藏时刻，
    // 可见时由 bindTimerVisibility 把隐藏时长补回 deadline 再恢复计时
    if (!state.timer.hiddenAt) state.timer.hiddenAt = performance.now();
    stopTimer();
    return;
  }
  const left = (state.timer.deadline - performance.now()) / 1000;
  const chip = state.dom.timerChip;
  if (chip) {
    const txt = state.dom.timerText;
    if (txt) txt.textContent = formatClock(Math.max(0, left));
    chip.classList.toggle("urgent", left <= 3);
  }
  if (left <= 0) {
    handleTimeout();
    return;
  }
  state.timer.handle = window.setTimeout(tickTimer, 180);
}

function bindTimerVisibility() {
  document.addEventListener("visibilitychange", () => {
    if (!state.settings.timerEnabled) return;
    if (document.hidden) {
      if (!state.timer.hiddenAt) state.timer.hiddenAt = performance.now();
      stopTimer();
    } else if (state.timer.hiddenAt) {
      // 切回页面时把隐藏期间的时间补给用户，避免"回来就超时"，然后恢复计时
      state.timer.deadline += performance.now() - state.timer.hiddenAt;
      state.timer.hiddenAt = 0;
      if (!state.answered) tickTimer();
    }
  });
}

/* ============ 报告 ============ */

function showReport() {
  const stats = computeStats(state.session);
  const chart = chapterProgress(state.words, state.chapter, CHAPTER_BY_ID.get(state.chapter)?.count || 0);
  const practice = practiceMode();
  const breakdown = chapterPracticeStats(state.modes, state.chapter);
  const states = statesForChapter(state.words, state.chapter);
  const wrongWords = states
    .filter((s) => s.s === STATUS.wrong)
    .map((s) => state.wordById.get(Number(s.w)))
    .filter(Boolean);
  // "只认过、还没拼对过"的词：认词能过、拼写写不出来的那批，值得单独提醒
  const readOnly = states.filter(
    (s) => s.s === STATUS.mastered && modeStats(state.modes[stateKey(s.c, s.w)], PRACTICE.spell).c === 0
  ).length;

  const sheet = openAppSheet({ title: state.review ? "复习报告" : "本轮报告" });
  const great = stats.accuracy >= 80;
  sheet.body.append(
    el("div", { class: `result-banner ${great ? "great" : "soso"}` }, [
      `${great ? "" : "继续加油 · "}${practice === "choice" ? "认词" : "拼写"}本轮正确率 ${stats.accuracy}%`,
    ]),
    el("div", { class: "report-grid" }, [
      el("div", { class: "report-cell" }, [el("b", { text: String(stats.attempts) }), el("small", { text: "本轮尝试" })]),
      el("div", { class: "report-cell" }, [el("b", { text: String(stats.correct) }), el("small", { text: "答对" })]),
      el("div", { class: "report-cell" }, [el("b", { text: String(chart.mastered) }), el("small", { text: "本章已掌握" })]),
    ]),
    el("p", { class: "small muted", text: `本章进度：已掌握 ${chart.mastered} / ${chart.total}，错题 ${chart.wrong}，学习中 ${chart.learning}` }),
    el("p", {
      class: "small muted",
      text: `本章分模式成绩（本机）：认词 ${breakdown.choice.c}/${breakdown.choice.total || 0}${
        breakdown.choice.total ? `（${breakdown.choice.accuracy}%）` : ""
      } · 拼写 ${breakdown.spell.c}/${breakdown.spell.total || 0}${
        breakdown.spell.total ? `（${breakdown.spell.accuracy}%）` : ""
      }`,
    })
  );

  if (readOnly > 0) {
    sheet.body.append(
      el("p", {
        class: "small muted",
        text: `其中有 ${readOnly} 个词只做过选择题、还没拼对过 —— 这些词在拼写模式里不会被当成"已掌握"。`,
      })
    );
  }

  if (wrongWords.length) {
    sheet.body.append(el("h3", { class: "small", text: `需要加固的词（${wrongWords.length}）` }));
    const chips = el("div", { class: "word-chips" });
    for (const word of wrongWords.slice(0, 200)) {
      chips.append(
        el("button", {
          class: "word-chip",
          type: "button",
          title: "点击朗读",
          onclick: () => void speak(word.word),
        }, [el("span", { text: word.word }), el("span", { class: "meaning", text: word.meaningCN })])
      );
    }
    sheet.body.append(chips);
  }

  sheet.body.append(
    el("div", { class: "dialog-actions" }, [
      el("button", {
        class: "btn",
        type: "button",
        text: "复习错题+生词",
        onclick: () => {
          sheet.close();
          startReview();
        },
      }),
      el("button", {
        class: "btn",
        type: "button",
        text: "切换章节",
        onclick: () => {
          sheet.close();
          openChapterSheet();
        },
      }),
      el("button", {
        class: "btn btn-primary",
        type: "button",
        text: "再练一轮",
        onclick: () => {
          sheet.close();
          startRound({ fresh: true, focus: true });
        },
      }),
    ])
  );
}

/* ============ 章节 / 菜单 / 设置 抽屉 ============ */

function openChapterSheet() {
  const sheet = openAppSheet({ title: "选择章节" });
  const list = el("div", { class: "list chapter-list" });
  const now = Date.now();

  sheet.body.append(
    el("p", { class: "small muted", text: `共 ${CHAPTERS.length} 章。进度按"已掌握"统计，错词会优先复现。` })
  );

  for (const chapter of CHAPTERS) {
    const progress = chapterProgress(state.words, chapter.id, chapter.count);
    const due = dueReviewIds(state.words, chapter.id, now, 99).length;
    const isCurrent = chapter.id === state.chapter;
    const bar = el("div", { class: "progress thin chapter-item-progress" }, [
      el("i", { style: `width:${progress.percent}%` }),
    ]);
    const item = el(
      "button",
      {
        class: "list-item",
        type: "button",
        "aria-current": String(isCurrent),
        onclick: () => {
          sheet.close();
          if (state.review) state.review = null;
          void loadChapter(chapter.id);
        },
      },
      [
        el("span", { class: "ch-tile", "aria-hidden": "true", text: String(chapter.id) }),
        el("div", { class: "chapter-item-main" }, [
          el("strong", { text: `第${chapter.id}章 · ${chapter.title}` }),
          el("span", { class: "meta" }, [
            el("span", { text: `掌握 ${progress.mastered}/${chapter.count}` }),
            progress.wrong ? el("span", { class: "chip-bad chip", text: `错 ${progress.wrong}` }) : null,
            due ? el("span", { class: "chip-warn chip", text: `待复习 ${due}` }) : null,
          ]),
          bar,
        ]),
        el("span", { class: "go", text: isCurrent ? "当前" : "▶" }),
      ]
    );
    list.append(item);
  }
  sheet.body.append(list);
}

function openMenuSheet(tab = "settings") {
  const run = captureUiSession();
  const isCurrent = () => uiSessionCurrent(run);
  const sheet = openAppSheet({ title: "学习面板" });
  const tabs = el("div", { class: "tabs", role: "tablist" });
  const panels = el("div");

  const renderTab = (/** @type {string} */ which) => {
    if (!isCurrent()) return;
    for (const btn of $$("button", tabs)) btn.setAttribute("aria-selected", String(btn.dataset.tab === which));
    panels.replaceChildren();
    if (which === "settings") panels.append(buildSettingsPanel(sheet));
    else if (which === "wrong") panels.append(buildBookPanel("wrong", sheet));
    else panels.append(buildBookPanel("star", sheet));
  };

  for (const [key, label] of [
    ["settings", "设置"],
    ["wrong", `易错词 ${Object.keys(state.weights || {}).filter((k) => k.startsWith(`${state.chapter}:`)).length}`],
    ["star", `生词本 ${starIdsFor(state.chapter).length}`],
  ]) {
    tabs.append(
      el("button", {
        type: "button",
        role: "tab",
        dataset: { tab: key },
        text: label,
        onclick: () => renderTab(key),
      })
    );
  }
  sheet.body.append(tabs, panels);
  renderTab(tab);
}

/** 错题本 / 生词本面板 */
function buildBookPanel(which, sheet) {
  const run = captureUiSession();
  const chapter = state.chapter;
  const isCurrent = () => uiSessionCurrent(run) && state.chapter === chapter;
  const wrap = el("div", { class: "stack-3" });
  const ids =
    which === "wrong"
      ? Object.entries(state.weights || {})
          .filter(([key]) => key.startsWith(`${chapter}:`))
          .sort((a, b) => Number(b[1].w) - Number(a[1].w))
          .map(([key]) => Number(key.split(":")[1]))
      : starIdsFor(chapter);
  const words = ids.map((id) => state.wordById.get(Number(id))).filter(Boolean);

  if (!words.length) {
    wrap.append(el("p", { class: "empty", text: which === "wrong" ? "本章暂无易错词（答错过的词会永久留在这里，直到你手动删除）" : "本章暂无生词，答题时点「☆ 生词」收藏" }));
  } else {
    const chips = el("div", { class: "word-chips" });
    for (const word of words) {
      const chip = el(
        "span",
        { class: `word-chip${which === "star" ? " new-word" : ""}` },
        [
          el("span", {
            text: word.word,
            title: "点击朗读",
            style: "cursor:pointer",
            onclick: () => void speak(word.word),
          }),
          el("span", { class: "meaning", text: word.meaningCN }),
          which === "wrong"
            ? el("span", { class: "weight-tag", title: "易错权重（答错升、答对降，决定复现频率）", text: `×${(state.weights?.[stateKey(chapter, Number(word.id))]?.w ?? 1).toFixed(1)}` })
            : null,
        ]
      );
      chip.append(
        el("span", {
          class: "x",
          text: "✕",
          title: "移除",
          style: "cursor:pointer",
          onclick: () => {
            if (!isCurrent()) return;
            if (which === "wrong") {
              // 用户手动删除：清易错权重 + 停止复现（系统自身无权移除易错词）
              const key = stateKey(chapter, Number(word.id));
              delete state.weights[key];
              state.words[key] = {
                ...(state.words[key] || {}),
                c: chapter,
                w: Number(word.id),
                s: STATUS.learning,
                cs: 0,
                wc: Number(state.words[key]?.wc) || 0,
                seen: Date.now(),
                due: 0,
              };
              markDirty(chapter, Number(word.id));
            } else {
              toggleStar(chapter, Number(word.id));
            }
            if (state.review) {
              state.review.ids = state.review.ids.filter((id) => Number(id) !== Number(word.id));
              state.deck = state.deck.filter((id) => Number(id) !== Number(word.id));
              if (state.index >= state.deck.length) state.index = Math.max(0, state.deck.length - 1);
            }
            sheet.close();
            openMenuSheet(which);
            render();
          },
        })
      );
      chips.append(chip);
    }
    wrap.append(chips);
  }

  if (words.length) {
    wrap.append(
      el("div", { class: "dialog-actions" }, [
        el("button", {
          class: "btn btn-danger",
          type: "button",
          text: which === "wrong" ? "清空易错词" : "清空生词本",
          onclick: async () => {
            const ok = await confirmDialog({
              title: which === "wrong" ? "清空本章易错词？" : "清空本章生词本？",
              message: "该操作会立即同步到云端，可以撤销。",
              confirmText: "清空",
              danger: true,
            });
            if (!ok || !isCurrent()) return;
            const snapshot = Object.create(null);
            const snapshotWeights = Object.create(null);
            const snapshotStars = loadStars();
            for (const id of ids) {
              const key = stateKey(chapter, Number(id));
              if (state.words[key]) snapshot[key] = { ...state.words[key] };
              if (state.weights[key]) snapshotWeights[key] = { ...state.weights[key] };
            }
            if (which === "wrong") {
              for (const id of ids) {
                const key = stateKey(chapter, Number(id));
                // 清空 = 状态回到 learning + 删除易错权重（列表以 weights 为准，只清状态会导致"清不掉"）
                delete state.weights[key];
                if (state.words[key]) {
                  state.words[key] = { ...state.words[key], s: STATUS.learning, cs: 0, seen: Date.now(), due: 0 };
                  markDirty(chapter, Number(id));
                }
              }
            } else {
              const stars = loadStars();
              stars[chapter] = [];
              saveStars(stars);
            }
            saveLocal();
            sheet.close();
            render();
            toast(which === "wrong" ? "已清空易错词" : "已清空生词本", {
              type: "ok",
              action: {
                label: "撤销",
                onClick: async () => {
                  if (!isCurrent()) return;
                  if (which === "wrong") {
                    for (const id of ids) {
                      const key = stateKey(chapter, Number(id));
                      const previous = snapshot[key];
                      if (previous) state.words[key] = { ...previous };
                      else delete state.words[key];
                      const previousWeight = snapshotWeights[key];
                      if (previousWeight) state.weights[key] = { ...previousWeight };
                      else delete state.weights[key];
                    }
                  }
                  saveStars(snapshotStars);
                  if (which === "wrong") {
                    for (const id of ids) markDirty(chapter, Number(id));
                  }
                  saveLocal();
                  render();
                  if (Auth.isLoggedIn()) {
                    try {
                      const flushed = await flushForSession(run);
                      if (!isCurrent()) return;
                      if (!flushed) toast("撤销已保存在本机，云端同步待重试", { type: "bad" });
                      await starSync.flush();
                      if (!isCurrent()) return;
                    } catch {
                      if (isCurrent()) toast("撤销已保存在本机，云端同步待重试", { type: "bad" });
                    }
                  }
                },
              },
            });
          },
        }),
        el("button", {
          class: "btn btn-primary",
          type: "button",
          text: "开始复习",
          onclick: () => {
            if (!isCurrent()) return;
            sheet.close();
            startReview();
          },
        }),
      ])
    );
  }
  return wrap;
}

/** Reset one chapter only after its pending upload has drained, and keep an account-bound undo. */
async function resetChapterWithUndo() {
  const run = captureUiSession();
  const chapter = state.chapter;
  const isCurrent = () => uiSessionCurrent(run) && state.chapter === chapter;
  const ok = await confirmDialog({
    title: `重置「${chapterTitle(chapter)}」？`,
    message: "本章的掌握状态、易错词会全部清空，无法恢复学习历史（10 秒内可撤销）。",
    confirmText: "重置",
    danger: true,
  });
  if (!ok || !isCurrent()) return;
  closeAppSheets();

  try {
    let resetAt = Date.now();
  if (Auth.isLoggedIn()) {
    const flushed = await flushForSession(run);
    if (!isCurrent()) return;
    if (!flushed) {
      toast("待上传记录尚未同步，未执行重置", { type: "bad" });
      return;
    }
    const result = await Auth.resetChapter(chapter);
    if (!isCurrent()) return;
    if (result?.error === "auth_changed") return;
    if (!result?.ok) {
      toast(result?.msg || "云端重置失败，未执行重置", { type: "bad" });
      return;
    }
    resetAt = Number(result?.data?.resetAt) || Number(result?.data?.serverTime) || resetAt;
  }

  const keys = [...new Set([
    ...Object.keys(state.words),
    ...Object.keys(state.weights),
  ].filter((key) => key.startsWith(`${chapter}:`)))];
  const snapshotWords = Object.create(null);
  const snapshotWeights = Object.create(null);
  for (const key of keys) {
    snapshotWords[key] = state.words[key] ? { ...state.words[key] } : null;
    if (state.weights[key]) snapshotWeights[key] = { ...state.weights[key] };
    delete state.words[key];
    delete state.weights[key];
    state.sync.dirty.delete(key);
  }
  saveLocal();
  startRound({ fresh: true, focus: false });
  render();
  toast("已重置本章进度", {
    type: "ok",
    action: {
      label: "撤销",
      onClick: async () => {
        if (!isCurrent()) return;
        const restoredSeen = Math.max(Date.now(), resetAt + 1);
        for (const key of keys) {
          const previous = snapshotWords[key];
          if (previous) state.words[key] = { ...previous, seen: restoredSeen };
          const previousWeight = snapshotWeights[key];
          if (previousWeight) state.weights[key] = previousWeight;
          else delete state.weights[key];
          const [c, w] = key.split(":").map(Number);
          if (previous) markDirty(c, w);
        }
        saveLocal();
        render();
        if (Auth.isLoggedIn()) {
          try {
            const flushed = await flushForSession(run);
            if (!isCurrent()) return;
            if (!flushed) toast("撤销已保存在本机，云端同步待重试", { type: "bad" });
          } catch {
            if (isCurrent()) toast("撤销已保存在本机，云端同步待重试", { type: "bad" });
          }
        }
      },
    },
    });
  } catch (err) {
    if (isCurrent()) toast(`重置失败：${err instanceof Error ? err.message : "未知错误"}`, { type: "bad" });
  }
}

/** 设置面板 */
function buildSettingsPanel(sheet) {
  const run = captureUiSession();
  const isCurrent = () => uiSessionCurrent(run);
  const wrap = el("div");
  const settings = state.settings;

  /* 学习 */
  const dailyGroup = el("div", { class: "settings-group" }, [el("h3", { text: "学习" })]);
  const today = localDateKey();
  const streak = currentStreak(settings.daily, today);
  const practice = practiceMode();
  dailyGroup.append(
    el("div", { class: "setting-row" }, [
      el("div", { class: "label" }, [
        el("b", { text: "练习方式" }),
        el("small", {
          text:
            practice === "choice"
              ? "认词：看英文选中文，只要求认识（更快、更适合泛读）"
              : "拼写：看中文/听音写单词，要求会写",
        }),
      ]),
      buildSeg(
        PRACTICE_OPTIONS,
        settings.answer,
        (value) => {
          if (!isCurrent()) return;
          void switchPractice(value === "choice" ? "choice" : "spell").then(() => {
            if (!isCurrent()) return;
            sheet.close();
            openMenuSheet("settings");
          });
        },
        "answer"
      ),
    ]),
    practice === "choice"
      ? el("div", { class: "setting-row" }, [
          el("div", { class: "label" }, [el("b", { text: "认词题干" }), el("small", { text: "看英文 / 只听音（答完再揭示单词）" })]),
          buildSeg(
            QUIZ_MODES,
            settings.quizPrompt,
            (value) => {
              settings.quizPrompt = value;
              markSettingsDirty();
              if (!state.answered) renderWord({ focus: false });
              else {
                pickPromptKind();
                render();
              }
            },
            "quizPrompt"
          ),
        ])
      : null,
    practice === "choice"
      ? el("div", { class: "setting-row" }, [
          el("div", { class: "label" }, [el("b", { text: "答对自动下一题" }), el("small", { text: "答错会停下来，让你先看辨析" })]),
          buildSwitch(settings.autoNext, (on) => {
            settings.autoNext = on;
            markSettingsDirty();
            if (!on) clearAutoNext();
          }, "答对自动下一题"),
        ])
      : null,
    el("div", { class: "setting-row" }, [
      el("div", { class: "label" }, [
        el("b", { text: "每日目标" }),
        el("small", {
          text: `今日 ${settings.daily.count}/${settings.daily.target}${settings.daily.achieved ? " · 已达成" : ""}${
            streak ? ` · 连续 ${streak} 天` : ""
          }`,
        }),
      ]),
      el("div", { class: "row" }, [
        el("button", {
          class: "btn btn-sm",
          type: "button",
          text: "修改",
          onclick: async () => {
            if (!isCurrent()) return;
            const value = await promptDialog({
              title: "每日目标",
              label: "每天要完成多少词？",
              value: String(settings.daily.target),
              type: "number",
              min: 1,
              max: 999,
              hint: "达标后不再清零，可累计超额完成",
            });
            if (value === null || !isCurrent()) return;
            const target = Math.max(1, Math.min(999, Number(value) || settings.daily.target));
            settings.daily = { ...settings.daily, target };
            markSettingsDirty();
            sheet.close();
            openMenuSheet("settings");
            render();
          },
        }),
      ]),
    ]),
    el("div", { class: "setting-row" }, [
      el("div", { class: "label" }, [el("b", { text: "提示字母" }), el("small", { text: "只在拼写模式生效：给出首字母或随机字母，降低起步难度" })]),
      buildSeg(
        [
          [0, "无"],
          [1, "首字母"],
          [2, "随机2"],
          [3, "随机3"],
        ],
        settings.hint,
        (value) => {
          settings.hint = Number(value);
          markSettingsDirty();
          if (!state.answered) renderWord({ focus: false });
          else render();
        },
        "hint"
      ),
    ]),
    el("div", { class: "setting-row" }, [
      el("div", { class: "label" }, [el("b", { text: "限时作答" }), el("small", { text: "每题倒计时，超时判定为错" })]),
      el("div", { class: "row" }, [
        buildSeg(
          [
            [5, "5s"],
            [10, "10s"],
            [15, "15s"],
            [20, "20s"],
          ],
          settings.timerSeconds,
          (value) => {
            settings.timerSeconds = Number(value);
            markSettingsDirty();
            if (settings.timerEnabled) startTimer();
          }
        ),
        buildSwitch(settings.timerEnabled, (on) => {
          settings.timerEnabled = on;
          markSettingsDirty();
          if (on) startTimer();
          else stopTimer();
          render();
        }, "限时作答"),
      ]),
    ])
  );

  /* 声音 */
  const soundGroup = el("div", { class: "settings-group" }, [
    el("h3", { text: "声音" }),
    el("div", { class: "setting-row" }, [
      el("div", { class: "label" }, [el("b", { text: "答对/答错音效" })]),
      buildSwitch(settings.sfx, (on) => {
        settings.sfx = on;
        markSettingsDirty();
      }, "答对/答错音效"),
    ]),
    el("div", { class: "setting-row" }, [
      el("div", { class: "label" }, [el("b", { text: "朗读单词" }), el("small", { text: "判分后与听音模式都会朗读" })]),
      buildSwitch(settings.speech, (on) => {
        settings.speech = on;
        markSettingsDirty();
        if (on) void speak(currentWord()?.word || "");
      }, "朗读单词"),
    ]),
    el("div", { class: "setting-row" }, [
      el("div", { class: "label" }, [el("b", { text: "朗读语速" })]),
      buildSeg(
        [
          [0.7, "慢"],
          [0.9, "正常"],
          [1.1, "快"],
        ],
        settings.rate,
        (value) => {
          settings.rate = Number(value);
          markSettingsDirty();
          void speak(currentWord()?.word || "");
        }
      ),
    ]),
  ]);

  /* 外观 */
  const themeGroup = el("div", { class: "settings-group" }, [
    el("h3", { text: "外观" }),
    el("div", { class: "setting-row" }, [
      el("div", { class: "label" }, [el("b", { text: "主题色" }), el("small", { text: "六款精选渐变，或自定义取色" })]),
      buildSwatches(state.settings.accent, state.settings.accentCustom),
    ]),
    el("div", { class: "setting-row" }, [
      el("div", { class: "label" }, [el("b", { text: "主题" }), el("small", { text: "跟随系统 / 浅色 / 深色" })]),
      buildSeg(
        [
          ["system", "跟随系统"],
          ["light", "浅色"],
          ["dark", "深色"],
        ],
        theme.stored(),
        (value) => theme.set(/** @type {any} */ (value))
      ),
    ]),
  ]);

  /* 账号（两页共享组件，见 ui.js；onAction 负责与本页抽屉联动） */
  const accountGroup = buildAccountSection({
    Auth,
    onAction: (type) => {
      if (!isCurrent()) return;
      if (type === "auth") {
        sheet.close();
        openAuthSheet();
      } else if (type === "password") {
        sheet.close();
        openPasswordSheet();
      } else if (type === "refresh" || type === "changed") {
        sheet.close();
        openMenuSheet("settings");
      }
    },
  });

  /* 数据 */
  const dataGroup = el("div", { class: "settings-group" }, [
    el("h3", { text: "数据" }),
    el("div", { class: "row", style: "flex-wrap:wrap;gap:8px" }, [
      el("button", {
        class: "btn btn-sm",
        type: "button",
        text: "导出备份",
        onclick: async () => {
          if (!isCurrent()) return;
          if (!Auth.isLoggedIn()) {
            downloadJson(
              {
                version: 2,
                exportedAt: new Date().toISOString(),
                localWords: state.words,
                localStars: starSync.active(),
                starRecords: starSync.records(),
                settings: state.settings,
              },
              "vocab-backup"
            );
            toast("已导出本机数据", { type: "ok" });
            return;
          }
          const data = await Auth.exportAll(true);
          if (!isCurrent()) return;
          if (!data) {
            toast("导出失败，请稍后重试", { type: "bad" });
            return;
          }
          downloadJson(data, "vocab-backup");
          toast("已导出云端备份（含配图）", { type: "ok" });
        },
      }),
      el("button", {
        class: "btn btn-sm",
        type: "button",
        text: "导入备份",
        onclick: () => importBackup(),
      }),
    ]),
    el("div", { class: "danger-zone", style: "margin-top:12px" }, [
      el("p", { class: "small", style: "margin:0 0 8px", text: "以下操作会影响本章学习状态，均会同步到云端（可撤销）。" }),
      el("div", { class: "row", style: "flex-wrap:wrap;gap:8px" }, [
        el("button", {
          class: "btn btn-sm btn-danger",
          type: "button",
          text: "重置本章进度",
          onclick: () => void resetChapterWithUndo(),
        }),
      ]),
    ]),
  ]);

  wrap.append(dailyGroup, soundGroup, themeGroup, accountGroup, dataGroup);
  return wrap;
}

/* ============ 主题调色盘 ============ */

const SWATCH_NAMES = { sky: "天蓝", violet: "紫罗兰", emerald: "翡翠", rose: "玫瑰", amber: "琥珀", slate: "石板", custom: "自定义" };

let lastAccentKey = "";

/** 把当前 settings 的主题色落到 <html> + 镜像 + 动态 favicon（同状态幂等） */
function applyAccentSettings() {
  const name = String(state.settings.accent || "sky");
  const color = String(state.settings.accentCustom || "");
  const key = `${name}|${color}`;
  if (key === lastAccentKey) return;
  lastAccentKey = key;
  applyAccent(name, color);
  appearanceMirrorWrite({ name, color: name === "custom" ? color : "" });
  applyFavicon(name === "custom" ? color : ACCENT_HEX[name] || "#0ea5e9");
}

/** 动态 favicon：用当前主题色画一枚渐变 L 标（浏览器标签页跟着换色） */
function applyFavicon(hex) {
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const grad = ctx.createLinearGradient(0, 0, 64, 64);
    grad.addColorStop(0, mix(hex, [255, 255, 255], 0.25));
    grad.addColorStop(1, mix(hex, [0, 0, 0], 0.3));
    ctx.fillStyle = grad;
    if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(0, 0, 64, 64, 16); ctx.fill(); }
    else ctx.fillRect(0, 0, 64, 64);
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 7;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(22, 16);
    ctx.lineTo(22, 46);
    ctx.lineTo(44, 46);
    ctx.stroke();
    let link = document.querySelector('link[rel="icon"]');
    if (!link) {
      link = document.createElement("link");
      link.rel = "icon";
      document.head.append(link);
    }
    link.href = canvas.toDataURL("image/png");
  } catch {}
}

/**
 * 主题色色卡（六预设 + 自定义取色）。状态读写都走 state.settings，变更自带 markSettingsDirty。
 * @param {string} value 当前盘名
 * @param {string} customHex 自定义色（value === "custom" 时有效）
 */
function buildSwatches(value, customHex) {
  const host = el("div", { class: "swatches", role: "radiogroup", "aria-label": "主题色" });
  const repaint = () => {
    for (const btn of host.querySelectorAll(".swatch")) {
      const isCustom = btn.dataset.palette === "custom";
      btn.setAttribute("aria-pressed", String(state.settings.accent === btn.dataset.palette || (state.settings.accent === "custom" && isCustom)));
    }
  };
  for (const name of ACCENTS) {
    if (name === "custom") continue;
    host.append(
      el("button", {
        class: "swatch",
        type: "button",
        role: "radio",
        "aria-pressed": String(value === name),
        "aria-label": SWATCH_NAMES[name],
        title: SWATCH_NAMES[name],
        dataset: { palette: name },
        onclick: () => {
          state.settings.accent = name;
          state.settings.accentCustom = "";
          markSettingsDirty();
          applyAccentSettings();
          repaint();
        },
      })
    );
  }
  const colorInput = el("input", { type: "color", value: /^#[0-9a-fA-F]{6}$/.test(customHex || "") ? customHex : "#0ea5e9", "aria-label": "自定义主题色" });
  colorInput.addEventListener("input", () => {
    state.settings.accent = "custom";
    state.settings.accentCustom = colorInput.value;
    markSettingsDirty();
    applyAccentSettings();
    repaint();
  });
  host.append(
    el("label", {
      class: "swatch swatch-custom",
      role: "radio",
      "aria-pressed": String(value === "custom"),
      "aria-label": "自定义主题色",
      title: "自定义色（点右侧圆点取色）",
      dataset: { palette: "custom" },
    }, [colorInput])
  );
  return host;
}

/**
 * 分段控件
 * @param {Array<[any, string]>} options
 * @param {any} value
 * @param {(value: any) => void} onChange
 * @param {string} [name] 用于跨面板同步（例如主界面与设置里的"提示"是同一项）
 */
function buildSeg(options, value, onChange, name) {
  const seg = el("div", { class: "seg", role: "group", dataset: name ? { seg: name } : undefined });
  for (const [optionValue, label] of options) {
    seg.append(
      el("button", {
        type: "button",
        text: label,
        dataset: { value: String(optionValue) },
        "aria-pressed": String(String(optionValue) === String(value)),
        onclick: () => onChange(optionValue),
      })
    );
  }
  return seg;
}

/**
 * @param {boolean} checked
 * @param {(checked: boolean) => void} onChange
 * @param {string} [label] 稳定的可访问名（aria-label 不能随开关状态变化，否则读屏器每次播报都不同）
 */
function buildSwitch(checked, onChange, label = "开关") {
  const btn = el("button", {
    class: "switch",
    type: "button",
    role: "switch",
    "aria-checked": String(checked),
    "aria-label": label,
    onclick: () => {
      const next = btn.getAttribute("aria-checked") !== "true";
      btn.setAttribute("aria-checked", String(next));
      onChange(next);
    },
  });
  return btn;
}

/* ============ 练习方式 / 出题方式 分段控件 ============ */

const PRACTICE_OPTIONS = /** @type {Array<[any, string]>} */ ([
  ["spell", "拼写"],
  ["choice", "认词"],
]);
const SPELL_MODES = /** @type {Array<[any, string]>} */ ([
  ["chinese", "看中文"],
  ["audio", "听音"],
  ["random", "随机"],
]);
const QUIZ_MODES = /** @type {Array<[any, string]>} */ ([
  ["en", "看英文"],
  ["zh", "看中文"],
  ["audio", "听音"],
  ["random", "随机"],
]);

function syncPracticeSeg() {
  for (const btn of $$("[data-practice]", state.dom.practiceSeg)) {
    btn.setAttribute("aria-pressed", String(btn.dataset.practice === practiceMode()));
  }
}

/**
 * 出题方式分段控件随练习方式变化。
 * 只有练习方式真的变了才重建 DOM —— 否则每次 render 都重建会让按钮闪一下。
 */
function renderModeSeg(force = false) {
  const host = state.dom.modeSeg;
  if (!host) return;
  const practice = practiceMode();
  if (!force && host.dataset.practice === practice && host.childElementCount) return;
  host.dataset.practice = practice;
  const options = practice === "choice" ? QUIZ_MODES : SPELL_MODES;
  const value = practice === "choice" ? state.settings.quizPrompt : state.settings.mode;
  const seg = buildSeg(options, value, onModeSegChange);
  host.replaceChildren(...Array.from(seg.children));
  host.setAttribute("aria-label", practice === "choice" ? "认词出题方式" : "拼写出题方式");
}

function syncModeSeg() {
  const host = state.dom.modeSeg;
  if (!host) return;
  const practice = practiceMode();
  const value = String(practice === "choice" ? state.settings.quizPrompt : state.settings.mode);
  for (const btn of $$("button", host)) btn.setAttribute("aria-pressed", String(btn.dataset.value === value));
}

/** @param {any} value */
function onModeSegChange(value) {
  const practice = practiceMode();
  if (practice === "choice") state.settings.quizPrompt = value;
  else state.settings.mode = value;
  markSettingsDirty();
  if (state.answered) {
    // 已答完：只换题面呈现方式，不重置作答状态
    pickPromptKind();
    render();
  } else {
    renderWord({ focus: false });
  }
}

/** 登录 / 注册：表单本体在 ui.js（两页共享），这里只做本页委托 */
function openAuthSheet(mode = "login") {
  openSharedAuthSheet({ Auth, mode });
}

function openPasswordSheet() {
  openSharedPasswordSheet({ Auth });
}

/** 今日目标详情（点顶栏目标环打开）：当日进度 + 连续天数 + 手动重置入口 */
function openDailyGoalSheet() {
  const run = captureUiSession();
  const isCurrent = () => uiSessionCurrent(run);
  const sheet = openAppSheet({ title: "今日目标" });
  const daily = state.settings.daily || {};
  const count = Math.max(0, Number(daily.count) || 0);
  const target = Math.max(1, Number(daily.target) || 50);
  sheet.body.append(
    el("div", { class: "report-grid" }, [
      el("div", { class: "report-cell" }, [el("b", { text: `${count}/${target}` }), el("small", { text: "今日进度" })]),
      el("div", { class: "report-cell" }, [el("b", { text: String(currentStreak(daily, localDateKey())) }), el("small", { text: "连续天数" })]),
      el("div", { class: "report-cell" }, [el("b", { text: String(Math.max(0, Number(daily.total) || 0)) }), el("small", { text: "累计答题" })]),
    ]),
    el("p", { class: "small muted", text: "每答一题计 1 次（对错都算）。多端同天取更大进度合并；手动重置以最近一次为准。" }),
    el("div", { class: "dialog-actions" }, [
      el("button", { class: "btn", type: "button", text: "关闭", onclick: () => sheet.close() }),
      el("button", {
        class: "btn btn-danger",
        type: "button",
        text: "重置今日计数",
        onclick: async () => {
          if (!isCurrent()) return;
          const ok = await confirmDialog({
            title: "重置今日计数？",
            message: "清零今日进度与已达成状态；连续天数与历史累计保留。其它设备会以这次重置为准。",
            confirmText: "重置",
          });
          if (!ok || !isCurrent()) return;
          state.settings.daily = resetDaily(state.settings.daily, localDateKey());
          markSettingsDirty();
          saveLocal();
          sheet.close();
          render();
          toast("今日计数已清零", { type: "ok" });
        },
      }),
    ])
  );
}

/* ============ 备份导入导出 ============ */

export const BACKUP_IMPORT_MAX_BYTES = 4 * 1024 * 1024;
const BACKUP_MAX_ITEMS = 10_000;
const BACKUP_MAX_SETTINGS_BYTES = 7200;
const BACKUP_MAX_NOTE_CHARS = 4000;
const BACKUP_MAX_IMAGE_BASE64 = 400_000;
const BACKUP_MAX_RESUME_DECK = 600;
const BACKUP_STATUSES = new Set(["learning", "wrong", "mastered"]);
const BACKUP_IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/webp"]);
const BACKUP_TOP_LEVEL_KEYS = new Set([
  "version",
  "exportedAt",
  "email",
  "settings",
  "words",
  "stars",
  "notes",
  "images",
  "resets",
  "noteTombstones",
  "imageTombstones",
  "localWords",
  "localStars",
  "starRecords",
]);

/** @param {unknown} value */
function isPlainBackupObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** @param {Record<string, unknown>} value @param {readonly string[]} allowed */
function hasOnlyBackupKeys(value, allowed) {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

/** @param {Record<string, unknown>} value @param {readonly string[]} expected */
function hasExactBackupKeys(value, expected) {
  const keys = Object.keys(value);
  return keys.length === expected.length && hasOnlyBackupKeys(value, expected);
}

/** @param {unknown} value */
function isBackupCount(value, min = 0, max = Number.MAX_SAFE_INTEGER) {
  return Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max;
}

function isBackupChapter(value) {
  return isBackupCount(value, 1, 999);
}

function isBackupWord(value) {
  return isBackupCount(value, 1, 100_000);
}

/** @param {unknown} value @returns {any|null} */
function validateBackupWordState(value) {
  if (!isPlainBackupObject(value) || !hasExactBackupKeys(value, ["c", "w", "s", "cs", "wc", "seen", "due"])) return null;
  if (
    !isBackupChapter(value.c) ||
    !isBackupWord(value.w) ||
    !BACKUP_STATUSES.has(String(value.s)) ||
    !isBackupCount(value.cs, 0, 9999) ||
    !isBackupCount(value.wc, 0, 9999) ||
    !isBackupCount(value.seen) ||
    !isBackupCount(value.due)
  ) {
    return null;
  }
  return { c: value.c, w: value.w, s: value.s, cs: value.cs, wc: value.wc, seen: value.seen, due: value.due };
}

/** @param {unknown} value @returns {any|null} */
function validateBackupSettings(value) {
  if (value === null) return null;
  if (!isPlainBackupObject(value)) return undefined;
  if (
    !hasOnlyBackupKeys(value, [
      "mode",
      "answer",
      "quizPrompt",
      "accent",
      "accentCustom",
      "autoNext",
      "hint",
      "timerEnabled",
      "timerSeconds",
      "sfx",
      "speech",
      "rate",
      "daily",
      "resume",
    ])
  ) {
    return undefined;
  }
  if (value.mode !== undefined && !["random", "chinese", "audio"].includes(String(value.mode))) return undefined;
  if (value.answer !== undefined && !["spell", "choice"].includes(String(value.answer))) return undefined;
  if (value.quizPrompt !== undefined && !["en", "zh", "audio", "random"].includes(String(value.quizPrompt))) return undefined;
  if (value.accent !== undefined && !ACCENTS.includes(String(value.accent))) return undefined;
  if (value.accentCustom !== undefined && !/^$|^#[0-9a-fA-F]{6}$/.test(String(value.accentCustom))) return undefined;
  for (const key of ["autoNext", "timerEnabled", "sfx", "speech"]) {
    if (value[key] !== undefined && typeof value[key] !== "boolean") return undefined;
  }
  if (value.hint !== undefined && !isBackupCount(value.hint, 0, 3)) return undefined;
  if (value.timerSeconds !== undefined && !isBackupCount(value.timerSeconds, 3, 60)) return undefined;
  if (value.rate !== undefined && (typeof value.rate !== "number" || !Number.isFinite(value.rate) || value.rate < 0.6 || value.rate > 1.3)) {
    return undefined;
  }

  /** @type {Record<string, unknown>} */
  const out = {};
  for (const key of Object.keys(value)) {
    if (key !== "daily" && key !== "resume") out[key] = value[key];
  }
  if (value.daily !== undefined) {
    if (!isPlainBackupObject(value.daily) || !hasOnlyBackupKeys(value.daily, ["target", "count", "date", "achieved", "streak", "best", "total", "lastAchieved"])) {
      return undefined;
    }
    if (value.daily.target !== undefined && !isBackupCount(value.daily.target, 1, 999)) return undefined;
    for (const key of ["count", "streak", "best", "total"]) {
      if (value.daily[key] !== undefined && !isBackupCount(value.daily[key])) return undefined;
    }
    for (const key of ["date", "lastAchieved"]) {
      if (value.daily[key] !== undefined && (typeof value.daily[key] !== "string" || String(value.daily[key]).length > 32)) return undefined;
    }
    if (value.daily.achieved !== undefined && typeof value.daily.achieved !== "boolean") return undefined;
    out.daily = { ...value.daily };
  }
  if (value.resume !== undefined && value.resume !== null) {
    if (
      !isPlainBackupObject(value.resume) ||
      !hasExactBackupKeys(value.resume, ["chapter", "index", "deck", "attempts", "correct", "practice", "at"])
    ) {
      return undefined;
    }
    if (
      !isBackupChapter(value.resume.chapter) ||
      !isBackupCount(value.resume.index) ||
      !Array.isArray(value.resume.deck) ||
      value.resume.deck.length > BACKUP_MAX_RESUME_DECK ||
      !value.resume.deck.every(isBackupWord) ||
      !isBackupCount(value.resume.attempts) ||
      !isBackupCount(value.resume.correct) ||
      !["spell", "choice"].includes(String(value.resume.practice)) ||
      !isBackupCount(value.resume.at)
    ) {
      return undefined;
    }
    out.resume = { ...value.resume, deck: [...value.resume.deck] };
  } else if (value.resume === null) {
    out.resume = null;
  }
  if (new TextEncoder().encode(JSON.stringify(out)).byteLength > BACKUP_MAX_SETTINGS_BYTES) return undefined;
  return out;
}

/** @param {unknown} value @returns {Record<string, any>|null} */
function validateBackupLocalWords(value) {
  if (!isPlainBackupObject(value)) return null;
  const entries = Object.entries(value);
  if (entries.length > BACKUP_MAX_ITEMS) return null;
  const out = Object.create(null);
  for (const [key, raw] of entries) {
    const match = /^([1-9]\d*):([1-9]\d*)$/.exec(key);
    if (!match) return null;
    const c = Number(match[1]);
    const w = Number(match[2]);
    const word = validateBackupWordState(raw);
    if (!word || word.c !== c || word.w !== w) return null;
    out[key] = word;
  }
  return out;
}

/** @param {unknown} value */
function validateBackupLocalStars(value) {
  if (!isPlainBackupObject(value)) return false;
  let count = 0;
  /** @type {Record<string, number[]>} */
  const out = Object.create(null);
  for (const [key, raw] of Object.entries(value)) {
    if (!/^[1-9]\d*$/.test(key) || !isBackupChapter(Number(key)) || !Array.isArray(raw)) return false;
    count += raw.length;
    if (count > BACKUP_MAX_ITEMS) return false;
    const ids = [];
    const seen = new Set();
    for (const id of raw) {
      if (!isBackupWord(id) || seen.has(id)) return false;
      seen.add(id);
      ids.push(id);
    }
    out[key] = ids;
  }
  return out;
}

/** @param {unknown} value */
function validateBackupStarRecords(value) {
  if (!isPlainBackupObject(value)) return false;
  const entries = Object.entries(value);
  if (entries.length > BACKUP_MAX_ITEMS) return false;
  const out = Object.create(null);
  for (const [key, raw] of entries) {
    const match = /^([1-9]\d*):([1-9]\d*)$/.exec(key);
    if (!match || !isPlainBackupObject(raw) || !hasExactBackupKeys(raw, ["starred", "updatedAt"])) return false;
    if (typeof raw.starred !== "boolean" || !isBackupCount(raw.updatedAt)) return false;
    if (!isBackupChapter(Number(match[1])) || !isBackupWord(Number(match[2]))) return false;
    out[key] = { starred: raw.starred, updatedAt: raw.updatedAt };
  }
  return out;
}

/**
 * Validate and clone a backup before any account request or local mutation.
 * @param {unknown} input
 * @returns {Record<string, any>|null}
 */
export function validateBackupPayload(input) {
  if (!isPlainBackupObject(input) || input.version !== 2 || !hasOnlyBackupKeys(input, BACKUP_TOP_LEVEL_KEYS)) return null;
  if (Object.hasOwn(input, "localWords") && Object.hasOwn(input, "words")) return null;
  if ((Object.hasOwn(input, "localStars") || Object.hasOwn(input, "starRecords")) && ["words", "stars", "notes", "images"].some((key) => Object.hasOwn(input, key))) {
    return null;
  }
  if (
    !["settings", "words", "stars", "notes", "images", "resets", "noteTombstones", "imageTombstones", "localWords", "localStars", "starRecords"].some((key) =>
      Object.hasOwn(input, key)
    )
  ) {
    return null;
  }
  if (input.exportedAt !== undefined && (typeof input.exportedAt !== "string" || input.exportedAt.length > 64 || !Number.isFinite(Date.parse(input.exportedAt)))) {
    return null;
  }
  if (input.email !== undefined && (typeof input.email !== "string" || input.email.length > 320 || !input.email.includes("@"))) return null;

  /** @type {Record<string, any>} */
  const out = { version: 2 };
  if (input.exportedAt !== undefined) out.exportedAt = input.exportedAt;
  if (input.email !== undefined) out.email = input.email;
  if (Object.hasOwn(input, "settings")) {
    const settings = validateBackupSettings(input.settings);
    if (settings === undefined) return null;
    out.settings = settings;
  }
  if (Object.hasOwn(input, "resets")) {
    if (!isPlainBackupObject(input.resets)) return null;
    const resets = Object.create(null);
    for (const [chapter, resetAt] of Object.entries(input.resets)) {
      if (!/^[1-9]\d*$/.test(chapter) || !isBackupCount(resetAt, 1)) return null;
      resets[chapter] = resetAt;
    }
    out.resets = resets;
  }

  for (const [field, max] of [["words", BACKUP_MAX_ITEMS], ["stars", BACKUP_MAX_ITEMS], ["notes", BACKUP_MAX_ITEMS], ["images", BACKUP_MAX_ITEMS], ["noteTombstones", BACKUP_MAX_ITEMS], ["imageTombstones", BACKUP_MAX_ITEMS]]) {
    if (!Object.hasOwn(input, field)) continue;
    const list = input[field];
    if (!Array.isArray(list) || list.length > max) return null;
    /** @type {any[]} */
    const copy = [];
    for (const raw of list) {
      if (!isPlainBackupObject(raw)) return null;
      if (field === "words") {
        const word = validateBackupWordState(raw);
        if (!word) return null;
        copy.push(word);
      } else if (field === "stars") {
        if (!hasExactBackupKeys(raw, ["c", "w", "starred", "updatedAt"])) return null;
        if (!isBackupChapter(raw.c) || !isBackupWord(raw.w) || typeof raw.starred !== "boolean" || !isBackupCount(raw.updatedAt, 1)) return null;
        copy.push({ c: raw.c, w: raw.w, starred: raw.starred, updatedAt: raw.updatedAt });
      } else if (field === "notes" || field === "noteTombstones" || field === "imageTombstones") {
        const keys = field === "notes" ? ["c", "w", "note", "hasImage", "updatedAt"] : ["c", "w", "updatedAt"];
        if (!hasExactBackupKeys(raw, keys)) return null;
        if (!isBackupChapter(raw.c) || !isBackupWord(raw.w) || !isBackupCount(raw.updatedAt, 1)) return null;
        if (field === "notes") {
          if (typeof raw.note !== "string" || raw.note.length > BACKUP_MAX_NOTE_CHARS || ![0, 1].includes(raw.hasImage)) return null;
          copy.push({ c: raw.c, w: raw.w, note: raw.note, hasImage: raw.hasImage, updatedAt: raw.updatedAt });
        } else {
          copy.push({ c: raw.c, w: raw.w, updatedAt: raw.updatedAt });
        }
      } else {
        if (!hasExactBackupKeys(raw, ["c", "w", "mime", "data", "updatedAt"])) return null;
        if (
          !isBackupChapter(raw.c) ||
          !isBackupWord(raw.w) ||
          typeof raw.mime !== "string" ||
          !BACKUP_IMAGE_MIMES.has(raw.mime) ||
          typeof raw.data !== "string" ||
          !raw.data ||
          raw.data.length > BACKUP_MAX_IMAGE_BASE64 ||
          !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(raw.data) ||
          !isBackupCount(raw.updatedAt)
        ) {
          return null;
        }
        copy.push({ c: raw.c, w: raw.w, mime: raw.mime, data: raw.data, updatedAt: raw.updatedAt });
      }
    }
    out[field] = copy;
  }

  if (Object.hasOwn(input, "localWords")) {
    const localWords = validateBackupLocalWords(input.localWords);
    if (!localWords) return null;
    out.localWords = localWords;
  }
  if (Object.hasOwn(input, "localStars")) {
    const localStars = validateBackupLocalStars(input.localStars);
    if (localStars === false) return null;
    out.localStars = localStars;
  }
  if (Object.hasOwn(input, "starRecords")) {
    const starRecords = validateBackupStarRecords(input.starRecords);
    if (starRecords === false) return null;
    out.starRecords = starRecords;
  }
  return out;
}

/** @param {any} data @param {string} name */
function downloadJson(data, name) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = el("a", { href: url, download: `${name}-${localDateKey()}.json` });
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function rebaseBackupWords(baseWords, currentWords, incomingWords) {
  const rebased = Object.assign(Object.create(null), currentWords);
  const base = baseWords || {};
  let changed = 0;
  for (const item of incomingWords || []) {
    const key = stateKey(Number(item.c), Number(item.w));
    const before = base[key];
    const now = rebased[key];
    const unchanged = before
      ? now && JSON.stringify(now) === JSON.stringify(before)
      : !now;
    if (!unchanged) continue;
    if (now && !pickNewer(now, item)) continue;
    const next = { c: Number(item.c), w: Number(item.w), s: item.s, cs: Number(item.cs) || 0, wc: Number(item.wc) || 0, seen: Number(item.seen) || 0, due: Number(item.due) || 0 };
    if (JSON.stringify(now) !== JSON.stringify(next)) {
      rebased[key] = next;
      changed++;
    }
  }
  return { words: rebased, changed };
}

function stageBackupImport(payload) {
  const incomingWords = Array.isArray(payload.words) ? payload.words : payload.localWords ? Object.values(payload.localWords) : [];
  const baseWords = Object.assign(Object.create(null), state.words);
  const stagedWords = Object.assign(Object.create(null), baseWords);
  const merged = mergeWordStates(stagedWords, incomingWords);
  let settings = state.settings;
  if (payload.settings && typeof payload.settings === "object") {
    const localDaily = state.settings.daily;
    const backupDaily = normalizeSettings(payload.settings).daily;
    // 取更近的一天；同一天 resetAt（手动重置）新者胜，打平取更大计数
    const newerDaily = mergeDailyBackup(localDaily, backupDaily);
    settings = normalizeSettings({
      ...state.settings,
      ...payload.settings,
      daily: newerDaily,
      resume: state.settings.resume ?? payload.settings.resume ?? null,
    });
  }
  const starPayload = payload.starRecords ?? payload.localStars ?? payload.stars ?? null;
  const starKind = payload.starRecords ? "records" : payload.localStars ? "active" : payload.stars ? "records" : null;
  return {
    words: stagedWords,
    incomingWords,
    settings,
    merged,
    baseWords,
    baseSettingsSnapshot: JSON.stringify(state.settings),
    starPayload,
    starKind,
  };
}

function commitStagedBackup(staged) {
  const rebased = rebaseBackupWords(staged.baseWords, state.words, staged.incomingWords);
  state.words = rebased.words;
  if (JSON.stringify(state.settings) === staged.baseSettingsSnapshot) state.settings = staged.settings;
  if (staged.starPayload) {
    if (staged.starKind === "active") starSync.mergeActive(staged.starPayload);
    else starSync.merge(staged.starPayload);
  }
  for (const key of Object.keys(state.words)) {
    const [c, w] = key.split(":").map(Number);
    markDirty(c, w);
  }
  markSettingsDirty();
  saveLocal();
  render();
  renderSync();
}

function importBackup() {
  const input = el("input", { type: "file", accept: "application/json,.json", style: "display:none" });
  // 用户取消选择时清理隐藏的 input，避免残留 DOM（与 lecture 页 pickImage 一致）。
  input.addEventListener("cancel", () => input.remove());
  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    if (!file) {
      input.remove();
      return;
    }
    const runUserId = Auth.userId();
    const runUserKey = state.userKey;
    const runEpoch = userEpoch;
    const runAuthRevision = Auth.revision();
    const runToken = sessionGuard.capture(runUserKey, runAuthRevision);
    const isCurrent = () =>
      currentUserEpoch(runEpoch, runUserKey, runAuthRevision) &&
      sessionGuard.isCurrent(runToken, runUserKey, runAuthRevision) &&
      Auth.userId() === runUserId;
    const abortImport = () => {
      input.remove();
      return false;
    };
    try {
      if (file.size > BACKUP_IMPORT_MAX_BYTES) {
        toast("备份文件过大（最多 4MB）", { type: "bad" });
        return abortImport();
      }
      const raw = await file.text();
      if (!isCurrent()) return abortImport();
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        toast("备份文件不是合法的 JSON", { type: "bad" });
        return abortImport();
      }
      const payload = validateBackupPayload(parsed);
      if (!payload) {
        toast("备份文件格式或版本不受支持", { type: "bad" });
        return abortImport();
      }
      const staged = stageBackupImport(payload);
      const hasCloudData = ["words", "stars", "notes", "images", "resets", "noteTombstones", "imageTombstones"].some((key) => Object.hasOwn(payload, key));
      if (Auth.isLoggedIn() && hasCloudData) {
        const res = await Auth.importAll(payload);
        if (res?.error === "auth_changed" || !isCurrent()) return abortImport();
        if (!res?.ok) {
          toast(res?.msg || "导入失败", { type: "bad" });
          return abortImport();
        }
        if (!isCurrent()) return abortImport();
        await starSync.pull();
        if (!isCurrent()) return abortImport();
        await starSync.flush();
        if (!isCurrent()) return abortImport();
        commitStagedBackup(staged);
        toast(
          `云端导入完成：${res.data?.words ?? 0} 词状态 / ${res.data?.notes ?? 0} 备注 / ${res.data?.stars ?? 0} 生词`,
          { type: "ok" }
        );
      } else {
        if (!isCurrent()) return abortImport();
        commitStagedBackup(staged);
        toast(`已导入 ${staged.merged} 条本地记录`, { type: "ok" });
      }
    } catch (err) {
      if (isCurrent()) toast(`导入失败：${err instanceof Error ? err.message : "未知错误"}`, { type: "bad" });
    } finally {
      input.remove();
    }
  });
  document.body.append(input);
  input.click();
}

/* ============ 事件绑定 ============ */

/** @param {KeyboardEvent} e */
function onKeydown(e) {
  const target = /** @type {HTMLElement} */ (e.target);
  const tag = target?.tagName;
  const isAnswerInput = target === state.dom.answerInput;
  if (!isAnswerInput && (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT")) return;
  if (e.isComposing || e.keyCode === 229) return; // 输入法组字中，交给 compositionend
  if (target?.isContentEditable) return;
  // 焦点在按钮/链接等交互元素上时，空格交给浏览器"激活控件"，不劫持为朗读
  // （否则键盘用户无法用空格点按钮；Enter 在下面各分支本来就有 BUTTON 豁免）
  const onInteractive = !isAnswerInput && Boolean(target?.closest?.('button, a, select, [role="button"], [role="radio"]'));

  // 认词模式：数字 / 字母直接选选项，Enter 只用于进入下一题（选项本身就是提交）
  if (practiceMode() === "choice") {
    if (e.key === "Enter") {
      if (tag === "BUTTON" && !isAnswerInput) return;
      e.preventDefault();
      clearAutoNext();
      if (state.roundDone) showReport();
      else if (state.answered) advance();
      return;
    }
    if (e.key === " ") {
      if (onInteractive) return; // 让按钮/选项被空格激活
      e.preventDefault();
      clearAutoNext(); // 想再听一遍，就别急着跳下一题
      if (state.promptKind === "zh" && !state.answered) return; // 反向题没作答前朗读=泄底
      void speak(currentWord()?.word || "");
      return;
    }
    if (/^[1-9]$/.test(e.key)) {
      e.preventDefault();
      clearAutoNext();
      chooseOption(Number(e.key) - 1);
      return;
    }
    if (/^[a-dA-D]$/.test(e.key)) {
      e.preventDefault();
      clearAutoNext();
      chooseOption(e.key.toLowerCase().charCodeAt(0) - 97);
      return;
    }
    return; // 认词不接收打字，其它按键一律忽略
  }

  if (e.key === "Enter") {
    if (tag === "BUTTON" && !isAnswerInput) return;
    e.preventDefault();
    if (state.roundDone) showReport();
    else if (state.answered) advance();
    else submit();
    return;
  }
  if (e.key === " ") {
    // 空格在刷词页统一是"重读"；焦点在按钮/链接上时放行给控件激活
    if (onInteractive) return;
    e.preventDefault();
    clearAutoNext();
    void speak(currentWord()?.word || "");
    return;
  }
  if (e.key === "Backspace") {
    if (!isAnswerInput) e.preventDefault();
    backspace();
    return;
  }
  if (e.key === "Delete") {
    e.preventDefault();
    clearAtCursor();
    return;
  }
  if (e.key === "ArrowLeft") {
    e.preventDefault();
    state.cursor = Math.max(0, state.cursor - 1);
    renderSlots();
    return;
  }
  if (e.key === "ArrowRight") {
    e.preventDefault();
    state.cursor = Math.min(state.values.length, state.cursor + 1);
    renderSlots();
    return;
  }
  if (e.key === "Tab" || e.key === "Escape") return;
  if (/^[a-zA-Z]$/.test(e.key)) {
    e.preventDefault();
    typeLetter(e.key);
  }
}

function bindAnswerInput() {
  const input = /** @type {HTMLInputElement} */ (state.dom.answerInput);
  // 输入法（中文/日文等）提交的结果走 compositionend
  input.addEventListener("compositionend", (e) => {
    const text = String(e.data || "");
    for (const ch of text) if (/[a-zA-Z]/.test(ch)) typeLetter(ch);
    input.value = "";
  });
  input.addEventListener("input", (e) => {
    if (e.isComposing) return;
    const text = String(input.value || "");
    for (const ch of text) if (/[a-zA-Z]/.test(ch)) typeLetter(ch);
    input.value = "";
  });
  input.addEventListener("blur", () => renderSlots());
  input.addEventListener("focus", () => {
    renderSlots();
    // 触屏上软键盘可能遮挡槽位，把它们带到视野中间
    if (window.matchMedia("(pointer: coarse)").matches) {
      window.setTimeout(() => state.dom.slotsWrap?.scrollIntoView({ block: "center", behavior: "smooth" }), 140);
    }
  });
}

/* ============ 初始化 ============ */

function cacheDom() {
  const dom = state.dom;
  dom.brandSub = $("#brandSub");
  dom.syncBtn = $("#syncBtn");
  dom.goal = $("#goalRing");
  dom.goalNum = $("#goalNum");
  dom.timerText = $("#timerText");
  dom.moreBtn = $("#moreBtn");
  dom.quickMenu = $("#quickMenu");
  dom.menuBtn = $("#menuBtn");
  dom.chapterBtn = $("#chapterBtn");
  dom.meta = $("#sessionMeta");
  dom.progressFill = $("#progressFill");
  dom.stageHead = $("#stageHead");
  dom.loading = $("#loadingCard");
  dom.loadingText = $("#loadingText");
  dom.loadError = $("#loadErrorCard");
  dom.loadErrorText = $("#loadErrorText");
  dom.retryBtn = $("#retryBtn");
  dom.errorChapterBtn = $("#errorChapterBtn");
  dom.body = $("#stageBody");
  dom.practiceSeg = $("#practiceSeg");
  dom.modeSeg = $("#modeSeg");
  dom.promptCn = $("#promptCn");
  dom.promptAudio = $("#promptAudio");
  dom.promptHint = $("#promptHint");
  dom.speakBtn = $("#speakBtn");
  dom.promptWord = $("#promptWord");
  dom.promptWordEn = $("#promptWordEn");
  dom.promptPhonetic = $("#promptPhonetic");
  dom.promptSpeak = $("#promptSpeak");
  dom.slots = $("#slots");
  dom.slotsWrap = $("#slotsWrap");
  dom.spellArea = $("#spellArea");
  dom.choiceArea = $("#choiceArea");
  dom.options = $("#options");
  dom.choiceHint = $("#choiceHint");
  dom.quizNote = $("#quizNote");
  dom.quizNoteHead = $("#quizNoteHead");
  dom.quizNoteList = $("#quizNoteList");
  dom.quizNoteFoot = $("#quizNoteFootText");
  dom.tapHint = $("#tapHint");
  dom.answerInput = $("#answerInput");
  dom.feedback = $("#feedback");
  dom.example = $("#example");
  dom.exampleEn = $("#exampleEn");
  dom.exampleCn = $("#exampleCn");
  dom.primaryBtn = $("#primaryBtn");
  dom.skipBtn = $("#skipBtn");
  dom.starBtn = $("#starBtn");
  dom.repeatBtn = $("#repeatBtn");
  dom.prevBtn = $("#prevBtn");
  dom.dontBtn = $("#dontBtn");
  dom.resetBtn = $("#resetBtn");
  dom.timerBtn = $("#timerBtn");
  dom.timerChip = $("#timerChip");
  dom.hintPick = $("#hintPick");
  dom.hintSelect = /** @type {HTMLSelectElement} */ ($("#hintSelect"));
  dom.reportBtn = $("#reportBtn"); // 曾漏缓存 → 辨析卡上的「报错」入口从未出现过（第五期遗留，第六期线上审查抓出）
  dom.reviewBanner = $("#reviewBanner");
  dom.reviewExit = $("#reviewExit");
}

function bindUi() {
  const dom = state.dom;

  dom.syncBtn.addEventListener("click", async () => {
    const run = captureUiSession();
    if (!Auth.isLoggedIn()) {
      openMenuSheet("settings");
      return;
    }
    toast("正在与云端同步…");
    // 先把待上传的写完，再回拉一次全量，最后重试队列
    const completed = await syncAccountUi(run, { full: true, flushFirst: true });
    if (!uiSessionCurrent(run)) return;
    if (completed) {
      state.sync.backoff = 0;
      await flushForSession(run);
      if (!uiSessionCurrent(run)) return;
    }
    render();
    toast(state.sync.lastError ? `同步未完成：${state.sync.lastError}` : "同步完成", {
      type: state.sync.lastError ? "bad" : "ok",
    });
  });

  dom.menuBtn.addEventListener("click", () => openMenuSheet("settings"));
  dom.chapterBtn.addEventListener("click", () => {
    if (state.review) {
      exitReview();
      return;
    }
    openChapterSheet();
  });
  dom.reviewExit.addEventListener("click", exitReview);

  // 「更多操作」菜单（出题方式/提示/再读/计时/跳过/重置收于此）：切换 + 点外/Esc 关闭
  if (dom.moreBtn && dom.quickMenu) {
    const closeMenu = () => {
      dom.quickMenu.hidden = true;
      dom.moreBtn.setAttribute("aria-expanded", "false");
    };
    dom.moreBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const willOpen = dom.quickMenu.hidden;
      dom.quickMenu.hidden = !willOpen;
      dom.moreBtn.setAttribute("aria-expanded", String(willOpen));
    });
    document.addEventListener("click", (e) => {
      if (dom.quickMenu.hidden) return;
      const t = /** @type {HTMLElement} */ (e.target);
      if (!dom.quickMenu.contains(t) && !dom.moreBtn.contains(t)) closeMenu();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !dom.quickMenu.hidden) closeMenu();
    });
  }

  // 练习方式：拼写 / 认词（换答法 = 换一轮，词状态不动）
  for (const btn of $$("[data-practice]", dom.practiceSeg)) {
    btn.addEventListener("click", () => void switchPractice(btn.dataset.practice === "choice" ? "choice" : "spell"));
  }

  // 认词的选项：点哪算哪，点完即判
  dom.options.addEventListener("click", (e) => {
    const node = /** @type {HTMLElement} */ (e.target)?.closest?.(".option");
    if (!node || node.hasAttribute("disabled")) return;
    chooseOption(Number(node.dataset.index));
  });
  dom.promptSpeak.addEventListener("click", () => void speak(currentWord()?.word || ""));

  dom.primaryBtn.addEventListener("click", () =>
    state.roundDone ? showReport() : state.answered ? advance() : practiceMode() === "choice" ? undefined : submit()
  );
  dom.skipBtn.addEventListener("click", skip);
  dom.repeatBtn.addEventListener("click", () => {
    if (practiceMode() === PRACTICE.choice && state.promptKind === "zh" && !state.answered) {
      toast("反向题作答后才能听发音（避免泄底）", { type: "info" });
      return;
    }
    void speak(currentWord()?.word || "");
  });

  // ⏮ 上一个：回看上一词（可补标生词；重新作答会按正常规则计分）
  dom.prevBtn.addEventListener("click", () => {
    if (state.index <= 0) return;
    clearAutoNext();
    state.index -= 1;
    renderWord({ focus: practiceMode() === "spell" });
  });

  // 🙋 不会（认词）：标生词 + 揭示答案 + 按答错计入易错权重
  dom.dontBtn.addEventListener("click", () => {
    if (state.answered) return;
    const word = currentWord();
    if (!word) return;
    if (!starIdsFor(state.chapter).includes(Number(word.id))) toggleStar(state.chapter, Number(word.id));
    finalize(false, false);
  });

  // ↺ 重置本章（主界面直达；确认 + 可撤销）
  dom.resetBtn.addEventListener("click", () => void resetChapterWithUndo());
  dom.timerBtn.addEventListener("click", () => {
    state.settings.timerEnabled = !state.settings.timerEnabled;
    markSettingsDirty();
    if (state.settings.timerEnabled) startTimer();
    else stopTimer();
    render();
  });
  dom.starBtn.addEventListener("click", () => {
    const word = currentWord();
    if (!word) return;
    const added = toggleStar(state.chapter, Number(word.id));
    toast(added ? "已加入生词本" : "已移出生词本", { type: "ok" });
    render();
  });
  dom.retryBtn.addEventListener("click", () => void loadChapter(state.chapter));
  dom.errorChapterBtn.addEventListener("click", () => openChapterSheet());

  // 主界面的提示字母：改了立刻对当前词生效
  dom.hintSelect.addEventListener("change", () => {
    state.settings.hint = Number(dom.hintSelect.value) || 0;
    markSettingsDirty();
    if (!state.answered) renderWord({ focus: false });
    else render();
  });

  // 点击题干/槽位区域调出键盘（认词模式不需要键盘，点了反而弹软键盘）
  for (const node of [dom.slotsWrap, dom.promptCn, dom.promptAudio, dom.feedback]) {
    node?.addEventListener("pointerdown", (e) => {
      if (state.answered || practiceMode() === "choice") return;
      const target = /** @type {HTMLElement} */ (e.target);
      if (target.closest("button")) return;
      e.preventDefault();
      focusInput();
    });
  }

  document.addEventListener("keydown", onKeydown);
  bindAnswerInput();
  bindTimerVisibility();

  // 顶栏今日目标环可点击：详情 + 重置入口（键盘可达）
  if (dom.goal) {
    dom.goal.setAttribute("role", "button");
    dom.goal.tabIndex = 0;
    dom.goal.addEventListener("click", () => openDailyGoalSheet());
    dom.goal.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openDailyGoalSheet();
      }
    });
  }

  // 讲义页改了生词（含切章）：跨 tab 实时跟上（storage 只在"别的 tab"触发，
  // 同 tab 内本页 toggleStar 后 renderWord 已即时重绘，这里无需处理）
  window.addEventListener("storage", (e) => {
    // 同值写入（如归一化回写）状态没变，过滤掉避免两页互相触发重绘的热循环。
    if (e.newValue === e.oldValue) return;
    if (e.key === activeStarsKey(state.userKey) || e.key === starRecordsKey(state.userKey)) render();
  });

  // 鼠标点完动作按钮后把焦点还给答题输入框，避免"回车又触发刚才那个按钮"
  document.addEventListener("click", (e) => {
    const btn = /** @type {HTMLElement} */ (e.target)?.closest?.(".actions button, .stage-head button");
    if (!btn) return;
    /** @type {HTMLButtonElement} */ (btn).blur();
    if (!state.answered && practiceMode() === "spell") window.setTimeout(() => focusInput(), 0);
  });

  window.addEventListener("beforeunload", () => {
    persistResume();
    saveLocal();
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      saveLocal();
      const run = captureUiSession();
      void syncAccountUi(run);
    } else {
      saveLocal();
    }
  });
}

/** 把设置同步到界面（拉云端后调用） */
function persistSettingsToUi() {
  syncPracticeSeg();
  renderModeSeg(true);
  syncModeSeg();
}

/**
 * 切换本地存档命名空间，并按需与云端合并。
 *  · 登录：把"未登录期间"的进度并入（每个浏览器只允许并入一个账号），拉云端，
 *          若本机完全没有进度则接着云端记住的章节继续
 *  · 登出：回到未登录存档，内存里的数据不再上行
 * @param {{ userId: number, email: string, nickname: string } | null} user
 * @param {{ switchChapter?: boolean }} [opts] 是否立即重载章节（从"点击登录"进来时为 true）
 */
let lastAppliedAuthRevision = Auth.revision();

async function applyUser(user, opts = {}) {
  const nextKey = user ? `u${user.userId}` : "guest";
  const prevKey = state.userKey;
  const keyChanged = nextKey !== prevKey;
  const nextAuthRevision = Auth.revision();
  const sessionChanged = nextKey !== prevKey || nextAuthRevision !== lastAppliedAuthRevision;
  if (sessionChanged) {
    transitionUserSession(nextKey, nextAuthRevision);
    lastAppliedAuthRevision = nextAuthRevision;
  }
  const runEpoch = userEpoch;
  const runAuthRevision = nextAuthRevision;
  const isCurrent = () => currentUserEpoch(runEpoch, nextKey, runAuthRevision);
  // 同一个账号且已经拉过云端 → 不重复处理（Auth.onAuthChange 会在注册时立即回调一次）
  if (nextKey === prevKey && state.sync.pulledOnce && !sessionChanged) return;
  if (nextKey !== prevKey) starSync.reset();
  let chapterLoaded = false;

  if (user) {
    // 直接从另一个账号切换过来（不经 guest）：先丢弃上一个账号的内存态，
    // 否则 A 的进度会被 merge 进 B 的命名空间并 markAllDirty 上传，造成串号
    if (prevKey !== "guest" && prevKey !== nextKey) {
      state.words = {};
      state.weights = {};
      state.modes = normalizeModeLedger(null);
      state.sync.dirty.clear();
      state.sync.settingsDirty = false;
      state.sync.firstDirtyAt = 0;
      state.questions.clear();
      state.chapterWords = [];
      state.wordById = new Map();
      state.deck = [];
      state.index = 0;
      state.session = { attempts: 0, correct: 0 };
      state.review = null;
    }
    // 注意：要在合并之前判断"本机有没有自己的进度"
    const hadProgress = Object.keys(state.words).length > 0;
    state.userKey = nextKey;
    const scoped = loadLocal(nextKey);
    if (scoped?.words) mergeWordStates(state.words, Object.values(scoped.words));
    state.settings = normalizeSettings(scoped?.settings);
    state.chapter = scoped?.chapter ? Number(scoped.chapter) || 1 : 1;
    if (scoped?.deck) state.deck = Array.isArray(scoped.deck) ? scoped.deck : [];
    if (scoped?.index !== undefined) state.index = Number(scoped.index) || 0;
    if (scoped?.session) state.session = scoped.session;
    if (scoped?.review !== undefined) state.review = scoped.review;
    // 分模式台账只在本机：换命名空间时按词取较大值合并（不重复计数）
    state.weights = normalizeWeights({ ...state.weights, ...(scoped?.weights || {}) });
    state.modes = mergeModeLedgers(state.modes, scoped?.modes);
    if (prevKey === "guest" && canMergeGuest(user.userId)) {
      const guest = loadLocal("guest");
      if (guest?.words) mergeWordStates(state.words, Object.values(guest.words));
      state.weights = normalizeWeights({ ...state.weights, ...(guest?.weights || {}) });
      state.modes = mergeModeLedgers(state.modes, guest?.modes);
      // guest 期间的设置（切章的 resume、每日目标/计数等）一并并入账号——
      // 之前只并学习数据，登录后 resume 丢失会直接回到第 1 章，"接着上次"
      // 的承诺对 guest 登录场景失效。内存 state.settings 最能代表 guest 的
      // 最新意图（切章/改设置未必已落盘），故优先于 guest 存档。
      state.settings = normalizeSettings({
        ...(guest?.settings || {}),
        ...state.settings,
        daily: mergeDailyBackup(guest?.settings?.daily, state.settings.daily),
      });
      if (!state.settings.resume && guest?.chapter) {
        state.settings.resume = { chapter: Number(guest.chapter) };
      }
      starSync.mergeGuestInto(nextKey);
      markGuestMerged(user.userId);
    }
    await syncPull({ full: true });
    if (!isCurrent()) return;
    starSync.markAllDirty();
    await starSync.pull();
    if (!isCurrent()) return;
    await starSync.flush();
    if (!isCurrent()) return;

    // 新设备 / 清过缓存（本机无进度、也没有深链指定章节）→ 接着上次的章节
    const resumeChapter = Number(state.settings.resume?.chapter);
    const targetChapter = state.deepLinkChapter || (Number.isInteger(resumeChapter) && resumeChapter >= 1 && resumeChapter <= CHAPTERS.length ? resumeChapter : state.chapter);
    if (opts.switchChapter && keyChanged) {
      state.chapter = targetChapter;
      await loadChapter(state.chapter, { fresh: true });
      if (!isCurrent()) return;
      chapterLoaded = true;
    }
    if (!hadProgress && !state.deepLinkChapter && targetChapter !== state.chapter) state.chapter = targetChapter;
    const count = markAllDirty();
    if (count) toast(`正在同步本机 ${count} 条学习记录…`);
  } else {
    state.userKey = "guest";
    const guest = loadLocal("guest");
    state.chapter = guest?.chapter ? Number(guest.chapter) || 1 : 1;
    state.words = guest?.words && typeof guest.words === "object" ? guest.words : {};
    state.settings = normalizeSettings(guest?.settings);
    state.modes = normalizeModeLedger(guest?.modes);
    state.weights = normalizeWeights(guest?.weights);
    state.sync.dirty.clear();
    state.sync.settingsDirty = false;
    state.sync.firstDirtyAt = 0;
    window.clearTimeout(state.sync.timer);
    state.questions.clear();
    state.chapterWords = [];
    state.wordById = new Map();
    state.deck = [];
    state.index = 0;
    state.session = { attempts: 0, correct: 0 };
    state.review = null;
  }
  if (opts.switchChapter && !chapterLoaded) {
    await loadChapter(state.chapter, { fresh: true });
    if (!isCurrent()) return;
  }
  if (!isCurrent()) return;
  saveLocal();
  render();
}

async function init() {
  if (init.done) return; // 重入守卫：既被 DOMContentLoaded 调用又被手动 init() 调用时不跑两遍
  init.done = true;
  initTheme();
  cacheDom();
  bindUi();

  // 1) 先恢复本机存档（guest 命名空间），保证离线也能立刻开始
  const local = loadLocal("guest");
  if (local) {
    state.settings = normalizeSettings(local.settings);
    state.words = local.words && typeof local.words === "object" ? local.words : {};
    state.modes = normalizeModeLedger(local.modes);
    state.weights = normalizeWeights(local.weights);
    state.chapter = Number(local.chapter) || 1;
    state.deck = Array.isArray(local.deck) ? local.deck : [];
    state.index = Number(local.index) || 0;
    state.session = local.session || { attempts: 0, correct: 0 };
  }

  const params = new URLSearchParams(location.search);
  const urlChapter = Number(params.get("chapter")) || 0;
  const urlWord = Number(params.get("word")) || 0;
  if (urlChapter) {
    state.chapter = urlChapter;
    state.deepLinkChapter = urlChapter;
  }

  render();

  // 2) 登录态：先拉云端，再渲染（旧版是新设备直接进第一章并覆盖云端）
  const user = await Auth.init();
  await applyUser(user, { switchChapter: false });
  renderSync();

  Auth.onSync(() => renderSync());
  Auth.onAuthChange(async (current) => {
    renderSync();
    const targetKey = current ? `u${current.userId}` : "guest";
    if (targetKey === state.userKey && !current && Auth.revision() === lastAppliedAuthRevision) return;
    await applyUser(current, { switchChapter: true });
  });

  // 3) 加载章节（深链优先；applyUser 可能已按云端记录改过 state.chapter）
  const ok = await loadChapter(state.deepLinkChapter || state.chapter, {
    jumpTo: urlWord || undefined,
    fresh: false,
  });
  if (!ok) return;

  window.addEventListener("focus", () => {
    const run = captureUiSession();
    void syncAccountUi(run);
  });
  window.setInterval(() => {
    const run = captureUiSession();
    void syncAccountUi(run);
  }, 120000);

  // 5) 桌面端直接聚焦，触屏等用户点
  if (window.matchMedia("(pointer: fine)").matches) focusInput();
}

/** 初始化完成标记（防重入，见 init()） */
init.done = false;

if (typeof document !== "undefined") {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => void init());
  else void init();
}

export { init };
