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
const S = { total: 0, aligned: 0, misNamed: 0, misNoLemma: 0, misNoLemmaOverlapsAnswer: 0 };
const namedBad = [], noLemmaBad = [];
for (const c of chapters) {
  for (const [id, it] of Object.entries(q[c].items)) {
    const w = data[c].find((x) => String(x.id) === id);
    if (!w) continue;
    for (const d of it.distractors || []) {
      S.total++;
      const text = String(d.text ?? ""), why = String(d.why ?? "");
      const named = new Set();
      for (const m of why.matchAll(/[A-Za-z][A-Za-z-]{2,}/g)) {
        const raw = m[0].toLowerCase().replace(/-$/, "");
        if (tokenIndex.has(raw)) for (const h of tokenIndex.get(raw)) named.add(h);
        else if (raw.length >= 4) for (const [tok, list] of tokenIndex) if (tok.startsWith(raw)) for (const h of list) named.add(h);
      }
      const ok = overlap(why, text) > 0 || [...named].some((n) => n.word === normalize(text) || overlap(n.meaningCN, text) > 0);
      if (ok) { S.aligned++; continue; }
      const row = { c, id, word: w.word, answer: w.meaningCN, text, kind: d.kind, why, named: [...named].map((n) => n.word).slice(0, 3) };
      if (named.size > 0) { S.misNamed++; namedBad.push(row); }
      else { S.misNoLemma++; noLemmaBad.push(row); if (overlap(why, w.meaningCN) > 0) S.misNoLemmaOverlapsAnswer++; }
    }
  }
}
const pct = (n, d) => ((n / d) * 100).toFixed(1);
console.log(`干扰项总数 ${S.total}`);
console.log(`  一致                        ${S.aligned}  (${pct(S.aligned, S.total)}%)`);
console.log(`  【可自动验证】why 点名词≠选项  ${S.misNamed}  (${pct(S.misNamed, S.total)}%)  ← 硬缺陷下限`);
console.log(`  【无法自动验证】why 无词库内词 ${S.misNoLemma}  (${pct(S.misNoLemma, S.total)}%)`);
console.log(`      其中 why 讲的是正确答案   ${S.misNoLemmaOverlapsAnswer}`);
console.log("\n=== 可自动验证的硬缺陷样例（18）===");
const step = Math.max(1, Math.floor(namedBad.length / 18));
for (let i = 0; i < namedBad.length && i / step < 18; i += step) {
  const x = namedBad[i];
  console.log(`ch${x.c} #${x.id} ${x.word}「${x.answer}」`);
  console.log(`     选项「${x.text}」  辨析「${x.why}」 ← 讲的是 ${x.named.join("/")}`);
}
console.log("\n=== 无法自动验证的样例（14，人工看）===");
const step2 = Math.max(1, Math.floor(noLemmaBad.length / 14));
for (let i = 0; i < noLemmaBad.length && i / step2 < 14; i += step2) {
  const x = noLemmaBad[i];
  console.log(`ch${x.c} #${x.id} ${x.word}「${x.answer}」`);
  console.log(`     选项「${x.text}」  辨析「${x.why}」`);
}
