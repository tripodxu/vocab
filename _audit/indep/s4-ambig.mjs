// s4-ambig.mjs —— 歧义扫描
// A1 子串：归一化后 选项text 与 本题正确释义 互为子串（含相等）
// A2 义项覆盖：选项义项集合被正确答案义项集合覆盖（ambig.mjs 口径 → 对应报告“49 条硬歧义”）
// A3 高度相似：char-bigram 真 Jaccard(text, 正确释义) ≥ 0.6（任务口径第 2 支）
// A4 借自近义词：text 与另一词库词释义逐字相同，且该词释义与本题正确释义 Jaccard ≥ 0.6
// 硬歧义并集 = A1 ∪ A2 ∪ A3（A4 独立计数）
import { loadAll, writeOut, normalize, jaccard, senseCover, pct } from "./lib.mjs";

const { chapters, data, quiz } = await loadAll();

// 全库释义索引（归一化 → 词列表）
const meaningIndex = new Map();
for (const [, words] of data) {
  for (const w of words) {
    const k = normalize(w.meaningCN);
    if (!k) continue;
    if (!meaningIndex.has(k)) meaningIndex.set(k, []);
    meaningIndex.get(k).push(w);
  }
}

const T = { dist: 0, a1: 0, a2: 0, a3: 0, a4: 0, negation: 0, union: 0 };
const perChapter = new Map(chapters.map((c) => [c, 0]));
const samples = [];
const allA = [];

for (const c of chapters) {
  const words = data.get(c);
  const byId = new Map(words.map((w) => [Number(w.id), w]));
  for (const [id, item] of Object.entries(quiz.get(c).items || {})) {
    const w = byId.get(Number(id));
    if (!w) continue;
    for (const d of item.distractors || []) {
      T.dist++;
      const text = String(d?.text ?? ""), answer = String(w.meaningCN ?? "");
      const nt = normalize(text), na = normalize(answer);
      let a1 = false, a2 = false, a3 = false, a4 = false;
      if (nt && na && (nt === na || nt.includes(na) || na.includes(nt))) a1 = true;
      const cov = senseCover(text, answer);
      if (cov === "covered") a2 = true;
      else if (cov === "negation") T.negation++;
      if (!a1 && !a2 && jaccard(text, answer) >= 0.6) a3 = true;
      if (!a1 && !a2 && meaningIndex.has(nt)) {
        for (const w2 of meaningIndex.get(nt)) {
          if (String(w2.id) === String(w.id) || w2.meaningCN === answer) continue;
          if (jaccard(w2.meaningCN, answer) >= 0.6) { a4 = true; break; }
        }
      }
      if (a1) T.a1++;
      if (a2) T.a2++;
      if (a3) T.a3++;
      if (a4) T.a4++;
      if (a1 || a2 || a3) {
        T.union++;
        perChapter.set(c, perChapter.get(c) + 1);
        const rec = { c, id, word: w.word, answer, text, kind: d.kind, why: d.why, hit: [a1 && "A1", a2 && "A2", a3 && "A3"].filter(Boolean).join("+") };
        allA.push(rec);
        if (samples.length < 15) samples.push(rec);
      }
    }
  }
}

const byChapter = [...perChapter.entries()].sort((a, b) => b[1] - a[1]);
await writeOut("s4-ambig.json", JSON.stringify({ ...T, unionPct: pct(T.union, T.dist), byChapter, samples, all: allA }, null, 1));
console.log(`dist=${T.dist} A1=${T.a1} A2=${T.a2} A3=${T.a3} union=${T.union} (${pct(T.union, T.dist)}%) A4=${T.a4} negationExcluded=${T.negation}`);
for (const [c, n] of byChapter.slice(0, 8)) console.log(`  ch${c}: ${n}`);
