import { readFile, readdir } from "node:fs/promises";

const normalizeMeaning = (t) => String(t ?? "").replace(/[\s\u3000]+/g, "")
  .replace(/[，,；;、。.．··:：!！?？"'“”‘’()（）[\]【】<>《》/\\|-]/g, "").toLowerCase();
const grams = (text) => { const s = normalizeMeaning(text); const o = new Set(); for (let i = 0; i < s.length - 1; i++) o.add(s.slice(i, i + 2)); if (!o.size && s) o.add(s); return o; };
const overlap = (a, b) => { const ga = grams(a), gb = grams(b); if (!ga.size || !gb.size) return 0; let h = 0; for (const g of ga) if (gb.has(g)) h++; return h / Math.min(ga.size, gb.size); };

const chapters = (await readdir("public")).filter((f) => /^data-\d+\.json$/.test(f)).map((f) => Number(f.match(/\d+/)[0])).sort((a, b) => a - b);
const data = {}, q = {};
const meaningIndex = new Set();
for (const c of chapters) {
  data[c] = JSON.parse(await readFile(`public/data-${c}.json`, "utf8"));
  q[c] = JSON.parse(await readFile(`public/quiz-${c}.json`, "utf8"));
  for (const w of data[c]) meaningIndex.add(normalizeMeaning(w.meaningCN));
}

const mode = process.argv[2];
if (mode === "untraceable") {
  const out = [];
  for (const c of chapters) for (const [id, it] of Object.entries(q[c].items)) {
    const w = data[c].find((x) => String(x.id) === id);
    for (const d of it.distractors) {
      const n = normalizeMeaning(d.text);
      if (meaningIndex.has(n)) continue;
      let bo = 0; for (const x of data[c]) { const o = overlap(d.text, x.meaningCN); if (o > bo) bo = o; }
      if (bo < 0.6) out.push(`ch${c} #${id} ${w.word}「${w.meaningCN}」\n      选项「${d.text}」 [${d.kind}] why=「${d.why}」`);
    }
  }
  console.log(`无法追溯到词库的选项共 ${out.length} 条，随机抽样 22 条：\n`);
  const step = Math.max(1, Math.floor(out.length / 22));
  for (let i = 0; i < out.length && i / step < 22; i += step) console.log("  " + out[i]);
}

if (mode === "ambig") {
  const rows = [];
  for (const c of chapters) for (const [id, it] of Object.entries(q[c].items)) {
    const w = data[c].find((x) => String(x.id) === id);
    for (const d of it.distractors) {
      const o = overlap(d.text, w.meaningCN);
      if (o >= 0.34) rows.push({ o, s: `ch${c} #${id} ${w.word}\n      正确「${w.meaningCN}」\n      选项「${d.text}」 [${d.kind}] 重合${(o * 100).toFixed(0)}%` });
    }
  }
  rows.sort((a, b) => b.o - a.o);
  console.log(`歧义风险 ${rows.length} 条，按重合度从高到低取 25 条：\n`);
  for (const r of rows.slice(0, 25)) console.log("  " + r.s);
}

if (mode === "note") {
  let miss = 0; const gaps = [];
  for (const c of chapters) for (const [id, it] of Object.entries(q[c].items)) {
    if (!it.note) { miss++; const w = data[c].find((x) => String(x.id) === id); if (gaps.length < 15) gaps.push(`ch${c} #${id} ${w?.word}（词库 root: ${w?.root || "无"}）`); }
  }
  console.log(`无 note 的条目 ${miss}；样例：`); for (const g of gaps) console.log("  " + g);
}
