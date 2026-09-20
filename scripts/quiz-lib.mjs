// @ts-check
/**
 * quiz-lib.mjs —— 认词题源（`public/quiz-N.json`）的**规范常量 + 校验器**
 *
 * 纯逻辑：不读文件、不写文件、不打印，方便 `npm test` 直接单测（test/quiz.test.js）。
 * 命令行入口在 scripts/quiz.mjs，生成规范（给模型看的）在 docs/选择题资料生成规范.md。
 *
 * 一句话数据流：
 *   data-N.json（词库，人工维护）
 *     + quiz-N.json（题源：干扰项 + 辨析，模型/人工生成，本模块校验）
 *     + quiz-index.json（清单：哪些章有题源，quiz.mjs 生成）
 *     → 前端 quiz.js 出题（没有题源时用同章词自动生成干扰项兜底）
 */

export const QUIZ_SPEC_VERSION = "1.1";
/** 兼容的题源 spec 版本（1.1 新增可选 rev 反向题源，1.0 文件仍然合法） */
const SPEC_VERSIONS_OK = new Set(["1.0", "1.1"]);

/** 干扰项类型（与 public/quiz.js 的 QUIZ_KIND 必须一致） */
export const QUIZ_KINDS = ["root", "form", "pos", "sense", "topic", "antonym"];

/** 有"辨析价值"的类型：每道题至少要有 1 个 */
export const CONFUSABLE_KINDS = ["root", "form", "sense", "antonym"];
/** 反向题（rev）允许的干扰项类型（与 public/quiz.js 的 REV_KINDS 同步；sense/pos 在反向无意义或有害） */
export const REV_KINDS = ["root", "form", "topic", "antonym"];

export const QUIZ_KIND_LABEL = {
  root: "同词根",
  form: "形近/音近",
  pos: "词性不同",
  sense: "近义",
  topic: "同主题",
  antonym: "反义",
};

/** 掌握要求：spell = 要会拼（默认）；read = 只认不拼（不进拼写牌堆） */
export const QUIZ_NEEDS = ["spell", "read"];

/** 每个词固定 3 个干扰项（4 选 1） */
export const DISTRACTOR_COUNT = 3;
/** topic 型干扰项最多 2 个（全是"同主题"等于没辨析） */
export const TOPIC_MAX = 2;
/** pos 型干扰项最多 1 个 */
export const POS_MAX = 1;
/** antonym 型干扰项最多 1 个 */
export const ANTONYM_MAX = 1;
/** 一句辨析的字数上限 */
export const WHY_MAX = 40;
/** note（词根/记忆点）的字数上限 */
export const NOTE_MAX = 60;

/** 空话 why 黑名单 */
export const WHY_BLACKLIST = [
  /^意思不同$/, /^含义不同$/, /^不是这个词$/, /^另一个意思$/,
  /^错误的选项$/, /^另一个词$/, /^词根不同$/, /^词性不对$/,
  /^拼写有点像$/, /^反义词$/, /^近义词$/,
  /同属.{1,6}领域但含义不同$/, /近义但侧重点不同$/,
  /^[a-z]\.词性，此处需要[a-z]\.$/, /^[a-z]\.词性，此处需要/,
  /但含义不同$/, /但意思不同$/,
];

/** 文档里"可直接喂给模型"的提示词区段标记 */
export const PROMPT_MARKERS = ["<!-- MODEL-PROMPT:START -->", "<!-- MODEL-PROMPT:END -->"];
/** 反向题（rev）的提示词区段标记 */
export const PROMPT_REV_MARKERS = ["<!-- MODEL-PROMPT-REV:START -->", "<!-- MODEL-PROMPT-REV:END -->"];

/** 题源文件路径（相对仓库根） */
export const quizPath = (chapter) => `public/quiz-${Number(chapter)}.json`;
export const quizIndexPath = "public/quiz-index.json";

/**
 * 宽容地解析 JSON：模型/编辑器导出的文件常带 UTF-8 BOM，
 * `JSON.parse` 会直接报错（浏览器端 `res.json()` 会自己吃掉 BOM，Node 不会）。
 * @param {string} text
 */
export function parseJsonLoose(text) {
  return JSON.parse(String(text ?? "").replace(/^\uFEFF/, ""));
}

/**
 * 归一化释义（与 public/quiz.js 的 normalizeMeaning 等价，此处独立实现，
 * 保证"校验用的口径"和"出题用的口径"一致；改动请同步两处）。
 * @param {unknown} text
 */
export function normalizeMeaning(text) {
  return String(text ?? "")
    .replace(/[\s\u3000]+/g, "")
    .replace(/[，,；;、。.．·・:：!！?？"'“”‘’()（）[\]【】<>《》/\\|-]/g, "")
    .toLowerCase();
}

/** 两个释义是否互相包含（含相等）→ 两个选项都说得通，不允许 */
export function meaningsConflict(a, b) {
  const na = normalizeMeaning(a);
  const nb = normalizeMeaning(b);
  if (!na || !nb) return true;
  return na === nb || na.includes(nb) || nb.includes(na);
}

/* ---------- 义项集合歧义判定（比子串更严：换序/换标点的同义改写也拦得住） ---------- */

/** 把释义切成义项集合（去空白标点、去纯词性标记） */
function senseSet(text) {
  return String(text ?? "")
    .split(/[，,；;、/|]+/)
    .map((s) => s.trim())
    .filter((s) => s && !/^[a-zA-Z.·~≈\s]+$/.test(s))
    .map(normalizeMeaning)
    .filter(Boolean);
}
const NEG_PREFIX = /^(不|无|非|未|没|没有|缺乏)/;
const stripNeg = (s) => s.replace(NEG_PREFIX, "");

/**
 * 选项的义项集合是否被正确释义覆盖（= 选了也算对）。
 * 返回 "exact"（逐义项相同）/ "contained"（每个义项都被某义项包含）/ "negation"（仅否定前缀之差）/ null。
 */
export function senseCover(optionText, answerText) {
  const A = senseSet(answerText);
  const O = senseSet(optionText);
  if (!A.length || !O.length) return null;
  const Aexact = new Set(A);
  if (O.every((o) => Aexact.has(o))) return "exact";
  if (O.some((o) => NEG_PREFIX.test(o))) {
    // 否定前缀开头的义项与答案的"去否定版"相同 → 也算说得通（如「不诚实」对「诚实」）
    const Astrip = new Set(A.map(stripNeg));
    if (O.every((o) => Astrip.has(stripNeg(o)))) return "negation";
    return null;
  }
  if (O.every((o) => A.some((a) => a.includes(o)))) return "contained";
  return null;
}

/** 空题源文档骨架 */
export function emptyQuizDoc(chapter) {
  return {
    spec: QUIZ_SPEC_VERSION,
    chapter: Number(chapter),
    source: "",
    generator: "",
    updatedAt: "",
    items: {},
  };
}

/**
 * 把"模型可能产出的各种形状"归一成 `{ [id]: item }`。
 * 支持：
 *   { chapter, items: { "12": {...} } }
 *   { chapters: [...], items: [...] } / { items: [ {id, ...} ] }
 *   [ { id, ... }, ... ]
 * @param {any} raw
 * @returns {{ items: Record<string, any>, chapter: number }}
 */
export function normalizeQuizDoc(raw) {
  const chapter = Number(raw?.chapter) || 0;
  /** @type {Record<string, any>} */
  const items = {};
  const source = raw?.items ?? raw;
  if (Array.isArray(source)) {
    for (const item of source) {
      const id = Number(item?.id ?? item?.wordId);
      if (Number.isInteger(id) && id > 0) items[String(id)] = item;
    }
  } else if (source && typeof source === "object") {
    for (const [key, item] of Object.entries(source)) {
      const id = Number(key);
      if (Number.isInteger(id) && id > 0) items[String(id)] = item;
    }
  }
  return { items, chapter };
}

/**
 * 校验一份题源。
 *
 * @param {any} doc 题源文档（已 JSON.parse）
 * @param {{ chapter: number, words: any[] }} ctx words = data-N.json
 * @returns {{
 *   errors: string[],
 *   warnings: string[],
 *   stats: {
 *     total: number, covered: number, coverage: number,
 *     kinds: Record<string, number>, needs: Record<string, number>,
 *     longestCorrectRatio: number, avgWhy: number,
 *   },
 * }}
 */
export function validateQuizDoc(doc, ctx) {
  /** @type {string[]} */
  const errors = [];
  /** @type {string[]} */
  const warnings = [];
  const chapter = Number(ctx?.chapter);
  const words = Array.isArray(ctx?.words) ? ctx.words : [];
  const byId = new Map(words.map((w) => [Number(w.id), w]));

  const kinds = Object.fromEntries(QUIZ_KINDS.map((k) => [k, 0]));
  const needs = Object.fromEntries(QUIZ_NEEDS.map((k) => [k, 0]));
  let whyTotal = 0;
  let whyCount = 0;
  let longestCorrect = 0;
  let revCovered = 0;
  /** @type {Map<string, number>} */
  const whySeen = new Map();
  /** @type {Map<string, number>} 章内干扰项释义频次（万能项检测） */
  const textSeen = new Map();
  /** 反向题源（rev）按"英文词 → 词条"查找，用于词义互含判定 */
  const wordByWord = new Map();
  for (const w of words) {
    const k = String(w?.word || "").toLowerCase();
    if (k) wordByWord.set(k, w);
  }

  /** @param {string} id @param {string} message */
  const bad = (id, message) => errors.push(`${id ? `#${id} ` : ""}${message}`);
  /** @param {string} id @param {string} message */
  const warn = (id, message) => warnings.push(`${id ? `#${id} ` : ""}${message}`);

  if (!doc || typeof doc !== "object") {
    bad("", "不是一个 JSON 对象");
    return { errors, warnings, stats: emptyStats(words.length) };
  }
  if (Number(doc.chapter) !== chapter) {
    bad("", `chapter 字段应为 ${chapter}，实际是 ${JSON.stringify(doc.chapter)}`);
  }
  if (doc.spec && !SPEC_VERSIONS_OK.has(String(doc.spec))) {
    warn("", `spec 版本是 ${doc.spec}，当前规范是 ${QUIZ_SPEC_VERSION}`);
  }

  const { items } = normalizeQuizDoc(doc);
  const ids = Object.keys(items);
  if (!ids.length) bad("", "items 为空：没有任何词条");

  for (const id of ids) {
    const wordId = Number(id);
    const entry = byId.get(wordId);
    const item = items[id];
    if (!entry) {
      bad(id, "词库里没有这个 id（id 必须以 data-N.json 为准）");
      continue;
    }
    const label = `（${entry.word}）`;
    if (!item || typeof item !== "object") {
      bad(id, `不是对象 ${label}`);
      continue;
    }

    if (item.need !== undefined && !QUIZ_NEEDS.includes(item.need)) {
      bad(id, `need 只能是 ${QUIZ_NEEDS.join(" / ")}，实际是 ${JSON.stringify(item.need)}`);
    } else {
      needs[item.need === "read" ? "read" : "spell"] += 1;
    }

    if (item.note !== undefined) {
      const note = String(item.note ?? "");
      if (note.length > NOTE_MAX) bad(id, `note 超过 ${NOTE_MAX} 字 ${label}`);
    }

    const distractors = item.distractors;
    if (!Array.isArray(distractors)) {
      bad(id, `缺少 distractors 数组 ${label}`);
      continue;
    }
    if (distractors.length !== DISTRACTOR_COUNT) {
      bad(id, `distractors 必须是 ${DISTRACTOR_COUNT} 条（4 选 1），实际 ${distractors.length} 条 ${label}`);
    }

    const texts = [];
    /** @type {string[]} 同题 why 去重 */
    const itemWhys = [];
    let topicCount = 0;
    let posCount = 0;
    let antonymCount = 0;
    let confusableCount = 0;
    for (const [index, distractor] of distractors.entries()) {
      const where = `第 ${index + 1} 个干扰项 ${label}`;
      if (!distractor || typeof distractor !== "object") {
        bad(id, `${where}不是对象`);
        continue;
      }
      const text = String(distractor.text ?? "").trim();
      if (!text) {
        bad(id, `${where}缺少 text`);
        continue;
      }
      if (!/[\u4e00-\u9fff]/.test(text)) {
        bad(id, `${where}的 text 不含中文字符：${JSON.stringify(text)}`);
      }
      if (/以上都|都不是|以上不是|都不对/.test(text)) {
        bad(id, `${where}的 text 是禁止写法（以上都不是类）：${JSON.stringify(text)}`);
      }
      if (!QUIZ_KINDS.includes(distractor.kind)) {
        bad(id, `${where}的 kind 必须是 ${QUIZ_KINDS.join(" / ")} 之一，实际是 ${JSON.stringify(distractor.kind)}`);
      } else {
        kinds[distractor.kind] += 1;
        if (distractor.kind === "topic") topicCount++;
        else if (distractor.kind === "pos") posCount++;
        else if (distractor.kind === "antonym") { antonymCount++; confusableCount++; }
        else if (CONFUSABLE_KINDS.includes(distractor.kind)) confusableCount++;
      }

      const why = String(distractor.why ?? "").trim();
      if (!why) bad(id, `${where}缺少 why（每条干扰项都必须写清差在哪）`);
      else {
        if (why.length > WHY_MAX) bad(id, `${where}的 why 超过 ${WHY_MAX} 字（${why.length} 字）：${why}`);
        if (WHY_BLACKLIST.some(re => re.test(why))) {
          bad(id, `${where}的 why 是空话模板：${why}`);
        }
        whyTotal += why.length;
        whyCount += 1;
        whySeen.set(why, (whySeen.get(why) || 0) + 1);
      }

      if (meaningsConflict(entry.meaningCN, text)) {
        bad(id, `${where}与正确释义冲突（学习者会认为它也说得通）：「${text}」 vs 「${entry.meaningCN}」`);
      } else {
        const cover = senseCover(text, entry.meaningCN);
        if (cover === "exact" || cover === "contained") {
          bad(id, `${where}的义项被正确释义覆盖（换序/改写也算同一个意思）：「${text}」 vs 「${entry.meaningCN}」`);
        } else if (cover === "negation") {
          bad(id, `${where}与正确释义只差一个否定词：「${text}」 vs 「${entry.meaningCN}」`);
        }
      }
      if (texts.some((t) => meaningsConflict(t, text))) {
        bad(id, `${where}与同题其它干扰项重复或互相包含：「${text}」`);
      }
      const nTextFull = normalizeMeaning(text);
      textSeen.set(nTextFull, (textSeen.get(nTextFull) || 0) + 1);
      const ratio = nTextFull.length / Math.max(1, normalizeMeaning(entry.meaningCN).length);
      if (ratio < 0.5 || ratio > 2.0) {
        warn(id, `${where}与正确释义长度差太多（${Math.round(ratio * 100)}%），会变成"最长的那个是答案"`);
      }
      if (itemWhys.includes(why)) {
        bad(id, `${where}的 why 与同题另一条干扰项完全相同：${why}`);
      } else {
        itemWhys.push(why);
      }
      texts.push(text);
    }

    if (topicCount > TOPIC_MAX) {
      bad(id, `同主题（topic）干扰项最多 ${TOPIC_MAX} 个，实际 ${topicCount} 个 ${label}`);
    }
    if (posCount > POS_MAX) {
      bad(id, `词性不同（pos）干扰项最多 ${POS_MAX} 个，实际 ${posCount} 个 ${label}`);
    }
    if (antonymCount > ANTONYM_MAX) {
      bad(id, `反义（antonym）干扰项最多 ${ANTONYM_MAX} 个，实际 ${antonymCount} 个 ${label}`);
    }
    if (confusableCount === 0 && distractors.length) {
      bad(
        id,
        `至少要有一个有辨析价值的干扰项（${CONFUSABLE_KINDS.join(" / ")}），不能全是"同主题不同概念" ${label}`
      );
    }

    /* ---------- 反向题源（rev：看中文选英文，text = 英文词） ---------- */
    const rev = item?.rev;
    if (rev != null) {
      const revList = Array.isArray(rev?.distractors) ? rev.distractors : null;
      if (!revList || revList.length !== DISTRACTOR_COUNT) {
        bad(id, `rev.distractors 必须恰好 ${DISTRACTOR_COUNT} 条（反向也是 4 选 1） ${label}`);
      } else {
        let revConfusable = 0;
        const revTopic = revList.filter((d) => d?.kind === "topic").length;
        const revAntonym = revList.filter((d) => d?.kind === "antonym").length;
        /** @type {string[]} */ const revWhys = [];
        revList.forEach((d, index) => {
          const revWhere = `rev 第 ${index + 1} 个干扰项 ${label}`;
          const text = String(d?.text ?? "").trim();
          if (!/^[A-Za-z][A-Za-z' -]*$/.test(text)) {
            bad(id, `${revWhere}的 text 必须是纯英文词：${JSON.stringify(text)}`);
          } else {
            // 与答案同形/互为屈折（act/acts）→ 两个选项都说得通
            const lt = text.toLowerCase();
            const lw = String(entry?.word || "").toLowerCase();
            if (!lw || lt === lw || lt.startsWith(lw) || lw.startsWith(lt)) {
              bad(id, `${revWhere}与答案词形相同或互为屈折：「${text}」`);
            } else {
              const poolEntry = wordByWord.get(lt);
              if (poolEntry) {
                if (meaningsConflict(poolEntry.meaningCN, entry.meaningCN)) {
                  bad(id, `${revWhere}的词义与题面互含（它也能回答这道题）：「${text}（${String(poolEntry.meaningCN).slice(0, 14)}）」`);
                }
              } else if (!String(d?.gloss || "").trim()) {
                bad(id, `${revWhere}的词不在词库里，必须带 gloss（一句中文释义）：「${text}」`);
              } else if (meaningsConflict(d.gloss, entry.meaningCN)) {
                bad(id, `${revWhere}的 gloss 与题面互含：「${text}」`);
              }
            }
          }
          if (!REV_KINDS.includes(d?.kind)) {
            bad(id, `${revWhere}的 kind 非法：${JSON.stringify(d?.kind)}（反向只允许 ${REV_KINDS.join("/")}）`);
          } else if (d.kind === "sense") {
            bad(id, `${revWhere}不能是 sense（反向里近义词就是另一个正确答案）`);
          } else if (d.kind === "pos") {
            bad(id, `${revWhere}不能是 pos（反向选项都是英文词，词性差异无从体现）`);
          } else if (d.kind !== "topic") {
            revConfusable += 1;
          }
          const revWhy = String(d?.why ?? "").trim();
          if (!revWhy) bad(id, `${revWhere}缺少 why`);
          else {
            if (revWhy.length > WHY_MAX) bad(id, `${revWhere}的 why 超过 ${WHY_MAX} 字（${revWhy.length} 字）：${revWhy}`);
            if (WHY_BLACKLIST.some((re) => re.test(revWhy))) bad(id, `${revWhere}的 why 是空话模板：${revWhy}`);
            if (revWhys.includes(revWhy)) bad(id, `${revWhere}的 why 与同题另一条完全相同`);
            revWhys.push(revWhy);
          }
        });
        if (revTopic > TOPIC_MAX) bad(id, `rev 的 topic 干扰项最多 ${TOPIC_MAX} 个，实际 ${revTopic} 个 ${label}`);
        if (revAntonym > 1) bad(id, `rev 的 antonym 干扰项最多 1 个，实际 ${revAntonym} 个 ${label}`);
        if (revConfusable === 0) bad(id, `rev 至少要有一个有辨析价值的干扰项（root / form / antonym） ${label}`);
        revCovered += 1;
      }
    }

    // 破绽检查：正确答案是不是总比干扰项长
    const answerLength = normalizeMeaning(entry.meaningCN).length;
    if (texts.length && texts.every((t) => normalizeMeaning(t).length < answerLength)) longestCorrect += 1;
  }

  for (const [why, count] of whySeen) {
    if (count >= 3) warn("", `同一句辨析被复用了 ${count} 次（模板句学不到东西）：「${why}」`);
  }
  {
    const univ = [...textSeen.entries()].filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]);
    for (const [t, n] of univ.slice(0, 5)) {
      warn("", `同一个释义在全章被当作干扰项用了 ${n} 次（万能干扰项，一眼就能排除）：「${t.slice(0, 14)}」`);
    }
    if (univ.length > 5) warn("", `…另有 ${univ.length - 5} 个释义被复用 ≥3 次`);
  }

  const total = words.length;
  const covered = ids.filter((id) => byId.has(Number(id))).length;
  const coverage = total ? covered / total : 0;
  if (total && coverage < 0.5) {
    warn("", `本章只覆盖了 ${covered}/${total}（${Math.round(coverage * 100)}%），其余词会退回"自动生成干扰项"`);
  }
  const readCount = needs.read || 0;
  if (covered && readCount / covered > 0.5) {
    warn("", `本章有 ${readCount}/${covered} 个词标为 need:"read"（只认不拼），确认不是批量误标`);
  }

  const longestCorrectRatio = covered ? longestCorrect / covered : 0;
  if (longestCorrectRatio > 0.6) {
    warn("", `有 ${Math.round(longestCorrectRatio * 100)}% 的题"正确答案是最长的那个"，容易被猜出来`);
  }

  return {
    errors,
    warnings,
    stats: {
      total,
      covered,
      revCovered,
      coverage,
      kinds,
      needs,
      longestCorrectRatio,
      avgWhy: whyCount ? Math.round((whyTotal / whyCount) * 10) / 10 : 0,
    },
  };
}

/** @param {number} total */
function emptyStats(total) {
  return {
    total,
    covered: 0,
    coverage: 0,
    kinds: Object.fromEntries(QUIZ_KINDS.map((k) => [k, 0])),
    needs: Object.fromEntries(QUIZ_NEEDS.map((k) => [k, 0])),
    longestCorrectRatio: 0,
    avgWhy: 0,
  };
}

/**
 * 生成题源清单（给前端用：只有清单里的章节才会去请求 quiz-N.json）
 * @param {Array<{ chapter: number, covered: number, total: number }>} chapters
 */
export function buildQuizIndex(chapters) {
  const list = (chapters ?? [])
    .filter((c) => Number(c.covered) > 0)
    .sort((a, b) => Number(a.chapter) - Number(b.chapter));
  /** @type {Record<string, { covered: number, total: number }>} */
  const coverage = {};
  /** @type {Record<string, { covered: number, total: number }>} 反向题源（rev）覆盖率，0 时省略 */
  const revCoverage = {};
  for (const c of list) {
    coverage[String(c.chapter)] = { covered: Number(c.covered), total: Number(c.total) };
    if (Number(c.revCovered) > 0) revCoverage[String(c.chapter)] = { covered: Number(c.revCovered), total: Number(c.total) };
  }
  return {
    spec: QUIZ_SPEC_VERSION,
    updatedAt: null, // 由 CLI 填真实时间
    chapters: list.map((c) => Number(c.chapter)),
    coverage,
    ...(Object.keys(revCoverage).length ? { revCoverage } : {}),
  };
}

/**
 * 合并分片：后写的覆盖先写的（同一 id），返回新文档
 * @param {any} target @param {any} patch
 */
export function mergeQuizDocs(target, patch) {
  const base = target && typeof target === "object" ? target : emptyQuizDoc(patch?.chapter);
  const { items } = normalizeQuizDoc(patch);
  return { ...base, items: { ...(base.items || {}), ...items } };
}

/**
 * 从生成规范文档里抽出"可直接喂给模型的提示词"区段
 * @param {string} markdown
 */
export function extractModelPrompt(markdown, markers = PROMPT_MARKERS) {
  const text = String(markdown ?? "");
  const start = text.indexOf(markers[0]);
  const end = text.indexOf(markers[1]);
  if (start < 0 || end < 0 || end <= start) return "";
  return text.slice(start + markers[0].length, end).trim();
}
