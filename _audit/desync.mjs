// @ts-check
/**
 * _audit/desync.mjs —— 量化"干扰项 text 与 why 错位"
 *
 * 判定（高精度）：why 里点名的英文词/词根，与干扰项 text 所对应的那个词库词不是同一个词，
 * 且 why 的中文内容与 text、与正确释义都无二元组重合 → 这条 why 在讲另一个词。
 * 另给出（中精度）"why 与 text、与正确释义都毫无用词重合"的兜底计数。
 */
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = path.join(root, "public");

const normalizeMeaning = (t) =>
  String(t ?? "").replace(/[\s\u3000]+/g, "")
    .replace(/[，,；;、。.．·・:：!！?？"'“”‘’()（）[\]【】<>《》/\\|-]/g, "").toLowerCase();
const mlen = (t) => normalizeMeaning(t).length;
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
/** 词形/词根 token → 词条 */
const tokenIndex = new Map();
/** 归一化释义 → 词条 */
const meaningIndex = new Map();
for (const c of chapters) {
  data[c] = JSON.parse(await readFile(path.join(publicDir, `data-${c}.json`), "utf8"));
  quizzes[c] = JSON.parse(await readFile(path.join(publicDir, `quiz-${c}.json`), "utf8"));
  for (const w of data[c]) {
    meaningIndex.set(normalizeMeaning(w.meaningCN), w);
    const toks = new Set([String(w.word || "").toLowerCase(), ...rootTokens(w)]);
    for (const t of toks) {
      if (t.length < 3) continue;
      if (!tokenIndex.has(t)) tokenIndex.set(t, []);
      tokenIndex.get(t).push(w);
    }
  }
}

/**
 * 找到 text 最可能的来源词：先精确，再模糊（释义重合度最高）
 */
function sourceOfText(text, chapterWords) {
  const exact = meaningIndex.get(normalizeMeaning(text));
  if (exact) return { entry: exact, how: "exact" };
  let best = null, bestOv = 0;
  for (const w of chapterWords) {
    const ov = overlap(text, w.meaningCN);
    if (ov > bestOv) { bestOv = ov; best = w; }
  }
  if (best && bestOv >= 0.6) return { entry: best, how: `fuzzy${bestOv.toFixed(2)}` };
  return null;
}

const rows = [];
const perChapter = {};
const totals = { distractors: 0, hardDesync: 0, softDesync: 0, unresolvedText: 0 };

for (const c of chapters) {
  const words = data[c], doc = quizzes[c];
  const st = { distractors: 0, hard: 0, soft: 0, unresolved: 0 };
  for (const [id, item] of Object.entries(doc.items || {})) {
    const entry = words.find((w) => String(w.id) === id);
    if (!entry) continue;
    for (const d of item.distractors || []) {
      totals.distractors++; st.distractors++;
      const text = String(d.text ?? ""), why = String(d.why ?? "");
      const src = sourceOfText(text, words);
      if (!src) { totals.unresolvedText++; st.unresolved++; }

      /* why 点名的英文 token → 它们指向的词条 */
      const named = new Set();
      for (const m of why.matchAll(/[A-Za-z][A-Za-z-]{2,}/g)) {
        const raw = m[0].toLowerCase().replace(/-$/, "");
        const hits = tokenIndex.get(raw);
        if (hits) for (const h of hits) named.add(h);
        else {
          // 前缀匹配（litho → lithosphere）
          for (const [tok, list] of tokenIndex) {
            if (tok.startsWith(raw) && raw.length >= 4) for (const h of list) named.add(h);
          }
        }
      }
      const namedWords = [...named];
      const whyOvText = overlap(why, text);
      const whyOvTarget = overlap(why, entry.meaningCN);

      let hard = false;
      if (src && namedWords.length && whyOvText === 0 && whyOvTarget === 0) {
        const sameFamily = namedWords.some((n) =>
          n.word === src.entry.word ||
          overlap(n.meaningCN, text) > 0 ||
          [...rootTokens(n)].some((t) => [...rootTokens(src.entry)].includes(t)));
        hard = !sameFamily;
      }
      const soft = !hard && whyOvText === 0 && whyOvTarget === 0 && mlen(text) >= 2;

      if (hard) { totals.hardDesync++; st.hard++; rows.push({ chapter: c, id, word: entry.word, answer: entry.meaningCN, kind: d.kind, text, why, textSource: src.entry.word, namedWords: namedWords.map((n) => n.word).slice(0, 3) }); }
      else if (soft) { totals.softDesync++; st.soft++; }
    }
  }
  perChapter[c] = st;
}

await writeFile(path.join(root, "_audit", "desync-report.json"),
  JSON.stringify({ totals, perChapter, rows }, null, 1), "utf8");

console.log("=== text / why 错位 ===");
console.log(`干扰项总数 ${totals.distractors}`);
console.log(`硬错位（why 明确在讲另一个词）${totals.hardDesync}  (${(totals.hardDesync / totals.distractors * 100).toFixed(1)}%)`);
console.log(`软错位（why 与选项、与答案都无用词重合）${totals.softDesync}  (${(totals.softDesync / totals.distractors * 100).toFixed(1)}%)`);
console.log(`text 找不到来源词（疑似生造）${totals.unresolvedText}`);
console.log("\n章节  干扰项  硬错位  软错位");
for (const c of chapters) {
  const s = perChapter[c];
  console.log(`ch${String(c).padStart(2)}  ${String(s.distractors).padStart(5)}  ${String(s.hard).padStart(5)}  ${String(s.soft).padStart(5)}`);
}
console.log("\n=== 硬错位样例（20 条）===");
for (const r of rows.slice(0, 20)) {
  console.log(`ch${r.chapter} #${r.id} ${r.word}「${r.answer}」 kind=${r.kind}`);
  console.log(`   选项: 「${r.text}」 (来自 ${r.textSource})`);
  console.log(`   why : 「${r.why}」  ← 讲的是 ${r.namedWords.join("/")}`);
}
