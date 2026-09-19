// s5-universal.mjs —— 万能干扰项：同一释义在章内被反复用作错误选项
import { loadAll, writeOut, normalize } from "./lib.mjs";

const { chapters, data, quiz } = await loadAll();

const perChapterTop = [];
const globalMap = new Map(); // text -> { total, chapters: Map c->n, uses: [ {c,id,word} ](前若干) }

for (const c of chapters) {
  const byId = new Map(data.get(c).map((w) => [Number(w.id), w]));
  const cnt = new Map(); // norm text -> { n, uses: [] }
  for (const [id, item] of Object.entries(quiz.get(c).items || {})) {
    const w = byId.get(Number(id));
    for (const d of item.distractors || []) {
      const k = normalize(d?.text);
      if (!k) continue;
      if (!cnt.has(k)) cnt.set(k, { n: 0, uses: [] });
      const e = cnt.get(k);
      e.n++;
      if (e.uses.length < 6) e.uses.push({ c, id, word: w?.word });
    }
  }
  const top = [...cnt.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 8)
    .map(([text, e]) => ({ text, n: e.n, uses: e.uses }));
  perChapterTop.push({ c, top });
  for (const [text, e] of cnt) {
    if (!globalMap.has(text)) globalMap.set(text, { text, total: 0, chapters: {} });
    const g = globalMap.get(text);
    g.total += e.n;
    g.chapters[c] = e.n;
  }
}

const globalTop20 = [...globalMap.values()].sort((a, b) => b.total - a.total).slice(0, 20);
const allSorted = [...globalMap.values()].sort((a, b) => b.total - a.total);
const ge8Global = allSorted.filter((g) => g.total >= 8);
const ge8InChapter = allSorted.filter((g) => Object.values(g.chapters).some((n) => n >= 8));
await writeOut("s5-universal.json", JSON.stringify({ globalTop20, ge8GlobalN: ge8Global.length, ge8InChapterN: ge8InChapter.length, perChapterTop }, null, 1));
console.log("global top20:");
for (const g of globalTop20) console.log(`  ${g.total}  ${JSON.stringify(g.text)}  ch=${Object.entries(g.chapters).map(([c, n]) => c + ":" + n).join(",")}`);
console.log(`kinds with total>=8: ${ge8Global.length}; with in-chapter>=8: ${ge8InChapter.length}`);
