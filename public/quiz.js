// @ts-check
/**
 * quiz.js —— 认词模式（看英文选中文）的题目构建（纯逻辑：无 DOM、无网络、无存储）
 *
 * 为什么单独一个模块：
 *  · 认词和拼写是"两种答法"，共用同一套词状态与同步协议，但出题规则完全不同；
 *  · 出题规则（干扰项挑选、辨析文案、反作弊）是最容易出错、也最需要单测的部分，
 *    所以全部放在这里，app.js 只负责渲染与交互。
 *
 * 三条硬规则：
 *  1) **题源优先**：`public/quiz-N.json`（模型/人工精编）里的干扰项与辨析优先使用；
 *     没有题源时用同章词自动生成，功能永远可用（内容可以慢慢补）。
 *  2) **干扰项必须有辨析价值**：同词根 / 形近 / 词性不同 / 近义 / 同主题，
 *     并且每条都带一句 why —— 答错时能看懂"错在哪"，这才叫练习题而不是抽奖。
 *  3) **反作弊**：选项按题号做种子打乱（同一题的位置稳定，重渲染不跳位）、
 *     不允许出现两个都说得通的选项、不允许正确答案永远最长或永远在 A。
 *
 * 全部是纯函数，rng 可注入 → 见 test/quiz.test.js
 */

/** 干扰项类型（务必与 docs/选择题资料生成规范.md 保持一致） */
export const QUIZ_KIND = /** @type {const} */ (["root", "form", "pos", "sense", "topic", "antonym"]);

export const QUIZ_KIND_LABEL = /** @type {Record<string, string>} */ ({
  root: "同词根",
  form: "形近/音近",
  pos: "词性不同",
  sense: "近义",
  topic: "同主题",
  antonym: "反义",
});

export const DEFAULT_OPTION_COUNT = 4;

/** 词根 token 最短长度（过滤 root 字段里的噪音，例如 "d（行为）" 这种被非 ASCII 截断的碎片） */
const ROOT_TOKEN_MIN = 3;
/** 词干重合判定阈值：前缀 ≥3 或后缀 ≥4 才算"形近" */
const PREFIX_MIN = 3;
const SUFFIX_MIN = 4;
/** 每道题里低价值干扰项的数量上限 */
const TOPIC_CAP = 2;
const POS_CAP = 1;

/* ============ 文本工具 ============ */

/**
 * 归一化释义：去掉空白与所有标点，用于"是不是同一个意思"的判断。
 * @param {unknown} text
 */
export function normalizeMeaning(text) {
  return String(text ?? "")
    .replace(/[\s\u3000]+/g, "")
    .replace(/[，,；;、。.．·・:：!！?？"'“”‘’()（）[\]【】<>《》/\\|-]/g, "")
    .toLowerCase();
}

/** 释义长度（字符数，用于避免"最长的那个就是答案"这种破绽） */
export const meaningLength = (text) => normalizeMeaning(text).length;

/**
 * 两个释义是否"互相包含"——只要一方包含另一方，两个选项就都说得通，必须排除。
 * 例：正确答案"大气层，大气圈；气氛" vs 干扰项"气氛" → 排除。
 * @param {unknown} a @param {unknown} b
 */
export function meaningsConflict(a, b) {
  const na = normalizeMeaning(a);
  const nb = normalizeMeaning(b);
  if (!na || !nb) return true; // 空释义直接视为冲突（不可用）
  if (na === nb) return true;
  return na.includes(nb) || nb.includes(na);
}

/** 最长公共前缀长度（大小写不敏感） */
export function commonPrefix(a, b) {
  const x = String(a ?? "").toLowerCase();
  const y = String(b ?? "").toLowerCase();
  const max = Math.min(x.length, y.length);
  let i = 0;
  while (i < max && x[i] === y[i]) i++;
  return i;
}

/** 最长公共后缀长度（大小写不敏感） */
export function commonSuffix(a, b) {
  const x = String(a ?? "").toLowerCase();
  const y = String(b ?? "").toLowerCase();
  const max = Math.min(x.length, y.length);
  let i = 0;
  while (i < max && x[x.length - 1 - i] === y[y.length - 1 - i]) i++;
  return i;
}

/**
 * 等长且只差一个字母（adapt / adopt、affect / effect）——
 * 这是中国考生最常看错的一类，比"前缀相同"更值得出题。
 * @param {unknown} a @param {unknown} b
 */
export function isNearMiss(a, b) {
  const x = String(a ?? "").toLowerCase();
  const y = String(b ?? "").toLowerCase();
  if (x.length !== y.length || x.length < 4) return false;
  let diff = 0;
  let at = -1;
  for (let i = 0; i < x.length; i++) {
    if (x[i] !== y[i]) {
      diff++;
      at = i;
      if (diff > 1) return false;
    }
  }
  return diff === 1 && at >= 0;
}

/**
 * 从词条的 root 字段里抽出拉丁词根 token。
 * 例："atmo（水汽）+ sphere（球体，球形）→ 大气圈" → {atmo, sphere}
 * @param {{ root?: string } | null | undefined} entry
 */
export function rootTokens(entry) {
  const out = new Set();
  const text = String(entry?.root || "");
  for (const m of text.matchAll(/([A-Za-z][A-Za-z-]*)\s*[（(]/g)) {
    const token = m[1].toLowerCase();
    if (token.length >= ROOT_TOKEN_MIN) out.add(token);
  }
  return out;
}

/** 两个词条共享的词根 token */
export function sharedRoots(a, b) {
  const ta = rootTokens(a);
  if (!ta.size) return [];
  const tb = rootTokens(b);
  const out = [];
  for (const token of ta) if (tb.has(token)) out.push(token);
  return out;
}

/* ============ 随机数（同一题的位置永远一样） ============ */

/** FNV-1a：把题目 key 变成种子 */
export function hashSeed(text) {
  let h = 2166136261 >>> 0;
  const s = String(text ?? "");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/**
 * mulberry32：小巧的可复现随机数。传入题号做种子 → 同题每次出题顺序完全一致
 * @param {string|number} seed
 */
export function seededRng(seed) {
  let a = (typeof seed === "number" ? seed : hashSeed(seed)) >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** @param {number} index */
export function optionLabel(index) {
  return String.fromCharCode(65 + Math.min(25, Math.max(0, Number(index) || 0)));
}

/**
 * 用 rng 洗牌（不改原数组）；同样的 rng 序列 → 同样的结果
 * @template T @param {T[]} list @param {() => number} rng
 */
export function shuffleWith(list, rng) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/* ============ 干扰项挑选 ============ */

/**
 * 判断某个词能不能当参照词的干扰项（硬性排除项）
 * @param {any} base 参照词（出题的那个词）
 * @param {any} other 候选
 * @param {string[]} [taken] 已经被占用的释义（含精编干扰项）
 */
export function isUsableDistractor(base, other, taken = []) {
  if (!base || !other) return false;
  if (Number(other.id) === Number(base.id)) return false;
  if (String(other.word || "").toLowerCase() === String(base.word || "").toLowerCase()) return false;
  if (!String(other.meaningCN || "").trim()) return false;
  if (meaningsConflict(base.meaningCN, other.meaningCN)) return false;
  // 与参照词互为词形（"act / acts"）也不要，容易被当成同一个词
  if (String(other.word || "").toLowerCase().startsWith(String(base.word || "").toLowerCase())) return false;
  for (const text of taken) if (meaningsConflict(text, other.meaningCN)) return false;
  return true;
}

/**
 * 给候选干扰项定类型、打分、写一句 why。
 * 打分决定"谁最值得当干扰项"：同词根 > 形近 > 近义 > 词性不同 > 同主题。
 * @param {any} base @param {any} other
 * @returns {{ kind: string, score: number, why: string }}
 */
export function classifyDistractor(base, other) {
  const baseWord = String(base?.word || "");
  const otherWord = String(other?.word || "");
  const prefix = commonPrefix(baseWord, otherWord);
  const suffix = commonSuffix(baseWord, otherWord);
  const roots = sharedRoots(base, other);

  // 1) 同词根：最容易混的一类（hydrosphere / lithosphere）
  if (roots.length) {
    return {
      kind: "root",
      score: 6 + Math.min(2, roots.length - 1),
      why: `同为 ${roots.map((r) => `${r}-`).join(" / ")} 词根，含义不同`,
    };
  }
  // 2) 只差一个字母：看错成本最高的一类（adapt / adopt）
  if (isNearMiss(baseWord, otherWord)) {
    let at = 0;
    const x = baseWord.toLowerCase();
    const y = otherWord.toLowerCase();
    while (at < x.length && x[at] === y[at]) at++;
    return {
      kind: "form",
      score: 5,
      why: `只差一个字母（第 ${at + 1} 位是 ${y[at]}），最容易看错`,
    };
  }
  // 3) 形近/音近：拼写重合度高
  if (prefix >= PREFIX_MIN || suffix >= SUFFIX_MIN) {
    const parts = [];
    if (suffix >= SUFFIX_MIN) parts.push(`同后缀 -${otherWord.slice(-suffix)}`);
    if (prefix >= PREFIX_MIN) parts.push(`前缀 ${otherWord.slice(0, prefix)}- 相同`);
    return {
      kind: "form",
      score: 4 + (prefix >= 4 ? 1 : 0) + (suffix >= 5 ? 1 : 0),
      why: `${parts.join("、")}，拼写相近`,
    };
  }
  // 4) 近义：释义用词高度重合但不是同一个意思
  const overlap = meaningOverlap(base?.meaningCN, other?.meaningCN);
  if (overlap >= 0.34) {
    return { kind: "sense", score: 3, why: "释义用词相近，但范围/侧重点不同" };
  }
  // 5) 词性不同：提醒看词性
  const basePos = String(base?.pos || "");
  const otherPos = String(other?.pos || "");
  if (otherPos && basePos && otherPos !== basePos) {
    return { kind: "pos", score: 2, why: `词性不同（这是 ${otherPos}）` };
  }
  // 6) 兜底：同章同主题，含义无关
  return { kind: "topic", score: 1, why: "同主题的另一概念，不是这个词的意思" };
}

/**
 * 释义字符二元组重合度（0~1），用于近似义判断
 * @param {unknown} a @param {unknown} b
 */
export function meaningOverlap(a, b) {
  const grams = (text) => {
    const s = normalizeMeaning(text);
    const out = new Set();
    for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
    if (!out.size && s) out.add(s);
    return out;
  };
  const ga = grams(a);
  const gb = grams(b);
  if (!ga.size || !gb.size) return 0;
  let hit = 0;
  for (const g of ga) if (gb.has(g)) hit++;
  return hit / Math.min(ga.size, gb.size);
}

/**
 * 从同章词里挑干扰项。
 * @param {any} base 出题的词
 * @param {any[]} pool 同章词池
 * @param {number} count 需要的干扰项数量
 * @param {() => number} rng
 * @param {string[]} [taken] 已被占用的释义（精编干扰项）
 * @returns {Array<{ text: string, kind: string, why: string, source: string }>}
 */
export function pickDistractors(base, pool, count, rng = Math.random, taken = []) {
  const want = Math.max(0, Number(count) || 0);
  if (!want) return [];

  /** @type {Array<{ entry: any, kind: string, score: number, why: string, size: number, rnd: number }>} */
  const candidates = [];
  for (const other of pool ?? []) {
    if (!isUsableDistractor(base, other, taken)) continue;
    const info = classifyDistractor(base, other);
    // 长度接近的释义更像"同一层级的选项"，长度差太大会一眼看出
    const ratio = meaningLength(other.meaningCN) / Math.max(1, meaningLength(base.meaningCN));
    const size = ratio >= 0.6 && ratio <= 1.7 ? 1 : 0;
    candidates.push({ entry: other, kind: info.kind, score: info.score + size, why: info.why, size, rnd: rng() });
  }
  // 先按分数，再按随机数 → 同分之间随机但可复现
  candidates.sort((a, b) => b.score - a.score || b.rnd - a.rnd);

  /** @type {typeof candidates} */
  const picked = [];
  const usedKind = new Map();
  const capOf = (kind) => (kind === "topic" ? TOPIC_CAP : kind === "pos" ? POS_CAP : 99);
  /**
   * 同章词库里可能有释义完全相同的近义词（第 8 章就是这种），
   * 一旦两条候选释义互相包含，两个选项就都说得通 —— 必须去重。
   */
  const conflicts = (text) =>
    taken.some((t) => meaningsConflict(t, text)) ||
    picked.some((item) => meaningsConflict(item.entry.meaningCN, text));

  for (const item of candidates) {
    if (picked.length >= want) break;
    if (conflicts(item.entry.meaningCN)) continue;
    const used = usedKind.get(item.kind) || 0;
    if (used >= capOf(item.kind)) continue;
    usedKind.set(item.kind, used + 1);
    picked.push(item);
  }
  // 类别配额把数量卡住时，用剩下的高分候选补满（宁可少一点类别多样性，也要有 4 个选项）
  if (picked.length < want) {
    for (const item of candidates) {
      if (picked.length >= want) break;
      if (picked.includes(item)) continue;
      if (conflicts(item.entry.meaningCN)) continue;
      picked.push(item);
    }
  }

  return picked.map((item) => ({
    text: String(item.entry.meaningCN || "").trim(),
    kind: item.kind,
    why: item.why,
    source: "generated",
    word: String(item.entry.word || ""),
  }));
}

/** 精编干扰项归一化：只接受字段完整的条目 */
export function normalizeCuratedDistractors(curated, base, taken = []) {
  const raw = Array.isArray(curated?.distractors) ? curated.distractors : [];
  /** @type {Array<{ text: string, kind: string, why: string, source: string }>} */
  const out = [];
  const seen = taken.slice();
  for (const item of raw) {
    const text = String(item?.text || "").trim();
    if (!text) continue;
    if (meaningsConflict(base?.meaningCN, text)) continue;
    if (seen.some((t) => meaningsConflict(t, text))) continue;
    const kind = QUIZ_KIND.includes(item?.kind) ? String(item.kind) : "topic";
    out.push({ text, kind, why: String(item?.why || "").trim(), source: "curated" });
    seen.push(text);
  }
  return out;
}

/* ============ 出题 ============ */

/** 题目 key：同一个词在同一轮里位置固定 */
export const questionKey = (chapter, wordId) => `${Number(chapter)}:${Number(wordId)}`;

/**
 * 生成一道"看英文选中文"的选择题。
 *
 * @param {{
 *   chapter: number,
 *   entry: any,
 *   pool: any[],
 *   count?: number,
 *   rng?: () => number,
 *   curated?: any,
 *   promptKind?: "en" | "audio",
 * }} opts
 * @returns {any}
 */
export function buildChoiceQuestion(opts) {
  const { chapter, entry, pool, count = DEFAULT_OPTION_COUNT, rng = Math.random, curated = null } = opts;
  const answer = String(entry?.meaningCN || "").trim();
  const key = questionKey(chapter, entry?.id);

  const curatedList = normalizeCuratedDistractors(curated, entry);
  let need = Math.max(0, count - 1 - curatedList.length);
  let generated = need > 0 ? pickDistractors(entry, pool, need, rng, curatedList.map((d) => d.text)) : [];
  // 兜底再挑一次：去重后可能还差一两个，缺选项比多一次计算糟糕得多
  if (curatedList.length + generated.length < count - 1) {
    need = count - 1 - curatedList.length - generated.length;
    generated = [
      ...generated,
      ...pickDistractors(entry, pool, need, rng, [...curatedList, ...generated].map((d) => d.text)),
    ];
  }
  const distractors = [...curatedList, ...generated];

  /** @type {Array<{ text: string, correct: boolean, kind: string, why: string, source: string, word?: string }>} */
  const options = [
    { text: answer, correct: true, kind: "answer", why: String(curated?.note || "").trim(), source: curated ? "curated" : "generated" },
    ...distractors.map((d) => ({
      text: d.text,
      correct: false,
      kind: d.kind,
      why: d.why,
      source: d.source,
      ...(d.word ? { word: d.word } : {}),
    })),
  ];

  // 位置打乱：种子来自题目 key → 同一题永远同一顺序（重渲染/回插都不会跳位）
  const shuffled = shuffleWith(options, seededRng(`${key}:${options.length}`));
  const correctIndex = Math.max(0, shuffled.findIndex((o) => o.correct));

  return {
    key,
    chapter: Number(chapter),
    wordId: Number(entry?.id),
    word: String(entry?.word || ""),
    phonetic: String(entry?.phonetic || ""),
    pos: String(entry?.pos || ""),
    answer,
    promptKind: opts.promptKind === "audio" ? "audio" : "en",
    /** 选项里的 why 用于"答错讲清楚差在哪" */
    options: shuffled,
    correctIndex,
    /** 只用了自动生成的干扰项时标注出来，界面会提示"本章暂无精编题源" */
    hasCurated: curatedList.length > 0,
    generatedCount: generated.length,
    note: String(curated?.note || "").trim(),
  };
}

/**
 * 判分。
 * @param {any} question @param {number} index
 */
export function gradeChoice(question, index) {
  const chosenIndex = Number(index);
  return {
    correct: chosenIndex === Number(question?.correctIndex),
    chosenIndex,
    correctIndex: Number(question?.correctIndex),
  };
}

/**
 * 答错时给一句总评（配合每题各选项的 why 使用）
 * @param {any} question @param {number} chosenIndex
 */
export function explainChoice(question, chosenIndex) {
  const chosen = question?.options?.[Number(chosenIndex)];
  if (!chosen) return "";
  const label = QUIZ_KIND_LABEL[chosen.kind] ? `【${QUIZ_KIND_LABEL[chosen.kind]}】` : "";
  return `你选了「${chosen.text}」${label}；正确释义是「${question?.answer ?? ""}」`;
}
