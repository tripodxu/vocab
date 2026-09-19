// @ts-check
/**
 * _audit/audit.mjs —— 认词题源质量审计（只读）
 *
 * 在 scripts/quiz-lib.mjs 的机器校验之上，补做**规范要求但校验器未实现**的检查：
 *   A. 干扰项来源可追溯性（是不是词库里真实存在的释义）
 *   B. 歧义风险（干扰项来自目标词的近义词 → "两个都说得通"）
 *   C. kind 标注保真度（声明的 kind 与实际词形/词义关系是否一致）
 *   D. why 质量（模板句、空话、重复、区分点）
 *   E. text 里的英文/拼音、解释句
 *   F. 万能干扰项（同章内同一释义被反复使用）
 *   G. 长度比与"正确答案最长"破绽
 *   H. public/quiz-N.json 与 content/quiz 中间产物的漂移
 */
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = path.join(root, "public");
const contentDir = path.join(root, "content", "quiz");

const ROOT_TOKEN_MIN = 3;
const PREFIX_MIN = 3;
const SUFFIX_MIN = 4;
const SENSE_OVERLAP_MIN = 0.34;

/* ---------- 与 public/quiz.js 对齐的纯函数 ---------- */
const normalizeMeaning = (t) =>
  String(t ?? "")
    .replace(/[\s\u3000]+/g, "")
    .replace(/[，,；;、。.．·・:：!！?？"'“”‘’()（）[\]【】<>《》/\\|-]/g, "")
    .toLowerCase();

const conflict = (a, b) => {
  const na = normalizeMeaning(a), nb = normalizeMeaning(b);
  if (!na || !nb) return true;
  return na === nb || na.includes(nb) || nb.includes(na);
};
const commonPrefix = (a, b) => {
  const x = String(a ?? "").toLowerCase(), y = String(b ?? "").toLowerCase();
  let i = 0; while (i < Math.min(x.length, y.length) && x[i] === y[i]) i++; return i;
};
const commonSuffix = (a, b) => {
  const x = String(a ?? "").toLowerCase(), y = String(b ?? "").toLowerCase();
  let i = 0; while (i < Math.min(x.length, y.length) && x[x.length - 1 - i] === y[y.length - 1 - i]) i++; return i;
};
const isNearMiss = (a, b) => {
  const x = String(a ?? "").toLowerCase(), y = String(b ?? "").toLowerCase();
  if (x.length !== y.length || x.length < 4) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) { diff++; if (diff > 1) return false; }
  return diff === 1;
};
const rootTokens = (entry) => {
  const out = new Set();
  for (const m of String(entry?.root || "").matchAll(/([A-Za-z][A-Za-z-]*)\s*[（(]/g)) {
    const t = m[1].toLowerCase();
    if (t.length >= ROOT_TOKEN_MIN) out.add(t);
  }
  return out;
};
const sharedRoots = (a, b) => {
  const ta = rootTokens(a); if (!ta.size) return [];
  const tb = rootTokens(b); const out = [];
  for (const t of ta) if (tb.has(t)) out.push(t);
  return out;
};
const meaningOverlap = (a, b) => {
  const grams = (text) => {
    const s = normalizeMeaning(text); const out = new Set();
    for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
    if (!out.size && s) out.add(s);
    return out;
  };
  const ga = grams(a), gb = grams(b);
  if (!ga.size || !gb.size) return 0;
  let hit = 0; for (const g of ga) if (gb.has(g)) hit++;
  return hit / Math.min(ga.size, gb.size);
};
const mlen = (t) => normalizeMeaning(t).length;

/* ---------- 载入词库 / 题源 ---------- */
const chapterFiles = (await readdir(publicDir)).filter((f) => /^data-\d+\.json$/.test(f));
const chapters = chapterFiles.map((f) => Number(f.match(/\d+/)[0])).sort((a, b) => a - b);

const data = {};      // chapter -> words[]
const quizzes = {};   // chapter -> doc
for (const c of chapters) {
  data[c] = JSON.parse(await readFile(path.join(publicDir, `data-${c}.json`), "utf8"));
  try {
    quizzes[c] = JSON.parse(await readFile(path.join(publicDir, `quiz-${c}.json`), "utf8"));
  } catch { quizzes[c] = null; }
}

/** 全局释义索引：归一化释义 → [{chapter, word, entry}] */
const meaningIndex = new Map();
for (const c of chapters) {
  for (const w of data[c]) {
    const key = normalizeMeaning(w.meaningCN);
    if (!meaningIndex.has(key)) meaningIndex.set(key, []);
    meaningIndex.get(key).push({ chapter: c, word: w.word, entry: w });
  }
}

const report = { chapters: {}, global: {}, flags: [] };
const flag = (type, detail) => report.flags.push({ type, ...detail });
const bump = (obj, key) => { obj[key] = (obj[key] || 0) + 1; };

/* ---------- 逐章审计 ---------- */
const globalTotals = {
  items: 0, distractors: 0,
  provInChapter: 0, provOtherChapter: 0, provInvented: 0,
  ambiguityRisk: 0,
  kindMismatch: 0, kindChecked: 0,
  whyTemplate: 0, whyFiller: 0, whyTooGeneric: 0,
  textAscii: 0, textExplain: 0,
  universalDistractorHits: 0,
  lenLow: 0, lenHigh: 0, correctIsLongest: 0,
  noteCopiesExample: 0,
};
/** 全局 why 复用计数 */
const whyGlobal = new Map();
/** 全局"万能干扰项"计数（归一化释义） */
const distractorGlobal = new Map();

const WHY_FILLER = [
  /^意思不同$/, /^含义不同$/, /^不是这个词$/, /^另一个意思$/, /^错误的选项$/, /^另一个词$/,
  /^词根不同$/, /^词性不对$/, /^拼写有点像$/, /^反义词$/, /^近义词$/,
  /同属.{0,8}领域但含义不同$/, /近义但侧重点不同$/, /但含义不同$/, /但意思不同$/,
  /^[a-z]+ 词性不同$/, /^[a-z]+ 词性不对$/, /^[a-z]+ 是相近词$/, /^同主题的另一个词$/,
];
const WHY_GENERIC = [
  /同属.{0,8}(领域|主题)/, /意思(不同|相近|有差别)/, /含义(不同|相近)/, /另一个概念/,
  /侧重点不同/, /适用范围不同/, /语境不同/, /具体所指不同/, /词义不重叠/, /主题相关/,
  /^拼写相近$/, /类似但不同/,
];

for (const c of chapters) {
  const words = data[c];
  const doc = quizzes[c];
  const byId = new Map(words.map((w) => [Number(w.id), w]));
  const stat = {
    chapter: c, words: words.length, items: 0, coverage: 0,
    kinds: {}, needRead: 0,
    provInChapter: 0, provOtherChapter: 0, provInvented: 0,
    ambiguityRisk: 0, kindMismatch: 0,
    whyTemplate: 0, whyFiller: 0, whyTooGeneric: 0, whyAvgLen: 0, whyReused: 0,
    textAscii: 0, textExplain: 0,
    lenLow: 0, lenHigh: 0, correctIsLongest: 0,
    universalTop: [],
  };
  if (!doc?.items) { report.chapters[c] = stat; continue; }

  const ids = Object.keys(doc.items);
  stat.items = ids.length;
  stat.coverage = words.length ? ids.length / words.length : 0;

  /** 本章内归一化干扰项释义 → 次数 */
  const localUse = new Map();
  let whyTotal = 0, whyN = 0;

  for (const id of ids) {
    const entry = byId.get(Number(id));
    if (!entry) continue;
    const item = doc.items[id];
    if (item.need === "read") stat.needRead++;
    const dists = Array.isArray(item.distractors) ? item.distractors : [];
    const answerLen = mlen(entry.meaningCN);
    let allShorter = dists.length > 0;

    for (const d of dists) {
      globalTotals.distractors++;
      const text = String(d?.text ?? "").trim();
      const kind = String(d?.kind ?? "");
      const why = String(d?.why ?? "").trim();
      bump(stat.kinds, kind || "(空)");
      const nText = normalizeMeaning(text);
      localUse.set(nText, (localUse.get(nText) || 0) + 1);
      distractorGlobal.set(nText, (distractorGlobal.get(nText) || 0) + 1);

      /* E. text 里有没有 ASCII 字母（英文/拼音混入） */
      if (/[A-Za-z]/.test(text)) { stat.textAscii++; globalTotals.textAscii++; flag("text-ascii", { chapter: c, id, word: entry.word, text }); }
      /* E2. text 是不是解释句 */
      if (/是指|意思是|指的是|表示|即[^，]{0,4}的/.test(text)) { stat.textExplain++; globalTotals.textExplain++; flag("text-explain", { chapter: c, id, word: entry.word, text }); }

      /* A. 干扰项来源可追溯 */
      const hits = meaningIndex.get(nText) || [];
      const inChapter = hits.filter((h) => h.chapter === c);
      if (inChapter.length) { stat.provInChapter++; globalTotals.provInChapter++; }
      else if (hits.length) { stat.provOtherChapter++; globalTotals.provOtherChapter++; flag("prov-other-chapter", { chapter: c, id, word: entry.word, text, fromChapters: [...new Set(hits.map((h) => h.chapter))] }); }
      else { stat.provInvented++; globalTotals.provInvented++; flag("prov-invented", { chapter: c, id, word: entry.word, text, kind }); }

      /* B. 歧义风险：干扰项来自目标词的近义词（释义二元组重合 ≥0.34） */
      const src = inChapter[0] || hits[0];
      if (src) {
        const ov = meaningOverlap(entry.meaningCN, src.entry.meaningCN);
        if (ov >= SENSE_OVERLAP_MIN) {
          stat.ambiguityRisk++; globalTotals.ambiguityRisk++;
          flag("ambiguity-risk", { chapter: c, id, word: entry.word, answer: entry.meaningCN, text, sourceWord: src.word, sourceMeaning: src.entry.meaningCN, overlap: Math.round(ov * 100) / 100, kind, why });
        }

        /* C. kind 保真度 */
        stat.kindMismatch += 0; // 占位，下面按条判断
        const p = commonPrefix(entry.word, src.word);
        const s = commonSuffix(entry.word, src.word);
        const nm = isNearMiss(entry.word, src.word);
        const roots = sharedRoots(entry, src.entry);
        const posDiff = String(entry.pos || "") !== String(src.entry.pos || "") && entry.pos && src.entry.pos;
        globalTotals.kindChecked++;
        let ok = true, expect = "";
        if (kind === "root") { ok = roots.length > 0; expect = roots.length ? "" : "无共享词根 token"; }
        else if (kind === "form") { ok = nm || p >= PREFIX_MIN || s >= SUFFIX_MIN; expect = ok ? "" : `无前缀≥3/后缀≥4/一字母差（prefix=${p},suffix=${s}）`; }
        else if (kind === "sense") { ok = ov >= SENSE_OVERLAP_MIN; expect = ok ? "" : `释义重合度仅 ${Math.round(ov * 100)}%`; }
        else if (kind === "pos") { ok = Boolean(posDiff); expect = ok ? "" : "词性其实相同"; }
        else if (kind === "antonym") { ok = ov < SENSE_OVERLAP_MIN; expect = ok ? "" : `释义重合度 ${Math.round(ov * 100)}%（更像近义）`; }
        else if (kind === "topic") { ok = ov < SENSE_OVERLAP_MIN; expect = ok ? "" : `释义重合度 ${Math.round(ov * 100)}%（更像近义）`; }
        if (!ok) {
          stat.kindMismatch++; globalTotals.kindMismatch++;
          flag("kind-mismatch", { chapter: c, id, word: entry.word, kind, sourceWord: src.word, sourceMeaning: src.entry.meaningCN, reason: expect, targetMeaning: entry.meaningCN, text, why });
        }
      }

      /* D. why 质量 */
      if (why) {
        whyTotal += why.length; whyN++;
        whyGlobal.set(why, (whyGlobal.get(why) || 0) + 1);
        if (WHY_FILLER.some((re) => re.test(why))) { stat.whyFiller++; globalTotals.whyFiller++; flag("why-filler", { chapter: c, id, word: entry.word, why }); }
        else if (WHY_GENERIC.some((re) => re.test(why))) { stat.whyTooGeneric++; globalTotals.whyTooGeneric++; flag("why-generic", { chapter: c, id, word: entry.word, why, kind }); }
        if (/^[a-zA-Z]+\s/.test(why) && why.length < 12) { stat.whyTemplate++; globalTotals.whyTemplate++; flag("why-name-only", { chapter: c, id, word: entry.word, why }); }
      }

      /* G. 长度比 */
      const ratio = nText.length / Math.max(1, answerLen);
      if (ratio < 0.5) { stat.lenLow++; globalTotals.lenLow++; }
      if (ratio > 2.0) { stat.lenHigh++; globalTotals.lenHigh++; }
      if (nText.length >= answerLen) allShorter = false;
    }
    if (dists.length && allShorter) { stat.correctIsLongest++; globalTotals.correctIsLongest++; }

    /* note 抄例句 */
    const note = String(item.note ?? "");
    if (note) {
      const ex = String(entry.exampleEN || "");
      if (ex && (note.includes(ex) || (/\s/.test(note) && (note.match(/[A-Za-z]{2,}/g) || []).length >= 5 && !/[（(]/.test(note)))) {
        globalTotals.noteCopiesExample++;
        flag("note-example", { chapter: c, id, word: entry.word, note });
      }
    }
  }

  stat.whyAvgLen = whyN ? Math.round((whyTotal / whyN) * 10) / 10 : 0;

  /* F. 万能干扰项（本章内同一释义被用 ≥3 次） */
  const uni = [...localUse.entries()].filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]);
  stat.universalTop = uni.slice(0, 5).map(([t, n]) => ({ meaning: t, uses: n }));
  globalTotals.universalDistractorHits += uni.reduce((a, [, n]) => a + n, 0);

  report.chapters[c] = stat;
}

/* ---------- 全局：why 复用、万能干扰项 ---------- */
report.global.totals = globalTotals;
report.global.whyReused3 = [...whyGlobal.entries()].filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]).slice(0, 30);
report.global.whyReused3Count = [...whyGlobal.values()].filter((n) => n >= 3).length;
report.global.universalDistractors = [...distractorGlobal.entries()].filter(([, n]) => n >= 5).sort((a, b) => b[1] - a[1]).slice(0, 40);
report.global.universalDistractorCount = [...distractorGlobal.values()].filter((n) => n >= 5).length;
report.global.whyDistinct = whyGlobal.size;
report.global.distractorDistinct = distractorGlobal.size;

/* ---------- H. public 与 content 中间产物漂移 ---------- */
const contentFiles = (await readdir(contentDir)).filter((f) => f.endsWith(".json"));
const drift = [];
for (const f of contentFiles) {
  const m = f.match(/^(\d+)([-.].*)?\.json$/);
  if (!m) continue;
  const c = Number(m[1]);
  try {
    const patch = JSON.parse(await readFile(path.join(contentDir, f), "utf8"));
    const pub = quizzes[c];
    if (!pub?.items) continue;
    const pitems = patch.items || {};
    let missing = 0, differing = 0;
    const examples = [];
    for (const [id, item] of Object.entries(pitems)) {
      const a = JSON.stringify(item);
      const b = JSON.stringify(pub.items[id]);
      if (b === undefined) missing++;
      else if (a !== b) {
        differing++;
        if (examples.length < 3) examples.push({ id, content: item?.distractors?.[0]?.text, public: pub.items[id]?.distractors?.[0]?.text });
      }
    }
    drift.push({ file: f, chapter: c, items: Object.keys(pitems).length, notInPublic: missing, differing, examples });
  } catch (e) { drift.push({ file: f, error: String(e.message) }); }
}
report.global.drift = drift.sort((a, b) => (b.differing || 0) - (a.differing || 0));

await writeFile(path.join(root, "_audit", "audit-report.json"), JSON.stringify(report, null, 1), "utf8");

/* ---------- 打印摘要 ---------- */
const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : 0);
console.log("=== 总量 ===");
console.log(`章节 ${chapters.length}，题源条目 ${globalTotals.items || "—"}，干扰项 ${globalTotals.distractors}`);
console.log(`干扰项来源：同章 ${globalTotals.provInChapter} (${pct(globalTotals.provInChapter, globalTotals.distractors)}%)，`
  + `仅他章 ${globalTotals.provOtherChapter} (${pct(globalTotals.provOtherChapter, globalTotals.distractors)}%)，`
  + `词库中不存在（生造）${globalTotals.provInvented} (${pct(globalTotals.provInvented, globalTotals.distractors)}%)`);
console.log(`歧义风险（干扰项=目标词近义词） ${globalTotals.ambiguityRisk} (${pct(globalTotals.ambiguityRisk, globalTotals.distractors)}%)`);
console.log(`kind 标注不符 ${globalTotals.kindMismatch} / 已核 ${globalTotals.kindChecked} (${pct(globalTotals.kindMismatch, globalTotals.kindChecked)}%)`);
console.log(`why 空话 ${globalTotals.whyFiller}，泛化模板 ${globalTotals.whyTooGeneric}，仅词名 ${globalTotals.whyTemplate}`);
console.log(`text 含英文/拼音 ${globalTotals.textAscii}，解释句 ${globalTotals.textExplain}`);
console.log(`长度比 <0.5 ${globalTotals.lenLow}，>2.0 ${globalTotals.lenHigh}，正确答案最长 ${globalTotals.correctIsLongest}`);
console.log(`note 疑似抄例句 ${globalTotals.noteCopiesExample}`);
console.log(`why 去重后 ${report.global.whyDistinct} 种；被复用 ≥3 次的 why ${report.global.whyReused3Count} 种`);
console.log(`干扰项释义去重后 ${report.global.distractorDistinct} 种；被用 ≥5 次的"万能干扰项" ${report.global.universalDistractorCount} 种`);
console.log("\n=== 出题条目数（应为各章词数）===");
for (const c of chapters) {
  const s = report.chapters[c];
  globalTotals.items += s.items;
  console.log(
    `ch${String(c).padStart(2)} 词${String(s.words).padStart(4)} 题源${String(s.items).padStart(4)} `
    + `cov${String(pct(s.items, s.words)).padStart(5)}% kind不符${String(s.kindMismatch).padStart(4)} `
    + `歧义${String(s.ambiguityRisk).padStart(4)} 生造${String(s.provInvented).padStart(4)} `
    + `why模板${String(s.whyTooGeneric + s.whyFiller).padStart(4)} len低${String(s.lenLow).padStart(4)} len高${String(s.lenHigh).padStart(4)}`
  );
}
console.log("\n=== 最严重的 why 复用 ===");
for (const [w, n] of report.global.whyReused3.slice(0, 12)) console.log(`  ${n}× 「${w}」`);
console.log("\n=== 万能干扰项（≥5 次）===");
for (const [t, n] of report.global.universalDistractors.slice(0, 15)) console.log(`  ${n}× ${t}`);
console.log("\n=== public 与 content 漂移（Top 12）===");
for (const d of report.global.drift.slice(0, 12)) {
  if (d.error) { console.log(`  ${d.file}: 读取失败 ${d.error}`); continue; }
  console.log(`  ${d.file}: 条目${d.items} 不在public${d.notInPublic} 内容不同${d.differing}`);
}
