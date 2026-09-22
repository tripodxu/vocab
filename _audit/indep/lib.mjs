// _audit/indep/lib.mjs —— 独立审计共享库（只读项目文件，输出仅写 _audit/indep/out/）
// 归一化口径与 docs/选择题资料生成规范.md 附录 B、scripts/quiz-lib.mjs 保持一致。
import { readFile, readdir, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
// 口径单源：归一化 / 义项覆盖 / 空话黑名单全部转发自生产侧规范库 scripts/quiz-lib.mjs，
// 不再各自维护拷贝（此前与 analyze-length/gen-length-fix 的拷贝连引号集都已漂移）。
// 依赖方向：_audit → scripts（生产脚本永远不反向 import _audit）。
import { normalizeMeaning, senseCover, WHY_BLACKLIST } from "../../scripts/quiz-lib.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const OUT = path.join(ROOT, "_audit", "indep", "out");
export const TODAY = new Date().toISOString().slice(0, 10);

export async function ensureOut() {
  await mkdir(OUT, { recursive: true });
}

export async function writeOut(name, content) {
  await mkdir(OUT, { recursive: true });
  const p = path.join(OUT, name);
  await (await import("node:fs/promises")).writeFile(p, content, "utf8");
  return p;
}

/** 附录 B 归一化：去空白/标点、转小写（= scripts/quiz-lib.mjs normalizeMeaning，单一实现） */
export const normalize = normalizeMeaning;

/** 义项集合覆盖判定（= scripts/quiz-lib.mjs senseCover，单一实现；返回 exact/contained/negation/null，真值判定不受影响） */
export { senseCover };

/** docs 附录 A 空话黑名单（= scripts/quiz-lib.mjs WHY_BLACKLIST，单一实现） */
export { WHY_BLACKLIST };

export function bigrams(t) {
  const s = normalize(t);
  const o = new Set();
  for (let i = 0; i < s.length - 1; i++) o.add(s.slice(i, i + 2));
  if (!o.size && s) o.add(s);
  return o;
}

/** 真 Jaccard：|A∩B| / |A∪B|（char-bigram） */
export function jaccard(a, b) {
  const ga = bigrams(a), gb = bigrams(b);
  if (!ga.size || !gb.size) return 0;
  let hit = 0;
  for (const g of ga) if (gb.has(g)) hit++;
  return hit / (ga.size + gb.size - hit);
}

/** min 归一重合度（与既有 _audit 脚本口径一致，用于对齐判断） */
export function minOverlap(a, b) {
  const ga = bigrams(a), gb = bigrams(b);
  if (!ga.size || !gb.size) return 0;
  let hit = 0;
  for (const g of ga) if (gb.has(g)) hit++;
  return hit / Math.min(ga.size, gb.size);
}

/** 拆义项（与 _audit/ambig.mjs 相同） */
export function senses(t) {
  return String(t ?? "")
    .split(/[，,；;、/|]+/)
    .map((s) => s.trim())
    .filter((s) => s && !/^[a-zA-Z.·]+$/.test(s))
    .map(normalize)
    .filter(Boolean);
}

/** 加载全部 data-N / quiz-N */
export async function loadAll() {
  const files = (await readdir(path.join(ROOT, "public")))
    .filter((f) => /^data-\d+\.json$/.test(f))
    .map((f) => Number(f.match(/\d+/)[0]))
    .sort((a, b) => a - b);
  const data = new Map(), quiz = new Map();
  for (const c of files) {
    data.set(c, JSON.parse(await readFile(path.join(ROOT, `public/data-${c}.json`), "utf8")));
    quiz.set(c, JSON.parse(await readFile(path.join(ROOT, `public/quiz-${c}.json`), "utf8")));
  }
  return { chapters: files, data, quiz };
}

/** root 字段里的词根 token（与既有审计脚本相同口径：英文 token 后跟全角括号） */
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
 * 口径与 _audit/strict.mjs 相同：先精确命中（word/词根），否则长度≥4 的前缀匹配；
 * 任一 token 无法解析 → allResolved=false（不可机器判定）。
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

/** 遍历发布题源的全部干扰项 */
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

/**
 * 机器模板 why 模式（前 5 条对应质检报告主张 1 的 5 行；其余为各修复脚本模板的扩展覆盖）。
 */
export const TEMPLATES = [
  { key: "len-tag（|长度修复|避免最长项可猜）", re: /\|(长度修复|修复)\|.*避免最长项可猜|避免最长项可猜/, claim: 203 },
  { key: "pos-short（X 词性不同）", re: /^[A-Za-z][\w' -]* 词性不同$/, claim: 284 },
  { key: "sense-diff（X 与 Y 意思有区别）", re: /^[A-Za-z][\w' -]* 与 [A-Za-z][\w' -]* 意思有区别$/, claim: 241 },
  { key: "form-confuse（“X”与“Y”形近易混，但实际含义不同）", re: /形近易混，但实际含义不同/, claim: 76 },
  { key: "semantic-field（属同一语义场，但具体所指不同）", re: /属于同一语义场，但具体所指不同/, claim: 24 },
  // 扩展：各修复脚本模板（generate-fixes.mjs 16-18 / content/quiz/generate-fix.mjs 19-22 / fix-length.mjs 12-15 等）
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

/** 命中第一个模板（用于归因；总计用“任一命中”） */
export function matchTemplate(why) {
  for (const t of TEMPLATES) if (t.re.test(String(why))) return t;
  return null;
}

export const pct = (n, d) => (d ? ((n / d) * 100).toFixed(1) : "0.0");
