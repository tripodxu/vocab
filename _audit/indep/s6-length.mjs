// s6-length.mjs —— 长度比与位置泄漏
// ratio = 归一化(选项text).length / 归一化(正确释义).length
// lenLow: ratio<0.5；lenHigh: ratio>2.0；answerLongest: 3 个干扰项归一化长度全部 < 正确释义
import { loadAll, writeOut, normalize, pct } from "./lib.mjs";

const { chapters, data, quiz } = await loadAll();

const T = { dist: 0, lenLow: 0, lenHigh: 0, items: 0, answerLongest: 0 };
const perChapter = [];
const lowSamples = [], highSamples = [];

for (const c of chapters) {
  const byId = new Map(data.get(c).map((w) => [Number(w.id), w]));
  const st = { c, dist: 0, lenLow: 0, lenHigh: 0, items: 0, answerLongest: 0 };
  for (const [id, item] of Object.entries(quiz.get(c).items || {})) {
    const w = byId.get(Number(id));
    if (!w) continue;
    st.items++; T.items++;
    const answerLen = normalize(w.meaningCN).length || 1;
    let allShorter = true;
    for (const d of item.distractors || []) {
      st.dist++; T.dist++;
      const nLen = normalize(d?.text).length;
      const ratio = nLen / answerLen;
      if (ratio < 0.5) {
        st.lenLow++; T.lenLow++;
        if (lowSamples.length < 5) lowSamples.push({ c, id, word: w.word, answer: w.meaningCN, text: d.text, ratio: +ratio.toFixed(2) });
      }
      if (ratio > 2.0) {
        st.lenHigh++; T.lenHigh++;
        if (highSamples.length < 5) highSamples.push({ c, id, word: w.word, answer: w.meaningCN, text: d.text, ratio: +ratio.toFixed(2) });
      }
      if (nLen >= answerLen) allShorter = false;
    }
    if (allShorter) { st.answerLongest++; T.answerLongest++; }
  }
  st.longestPct = pct(st.answerLongest, st.items);
  perChapter.push(st);
}

perChapter.sort((a, b) => b.longestPct.localeCompare(a.longestPct, undefined, { numeric: true }));
const out = { ...T, lowPct: pct(T.lenLow, T.dist), highPct: pct(T.lenHigh, T.dist), longestPct: pct(T.answerLongest, T.items), perChapter, lowSamples, highSamples };
await writeOut("s6-length.json", JSON.stringify(out, null, 1));
console.log(`dist=${T.dist} lenLow(<0.5)=${T.lenLow} lenHigh(>2.0)=${T.lenHigh}`);
console.log(`answerLongest=${T.answerLongest}/${T.items} (${out.longestPct}%)`);
console.log("chapters by answerLongest%:");
for (const s of perChapter.slice(0, 5)) console.log(`  ch${s.c}: ${s.answerLongest}/${s.items}=${s.longestPct}%`);
console.log("lowest:");
for (const s of perChapter.slice(-3)) console.log(`  ch${s.c}: ${s.answerLongest}/${s.items}=${s.longestPct}%`);
