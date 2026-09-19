// @ts-check
/**
 * _audit/desync2.mjs —— 精确量化 + 归因
 *
 * 核心指标：**这条 why 到底在不在解释它挂着的那个选项？**
 *   aligned  = why 的中文与选项释义有二元组重合，或 why 点名的英文词/词根正是该选项的来源词
 *   misaligned = 否则
 *     其中再分：why 与"正确释义"有重合（讲的是答案或第三个词）/ 与两者都无关
 *
 * 归因：把 public/quiz-N.json 与 content/quiz 的**原始模型分片**（N.json / N-2.json …，
 * 不含 *-fix-* 与 *-analysis）对比，得到每个干扰项是"原始保留"还是"被脚本替换"。
 */
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = path.join(root, "public");
const contentDir = path.join(root, "content", "quiz");

const normalizeMeaning = (t) =>
  String(t ?? "").replace(/[\s\u3000]+/g, "")
    .replace(/[，,；;、。.．·・:：!！?？"'“”‘’()（）[\]【】<>《》/\\|-]/g, "").toLowerCase();
const grams = (text) => {
  const s = normalizeMeaning(text); const out = new Set();
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  return out;
};
const overlap = (a, b) => {
  const ga = grams(a), gb = grams(b);
  if (!ga.size || !gb.size) return 0;
  let hit = 0; for (const g of ga) if (gb.has(g)) hit++;
  return hit / Math.min(ga.size, gb.size);
};
const rootTokens = (entry) => {
  const out = new Set();
  for (const m of String(entry?.root || "").matchAll(/([A-Za-z][A-Za-z-]*)\s*[（(]/g)) {
    const t = m[1].toLowerCase().replace(/-$/, "");
    if (t.length >= 3) out.add(t);
  }
  return out;
};

const chapters = (await readdir(publicDir)).filter((f) => /^data-\d+\.json$/.test(f))
  .map((f) => Number(f.match(/\d+/)[0])).sort((a, b) => a - b);

const data = {}, quizzes = {};
const tokenIndex = new Map(), meaningIndex = new Map();
for (const c of chapters) {
  data[c] = JSON.parse(await readFile(path.join(publicDir, `data-${c}.json`), "utf8"));
  quizzes[c] = JSON.parse(await readFile(path.join(publicDir, `quiz-${c}.json`), "utf8"));
  for (const w of data[c]) {
    meaningIndex.set(normalizeMeaning(w.meaningCN), w);
    for (const t of new Set([String(w.word || "").toLowerCase(), ...rootTokens(w)])) {
      if (t.length < 3) continue;
      if (!tokenIndex.has(t)) tokenIndex.set(t, []);
      tokenIndex.get(t).push(w);
    }
  }
}

/* ---------- 原始模型分片（按文件名顺序合并） ---------- */
const files = (await readdir(contentDir)).filter((f) => /^\d+(-\d+)?\.json$/.test(f));
const original = {}; // chapter -> { id -> [text,...] }
for (const f of files.sort()) {
  const c = Number(f.match(/^\d+/)[0]);
  const doc = JSON.parse(await readFile(path.join(contentDir, f), "utf8"));
  original[c] = original[c] || {};
  for (const [id, item] of Object.entries(doc.items || {})) {
    original[c][id] = (item.distractors || []).map((d) => normalizeMeaning(d.text));
  }
}

function namedWordsOf(why) {
  const named = new Set();
  for (const m of why.matchAll(/[A-Za-z][A-Za-z-]{2,}/g)) {
    const raw = m[0].toLowerCase().replace(/-$/, "");
    if (tokenIndex.has(raw)) for (const h of tokenIndex.get(raw)) named.add(h);
    else if (raw.length >= 4) {
      for (const [tok, list] of tokenIndex) {
        if (tok.startsWith(raw)) for (const h of list) named.add(h);
      }
    }
  }
  return [...named];
}

const rows = [];
const per = {};
const T = { total: 0, aligned: 0, misToTarget: 0, misUnrelated: 0,
  kept: 0, replaced: 0, keptBad: 0, replacedBad: 0, unresolvedSource: 0 };

for (const c of chapters) {
  const words = data[c], doc = quizzes[c];
  const st = { total: 0, aligned: 0, misToTarget: 0, misUnrelated: 0, kept: 0, replaced: 0, keptBad: 0, replacedBad: 0 };
  const meaningToEntry = new Map(words.map((w) => [normalizeMeaning(w.meaningCN), w]));

  for (const [id, item] of Object.entries(doc.items || {})) {
    const entry = words.find((w) => String(w.id) === id);
    if (!entry) continue;
    const origTexts = new Set(original[c]?.[id] || []);

    for (const d of item.distractors || []) {
      T.total++; st.total++;
      const text = String(d.text ?? ""), why = String(d.why ?? "");
      const nText = normalizeMeaning(text);
      const src = meaningToEntry.get(nText) || (() => {
        let best = null, bo = 0;
        for (const w of words) { const o = overlap(text, w.meaningCN); if (o > bo) { bo = o; best = w; } }
        return bo >= 0.6 ? best : null;
      })();
      if (!src) { T.unresolvedSource++; }
      const named = namedWordsOf(why);
      const ovText = overlap(why, text);
      const ovTarget = overlap(why, entry.meaningCN);
      const aligned = ovText > 0 || (src && named.some((n) => n.word === src.word));
      const wasReplaced = origTexts.size > 0 && !origTexts.has(nText);
      if (origTexts.size > 0) { if (wasReplaced) { T.replaced++; st.replaced++; } else { T.kept++; st.kept++; } }

      if (aligned) { T.aligned++; st.aligned++; }
      else {
        if (wasReplaced) { T.replacedBad++; st.replacedBad++; } else if (origTexts.size > 0) { T.keptBad++; st.keptBad++; }
        if (ovTarget > 0) { T.misToTarget++; st.misToTarget++; }
        else { T.misUnrelated++; st.misUnrelated++; }
        rows.push({ chapter: c, id, word: entry.word, answer: entry.meaningCN, kind: d.kind, text, why, textSource: src?.word ?? null, replaced: wasReplaced, named: named.map((n) => n.word).slice(0, 3) });
      }
    }
  }
  per[c] = st;
}

const pct = (n, d) => (d ? ((n / d) * 100).toFixed(1) : "0.0");
const mis = T.misToTarget + T.misUnrelated;

await writeFile(path.join(root, "_audit", "desync2-report.json"), JSON.stringify({ T, per, samples: rows }, null, 1), "utf8");

console.log("=== 辨析（why）与所挂选项的一致性 ===");
console.log(`干扰项总数            ${T.total}`);
console.log(`why 与选项一致        ${T.aligned}  (${pct(T.aligned, T.total)}%)`);
console.log(`why 与选项不一致      ${mis}  (${pct(mis, T.total)}%)`);
console.log(`   ├ why 讲的是正确答案/别的词  ${T.misToTarget}  (${pct(T.misToTarget, T.total)}%)`);
console.log(`   └ why 与选项和答案都无关    ${T.misUnrelated}  (${pct(T.misUnrelated, T.total)}%)`);
console.log(`选项释义在词库里找不到来源词  ${T.unresolvedSource}  (${pct(T.unresolvedSource, T.total)}%)`);

console.log("\n=== 归因：原始保留 vs 被修复脚本替换 ===");
console.log(`原始保留 ${T.kept}，其中 why 不一致 ${T.keptBad} (${pct(T.keptBad, T.kept)}%)`);
console.log(`被替换   ${T.replaced}，其中 why 不一致 ${T.replacedBad} (${pct(T.replacedBad, T.replaced)}%)`);

console.log("\n章节  干扰项  一致   不一致  其中讲错词  |  原始保留/坏  被替换/坏");
for (const c of chapters) {
  const s = per[c];
  console.log(
    `ch${String(c).padStart(2)} ${String(s.total).padStart(5)}  ${String(s.aligned).padStart(5)}  ${String(s.misToTarget + s.misUnrelated).padStart(6)}  ${String(s.misToTarget).padStart(9)}  |  ${String(s.kept).padStart(6)}/${String(s.keptBad).padStart(4)}  ${String(s.replaced).padStart(6)}/${String(s.replacedBad).padStart(4)}`);
}
