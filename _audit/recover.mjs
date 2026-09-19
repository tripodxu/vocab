// @ts-check
/**
 * _audit/recover.mjs —— 对比「当前 public/quiz-N.json」与「只合并 content/quiz 原始分片」的质量
 * 用于判断：把 -fix-* 产物撤下来、回到原始模型产出，是否更好（以及覆盖率损失多少）。
 */
import { readFile, readdir } from "node:fs/promises";

const normalize = (t) => String(t ?? "").replace(/[\s\u3000]+/g, "")
  .replace(/[，,；;、。.．··:：!！?？"'“”‘’()（）[\]【】<>《》/\\|-]/g, "").toLowerCase();
const grams = (text) => { const s = normalize(text); const o = new Set(); for (let i = 0; i < s.length - 1; i++) o.add(s.slice(i, i + 2)); if (!o.size && s) o.add(s); return o; };
const overlap = (a, b) => { const ga = grams(a), gb = grams(b); if (!ga.size || !gb.size) return 0; let h = 0; for (const g of ga) if (gb.has(g)) h++; return h / Math.min(ga.size, gb.size); };
const senses = (t) => String(t ?? "").split(/[，,；;、/|]+/).map((s) => s.trim()).filter((s) => s && !/^[a-zA-Z.·]+$/.test(s)).map(normalize).filter(Boolean);
const stripNeg = (s) => s.replace(/^(不|无|非|未|没|没有|缺乏)/, "");
const NEG = /^(不|无|非|未|没|没有|缺乏)/;
function covered(optionText, answerText) {
  const A = senses(answerText), O = senses(optionText);
  if (!A.length || !O.length) return false;
  if (O.some((o) => NEG.test(o))) return false;
  const As = new Set(A), Astrip = new Set(A.map(stripNeg));
  if (A.some((a) => NEG.test(a))) return false;
  if (O.every((o) => As.has(o))) return true;
  return O.every((o) => A.some((a) => a.includes(o)));
}
const TEMPLATE = /\|(长度修复|修复)\|.*避免最长项可猜|避免最长项可猜|^[A-Za-z][\w' -]* 与 [A-Za-z][\w' -]* 意思有区别$|^[A-Za-z][\w' -]* 词性不同$|同词根但含义不同$|形近但意思不同$|^[A-Za-z][\w' -]* 与 [A-Za-z][\w' -]* 有区别$|但含义侧重不同|形近易混，但实际含义不同|属于同一语义场|^[A-Za-z][\w' -]* 与 [A-Za-z][\w' -]* 不同$|词性不同或用法不同$/;

const tokenIndex = new Map();
const chapters = (await readdir("public")).filter((f) => /^data-\d+\.json$/.test(f)).map((f) => Number(f.match(/\d+/)[0])).sort((a, b) => a - b);
const data = {};
for (const c of chapters) {
  data[c] = JSON.parse(await readFile(`public/data-${c}.json`, "utf8"));
  for (const w of data[c]) {
    const toks = new Set([String(w.word || "").toLowerCase()]);
    for (const m of String(w.root || "").matchAll(/([A-Za-z][A-Za-z-]*)\s*[（(]/g)) toks.add(m[1].toLowerCase().replace(/-$/, ""));
    for (const t of toks) { if (t.length < 3) continue; if (!tokenIndex.has(t)) tokenIndex.set(t, []); tokenIndex.get(t).push(w); }
  }
}

/** 只合并原始分片（形如 N.json / N-1.json，排除 *-fix* 与脚本） */
async function buildOriginal(c) {
  const files = (await readdir("content/quiz")).filter((f) => new RegExp(`^${c}(-\\d+)?\\.json$`).test(f));
  if (!files.length) return null;
  files.sort((a, b) => {
    const na = Number((a.match(/^(\d+)-(\d+)/) || [0, 0, 0])[2] || 0);
    const nb = Number((b.match(/^(\d+)-(\d+)/) || [0, 0, 0])[2] || 0);
    return na - nb;
  });
  const items = {};
  for (const f of files) {
    const doc = JSON.parse(await readFile(`content/quiz/${f}`, "utf8"));
    Object.assign(items, doc.items || {});
  }
  return { items, files };
}

function audit(itemsByChapter) {
  const R = { items: 0, total: 0, aligned: 0, template: 0, hardAmbig: 0, softAmbig: 0, lenLow: 0, lenHigh: 0, covered: 0 };
  for (const c of chapters) {
    const items = itemsByChapter[c]?.items || {};
    for (const [id, it] of Object.entries(items)) {
      const w = data[c].find((x) => String(x.id) === id);
      if (!w) continue;
      R.items++;
      const nAnswer = normalize(w.meaningCN).length;
      for (const d of it.distractors || []) {
        R.total++;
        const text = String(d.text ?? ""), why = String(d.why ?? "");
        if (TEMPLATE.test(why)) R.template++;
        if (covered(text, w.meaningCN)) { R.hardAmbig++; R.covered++; }
        else { const ov = overlap(text, w.meaningCN); if (ov >= 0.5) R.softAmbig++; }
        const named = new Set();
        for (const m of why.matchAll(/[A-Za-z][A-Za-z-]{2,}/g)) {
          const raw = m[0].toLowerCase().replace(/-$/, "");
          if (tokenIndex.has(raw)) for (const h of tokenIndex.get(raw)) named.add(h);
          else if (raw.length >= 4) for (const [tok, list] of tokenIndex) if (tok.startsWith(raw)) for (const h of list) named.add(h);
        }
        const ok = overlap(why, text) > 0 || [...named].some((n) => n.word === normalize(text) || overlap(n.meaningCN, text) > 0);
        if (ok) R.aligned++;
        const r = normalize(text).length / Math.max(1, nAnswer);
        if (r < 0.5) R.lenLow++;
        if (r > 2.0) R.lenHigh++;
      }
    }
  }
  return R;
}

const current = {};
for (const c of chapters) current[c] = JSON.parse(await readFile(`public/quiz-${c}.json`, "utf8"));
const original = {};
const cov = {};
for (const c of chapters) {
  const o = await buildOriginal(c);
  original[c] = o || { items: {} };
  const lib = data[c].length;
  cov[c] = { shards: o?.files.length ?? 0, items: Object.keys(o?.items || {}).length, lib };
}

const A = audit(current), B = audit(original);
const pct = (n, d) => (d ? ((n / d) * 100).toFixed(1) : "0.0");
const show = (label, R) => {
  console.log(`\n--- ${label} ---`);
  console.log(`  条目 ${R.items}  干扰项 ${R.total}`);
  console.log(`  机器模板 why      ${R.template}  (${pct(R.template, R.total)}%)`);
  console.log(`  why 与选项不一致  ${R.total - R.aligned}  (${pct(R.total - R.aligned, R.total)}%)`);
  console.log(`  硬歧义（选项=答案）${R.hardAmbig}  (${pct(R.hardAmbig, R.total)}%)`);
  console.log(`  软歧义（近义改写）${R.softAmbig}  (${pct(R.softAmbig, R.total)}%)`);
  console.log(`  长度比不合格      <0.5:${R.lenLow}  >2.0:${R.lenHigh}`);
};
show("当前 public/quiz-N.json", A);
show("只合并原始分片（撤掉所有 *-fix-*）", B);

console.log("\n=== 原始分片覆盖率（能否无损回退）===");
console.log("章节  原始分片数  原始条目/词库");
for (const c of chapters) console.log(`ch${String(c).padStart(2)}   ${String(cov[c].shards).padStart(6)}      ${cov[c].items}/${cov[c].lib}`);
const miss = chapters.reduce((a, c) => a + (cov[c].lib - cov[c].items), 0);
console.log(`\n原始分片缺口合计 ${miss} 词（回退后这些词将退回前端自动兜底）`);
