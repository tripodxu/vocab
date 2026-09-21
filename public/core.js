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
 *   · 两种答法（拼写 / 认词）的分模式计数与掌握判定
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
/**
 * 一次作答对词状态的影响。
 * @param {{ s?: string, cs?: number, wc?: number, seen?: number, due?: number }} prev
 * @param {boolean} correct
 * @param {number} now
 * @param {{ streakStep?: number }} [opts] streakStep：答对时连续 streak 的步长。
 *   拼写=1（连对 2 次掌握）；认词=2（快速识别答对一次即掌握——一轮内每词基本只见一次，
 *   凑不满\"连续两次\"，这正是\"认词正确率 77% 但已掌握 0\"的历史症结）。
 */
export function applyResult(prev, correct, now, opts = {}) {
  const step = Math.max(1, Number(opts.streakStep) || 1);
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
  const cs = base.cs + step;
  const s = cs >= MASTER_STREAK ? STATUS.mastered : base.s === STATUS.mastered ? STATUS.mastered : STATUS.learning;
  return { s, cs, wc: base.wc, seen: now, due: 0 };
}

/* ============ 易错词权重（第五期） ============ */

export const WEIGHT_MIN = 0.1;
export const WEIGHT_MAX = 3.0;
export const WEIGHT_INIT = 1.0;

/**
 * 易错权重表归一化：形如 { \"3:12\": { w, ok, bad, at } }。
 * @param {any} input
 */
export function normalizeWeights(input) {
  const out = {};
  for (const [key, raw] of Object.entries(input && typeof input === "object" ? input : {})) {
    const w = Number(raw?.w);
    if (!Number.isFinite(w) || w <= 0) continue;
    out[key] = {
      w: Math.min(WEIGHT_MAX, Math.max(WEIGHT_MIN, w)),
      ok: Math.max(0, Number(raw?.ok) || 0),
      bad: Math.max(0, Number(raw?.bad) || 0),
      at: Number(raw?.at) || 0,
    };
  }
  return out;
}

/**
 * 一次作答对易错权重的影响：答错升（首错即入池），答对降但**永不为 0**——
 * 易错词只有用户手动删除才会离开（系统无权移除）。
 * @param {{ w?: number, ok?: number, bad?: number, at?: number } | undefined} prev
 * @param {boolean} correct
 * @param {number} now
 */
export function applyWeightResult(prev, correct, now) {
  const w0 = Number(prev?.w) || 0;
  const weight = correct
    ? Math.max(WEIGHT_MIN, w0 > 0 ? w0 * 0.7 : WEIGHT_MIN)
    : Math.min(WEIGHT_MAX, w0 > 0 ? w0 * 1.5 + 0.5 : WEIGHT_INIT);
  return {
    w: Math.round(weight * 100) / 100,
    ok: (Number(prev?.ok) || 0) + (correct ? 1 : 0),
    bad: (Number(prev?.bad) || 0) + (correct ? 0 : 1),
    at: now,
  };
}

/** 该词在本轮牌堆中应额外复现的次数（1~3，由权重决定；无权重记录 = 0） */
export function weightInsertCount(entry) {
  const w = Number(entry?.w) || 0;
  if (w <= 0) return 0;
  return Math.max(1, Math.min(3, Math.round(w)));
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

/** 调色盘：tokens.css 的 [data-accent="…"] 块与这里的名字一一对应（"custom" 走内联变量） */
export const ACCENTS = ["sky", "violet", "emerald", "rose", "amber", "slate", "custom"];
/** 预设盘的代表色（色卡/动态 favicon 用；与 tokens.css 的 --accent 浅色值同步） */
export const ACCENT_HEX = {
  sky: "#0ea5e9",
  violet: "#8b5cf6",
  emerald: "#10b981",
  rose: "#e11d48",
  amber: "#d97706",
  slate: "#64748b",
};

/** #rrggbb → {r,g,b} */
function hexToRgb(hex) {
  const h = String(hex || "").replace("#", "");
  return { r: parseInt(h.slice(0, 2), 16) || 0, g: parseInt(h.slice(2, 4), 16) || 0, b: parseInt(h.slice(4, 6), 16) || 0 };
}
/** 颜色向白/黑混合（t: 0 原色 → 1 全白/全黑） */
function mix(hex, target, t) {
  const c = hexToRgb(hex);
  const m = (v, w) => Math.round(v + (w - v) * t);
  const to2 = (n) => n.toString(16).padStart(2, "0");
  const r = m(c.r, target[0]), g = m(c.g, target[1]), b = m(c.b, target[2]);
  return `#${to2(r)}${to2(g)}${to2(b)}`;
}
/** 相对亮度 → 自定义色的墨色自动取黑或白（对比度优先） */
export function accentInkFor(hex) {
  const { r, g, b } = hexToRgb(hex);
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return lum > 0.62 ? "#062033" : "#ffffff";
}
/**
 * 自定义主题色派生全套 accent 变量（内联到 <html> 上，优先级高于 tokens.css）。
 * @param {string} hex #rrggbb
 * @returns {Record<string, string>}
 */
export function deriveAccentVars(hex) {
  const h = /^#[0-9a-fA-F]{6}$/.test(String(hex || "")) ? String(hex).toLowerCase() : "#0ea5e9";
  const { r, g, b } = hexToRgb(h);
  const light = mix(h, [255, 255, 255], 0.35);
  const dark = mix(h, [0, 0, 0], 0.3);
  return {
    "--accent": h,
    "--accent-strong": mix(h, [0, 0, 0], 0.18),
    "--accent-ink": accentInkFor(h),
    "--accent-soft": `rgba(${r}, ${g}, ${b}, 0.16)`,
    "--accent-faint": `rgba(${r}, ${g}, ${b}, 0.07)`,
    "--accent-grad": `linear-gradient(135deg, ${light} 0%, ${h} 55%, ${dark} 100%)`,
    "--glow": `0 6px 20px rgba(${r}, ${g}, ${b}, 0.35)`,
    "--bg-glow-1": `rgba(${r}, ${g}, ${b}, 0.20)`,
  };
}
/**
 * 把调色盘应用到 <html>：预设盘设 data-accent，自定义盘写内联变量。
 * 纯 DOM 参数化设计，单测可传假 root。
 * @param {string} name settings.accent
 * @param {string} [customHex] settings.accentCustom（name === "custom" 时必填）
 * @param {{dataset: any, style: any}} [root] 默认 document.documentElement
 */
export function applyAccent(name, customHex = "", root = typeof document !== "undefined" ? document.documentElement : null) {
  if (!root) return;
  const isCustom = name === "custom";
  if (!isCustom) {
    for (const key of Object.keys(deriveAccentVars("#0ea5e9"))) root.style.removeProperty(key);
  }
  root.dataset.accent = isCustom ? "custom" : ACCENTS.includes(name) ? name : "sky";
  if (isCustom) {
    const vars = deriveAccentVars(customHex);
    for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
  }
}

/** 设置项的默认值与归一化（本地与云端共用） */
export function normalizeSettings(input) {
  const src = input && typeof input === "object" ? input : {};
  const mode = ["random", "chinese", "audio"].includes(src.mode) ? src.mode : "random";
  return {
    mode,
    /** 练习方式：spell = 看中文/听音拼写；choice = 看英文选中文（认词） */
    answer: src.answer === "choice" ? "choice" : "spell",
    /** 认词模式的题干：en = 显示英文单词；audio = 只放音；random = 两者随机 */
    quizPrompt: ["en", "zh", "audio", "random"].includes(src.quizPrompt) ? src.quizPrompt : "en",
    /** 主题色（调色盘）：见 ACCENTS；"custom" 时用 accentCustom 的自选色 */
    accent: ACCENTS.includes(src.accent) ? src.accent : "sky",
    accentCustom: /^#[0-9a-fA-F]{6}$/.test(String(src.accentCustom || "")) ? String(src.accentCustom).toLowerCase() : "",
    /** 认词模式答对后自动进入下一题（答错时会停下来让你看辨析） */
    autoNext: src.autoNext === undefined ? false : Boolean(src.autoNext),
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
    answer: settings?.answer,
    quizPrompt: settings?.quizPrompt,
    accent: settings?.accent,
    accentCustom: settings?.accentCustom,
    autoNext: settings?.autoNext,
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
    answer: base.answer,
    quizPrompt: base.quizPrompt,
    autoNext: base.autoNext,
    hint: base.hint,
    timerEnabled: base.timerEnabled,
    timerSeconds: base.timerSeconds,
    sfx: base.sfx,
    speech: base.speech,
    rate: base.rate,
    daily: null,
    resume: null,
  };
  return JSON.stringify(minimal).length <= maxBytes ? minimal : { mode: base.mode, answer: base.answer, hint: base.hint };
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

// ============ 两种答法：拼写（spell） / 认词（choice） ============

/**
 * 同一份词状态支持两种答法：
 *   · spell  看中文/听音**拼写** —— 要求会写
 *   · choice 看英文**选中文**（认词）—— 只要求认识
 *
 * 掌握状态（s/cs/wc/seen/due）仍然是**全局唯一**的，因为同步协议按词 LWW，
 * 多一个维度会让服务端、合并、错题本全都复杂一倍。
 * 分模式的细节放在**本机台账** `modes`（不上云）里，用于：
 *   · 报告里区分"认识 / 会拼"；
 *   · 避免"只做过选择题"的词在拼写模式里被当成已掌握而不再出现。
 */
export const PRACTICE = /** @type {const} */ ({ spell: "spell", choice: "choice" });

/** @param {unknown} practice */
export const normalizePractice = (practice) => (practice === PRACTICE.choice ? PRACTICE.choice : PRACTICE.spell);

/** 归一化台账里的一项 */
function normalizeModeEntry(value) {
  const entry = value && typeof value === "object" ? value : {};
  return {
    spell: { c: Math.max(0, Number(entry?.spell?.c) || 0), w: Math.max(0, Number(entry?.spell?.w) || 0) },
    choice: { c: Math.max(0, Number(entry?.choice?.c) || 0), w: Math.max(0, Number(entry?.choice?.w) || 0) },
  };
}

/**
 * 归一化分模式台账：`{ "3:12": { spell:{c,w}, choice:{c,w} } }`
 * @param {unknown} input
 */
export function normalizeModeLedger(input) {
  /** @type {Record<string, { spell: { c: number, w: number }, choice: { c: number, w: number } }>} */
  const out = {};
  if (!input || typeof input !== "object") return out;
  for (const [key, value] of Object.entries(/** @type {Record<string, any>} */ (input))) {
    out[key] = normalizeModeEntry(value);
  }
  return out;
}

/**
 * 合并两份台账（本机跨命名空间合并用）。同一项按"取较大值"合并：
 * 台账只是本机成绩，重复计数比少算更糟，所以不做累加。
 * @param {any} a @param {any} b
 */
export function mergeModeLedgers(a, b) {
  const left = normalizeModeLedger(a);
  const right = normalizeModeLedger(b);
  /** @type {Record<string, any>} */
  const out = { ...left };
  for (const [key, entry] of Object.entries(right)) {
    const prev = out[key];
    if (!prev) {
      out[key] = entry;
      continue;
    }
    out[key] = {
      spell: { c: Math.max(prev.spell.c, entry.spell.c), w: Math.max(prev.spell.w, entry.spell.w) },
      choice: { c: Math.max(prev.choice.c, entry.choice.c), w: Math.max(prev.choice.w, entry.choice.w) },
    };
  }
  return out;
}

/**
 * 记一次作答（纯函数，返回新台账）
 * @param {any} ledger
 * @param {"spell"|"choice"} practice
 * @param {boolean} correct
 */
export function recordModeResult(ledger, practice, correct) {
  const next = normalizeModeEntry(ledger);
  const bucket = normalizePractice(practice) === PRACTICE.choice ? next.choice : next.spell;
  if (correct) bucket.c += 1;
  else bucket.w += 1;
  return next;
}

/**
 * 某个词在某种答法下的成绩
 * @param {any} entry 台账里的一项
 * @param {"spell"|"choice"} practice
 */
export function modeStats(entry, practice) {
  const key = normalizePractice(practice) === PRACTICE.choice ? "choice" : "spell";
  const bucket = entry && typeof entry === "object" ? entry[key] : null;
  const c = Math.max(0, Number(bucket?.c) || 0);
  const w = Math.max(0, Number(bucket?.w) || 0);
  const total = c + w;
  return { c, w, total, accuracy: total ? Math.round((c / total) * 100) : 0 };
}

/**
 * 这个词在当前答法下算不算"已经掌握"。
 *  · 认词：全局掌握即可（会拼当然也会认）
 *  · 拼写：全局掌握 **且** 这个字确实被拼对过 ——
 *    否则只做过选择题就把词标成"会拼"，拼写模式再也不会出现它。
 * @param {{ s?: string }|undefined} wordState
 * @param {any} ledgerEntry
 * @param {"spell"|"choice"} practice
 */
export function masteredForPractice(wordState, ledgerEntry, practice) {
  if (wordState?.s !== STATUS.mastered) return false;
  if (normalizePractice(practice) === PRACTICE.choice) return true;
  return modeStats(ledgerEntry, PRACTICE.spell).c > 0;
}

/**
 * 本章在两种答法下的整体成绩（报告用）
 * @param {Record<string, any>} ledger
 * @param {number} chapter
 */
export function chapterPracticeStats(ledger, chapter) {
  const out = { spell: { c: 0, w: 0, total: 0, accuracy: 0 }, choice: { c: 0, w: 0, total: 0, accuracy: 0 } };
  for (const [key, entry] of Object.entries(normalizeModeLedger(ledger))) {
    const [c] = key.split(":").map(Number);
    if (Number(c) !== Number(chapter)) continue;
    for (const practice of ["spell", "choice"]) {
      const stat = modeStats(entry, /** @type {any} */ (practice));
      out[practice].c += stat.c;
      out[practice].w += stat.w;
    }
  }
  for (const practice of ["spell", "choice"]) {
    const bucket = out[practice];
    bucket.total = bucket.c + bucket.w;
    bucket.accuracy = bucket.total ? Math.round((bucket.c / bucket.total) * 100) : 0;
  }
  return out;
}
