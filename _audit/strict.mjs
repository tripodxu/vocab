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
let strict = 0, strictAll = 0, anyLemmaUnresolved = 0;
const rows = [];
for (const c of chapters) {
  for (const [id, it] of Object.entries(q[c].items)) {
    const w = data[c].find((x) => String(x.id) === id);
    if (!w) continue;
    for (const d of it.distractors || []) {
      const text = String(d.text ?? ""), why = String(d.why ?? "");
      if (overlap(why, text) > 0) continue;
      const lemmas = [...why.matchAll(/[A-Za-z][A-Za-z-]{2,}/g)].map((m) => m[0].toLowerCase().replace(/-$/, ""));
      if (!lemmas.length) continue;
      // 只保留"每一个英文词都能在词库里认出来"的 why —— 不能认出就可能是选项的真实来源词，无法判定
      let allResolved = true;
      const named = new Set();
      for (const raw of lemmas) {
        if (tokenIndex.has(raw)) { for (const h of tokenIndex.get(raw)) named.add(h); continue; }
        let hit = false;
        if (raw.length >= 4) for (const [tok, list] of tokenIndex) if (tok.startsWith(raw)) { for (const h of list) named.add(h); hit = true; }
        if (!hit) allResolved = false;
      }
      if (!allResolved) { anyLemmaUnresolved++; continue; }
      strictAll++;
      const matchesOption = [...named].some((n) => n.word === normalize(text) || overlap(n.meaningCN, text) > 0);
      if (!matchesOption) {
        strict++; rows.push({ c, id, word: w.word, answer: w.meaningCN, text, why, named: [...named].map((n) => n.word).slice(0, 3) });
      }
    }
  }
}
const total = 10704;
console.log(`【最严格口径】辨析里的英文词全部能在词库中认出，但都不是该选项的来源词：`);
console.log(`  ${strict} / ${total}  (${((strict / total) * 100).toFixed(1)}%)`);
console.log(`  （另有 ${anyLemmaUnresolved} 条含词库外的英文词，无法自动判定；${strictAll} 条可判定）`);
console.log("\n样例（全部 %d 条中取 24）:".replace("%d", String(rows.length)));
const step = Math.max(1, Math.floor(rows.length / 24));
for (let i = 0; i < rows.length && i / step < 24; i += step) {
  const x = rows[i];
  console.log(`ch${x.c} #${x.id} ${x.word}「${x.answer}」`);
  console.log(`     选项「${x.text}」  ←  辨析「${x.why}」（讲的是 ${x.named.join("/")}）`);
}
