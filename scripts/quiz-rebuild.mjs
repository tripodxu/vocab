/**
 * 从 content/quiz/ 的原始模型分片重建 public/quiz-N.json。
 *
 * 用途：`merge` 以现有发布文件为底、校验失败整体不写入，无法用于"推翻重来"式的重建。
 * 本脚本在内存中按分片顺序合并后直接写入发布文件（写入前**不做**校验——原始分片
 * 常带校验错误，这些错误会逐条打印，作为后续逐题修复的工作清单；修复分片仍必须
 * 走 `quiz.mjs merge` 的校验门禁）。quiz-index.json 不在这里动，由 `quiz.mjs check` 决定。
 *
 * 用法：
 *   node scripts/quiz-rebuild.mjs                 # 全部 22 章
 *   node scripts/quiz-rebuild.mjs --only 1,16     # 只重建指定章
 *   node scripts/quiz-rebuild.mjs --extra 16=content/quiz/16-fix-61-110.json
 *                                                 # 追加模型重生成片（排在原始分片之后）
 *
 * 分片规则：`N.json` 与 `N-<整数>.json` 视为原始分片，按数字升序合并；
 * 文件名含非数字段（fix/v2/analysis 等）的一律忽略（那些是修复运动的产物）。
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { mergeQuizDocs, normalizeQuizDoc, validateQuizDoc, emptyQuizDoc } from "./quiz-lib.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const shardDir = join(root, "content", "quiz");

/* ---------- CLI ---------- */
const argv = process.argv.slice(2);
const only = (() => {
  const i = argv.indexOf("--only");
  if (i < 0) return null;
  return new Set(
    String(argv[i + 1] || "")
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0)
  );
})();
/** @type {Map<number, string[]>} */
const extras = new Map();
{
  let i = argv.indexOf("--extra");
  while (i >= 0) {
    const [ch, file] = String(argv[i + 1] || "").split("=");
    const c = Number(ch);
    if (Number.isInteger(c) && c > 0 && file) {
      if (!extras.has(c)) extras.set(c, []);
      extras.get(c).push(file);
    }
    i = argv.indexOf("--extra", i + 1);
  }
}

/* ---------- 收集每章的原始分片 ---------- */
/** @type {Map<number, string[]>} */
const byChapter = new Map();
for (const name of readdirSync(shardDir)) {
  if (!name.endsWith(".json")) continue;
  const stem = name.slice(0, -5);
  const m = stem.match(/^(\d+)(?:-(\d+))?$/); // N.json 或 N-<int>.json
  if (!m) continue;
  const chapter = Number(m[1]);
  if (only && !only.has(chapter)) continue;
  if (!byChapter.has(chapter)) byChapter.set(chapter, []);
  byChapter.get(chapter).push(name);
}
for (const [chapter, files] of extras) {
  if (only && !only.has(chapter)) continue;
  if (!byChapter.has(chapter)) byChapter.set(chapter, []);
  byChapter.get(chapter).push(...files);
}
for (const files of byChapter.values()) {
  files.sort((a, b) => {
    const sa = a.slice(0, -5).split("-");
    const sb = b.slice(0, -5).split("-");
    return Number(sa[1] || 0) - Number(sb[1] || 0);
  });
}

/* ---------- 重建 ---------- */
let totalErrors = 0;
for (const chapter of [...byChapter.keys()].sort((a, b) => a - b)) {
  const files = byChapter.get(chapter) || [];
  if (!files.length) continue;

  let doc = emptyQuizDoc(chapter);
  const generators = new Set();
  let loaded = 0;
  for (const name of files) {
    const full = name.includes("/") ? join(root, name) : join(shardDir, name);
    let raw;
    try {
      raw = JSON.parse(readFileSync(full, "utf8"));
    } catch (err) {
      console.log(`第 ${chapter} 章：✖ 分片解析失败 ${name}：${err.message}`);
      continue;
    }
    const norm = normalizeQuizDoc(raw);
    const gen = String(raw?.generator || "").trim();
    if (gen) generators.add(gen);
    doc = mergeQuizDocs(doc, norm);
    loaded++;
  }

  const words = JSON.parse(readFileSync(join(root, "public", `data-${chapter}.json`), "utf8"));
  const wordList = Array.isArray(words) ? words : words.words || words.data || [];
  const { errors, warnings } = validateQuizDoc(doc, { chapter, words: wordList });

  doc.spec = normalizeQuizDoc(doc).spec || "1.0";
  doc.chapter = chapter;
  doc.source = "model";
  doc.generator = [...generators].join("+") || "unknown";
  doc.updatedAt = new Date().toISOString().slice(0, 10);

  writeFileSync(join(root, "public", `quiz-${chapter}.json`), JSON.stringify(doc, null, 2) + "\n");
  totalErrors += errors.length;
  console.log(
    `第 ${chapter} 章：${loaded}/${files.length} 片 → ${Object.keys(doc.items).length} 词条，` +
      `generator=${doc.generator}；校验 error ${errors.length} / warning ${warnings.length}`
  );
  for (const e of errors) console.log(`  ✖ ${e}`);
}
console.log(totalErrors ? `\n完成，共 ${totalErrors} 条校验错误待逐题修复（先修再 merge 收口）` : "\n完成，全部通过校验");
