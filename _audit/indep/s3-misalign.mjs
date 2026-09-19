// s3-misalign.mjs —— why 与所挂选项错位（indep 口径 + strict 兼容口径）
// indep 判据：why 含英文 token(≥3字母) 且全部能在词库解析；
//   且解析出的词 meaningCN 与该干扰项 text 归一化后无重合（含 word===text 的不可能情形），
//   且也不与本题正确释义相关（无重合、也不是目标词本身）→ 疑似错位（hard）。
//   若解析出的词与正确释义相关（在讲目标词/其近亲）→ 单列为 answerRelated（不算 hard）。
// strict 兼容口径 = hard + answerRelated（即不排除“讲的是目标词”），用于与 _audit/strict.mjs 916 对比。
import { loadAll, writeOut, buildTokenIndex, resolveWhy, minOverlap, normalize, pct } from "./lib.mjs";

const { chapters, data, quiz } = await loadAll();
const idx = buildTokenIndex(data);

const T = { dist: 0, noEnglish: 0, unresolved: 0, alignedByCN: 0, alignedByWord: 0, answerRelated: 0, hard: 0 };
const perChapterHard = new Map(chapters.map((c) => [c, 0]));
const perChapterStrict = new Map(chapters.map((c) => [c, 0]));
const hardSamples = [];
const allRecords = [];

for (const c of chapters) {
  const byId = new Map(data.get(c).map((w) => [Number(w.id), w]));
  for (const [id, item] of Object.entries(quiz.get(c).items || {})) {
    const w = byId.get(Number(id));
    if (!w) continue;
    for (const d of item.distractors || []) {
      T.dist++;
      const text = String(d?.text ?? ""), why = String(d?.why ?? "");
      if (minOverlap(why, text) > 0) { T.alignedByCN++; continue; }
      const r = resolveWhy(why, idx);
      if (!r.tokens.length) { T.noEnglish++; continue; }
      if (!r.allResolved) { T.unresolved++; continue; }
      const matchesOption = [...r.named].some(
        (n) => n.word === normalize(text) || minOverlap(n.meaningCN, text) > 0
      );
      if (matchesOption) { T.alignedByWord++; continue; }
      const matchesAnswer = [...r.named].some(
        (n) => String(n.id) === String(w.id) || minOverlap(n.meaningCN, w.meaningCN) > 0
      );
      const rec = { c, id, word: w.word, answer: w.meaningCN, text, kind: d.kind, why, named: [...r.named].slice(0, 4).map((n) => n.word) };
      if (matchesAnswer) {
        T.answerRelated++;
        perChapterStrict.set(c, perChapterStrict.get(c) + 1);
      } else {
        T.hard++;
        perChapterHard.set(c, perChapterHard.get(c) + 1);
        perChapterStrict.set(c, perChapterStrict.get(c) + 1);
        if (hardSamples.length < 12) hardSamples.push(rec);
      }
      allRecords.push(rec);
    }
  }
}

const strictCompat = T.hard + T.answerRelated;
const byChapterHard = [...perChapterHard.entries()].sort((a, b) => b[1] - a[1]);
const out = {
  ...T, strictCompat,
  hardPct: pct(T.hard, T.dist),
  strictPct: pct(strictCompat, T.dist),
  byChapterHard: byChapterHard,
  hardSamples,
};
await writeOut("s3-misalign.json", JSON.stringify(out, null, 1));
await writeOut("s3-misalign-all.jsonl", allRecords.map((r) => JSON.stringify(r)).join("\n"));
console.log(`dist=${T.dist} noEnglish=${T.noEnglish} unresolved=${T.unresolved} alignedByCN=${T.alignedByCN} alignedByWord=${T.alignedByWord}`);
console.log(`indep hard misalign=${T.hard} (${pct(T.hard, T.dist)}%)  answerRelated=${T.answerRelated}`);
console.log(`strict-compat=${strictCompat} (${pct(strictCompat, T.dist)}%)`);
for (const [c, n] of byChapterHard.slice(0, 8)) console.log(`  ch${c}: hard=${n}`);
