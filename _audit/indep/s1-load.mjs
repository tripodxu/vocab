// s1-load.mjs —— 加载全部词库与发布题源，核对总数与 key 完整性
import { loadAll, writeOut, pct } from "./lib.mjs";

const { chapters, data, quiz } = await loadAll();

let totalWords = 0, totalItems = 0, totalDist = 0;
const rows = [];
const keyNotInVocab = [], missingWords = [], badDistCount = [];

for (const c of chapters) {
  const words = data.get(c), doc = quiz.get(c);
  totalWords += words.length;
  const itemIds = Object.keys(doc.items || {});
  totalItems += itemIds.length;
  let dc = 0;
  for (const [id, item] of Object.entries(doc.items || {})) {
    const ds = item.distractors || [];
    dc += ds.length;
    if (ds.length !== 3) badDistCount.push({ c, id, n: ds.length });
    if (!words.some((w) => String(w.id) === String(id))) keyNotInVocab.push({ c, id });
  }
  totalDist += dc;
  const vocabIds = words.map((w) => String(w.id));
  const miss = vocabIds.filter((x) => !(String(x) in (doc.items || {})));
  for (const m of miss) missingWords.push({ c, id: m });
  rows.push({ ch: c, words: words.length, items: itemIds.length, distractors: dc, missing: miss.length });
}

const summary = {
  chapters: chapters.length,
  totalWords, totalItems, totalDist,
  expectWords: 3568, expectDist: 10704,
  wordsMatch: totalWords === 3568,
  distMatch: totalDist === 10704,
  keyNotInVocab, missingWords, badDistCount,
  rows,
};
await writeOut("s1-load.json", JSON.stringify(summary, null, 1));
console.log(`words=${totalWords} (expect 3568, match=${summary.wordsMatch})`);
console.log(`items=${totalItems} distractors=${totalDist} (expect 10704, match=${summary.distMatch})`);
console.log(`keyNotInVocab=${keyNotInVocab.length} missingWords=${missingWords.length} badDistCount=${badDistCount.length}`);
console.log(`coverage=${pct(totalItems, totalWords)}%`);
