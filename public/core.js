// @ts-check
/**
 * core.js —— 刷词器的纯逻辑核心（无 DOM、无网络、无浏览器 API）
 *
 * 所有容易出错的规则都集中在这里，并且可以被 `npm test` 直接单测：
 *   · 单词分词（空格/连字符自动占位，用户只打字母）
 *   · 判对规则（忽略空格与连字符差异，兼容 IME 大小写）
 *   · 掌握判定（连错清零、连续答对 2 次判定掌握）
 *   · 错词自动复现（当日回插 + 次日到期）
 *   · 统计口径（本轮尝试/本轮正确/累计，正确率永远 ≤100%）
 *   · 每日目标（本地日期换天、达成后不清零、连续打卡）
 *   · 多端合并（按词 LWW，seen 大者胜）
 */

/** 词级状态 */
export const STATUS = /** @type {const} */ ({
  learning: "learning", // 学过但还不稳
  wrong: "wrong", // 在错题本里
  mastered: "mastered", // 连续答对 ≥2 次，移出错题本
});

export const MASTER_STREAK = 2;
export const WRONG_DUE_MS = 24 * 60 * 60 * 1000; // 错词次日复现
export const REINSERT_GAP = 5; // 答错的词在本轮往后第 5 个位置再出现
export const REVIEW_BATCH = 10; // 每次进入章节最多插入的到期错词数

/** 分隔符（不参与打字，自动占位） */
const SEPARATOR = /[\s\-–'’.·/]/;

/**
 * 把单词拆成槽位：字母位需要用户输入，分隔符位自动填充并显示为 '·'
 * @param {string} word
 * @returns {{ slots: { ch: string, sep: boolean }[], letters: number, text: string }}
 */
export function analyzeWord(word) {
  const text = String(word ?? "");
  /** @type {{ ch: string, sep: boolean }[]} */
  const slots = [];
  let letters = 0;
  for (const ch of text) {
    const sep = SEPARATOR.test(ch);
    if (!sep) letters++;
    slots.push({ ch, sep });
  }
  return { slots, letters, text };
}

/**
 * 用户当前输入 → 纯字母串（用于判分）
 * @param {{ ch: string, sep: boolean }[]} slots
 * @param {string[]} input 与 slots 等长，分隔符位通常是空
 */
export function typedLetters(slots, input) {
  let out = "";
  for (let i = 0; i < slots.length; i++) {
    if (slots[i].sep) continue;
    out += String(input[i] ?? "").toLowerCase();
  }
  return out;
}

/** 目标词 → 纯字母串 */
export function targetLetters(word) {
  return Array.from(String(word ?? ""))
    .filter((ch) => !SEPARATOR.test(ch))
    .join("")
    .toLowerCase();
}

/**
 * 判分：只比较字母，忽略空格/连字符、大小写差异
 * @param {{ ch: string, sep: boolean }[]} slots
 * @param {string[]} input
 * @param {string} word
 */
export function judgeAnswer(slots, input, word) {
  const typed = typedLetters(slots, input);
  const target = targetLetters(word);
  return typed.length > 0 && typed === target;
}

/**
 * 从旧状态 + 本次结果得到新状态（纯函数）
 * @param {{ s?: string, cs?: number, wc?: number, seen?: number, due?: number } | undefined} prev
 * @param {boolean} correct
 * @param {number} now
 */
export function applyResult(prev, correct, now) {
  const base = {
    s: prev?.s ?? STATUS.learning,
    cs: Number(prev?.cs) || 0,
    wc: Number(prev?.wc) || 0,
    seen: Number(prev?.seen) || 0,
    due: Number(prev?.due) || 0,
  };
  if (!correct) {
    return { s: STATUS.wrong, cs: 0, wc: base.wc + 1, seen: now, due: now + WRONG_DUE_MS };
  }
  const cs = base.cs + 1;
  const s = cs >= MASTER_STREAK ? STATUS.mastered : base.s === STATUS.mastered ? STATUS.mastered : STATUS.learning;
  return { s, cs, wc: base.wc, seen: now, due: 0 };
}

/**
 * 按词 LWW 合并：seen 大者胜；相等时以状态"更靠后"的一方为准
 * @param {{ seen?: number, s?: string } | undefined} local
 * @param {{ seen?: number, s?: string, cs?: number, wc?: number, due?: number }} incoming
 */
export function pickNewer(local, incoming) {
  const ls = Number(local?.seen) || 0;
  const is = Number(incoming?.seen) || 0;
  if (is > ls) return true;
  if (is < ls) return false;
  const rank = { learning: 0, wrong: 1, mastered: 2 };
  const lr = rank[/** @type {keyof typeof rank} */ (local?.s)] ?? 0;
  const ir = rank[/** @type {keyof typeof rank} */ (incoming?.s)] ?? 0;
  return ir > lr;
}

/**
 * 把服务端返回的词状态合并进本地 map
 * @param {Record<string, any>} map 形如 { "3:12": state }
 * @param {Array<{c:number,w:number,s:string,cs:number,wc:number,seen:number,due:number}>} list
 * @returns {number} 实际发生变化的条数
 */
export function mergeWordStates(map, list) {
  let changed = 0;
  for (const item of list ?? []) {
    if (!item || !Number.isFinite(Number(item.c)) || !Number.isFinite(Number(item.w))) continue;
    const key = stateKey(Number(item.c), Number(item.w));
    if (pickNewer(map[key], item)) {
      map[key] = { c: Number(item.c), w: Number(item.w), s: item.s, cs: Number(item.cs) || 0, wc: Number(item.wc) || 0, seen: Number(item.seen) || 0, due: Number(item.due) || 0 };
      changed++;
    }
  }
  return changed;
}

/** @param {number} chapter @param {number} word */
export const stateKey = (chapter, word) => `${chapter}:${word}`;

/** @param {Record<string, any>} map */
export function statesForChapter(map, chapter) {
  /** @type {any[]} */
  const out = [];
  for (const key of Object.keys(map ?? {})) {
    const st = map[key];
    if (Number(st?.c) === Number(chapter)) out.push(st);
  }
  return out;
}

/**
 * 到期需要复现的错词（按到期时间升序）
 * @param {Record<string, any>} map
 * @param {number} chapter
 * @param {number} now
 * @param {number} [limit]
 */
export function dueReviewIds(map, chapter, now, limit = REVIEW_BATCH) {
  return statesForChapter(map, chapter)
    .filter((st) => st.s === STATUS.wrong && (Number(st.due) || 0) <= now)
    .sort((a, b) => (Number(a.due) || 0) - (Number(b.due) || 0))
    .slice(0, limit)
    .map((st) => Number(st.w));
}

/**
 * 把错词回插到本轮牌堆的后面第 gap 个位置（不重复插入）
 * @param {number[]} deck
 * @param {number} index 当前下标
 * @param {number} wordId
 * @param {number} [gap]
 */
export function insertAhead(deck, index, wordId, gap = REINSERT_GAP) {
  const next = deck.slice();
  const from = index + 1;
  const tail = next.slice(from);
  if (tail.includes(wordId)) return next; // 本轮后面还会出现，不重复插
  const at = Math.min(next.length, index + 1 + gap);
  next.splice(at, 0, wordId);
  return next;
}

/**
 * 章节进度：以「已掌握」为主口径
 * @param {Record<string, any>} map
 * @param {number} chapter
 * @param {number} total
 */
export function chapterProgress(map, chapter, total) {
  const states = statesForChapter(map, chapter);
  let mastered = 0;
  let wrong = 0;
  let learning = 0;
  for (const st of states) {
    if (st.s === STATUS.mastered) mastered++;
    else if (st.s === STATUS.wrong) wrong++;
    else learning++;
  }
  const safeTotal = Math.max(0, Number(total) || 0);
  return {
    mastered,
    wrong,
    learning,
    total: safeTotal,
    seen: mastered + wrong + learning,
    percent: safeTotal ? Math.min(100, Math.round((mastered / safeTotal) * 100)) : 0,
  };
}

/**
 * 本轮统计（口径：本轮尝试 / 本轮正确，正确率不会超过 100%）
 * @param {{ attempts: number, correct: number }} session
 */
export function computeStats(session) {
  const attempts = Math.max(0, Number(session?.attempts) || 0);
  const correct = Math.max(0, Math.min(attempts, Number(session?.correct) || 0));
  return {
    attempts,
    correct,
    wrong: attempts - correct,
    accuracy: attempts ? Math.round((correct / attempts) * 100) : 0,
  };
}

/**
 * "本轮"是否已经全部答对（用于弹学习报告）
 * @param {{ attempts: number, correct: number }} session
 * @param {number} deckSize
 */
export function sessionFinished(session, deckSize) {
  const size = Math.max(0, Number(deckSize) || 0);
  if (!size) return false;
  const attempts = Number(session?.attempts) || 0;
  const correct = Number(session?.correct) || 0;
  return attempts >= size && correct >= size;
}

// ============ 每日目标（本地日期） ============

/**
 * 本地日期 key（不要用 toISOString：那是 UTC，国内会在早上 8 点换天）
 * @param {Date} [d]
 */
export function localDateKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** 昨天（本地） */
export function previousDateKey(d = new Date()) {
  const prev = new Date(d.getTime());
  prev.setDate(prev.getDate() - 1);
  return localDateKey(prev);
}

/**
 * 换天处理：新的一天把"今天"的计数清零。
 * 注意：不清 streak —— streak 表示「截至 lastAchieved 的连续达成天数」，
 * 是否还在连续中由 currentStreak() 判断，这样换天不会破坏历史记录。
 * @param {{ date?: string, count?: number, target?: number, achieved?: boolean, streak?: number, best?: number, total?: number, lastAchieved?: string }} daily
 * @param {string} today
 */
export function rollDaily(daily, today) {
  const base = {
    date: daily?.date ?? today,
    count: Number(daily?.count) || 0,
    target: Number(daily?.target) || 50,
    achieved: Boolean(daily?.achieved),
    streak: Number(daily?.streak) || 0,
    best: Number(daily?.best) || 0,
    total: Number(daily?.total) || 0,
    lastAchieved: typeof daily?.lastAchieved === "string" ? daily.lastAchieved : "",
  };
  if (base.date === today) return base;
  return { ...base, date: today, count: 0, achieved: false };
}

/**
 * 当前仍然有效的连续天数（今天或昨天达成过才算"还在连续中"）
 * @param {{ streak?: number, lastAchieved?: string }} daily
 * @param {string} today
 */
export function currentStreak(daily, today) {
  const last = typeof daily?.lastAchieved === "string" ? daily.lastAchieved : "";
  if (last === today || last === previousDateKey(new Date(`${today}T12:00:00`))) {
    return Math.max(0, Number(daily?.streak) || 0);
  }
  return 0;
}

/**
 * 记录一次完成；达成目标时只触发一次奖励，且计数不清零
 * @param {{ date?: string, count?: number, target?: number, achieved?: boolean, streak?: number, best?: number, total?: number, lastAchieved?: string }} daily
 * @param {string} today
 * @param {Date} [nowRef] 仅用于计算"昨天"，测试可注入
 * @returns {{ daily: any, achievedNow: boolean }}
 */
export function recordDaily(daily, today, nowRef = new Date()) {
  const rolled = rollDaily(daily, today);
  const count = rolled.count + 1;
  const target = Math.max(1, Number(rolled.target) || 50);
  const achievedNow = !rolled.achieved && count >= target;

  let streak = rolled.streak;
  let lastAchieved = rolled.lastAchieved;
  if (achievedNow) {
    const yesterday = previousDateKey(nowRef);
    streak = lastAchieved === yesterday ? rolled.streak + 1 : 1;
    lastAchieved = today;
  }
  return {
    daily: {
      ...rolled,
      count,
      target,
      achieved: rolled.achieved || achievedNow,
      streak,
      lastAchieved,
      best: Math.max(Number(rolled.best) || 0, streak),
      total: (Number(rolled.total) || 0) + 1,
    },
    achievedNow,
  };
}

// ============ 杂项 ============

/** Fisher–Yates（可注入 rng 以便测试） */
export function shuffle(list, rng = Math.random) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * 生成本轮牌堆：TODO 学过的优先、错词到期优先，其余随机
 * @param {number[]} allIds 本章全部词 id
 * @param {number[]} dueIds 到期错词
 * @param {number[]} masteredIds 已掌握
 * @param {() => number} [rng]
 */
export function buildDeck(allIds, dueIds, masteredIds, rng = Math.random) {
  const mastered = new Set(masteredIds ?? []);
  const due = new Set(dueIds ?? []);
  const rest = allIds.filter((id) => !due.has(id) && !mastered.has(id));
  const fresh = shuffle(allIds.filter((id) => mastered.has(id)), rng);
  return [...shuffle(Array.from(due), rng), ...shuffle(rest, rng), ...fresh];
}

/** 把毫秒格式化成 "刚刚 / 3 分钟前 / 2 小时前 / 3 天前" */
export function formatRelative(ms, now = Date.now()) {
  const diff = Math.max(0, now - (Number(ms) || 0));
  if (diff < 60_000) return "刚刚";
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)} 小时前`;
  return `${Math.floor(diff / 86400_000)} 天前`;
}

/** 设置项的默认值与归一化（本地与云端共用） */
export function normalizeSettings(input) {
  const src = input && typeof input === "object" ? input : {};
  const mode = ["random", "chinese", "audio"].includes(src.mode) ? src.mode : "random";
  return {
    mode,
    hint: [0, 1, 2, 3].includes(Number(src.hint)) ? Number(src.hint) : 0,
    timerEnabled: Boolean(src.timerEnabled),
    timerSeconds: Math.min(60, Math.max(3, Number(src.timerSeconds) || 10)),
    sfx: src.sfx === undefined ? true : Boolean(src.sfx),
    speech: src.speech === undefined ? true : Boolean(src.speech),
    rate: Math.min(1.3, Math.max(0.6, Number(src.rate) || 0.9)),
    daily: {
      target: Math.max(1, Math.min(999, Number(src?.daily?.target) || 50)),
      count: Math.max(0, Number(src?.daily?.count) || 0),
      date: typeof src?.daily?.date === "string" ? src.daily.date : "",
      achieved: Boolean(src?.daily?.achieved),
      streak: Math.max(0, Number(src?.daily?.streak) || 0),
      best: Math.max(0, Number(src?.daily?.best) || 0),
      total: Math.max(0, Number(src?.daily?.total) || 0),
      lastAchieved: typeof src?.daily?.lastAchieved === "string" ? src.daily.lastAchieved : "",
    },
    resume: src.resume && typeof src.resume === "object" ? src.resume : null,
  };
}

/**
 * 云端设置接口有 8KB 上限。超过时先丢掉"本轮牌堆顺序"（只保留章节与位置），
 * 再不行就丢掉 resume —— 绝不能因为设置太大导致整次同步失败。
 * @param {any} settings
 * @param {number} [maxBytes]
 */
export function cloudSettingsPayload(settings, maxBytes = 7200) {
  const base = {
    mode: settings?.mode,
    hint: settings?.hint,
    timerEnabled: settings?.timerEnabled,
    timerSeconds: settings?.timerSeconds,
    sfx: settings?.sfx,
    speech: settings?.speech,
    rate: settings?.rate,
    daily: settings?.daily,
    resume: settings?.resume,
  };
  if (JSON.stringify(base).length <= maxBytes) return base;
  if (base.resume) {
    const trimmed = { ...base, resume: { ...base.resume, deck: [] } };
    if (JSON.stringify(trimmed).length <= maxBytes) return trimmed;
    const noResume = { ...trimmed, resume: null };
    if (JSON.stringify(noResume).length <= maxBytes) return noResume;
  }
  // 最后一档兜底：只保留小字段，保证同步不会因为设置过大而整包失败
  const minimal = {
    mode: base.mode,
    hint: base.hint,
    timerEnabled: base.timerEnabled,
    timerSeconds: base.timerSeconds,
    sfx: base.sfx,
    speech: base.speech,
    rate: base.rate,
    daily: null,
    resume: null,
  };
  return JSON.stringify(minimal).length <= maxBytes ? minimal : { mode: base.mode, hint: base.hint };
}

/**
 * 未登录期间的进度只允许并入一个账号：记录过其它账号就不再并入，避免共用电脑时串号。
 * @param {string|null} mergedValue localStorage 里记录的 userId
 * @param {number} userId
 */
export function canMergeGuestInto(mergedValue, userId) {
  if (!mergedValue) return true;
  return Number(mergedValue) === Number(userId);
}
