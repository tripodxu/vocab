// @ts-check
/**
 * star-store.js —— 生词本的纯数据规则
 *
 * 生词本需要同时服务本机、跨页面和云端，因此把“形状归一化、按时间戳合并、
 * 删除墓碑”从两个页面中抽出来，避免 app.js / lecture.js 各自维护一套规则。
 *
 * 活动列表形状：{ "<chapter>": [wordId, ...] }
 * 记录形状：{ "<chapter>:<wordId>": { starred: boolean, updatedAt: number } }
 *
 * starred=false 的记录是删除墓碑（tombstone）：它不会出现在活动列表里，
 * 但会参与 LWW 合并，防止另一台设备用旧数据把已取消的生词复活。
 */

const MAX_CHAPTER = 999;
const MAX_WORD = 100_000;

function validChapter(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= MAX_CHAPTER;
}

function validWord(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= MAX_WORD;
}

function validStamp(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

/** @param {unknown} value @param {number} [fallbackChapter] */
export function normalizeActiveStars(value, fallbackChapter = 1) {
  /** @type {Record<string, number[]>} */
  const out = Object.create(null);
  const add = (chapter, word) => {
    if (!validChapter(chapter) || !validWord(word)) return;
    const key = String(chapter);
    const normalizedWord = Number(word);
    const list = (out[key] ||= []);
    if (!list.includes(normalizedWord)) list.push(normalizedWord);
  };

  if (Array.isArray(value)) {
    const chapter = validChapter(fallbackChapter) ? fallbackChapter : 1;
    for (const word of value) add(chapter, word);
  } else if (value && typeof value === "object") {
    for (const [chapter, words] of Object.entries(value)) {
      if (!Array.isArray(words)) continue;
      for (const word of words) add(chapter, word);
    }
  }
  for (const key of Object.keys(out)) out[key].sort((a, b) => a - b);
  return Object.fromEntries(Object.entries(out));
}

/** @param {unknown} value */
export function normalizeStarRecords(value) {
  /** @type {Record<string, { starred: boolean, updatedAt: number }>} */
  const out = Object.create(null);
  const put = (chapter, word, starred, updatedAt) => {
    if (!validChapter(chapter) || !validWord(word) || typeof starred !== "boolean") return;
    const stamp = validStamp(updatedAt);
    if (stamp === null) return;
    const key = `${chapter}:${word}`;
    out[key] = { starred, updatedAt: stamp };
  };

  if (Array.isArray(value)) {
    for (const item of value) {
      if (!item || typeof item !== "object") continue;
      put(item.c, item.w, item.starred, item.updatedAt);
    }
  } else if (value && typeof value === "object") {
    for (const [key, raw] of Object.entries(value)) {
      if (!raw || typeof raw !== "object") continue;
      const parts = key.split(":");
      if (parts.length !== 2 || parts.some((part) => !/^\d+$/.test(part))) continue;
      const [chapter, word] = parts.map(Number);
      put(chapter, word, raw.starred, raw.updatedAt);
    }
  }
  return Object.fromEntries(Object.entries(out));
}

/** @param {Record<string, { starred: boolean, updatedAt: number }>} records */
export function activeFromRecords(records) {
  /** @type {Record<string, number[]>} */
  const out = Object.create(null);
  for (const [key, item] of Object.entries(normalizeStarRecords(records))) {
    if (!item.starred) continue;
    const [chapter, word] = key.split(":").map(Number);
    (out[String(chapter)] ||= []).push(word);
  }
  for (const chapter of Object.keys(out)) out[chapter].sort((a, b) => a - b);
  return Object.fromEntries(Object.entries(out));
}

/** @param {unknown} value */
function incomingItems(value) {
  if (Array.isArray(value)) {
    return value
      .filter((item) => item && typeof item === "object")
      .map((item) => ({ c: item.c, w: item.w, starred: item.starred, updatedAt: item.updatedAt }));
  }
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, raw]) => {
      if (!raw || typeof raw !== "object") return [];
      const parts = key.split(":");
      if (parts.length !== 2 || parts.some((part) => !/^\d+$/.test(part))) return [];
      const [c, w] = parts.map(Number);
      return [{ c, w, starred: raw.starred, updatedAt: raw.updatedAt }];
    });
  }
  return [];
}

/**
 * 按 updatedAt 做逐词 LWW。相同时间戳时删除优先，避免“取消生词”被同刻旧加星覆盖。
 * @param {Record<string, { starred: boolean, updatedAt: number }>} local
 * @param {unknown} incoming
 */
export function mergeStarRecords(local, incoming) {
  const out = normalizeStarRecords(local);
  for (const item of incomingItems(incoming)) {
    if (!validChapter(item.c) || !validWord(item.w) || typeof item.starred !== "boolean") continue;
    const key = `${item.c}:${item.w}`;
    const stamp = validStamp(item.updatedAt);
    if (stamp === null) continue;
    const prev = out[key];
    if (!prev || stamp > prev.updatedAt || (stamp === prev.updatedAt && !item.starred && prev.starred)) {
      out[key] = { starred: item.starred, updatedAt: stamp };
    }
  }
  return Object.fromEntries(Object.entries(out));
}

/**
 * 旧的本地生词列表没有时间戳。给它们当前时间后再上传，才能在首次登录时进入云端；
 * 云端已有删除墓碑时，服务端会按时间戳裁决。
 * @param {Record<string, { starred: boolean, updatedAt: number }>} records
 * @param {number} [now]
 */
export function recordsForPush(records, now = Date.now()) {
  const stamp = validStamp(now) || 1;
  return Object.entries(normalizeStarRecords(records)).map(([key, item]) => {
    const [c, w] = key.split(":").map(Number);
    return { c, w, starred: item.starred, updatedAt: item.updatedAt || stamp };
  });
}

/** 合并两个活动列表（登录时 guest → 账号迁移使用）。 */
export function mergeActiveMaps(left, right) {
  const a = normalizeActiveStars(left);
  const b = normalizeActiveStars(right);
  /** @type {Record<string, number[]>} */
  const out = Object.create(null);
  for (const map of [a, b]) {
    for (const [chapter, words] of Object.entries(map)) {
      const list = (out[chapter] ||= []);
      for (const word of words) if (!list.includes(word)) list.push(word);
      list.sort((x, y) => x - y);
    }
  }
  return Object.fromEntries(Object.entries(out));
}

/** 把活动列表转换为可上传的记录（用于没有旧记录文件的首次登录）。 */
export function recordsFromActive(active, now = 0) {
  const records = Object.create(null);
  const stamp = validStamp(now) || 0;
  for (const [chapter, words] of Object.entries(normalizeActiveStars(active))) {
    for (const word of words) records[`${chapter}:${word}`] = { starred: true, updatedAt: stamp };
  }
  return Object.fromEntries(Object.entries(records));
}

export const recordKey = (chapter, word) => `${Number(chapter)}:${Number(word)}`;

/** 与旧版兼容的活动列表 localStorage key。 */
export const activeStarsKey = (userKey) => `vocab:stars:${userKey}`;
export const starRecordsKey = (userKey) => `vocab:star-records:${userKey}`;

function storageOrDefault(storage) {
  return storage || (typeof localStorage !== "undefined" ? localStorage : null);
}

function readJSON(storage, key) {
  if (!storage) return null;
  try {
    const raw = storage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeJSON(storage, key, value) {
  if (!storage) return false;
  try {
    return storage.setItem(key, JSON.stringify(value)) !== false;
  } catch {
    return false;
  }
}

/**
 * 读取活动列表；guest 兼容最早的 `vocab:stars` 键和旧数组形状。
 * @param {string} userKey
 * @param {Storage|null} [storage]
 * @param {number} [fallbackChapter]
 */
export function loadActiveStars(userKey, storage = null, fallbackChapter = 1) {
  const ls = storageOrDefault(storage);
  if (!ls) return {};
  const key = activeStarsKey(userKey);
  let rawStr = null;
  try {
    rawStr = ls.getItem(key);
  } catch {
    rawStr = null;
  }
  if (rawStr === null && userKey === "guest") {
    try {
      rawStr = ls.getItem("vocab:stars");
    } catch {
      rawStr = null;
    }
  }
  let raw = null;
  if (rawStr !== null) {
    try {
      raw = JSON.parse(rawStr);
    } catch {
      raw = null;
    }
  }
  const active = normalizeActiveStars(raw ?? {}, fallbackChapter);
  // 把旧 guest key / 数组形状归一到当前命名空间，后续两页只读同一形状。
  // 仅在内容真的变化时落盘：读取是每次渲染都会走的高频路径，无条件回写会
  // 让两个标签页经由 storage 事件互相触发重绘，形成热循环。
  if (rawStr !== JSON.stringify(active)) writeJSON(ls, key, active);
  return active;
}

/**
 * 读取记录表；没有记录表时用活动列表生成时间戳 0 的兼容记录。
 * @param {string} userKey
 * @param {Storage|null} [storage]
 * @param {Record<string, number[]>} [active]
 */
export function loadStarRecords(userKey, storage = null, active = null) {
  const ls = storageOrDefault(storage);
  if (!ls) return {};
  const records = normalizeStarRecords(readJSON(ls, starRecordsKey(userKey)));
  const currentActive = normalizeActiveStars(active ?? loadActiveStars(userKey, ls));
  for (const [chapter, words] of Object.entries(currentActive)) {
    for (const word of words) {
      const key = `${chapter}:${word}`;
      if (!records[key]) records[key] = { starred: true, updatedAt: 0 };
    }
  }
  return records;
}

/**
 * 原子性有限但足够：先写记录表再写活动列表；任一失败返回 false。
 * @param {string} userKey
 * @param {Record<string, number[]>} active
 * @param {Record<string, {starred:boolean,updatedAt:number}>} records
 * @param {Storage|null} [storage]
 */
export function saveStarState(userKey, active, records, storage = null) {
  const ls = storageOrDefault(storage);
  if (!ls) return false;
  const normalizedRecords = normalizeStarRecords(records);
  const normalizedActive = activeFromRecords(normalizedRecords);
  const recordsOk = writeJSON(ls, starRecordsKey(userKey), normalizedRecords);
  const activeOk = writeJSON(ls, activeStarsKey(userKey), normalizedActive);
  return recordsOk && activeOk;
}

/**
 * 用新的活动列表替换旧列表，同时为新增/删除的词写 LWW 记录。
 * 用于“清空本章生词本”和撤销操作，确保删除也能上云。
 * @param {string} userKey
 * @param {unknown} nextActive
 * @param {Storage|null} [storage]
 * @param {number} [now]
 */
export function replaceActiveStars(userKey, nextActive, storage = null, now = Date.now()) {
  const ls = storageOrDefault(storage);
  const previous = loadActiveStars(userKey, ls);
  const records = loadStarRecords(userKey, ls, previous);
  const next = normalizeActiveStars(nextActive);
  const keys = new Set(Object.keys(records));
  for (const [chapter, words] of Object.entries(previous)) for (const word of words) keys.add(`${chapter}:${word}`);
  for (const [chapter, words] of Object.entries(next)) for (const word of words) keys.add(`${chapter}:${word}`);
  for (const key of keys) {
    const [chapter, word] = key.split(":").map(Number);
    const wasStarred = records[key]?.starred ?? (previous[String(chapter)] || []).includes(word);
    const isStarred = (next[String(chapter)] || []).includes(word);
    if (wasStarred !== isStarred || !records[key]) {
      const base = Math.max(Number(now) || Date.now(), Number(records[key]?.updatedAt || 0) + 1, 1);
      const stamp = Number.isSafeInteger(base) ? base : Number.MAX_SAFE_INTEGER;
      records[key] = { starred: isStarred, updatedAt: stamp };
    }
  }
  saveStarState(userKey, next, records, ls);
  return { active: next, records };
}

/** 设置一个词的生词状态并记录时间戳。 */
export function setStar(userKey, chapter, word, starred, storage = null, now = Date.now()) {
  const ls = storageOrDefault(storage);
  const active = loadActiveStars(userKey, ls);
  const records = loadStarRecords(userKey, ls, active);
  const key = recordKey(chapter, word);
  const previous = records[key];
  const base = Math.max(Number(now) || Date.now(), (previous?.updatedAt || 0) + 1, 1);
  const stamp = Number.isSafeInteger(base) ? base : Number.MAX_SAFE_INTEGER;
  records[key] = { starred: Boolean(starred), updatedAt: stamp };
  const nextActive = activeFromRecords(records);
  const stored = saveStarState(userKey, nextActive, records, ls);
  return { active: nextActive, records, item: records[key], stored };
}

