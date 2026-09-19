import { readFile, readdir } from "node:fs/promises";
const normalize = (t) => String(t ?? "").replace(/[\s\u3000]+/g, "")
  .replace(/[，,；;、。.．··:：!！?？"'“”‘’()（）[\]【】<>《》/\\|-]/g, "").toLowerCase();
const grams = (text) => { const s = normalize(text); const o = new Set(); for (let i = 0; i < s.length - 1; i++) o.add(s.slice(i, i + 2)); if (!o.size && s) o.add(s); return o; };
const overlap = (a, b) => { const ga = grams(a), gb = grams(b); if (!ga.size || !gb.size) return 0; let h = 0; for (const g of ga) if (gb.has(g)) h++; return h / Math.min(ga.size, gb.size); };
const tokenIndex = new Map();
const chapters = (await readdir("public")).filter((f) => /^data-\d+\.json$/.test(f)).map((f) => Number(f.match(/\d+/)[0])).sort((a, b) => a - b);
const data = {}, q = {};
for (const c of chapters) {
  data[c] = JSON.parse(await readFile(`public/data-${c}.json`, "utf8"));
  q[c] = JSON.parse(await readFile(`public/quiz-${c}.json`, "utf8"));
  for (const w of data[c]) {
    const toks = new Set([String(w.word || "").toLowerCase()]);
    for (const m of String(w.root || "").matchAll(/([A-Za-z][A-Za-z-]*)\s*[（(]/g)) toks.add(m[1].toLowerCase().replace(/-$/, ""));
    for (const t of toks) { if (t.length < 3) continue; if (!tokenIndex.has(t)) tokenIndex.set(t, []); tokenIndex.get(t).push(w); }
  }
}
const bad = [];
for (const c of chapters) {
  for (const [id, it] of Object.entries(q[c].items)) {
    const w = data[c].find((x) => String(x.id) === id);
    if (!w) continue;
    for (const d of it.distractors || []) {
      const text = String(d.text ?? ""), why = String(d.why ?? "");
      const named = new Set();
      for (const m of why.matchAll(/[A-Za-z][A-Za-z-]{2,}/g)) {
        const raw = m[0].toLowerCase().replace(/-$/, "");
        if (tokenIndex.has(raw)) for (const h of tokenIndex.get(raw)) named.add(h);
        else if (raw.length >= 4) for (const [tok, list] of tokenIndex) if (tok.startsWith(raw)) for (const h of list) named.add(h);
      }
      const ok = overlap(why, text) > 0 || [...named].some((n) => n.word === normalize(text) || overlap(n.meaningCN, text) > 0);
      if (!ok) bad.push({ c, id, word: w.word, answer: w.meaningCN, text, kind: d.kind, why });
    }
  }
}
console.log(`判定为"why 与所挂选项不一致" 共 ${bad.length} 条；均匀抽样 28 条人工复核：\n`);
const step = Math.max(1, Math.floor(bad.length / 28));
for (let i = 0; i < bad.length && i / step < 28; i += step) {
  const x = bad[i];
  console.log(`ch${x.c} #${x.id} ${x.word}「${x.answer}」 [${x.kind}]`);
  console.log(`     选项「${x.text}」`);
  console.log(`     辨析「${x.why}」\n`);
}
