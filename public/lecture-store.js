// @ts-check
/**
 * lecture-store.js —— 讲义页的本地数据层（键名 / 读写 / 游客内容合并）
 *
 * 从 lecture.js 拆出来的理由：这一层只做"键怎么拼、值怎么存、游客内容怎么并进账号"，
 * 与渲染、弹层、画笔交互完全无关；放一起时 lecture.js 前 300 行几乎全是键名算术，
 * 真正的行为逻辑被埋在后面。
 *
 * 两条不能改的规则（历史上都出过事故）：
 *  1. **键名必须带 userKey 后缀**（`lecture-note-u12-3-45`），否则换账号会互相看到对方的备注/配图；
 *     游客档没有后缀（`lecture-note-3-45`）是历史格式，靠 `parseGuestLectureKey` 反解后合并。
 *  2. `persistLectureValue` 写 IDB 成功才删 localStorage 副本；IDB 写失败要**回落到 localStorage**，
 *     绝不能让"升级到 IDB"变成"内容没了"。
 */
import { idbGet, idbKeys, idbPut } from "./idb.js";
import { canMergeGuestInto } from "./core.js";

/** 讲义内容的单次存储上限（dataURL 字符数）；超过就放弃保存并提示，避免 IDB 被单条撑爆 */
export const DRAW_KEY_LIMIT = 1_200_000;
/** 记录"游客讲义内容"已经并入过哪个账号（与 app 的进度/生词标记相互独立） */
const LECTURE_GUEST_MERGE_KEY = "vocab:lecture-guest-merged-into";

export const localUserSuffix = (userKey) => (userKey === "guest" ? "" : `-${userKey}`);
export const noteKey = (chapter, word, userKey) => `lecture-note${localUserSuffix(userKey)}-${chapter}-${word}`;
export const stampKey = (chapter, userKey) => `lecture-note-stamps${localUserSuffix(userKey)}-${chapter}`;
export const imgKey = (chapter, word, userKey) => `lecture-img${localUserSuffix(userKey)}-${chapter}-${word}`;
export const drawKey = (chapter, word, userKey) => `lecture-draw${localUserSuffix(userKey)}-${chapter}-${word}`;
export const brushKey = (chapter, userKey) => `lecture-brush${localUserSuffix(userKey)}-${chapter}`;

export function safeSet(key, value) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function safeGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** IDB 写失败时保留 legacy localStorage 副本，避免升级/配额故障丢讲义内容。 */
export async function persistLectureValue(key, value) {
  if (await idbPut(key, value)) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* 清理失败不影响已经成功的 IDB 写入 */
    }
    return true;
  }
  return safeSet(key, value);
}

/** @returns {string[]} */
export function localStorageKeys() {
  try {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key) keys.push(key);
    }
    return keys;
  } catch {
    return [];
  }
}

/** @returns {Record<string, number>} */
export function parseStampMap(raw) {
  try {
    const parsed = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** @param {string} key @returns {{ kind: string, chapter: string, word: string }|null} */
export function parseGuestLectureKey(key) {
  const stamp = /^lecture-note-stamps-(\d+)$/.exec(key);
  if (stamp) return { kind: "note-stamps", chapter: stamp[1], word: "" };
  const item = /^lecture-(note|img|draw)-(\d+)-(.+)$/.exec(key);
  if (item) return { kind: item[1], chapter: item[2], word: item[3] };
  const page = /^lecture-brush-(\d+)$/.exec(key);
  return page ? { kind: "brush", chapter: page[1], word: "" } : null;
}

/**
 * Merge guest lecture content once into the first account that opens the
 * lecture page.  This marker is intentionally separate from the app's
 * progress/star marker: the two phases have different data and completion
 * semantics.  Existing account values win unless a guest note has a strictly
 * newer timestamp; images/drawings/brushes are copied only when the account
 * has no value.  IDB and legacy localStorage are both considered sources.
 *
 * @param {string} userKey
 * @param {number} userId
 * @returns {Promise<boolean>} true when the phase marker was written
 */
export async function migrateGuestLectureContent(userKey, userId) {
  if (!canMergeGuestInto(safeGet(LECTURE_GUEST_MERGE_KEY), userId)) return true;
  const prefixes = ["lecture-note-stamps-", "lecture-note-", "lecture-img-", "lecture-draw-", "lecture-brush-"];
  const candidates = new Set(localStorageKeys());
  for (const prefix of prefixes) {
    for (const key of await idbKeys(prefix)) candidates.add(key);
  }

  const entries = [...candidates]
    .map((key) => ({ key, parsed: parseGuestLectureKey(key) }))
    .filter((entry) => entry.parsed);
  const stamps = new Map();
  let allStored = true;

  // Read/merge chapter stamp maps first so note conflict resolution does not
  // depend on localStorage enumeration order.
  for (const entry of entries.filter(({ parsed }) => parsed.kind === "note-stamps")) {
    const guestKey = entry.key;
    const targetKey = stampKey(Number(entry.parsed.chapter), userKey);
    const guestMap = parseStampMap(safeGet(guestKey) ?? (await idbGet(guestKey)));
    const targetMap = parseStampMap(safeGet(targetKey) ?? (await idbGet(targetKey)));
    const merged = { ...targetMap };
    for (const [wordId, stamp] of Object.entries(guestMap)) {
      const next = Number(stamp) || 0;
      if (next > (Number(merged[wordId]) || 0)) merged[wordId] = next;
    }
    const serialized = JSON.stringify(merged);
    if (!(await persistLectureValue(targetKey, serialized))) allStored = false;
    stamps.set(Number(entry.parsed.chapter), { guest: guestMap, target: targetMap });
  }

  for (const entry of entries.filter(({ parsed }) => parsed.kind !== "note-stamps")) {
    const { key: guestKey, parsed } = entry;
    const targetKey =
      parsed.kind === "brush"
        ? brushKey(Number(parsed.chapter), userKey)
        : `${parsed.kind === "note" ? "lecture-note" : `lecture-${parsed.kind}`}-${userKey}-${parsed.chapter}-${parsed.word}`;
    const guestValue = safeGet(guestKey) ?? (await idbGet(guestKey));
    if (guestValue == null) continue;
    const targetValue = await idbGet(targetKey);
    let shouldCopy = targetValue == null;
    if (parsed.kind === "note" && targetValue != null) {
      const chapterStamps = stamps.get(Number(parsed.chapter));
      const guestStamp = Number(chapterStamps?.guest[parsed.word]) || 0;
      const targetStamp = Number(chapterStamps?.target[parsed.word]) || 0;
      shouldCopy = guestStamp > targetStamp;
    }
    if (shouldCopy && !(await persistLectureValue(targetKey, guestValue))) allStored = false;
  }

  if (allStored) allStored = safeSet(LECTURE_GUEST_MERGE_KEY, String(userId));
  return allStored;
}
