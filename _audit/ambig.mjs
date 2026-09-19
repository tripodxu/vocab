// @ts-check
/**
 * _audit/ambig.mjs —— "两个选项都说得通"的硬检测
 *
 * 校验器只做「拼接后子串包含」，抓不到两种真实歧义：
 *   (a) 义项集合被正确答案**覆盖**（顺序/标点不同就漏）—— 例：正确「遥远的；偏僻的；疏远的」 vs 选项「遥远的；疏远的」
 *   (b) 义项是答案义项的近义改写（画布 vs 帆布）
 * 这里按「义项集合」判：(a) 为硬缺陷，(b) 按二元组重合度给出软提示。
 * 反义项（答案是"不X"、选项是"X"，或"动物群/植物群"）不算歧义，单独排除。
 */
import { readFile, readdir, writeFile } from "node:fs/promises";

const normalize = (t) => String(t ?? "").replace(/[\s\u3000]+/g, "")
  .replace(/[，,；;、。.．··:：!！?？"'“”‘’()（）[\]【】<>《》/\\|-]/g, "").toLowerCase();
const grams = (text) => { const s = normalize(text); const o = new Set(); for (let i = 0; i < s.length - 1; i++) o.add(s.slice(i, i + 2)); if (!o.size && s) o.add(s); return o; };
const overlap = (a, b) => { const ga = grams(a), gb = grams(b); if (!ga.size || !gb.size) return 0; let h = 0; for (const g of ga) if (gb.has(g)) h++; return h / Math.min(ga.size, gb.size); };

/** 拆义项：按标点切分，去掉词性标记（v. / n. / adj. 等）与空段 */
function senses(text) {
  return String(text ?? "")
    .split(/[，,；;、/|]+/)
    .map((s) => s.trim())
    .filter((s) => s && !/^[a-zA-Z.·]+$/.test(s))
    .map(normalize)
    .filter(Boolean);
}
/** 去掉开头的否定标记（判断"不X"与"X"的反义关系） */
const stripNeg = (s) => s.replace(/^(不|无|非|未|没|没有|缺乏)/, "");
const NEG = /^(不|无|非|未|没|没有|缺乏)/;

/**
 * 选项是否被正确答案的义项集合覆盖
 * @returns {"covered"|"negation"|null}
 */
function coverage(optionText, answerText) {
  const A = senses(answerText), O = senses(optionText);
  if (!A.length || !O.length) return null;
  const Aexact = new Set(A);
  if (O.every((o) => Aexact.has(o))) return "covered";
  // 答案义项里含否定标记、去掉后与选项义项相同 → 反义，不算歧义
  const Astrip = new Set(A.map(stripNeg));
  if (O.some((o) => NEG.test(o))) return null;
  if (O.every((o) => Astrip.has(o)) && A.some((a) => NEG.test(a) && Astrip.has(stripNeg(a)))) return "negation";
  // 包含关系（选项义项是答案某个义项的子串）
  if (O.every((o) => A.some((a) => a.includes(o)))) {
    const anyNeg = A.some((a) => NEG.test(a)) || O.some((o) => NEG.test(o));
    return anyNeg ? "negation" : "covered";
  }
  return null;
}

const chapters = (await readdir("public")).filter((f) => /^data-\d+\.json$/.test(f)).map((f) => Number(f.match(/\d+/)[0])).sort((a, b) => a - b);
const data = {}, q = {};
for (const c of chapters) {
  data[c] = JSON.parse(await readFile(`public/data-${c}.json`, "utf8"));
  q[c] = JSON.parse(await readFile(`public/quiz-${c}.json`, "utf8"));
}

const T = { total: 0, covered: 0, soft50: 0, soft34: 0, negation: 0 };
const per = {}, samplesCovered = [], samplesSoft = [];

for (const c of chapters) {
  const st = { total: 0, covered: 0, soft50: 0, soft34: 0 };
  for (const [id, it] of Object.entries(q[c].items)) {
    const w = data[c].find((x) => String(x.id) === id);
    if (!w) continue;
    for (const d of it.distractors || []) {
      T.total++; st.total++;
      const cov = coverage(d.text, w.meaningCN);
      const ov = overlap(d.text, w.meaningCN);
      if (cov === "negation") { T.negation++; continue; }
      if (cov === "covered") {
        T.covered++; st.covered++;
        samplesCovered.push({ c, id, word: w.word, answer: w.meaningCN, text: d.text, kind: d.kind, why: d.why, ov: +ov.toFixed(2) });
        continue;
      }
      if (ov >= 0.5) { T.soft50++; st.soft50++; if (samplesSoft.length < 400) samplesSoft.push({ c, id, word: w.word, answer: w.meaningCN, text: d.text, kind: d.kind, why: d.why, ov: +ov.toFixed(2) }); }
      else if (ov >= 0.34) { T.soft34++; st.soft34++; }
    }
  }
  per[c] = st;
}

const pct = (n, d) => (d ? ((n / d) * 100).toFixed(1) : "0.0");
await writeFile("_audit/ambig-report.json", JSON.stringify({ T, per, samplesCovered, samplesSoft }, null, 1), "utf8");

console.log("=== 「两个选项都说得通」检测（%d 个干扰项）===".replace("%d", String(T.total)));
console.log(`硬缺陷：选项义项被正确答案完全覆盖   ${T.covered}  (${pct(T.covered, T.total)}%)`);
console.log(`软提示：义项重合 ≥50%（近义改写）      ${T.soft50}  (${pct(T.soft50, T.total)}%)`);
console.log(`软提示：义项重合 34~50%                ${T.soft34}  (${pct(T.soft34, T.total)}%)`);
console.log(`已排除的反义配对（不算歧义）           ${T.negation}`);
console.log("\n章节   干扰项   硬缺陷");
for (const c of chapters) console.log(`ch${String(c).padStart(2)}  ${String(per[c].total).padStart(6)}  ${String(per[c].covered).padStart(6)}`);
console.log("\n=== 硬缺陷样例（30）===");
for (const s of samplesCovered.slice(0, 30)) {
  console.log(`ch${s.c} #${s.id} ${s.word}  [${s.kind}]`);
  console.log(`   正确「${s.answer}」`);
  console.log(`   选项「${s.text}」  ← 选它在语义上也是对的`);
}
