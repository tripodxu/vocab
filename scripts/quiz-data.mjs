// @ts-check
/**
 * quiz-data.mjs —— 题源工具链的**数据层**：读词库/题源、建索引、算相似度、解析 why。
 *
 * 与 `quiz-lib.mjs` 的分工：
 *   quiz-lib.mjs  纯逻辑（常量 + 校验器），不碰文件系统，可被 `npm test` 直接单测
 *   本文件        需要读 `public/data-N.json` / `quiz-N.json` 的加载与索引工具
 *
 * 依赖方向（只允许单向）：
 *   生产脚本 scripts/*.mjs → scripts/quiz-lib.mjs + scripts/quiz-data.mjs
 *   _audit/**（审计/证据）→ scripts/**
 * **禁止反向**：生产脚本不得 import `_audit/` 下的任何文件（那里是一次性审计脚本，禁止运行）。
 * 历史原因，这些工具曾放在 `_audit/indep/lib.mjs`，已于 2026-09-28 上移到本文件。
 */

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeMeaning, senseCover, WHY_BLACKLIST } from "./quiz-lib.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 归一化 / 义项覆盖 / 空话黑名单：口径单源，转发自 quiz-lib（避免各处各写一份导致漂移） */
export const normalize = normalizeMeaning;
export { senseCover, WHY_BLACKLIST };

/* ---------- 文本相似度 ---------- */

export function bigrams(t) {
  const s = normalize(t);
  const o = new Set();
  for (let i = 0; i < s.length - 1; i++) o.add(s.slice(i, i + 2));
  if (!o.size && s) o.add(s);
  return o;
}

/** 真 Jaccard：|A∩B| / |A∪B|（char-bigram） */
export function jaccard(a, b) {
  const ga = bigrams(a);
  const gb = bigrams(b);
  if (!ga.size || !gb.size) return 0;
  let hit = 0;
  for (const g of ga) if (gb.has(g)) hit++;
  return hit / (ga.size + gb.size - hit);
}

/** min 归一重合度：|A∩B| / min(|A|,|B|)，用于"互相包含"类对齐判断 */
export function minOverlap(a, b) {
  const ga = bigrams(a);
  const gb = bigrams(b);
  if (!ga.size || !gb.size) return 0;
  let hit = 0;
  for (const g of ga) if (gb.has(g)) hit++;
  return hit / Math.min(ga.size, gb.size);
}

/** 拆义项：按分隔符切开并归一化（过滤纯英文/词性标记） */
export function senses(t) {
  return String(t ?? "")
    .split(/[，,；;、/|]+/)
    .map((s) => s.trim())
    .filter((s) => s && !/^[a-zA-Z.·]+$/.test(s))
    .map(normalize)
    .filter(Boolean);
}

/* ---------- 数据加载与索引 ---------- */

/**
 * 加载全部词库与题源
 * @returns {Promise<{ chapters: number[], data: Map<number, any[]>, quiz: Map<number, any> }>}
 */
export async function loadAll() {
  const files = (await readdir(path.join(ROOT, "public")))
    .filter((f) => /^data-\d+\.json$/.test(f))
    .map((f) => Number(f.match(/\d+/)[0]))
    .sort((a, b) => a - b);
  const data = new Map();
  const quiz = new Map();
  for (const c of files) {
    data.set(c, JSON.parse(await readFile(path.join(ROOT, `public/data-${c}.json`), "utf8")));
    quiz.set(c, JSON.parse(await readFile(path.join(ROOT, `public/quiz-${c}.json`), "utf8")));
  }
  return { chapters: files, data, quiz };
}

/** root 字段里的词根 token（口径：英文 token 后跟全角/半角括号） */
export function rootTokens(entry) {
  const out = new Set();
  for (const m of String(entry?.root || "").matchAll(/([A-Za-z][A-Za-z-]*)\s*[（(]/g)) {
    const t = m[1].toLowerCase().replace(/-$/, "");
    if (t.length >= 3) out.add(t);
  }
  return out;
}

/** 英文 token 索引：word + 词根 token → 词库条目（可一对多） */
export function buildTokenIndex(data) {
  const idx = new Map();
  for (const [, words] of data) {
    for (const w of words) {
      const toks = new Set([String(w.word || "").toLowerCase()]);
      for (const t of rootTokens(w)) toks.add(t);
      for (const t of toks) {
        if (t.length < 3) continue;
        if (!idx.has(t)) idx.set(t, []);
        idx.get(t).push(w);
      }
    }
  }
  return idx;
}

/**
 * 解析 why 中的英文 token（≥3 字母）→ 词库词。
 * 先精确命中（word / 词根），否则长度 ≥4 时做前缀匹配；任一 token 解析不出 → allResolved=false。
 */
export function resolveWhy(why, idx) {
  const out = { tokens: [], named: new Set(), allResolved: true };
  for (const m of String(why).matchAll(/[A-Za-z][A-Za-z-]{2,}/g)) {
    const raw = m[0].toLowerCase().replace(/-$/, "");
    out.tokens.push(raw);
    if (idx.has(raw)) {
      for (const w of idx.get(raw)) out.named.add(w);
      continue;
    }
    let hit = false;
    if (raw.length >= 4) {
      for (const [tok, list] of idx) {
        if (tok.startsWith(raw)) {
          for (const w of list) out.named.add(w);
          hit = true;
        }
      }
    }
    if (!hit) out.allResolved = false;
  }
  return out;
}

/** 遍历发布题源的全部干扰项（生成器，避免一次性展开大对象） */
export function* iterDistractors(quiz, data) {
  for (const [c, doc] of quiz) {
    const byId = new Map((data.get(c) || []).map((w) => [Number(w.id), w]));
    for (const [id, item] of Object.entries(doc.items || {})) {
      const entry = byId.get(Number(id));
      for (const [di, d] of (item.distractors || []).entries()) {
        yield { c, id, entry, item, d, di };
      }
    }
  }
}

/* ---------- 机器模板 why 识别（用于"模板句"归因） ---------- */

/** 前 5 条对应质检报告主张 1 的 5 行；其余为各修复脚本模板的扩展覆盖。 */
export const TEMPLATES = [
  { key: "len-tag（|长度修复|避免最长项可猜）", re: /\|(长度修复|修复)\|.*避免最长项可猜|避免最长项可猜/, claim: 203 },
  { key: "pos-short（X 词性不同）", re: /^[A-Za-z][\w' -]* 词性不同$/, claim: 284 },
  { key: "sense-diff（X 与 Y 意思有区别）", re: /^[A-Za-z][\w' -]* 与 [A-Za-z][\w' -]* 意思有区别$/, claim: 241 },
  { key: "form-confuse（“X”与“Y”形近易混，但实际含义不同）", re: /形近易混，但实际含义不同/, claim: 76 },
  { key: "semantic-field（属同一语义场，但具体所指不同）", re: /属于同一语义场，但具体所指不同/, claim: 24 },
  { key: "ext:root-related（“X”与“Y”词根相关但含义不同）", re: /词根相关但含义不同$/, claim: null },
  { key: "ext:root-diff（X 与 Y 同词根但含义不同）", re: /同词根，?但含义不同$/, claim: null },
  { key: "ext:form-diff（X 形近但意思不同）", re: /形近但意思不同$/, claim: null },
  { key: "ext:form-meaning（“X”与“Y”形近但含义不同）", re: /形近但含义不同$/, claim: null },
  { key: "ext:pos-vs（X 词性与 Y 不同）", re: /^[A-Za-z][\w' -]* 词性与 [A-Za-z][\w' -]* 不同$/, claim: null },
  { key: "ext:sense-near（X 与 Y 意思相近但用法不同）", re: /意思相近但用法不同$/, claim: null },
  { key: "ext:xy-diff（X 与 Y 不同）", re: /^[A-Za-z][\w' -]* 与 [A-Za-z][\w' -]* 不同$/, claim: null },
  { key: "ext:xy-have-diff（X 与 Y 有区别）", re: /^[A-Za-z][\w' -]* 与 [A-Za-z][\w' -]* 有区别$/, claim: null },
  { key: "ext:focus-diff（“…”侧重X，而“…”侧重Y）", re: /但含义侧重不同|侧重.{1,12}，而.{1,12}侧重/, claim: null },
  { key: "ext:related-concept（“…”是相关概念，但具体所指…不同）", re: /是相关概念，?但/, claim: null },
  { key: "ext:same-domain（“…”属于同一领域但具体含义不同）", re: /属于同一领域但具体含义不同/, claim: null },
  { key: "ext:antonym-tpl（“…”是反义(词|概念)，方向相反）", re: /是反义(词|概念)，?但?方向相反/, claim: null },
  { key: "ext:pos-usage（“…”词性或语法功能不同）", re: /词性或语法功能不同/, claim: null },
  { key: "ext:diff-correct（“…”与正确释义含义不同）", re: /与正确释义含义不同$/, claim: null },
];

/** 命中第一个模板（用于归因） */
export function matchTemplate(why) {
  for (const t of TEMPLATES) if (t.re.test(String(why))) return t;
  return null;
}
