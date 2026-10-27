// @ts-check
/**
 * storage.js —— 本机存档读写（刷词页）
 *
 * 从 app.js 拆出来的理由：存档是"纯数据进出"的一层，与渲染/同步逻辑没有耦合，
 * 单独放就能一眼看清"哪些字段会上本机、换账号时读哪个命名空间"。
 *
 * 两条铁律（改动前务必读）：
 *  1. **只读自己的命名空间**：`loadLocal` 对登录档不回退到 `guest`，否则换账号会把别人的进度并进来；
 *     只有未登录档才允许读一次旧版 key `vocab-tool-state` 做迁移。
 *  2. 写不进去时**先丢车保帅**：配额爆了就只保留 settings/words/modes/chapter，
 *     而不是整份存档失败（学习状态比复习顺序重要）。
 *  3. **同一任务内只序列化一次**：saveLocal 排队到微任务写"最终状态"；需要当场落盘时用
 *     flushLocalSave()（换账号 / 关页 / 切后台），理由见 saveLocal 的注释。
 */
import { canMergeGuestInto } from "./core.js";
import { toast } from "./ui.js";
import { LS_PREFIX, state } from "./state.js";

/** 记录"未登录期间的进度"已经并入过哪个账号，避免换账号时串号 */
const GUEST_MERGED_KEY = "vocab:guest-merged-into";

export const storageKey = () => LS_PREFIX + state.userKey;

export function storageGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function storageSet(key, value) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function storageRemove(key) {
  try {
    localStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

/** 已排队但还没落盘的一次存档写（同一任务内的重复 saveLocal 靠它合并） */
let savePending = false;

/** saveLocal 的实际执行体：同步把当前内存态写进 localStorage */
function writeLocalNow() {
  savePending = false;
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
 * 把内存态写进本机存档。
 *
 * **同一任务内多次调用只会真正写一次**：写的是微任务里的最终状态——既不丢字段，
 * 也仍在同一帧内完成（微任务一定早于渲染、早于下一个事件、早于关页）。
 * 合并的理由是实测出来的：重度用户（2600 词 ≈ 376KB）一次 JSON.stringify 约 4ms，
 * 而每次「下一题」原本写两遍（advance/skip 一次 + renderWord 末尾一次），白花一半。
 *
 * 需要**当场**落盘时（关页 / 切后台 / 换账号 / 读回校验）改用 {@link flushLocalSave}。
 */
export function saveLocal() {
  if (savePending) return;
  savePending = true;
  queueMicrotask(() => {
    if (savePending) writeLocalNow();
  });
}

/**
 * 立刻落盘（等价于改造前 saveLocal 的同步语义）。
 * 换账号前必须调用：storageKey() 取决于 state.userKey，排队中的写入会落到新命名空间。
 */
export function flushLocalSave() {
  if (savePending) writeLocalNow();
}

/**
 * 读取本机存档。
 * 注意：**只读自己的命名空间**（用户的存档不会回退到 guest，否则换账号会把别人的数据并进来）；
 * 只有未登录档才允许回退到旧版 key 做一次迁移。
 * @param {string} key
 */
export function loadLocal(key) {
  const candidates = key === "guest" ? [LS_PREFIX + "guest", "vocab-tool-state"] : [LS_PREFIX + key];
  for (const candidate of candidates) {
    const raw = storageGet(candidate);
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") continue;
      return parsed;
    } catch {
      /* 损坏的存档直接跳过，不要让它带崩启动流程 */
    }
  }
  return null;
}

export const canMergeGuest = (userId) => canMergeGuestInto(storageGet(GUEST_MERGED_KEY), userId);

export const markGuestMerged = (userId) => {
  storageSet(GUEST_MERGED_KEY, String(userId));
};
