// @ts-check
/**
 * _audit/final.mjs —— 认词题源交付质量终审（只读）
 * 输出一份汇总 JSON + 控制台表格，覆盖：
 *  1) 机器模板 why（脚本产物，按正则高精度识别）
 *  2) why 与所挂选项的一致性
 *  3) 歧义风险（选项与正确释义二元组重合 ≥0.34）
 *  4) 选项释义是否可追溯到词库词条
 *  5) kind 标注保真度
 *  6) 长度比 / "正确答案最长"
 *  7) note 覆盖率
 *  8) public 与 content 漂移
 */
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = path.join(root, "public");
const contentDir = path.join(root, "content", "quiz");

const normalizeMeaning = (t) =>
  String(t ?? "").replace(/[\s\u3000]+/g, "")
    .replace(/[，,；;、。.．·・:：!！?？"'“”‘’()（）[\]【】<>《》/\\|-]/g, "").toLowerCase();
const grams = (text) => {
  const s = normalizeMeaning(text); const out = new Set();
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  if (!out.size && s) out.add(s);
  return out;
};
const overlap = (a, b) => {
  const ga = grams(a), gb = grams(b);
  if (!ga.size || !gb.size) return 0;
  let hit = 0; for (const g of ga) if (gb.has(g)) hit++;
  return hit / Math.min(ga.size, gb.size);
};
const conflict = (a, b) => {
  const na = normalizeMeaning(a), nb = normalizeMeaning(b);
  if (!na || !nb) return true;
  return na === nb || na.includes(nb) || nb.includes(na);
};
const commonPrefix = (a, b) => { const x = String(a).toLowerCase(), y = String(b).toLowerCase(); let i = 0; while (i < Math.min(x.length, y.length) && x[i] === y[i]) i++; return i; };
const commonSuffix = (a, b) => { const x = String(a).toLowerCase(), y = String(b).toLowerCase(); let i = 0; while (i < Math.min(x.length, y.length) && x[x.length - 1 - i] === y[y.length - 1 - i]) i++; return i; };
const isNearMiss = (a, b) => { const x = String(a).toLowerCase(), y = String(b).toLowerCase(); if (x.length !== y.length || x.length < 4) return false; let d = 0; for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) { d++; if (d > 1) return false; } return d === 1; };
const rootTokens = (entry) => {
  const out = new Set();
  for (const m of String(entry?.root || "").matchAll(/([A-Za-z][A-Za-z-]*)\s*[（(]/g)) { const t = m[1].toLowerCase().replace(/-$/, ""); if (t.length >= 3) out.add(t); }
  return out;
};
const sharedRoots = (a, b) => { const ta = rootTokens(a); if (!ta.size) return []; const tb = rootTokens(b); return [...ta].filter((t) => tb.has(t)); };

/** 机器模板 why（脚本产物） —— 逐条都能定位到某个修复脚本的模板 */
const TEMPLATES = [
  { name: "长度修复标记（A≠B|长度修复|…）", re: /\|(长度修复|修复)\|.*避免最长项可猜|避免最长项可猜/ },
  { name: "《X 与 Y 意思有区别》", re: /^[A-Za-z][\w' -]* 与 [A-Za-z][\w' -]* 意思有区别$/ },
  { name: "《X 词性不同》", re: /^[A-Za-z][\w' -]* 词性不同$/ },
  { name: "《X 与 Y 同词根但含义不同》", re: /同词根但含义不同$/ },
  { name: "《X 形近但意思不同》", re: /形近但意思不同$/ },
  { name: "《X 与 Y 有区别》", re: /^[A-Za-z][\w' -]* 与 [A-Za-z][\w' -]* 有区别$/ },
  { name: '《"X"与"Y"…但含义侧重不同/形近易混》', re: /但含义侧重不同|形近易混，但实际含义不同/ },
  { name: "《属同一语义场，但具体所指不同》", re: /属于同一语义场/ },
  { name: "《X 与 Y 不同》", re: /^[A-Za-z][\w' -]* 与 [A-Za-z][\w' -]* 不同$/ },
  { name: "《X 与 Y 词性不同或用法不同》", re: /词性不同或用法不同$/ },
];

const chapters = (await readdir(publicDir)).filter((f) => /^data-\d+\.json$/.test(f))
  .map((f) => Number(f.match(/\d+/)[0])).sort((a, b) => a - b);

const data = {}, quizzes = {};
const tokenIndex = new Map(), meaningIndex = new Map();
for (const c of chapters) {
  data[c] = JSON.parse(await readFile(path.join(publicDir, `data-${c}.json`), "utf8"));
  quizzes[c] = JSON.parse(await readFile(path.join(publicDir, `quiz-${c}.json`), "utf8"));
  for (const w of data[c]) {
    const k = normalizeMeaning(w.meaningCN);
    if (!meaningIndex.has(k)) meaningIndex.set(k, w);
    for (const t of new Set([String(w.word || "").toLowerCase(), ...rootTokens(w)])) {
      if (t.length < 3) continue;
      if (!tokenIndex.has(t)) tokenIndex.set(t, []);
      tokenIndex.get(t).push(w);
    }
  }
}

const files = (await readdir(contentDir)).filter((f) => /^\d+(-\d+)?\.json$/.test(f));
const original = {};
for (const f of files.sort()) {
  const c = Number(f.match(/^\d+/)[0]);
  const doc = JSON.parse(await readFile(path.join(contentDir, f), "utf8"));
  original[c] = original[c] || {};
  for (const [id, item] of Object.entries(doc.items || {})) original[c][id] = (item.distractors || []).map((d) => normalizeMeaning(d.text));
}

const T = { distractors: 0, items: 0, withNote: 0, template: 0, templateByKind: {},
  aligned: 0, misaligned: 0, ambig34: 0, ambig50: 0, verbatim: 0, fuzzy: 0, untraceable: 0,
  kindChecked: 0, kindBad: 0, lenLow: 0, lenHigh: 0, answerLongest: 0 };
const per = {};
const templateSamples = {};
const ambigSamples = [];

for (const c of chapters) {
  const words = data[c], doc = quizzes[c];
  const st = { items: 0, distractors: 0, withNote: 0, template: 0, aligned: 0, misaligned: 0, ambig34: 0, verbatim: 0, untraceable: 0, kindBad: 0, kindChecked: 0, lenLow: 0, lenHigh: 0, answerLongest: 0 };
  const byId = new Map(words.map((w) => [Number(w.id), w]));

  for (const [id, item] of Object.entries(doc.items || {})) {
    const entry = byId.get(Number(id));
    if (!entry) continue;
    T.items++; st.items++;
    if (item.note) { T.withNote++; st.withNote++; }
    const dists = Array.isArray(item.distractors) ? item.distractors : [];
    let allShorter = dists.length > 0;

    for (const d of dists) {
      T.distractors++; st.distractors++;
      const text = String(d?.text ?? ""), why = String(d?.why ?? ""), kind = String(d?.kind ?? "");
      const nText = normalizeMeaning(text);
      const answerLen = normalizeMeaning(entry.meaningCN).length;
      const ratio = nText.length / Math.max(1, answerLen);
      if (ratio < 0.5) { T.lenLow++; st.lenLow++; }
      if (ratio > 2.0) { T.lenHigh++; st.lenHigh++; }
      if (nText.length >= answerLen) allShorter = false;

      /* 1) 机器模板 */
      for (const t of TEMPLATES) {
        if (t.re.test(why)) {
          T.template++; st.template++;
          T.templateByKind[t.name] = (T.templateByKind[t.name] || 0) + 1;
          if (!templateSamples[t.name]) templateSamples[t.name] = [];
          if (templateSamples[t.name].length < 3) templateSamples[t.name].push(`ch${c}#${id} ${entry.word}: 「${why}」`);
          break;
        }
      }

      /* 2) 一致性 */
      const named = new Set();
      for (const m of why.matchAll(/[A-Za-z][A-Za-z-]{2,}/g)) {
        const raw = m[0].toLowerCase().replace(/-$/, "");
        if (tokenIndex.has(raw)) for (const h of tokenIndex.get(raw)) named.add(h);
        else if (raw.length >= 4) for (const [tok, list] of tokenIndex) if (tok.startsWith(raw)) for (const h of list) named.add(h);
      }
      const ovText = overlap(why, text);
      const namedMatchesText = [...named].some((n) => n.word === nText || overlap(n.meaningCN, text) > 0);
      if (ovText > 0 || namedMatchesText) { T.aligned++; st.aligned++; }
      else { T.misaligned++; st.misaligned++; }

      /* 3) 歧义风险 */
      const ovAnswer = overlap(text, entry.meaningCN);
      if (ovAnswer >= 0.34 && !conflict(text, entry.meaningCN)) {
        T.ambig34++; st.ambig34++;
        if (ovAnswer >= 0.5) T.ambig50++;
        if (ambigSamples.length < 60) ambigSamples.push({ chapter: c, id, word: entry.word, answer: entry.meaningCN, text, overlap: Number(ovAnswer.toFixed(2)), why });
      }

      /* 4) 来源可追溯性 */
      if (meaningIndex.has(nText)) { T.verbatim++; st.verbatim++; }
      else {
        let bo = 0, best = null;
        for (const w of words) { const o = overlap(text, w.meaningCN); if (o > bo) { bo = o; best = w; } }
        if (best && bo >= 0.6) T.fuzzy++;
        else { T.untraceable++; st.untraceable++; }
      }

      /* 5) kind 保真度 */
      let srcW = meaningIndex.get(nText) || null;
      if (!srcW) {
        let bo = 0;
        for (const w of words) { const o = overlap(text, w.meaningCN); if (o > bo) { bo = o; srcW = w; } }
        if (bo < 0.6) srcW = null;
      }
      if (srcW) {
        T.kindChecked++; st.kindChecked++;
        const ov = overlap(entry.meaningCN, srcW.meaningCN);
        let ok = true;
        if (kind === "root") ok = sharedRoots(entry, srcW).length > 0;
        else if (kind === "form") ok = isNearMiss(entry.word, srcW.word) || commonPrefix(entry.word, srcW.word) >= 3 || commonSuffix(entry.word, srcW.word) >= 4;
        else if (kind === "sense") ok = ov >= 0.34;
        else if (kind === "pos") ok = String(entry.pos) !== String(srcW.pos);
        else if (kind === "antonym") ok = ov < 0.34;
        else if (kind === "topic") ok = ov < 0.34;
        if (!ok) { T.kindBad++; st.kindBad++; }
      }
    }
    if (dists.length && allShorter) { T.answerLongest++; st.answerLongest++; }
  }
  per[c] = st;
}

/* 8) 漂移 */
const drift = [];
for (const f of (await readdir(contentDir)).filter((x) => x.endsWith(".json"))) {
  const m = f.match(/^(\d+)([-.].*)?\.json$/);
  if (!m) continue;
  try {
    const patch = JSON.parse(await readFile(path.join(contentDir, f), "utf8"));
    const pub = quizzes[Number(m[1])];
    if (!pub?.items || !patch.items) continue;
    let differing = 0;
    for (const [id, item] of Object.entries(patch.items)) {
      if (JSON.stringify(item) !== JSON.stringify(pub.items[id])) differing++;
    }
    drift.push({ file: f, chapter: Number(m[1]), items: Object.keys(patch.items).length, differing });
  } catch { /* ignore */ }
}

const pct = (n, d) => (d ? ((n / d) * 100).toFixed(1) : "0.0");
const out = { T, per, templateSamples, ambigSamples, drift: drift.sort((a, b) => b.differing - a.differing) };
await writeFile(path.join(root, "_audit", "final-report.json"), JSON.stringify(out, null, 1), "utf8");

console.log("=== 汇总（22 章 / 3568 词）===");
console.log(`题源条目 ${T.items}，干扰项 ${T.distractors}`);
console.log(`\n[1] 机器模板 why（脚本产物）      ${T.template}  (${pct(T.template, T.distractors)}%)`);
for (const [k, v] of Object.entries(T.templateByKind).sort((a, b) => b[1] - a[1])) console.log(`      ${String(v).padStart(5)}  ${k}`);
console.log(`\n[2] why 与所挂选项一致            ${T.aligned}  (${pct(T.aligned, T.distractors)}%)`);
console.log(`    why 与所挂选项不一致          ${T.misaligned}  (${pct(T.misaligned, T.distractors)}%)`);
console.log(`\n[3] 歧义风险（选项≈正确释义）     ${T.ambig34}  (${pct(T.ambig34, T.distractors)}%)  其中重合≥0.5 的 ${T.ambig50}`);
console.log(`\n[4] 选项释义 = 词库原释义          ${T.verbatim}  (${pct(T.verbatim, T.distractors)}%)`);
console.log(`    同章近似改写（可追溯）          ${T.fuzzy}  (${pct(T.fuzzy, T.distractors)}%)`);
console.log(`    完全无法追溯                    ${T.untraceable}  (${pct(T.untraceable, T.distractors)}%)`);
console.log(`\n[5] kind 标注与词形/词义关系不符   ${T.kindBad}/${T.kindChecked}  (${pct(T.kindBad, T.kindChecked)}%)`);
console.log(`\n[6] 长度比 <0.5 ${T.lenLow}，>2.0 ${T.lenHigh}；正确答案最长 ${T.answerLongest} 题 (${pct(T.answerLongest, T.items)}%)`);
console.log(`\n[7] 有 note（记忆点）的词          ${T.withNote}/${T.items}  (${pct(T.withNote, T.items)}%)`);

console.log("\n章节  干扰项  模板why  不一致  歧义  无法追溯  kind不符");
for (const c of chapters) {
  const s = per[c];
  console.log(`ch${String(c).padStart(2)} ${String(s.distractors).padStart(6)} ${String(s.template).padStart(7)} ${String(s.misaligned).padStart(7)} ${String(s.ambig34).padStart(5)} ${String(s.untraceable).padStart(8)} ${String(s.kindBad).padStart(8)}`);
}
console.log("\n=== 模板 why 样例 ===");
for (const [k, v] of Object.entries(templateSamples)) { console.log(`  ${k}`); for (const x of v) console.log(`     ${x}`); }
