// s7-meta.mjs —— 元数据与结构异常（旧报告未覆盖的新方向）
// 1) 22 个发布文件的 source/generator/updatedAt 分布（空串、未来日期、chapter≠文件名）
// 2) 原始 JSON 文本重复 key 扫描（JSON.parse 会静默合并）
// 3) 多余字段（doc/item/distractor 层）
// 4) text 含英文/拼音、"是指/意思是"解释句、"以上都不是"类
// 5) 同题内 why/text 重复
// 6) note 丢失率（原始分片有 note、发布版没有）+ need:"read"
// 7) kind 分布与非法 kind；why>40 字、note>60 字；章内同一 why 复用≥3
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { ROOT, OUT, loadAll, writeOut, normalize, TODAY } from "./lib.mjs";

const { chapters, data, quiz } = await loadAll();

// ---------- 1) 发布文件元数据 ----------
const meta = [];
for (const c of chapters) {
  const doc = quiz.get(c);
  meta.push({
    file: `quiz-${c}.json`, chapterField: doc.chapter, chapterOk: Number(doc.chapter) === c,
    spec: doc.spec, source: doc.source ?? "(缺字段)", generator: doc.generator ?? "(缺字段)",
    updatedAt: doc.updatedAt ?? "(缺字段)",
    srcEmpty: doc.source === "", genEmpty: doc.generator === "",
    future: typeof doc.updatedAt === "string" && /^\d{4}-\d{2}-\d{2}$/.test(doc.updatedAt) && doc.updatedAt > TODAY,
    extraTopKeys: Object.keys(doc).filter((k) => !["spec", "chapter", "source", "generator", "updatedAt", "items"].includes(k)),
  });
}

// ---------- 2) 原始 JSON 重复 key 扫描 ----------
function scanDupKeys(text, label) {
  const dups = [];
  let i = 0;
  const n = text.length;
  const ws = () => { while (i < n && /[\s\uFEFF]/.test(text[i])) i++; };
  function str() {
    i++;
    let out = "";
    while (i < n) {
      const ch = text[i];
      if (ch === "\\") { out += text[i + 1] ?? ""; i += 2; continue; }
      if (ch === '"') { i++; return out; }
      out += ch; i++;
    }
    throw new Error(`${label}: 未闭合字符串 @${i}`);
  }
  function val(p, store) {
    ws();
    const ch = text[i];
    if (ch === "{") return obj(p, store);
    if (ch === "[") return arr(p, store);
    if (ch === '"') { store?.push(str().slice(0, 80)); return; }
    let s = "";
    while (i < n && !",}]".includes(text[i])) { s += text[i]; i++; }
    store?.push(s.trim().slice(0, 80));
  }
  function obj(p, store) {
    i++; ws();
    const seen = new Map(); // key -> values[]
    if (text[i] === "}") { i++; return; }
    for (;;) {
      ws();
      const k = str(); ws();
      if (text[i] !== ":") throw new Error(`${label}: 缺冒号 @${i}`);
      i++;
      const childStore = [];
      val(p ? `${p}.${k}` : k, childStore);
      if (seen.has(k)) {
        seen.get(k).push(childStore[0] ?? "(复合值)");
        dups.push({ file: label, path: p ? `${p}.${k}` : k, values: seen.get(k).slice(0, 4) });
      } else seen.set(k, [childStore[0] ?? "(复合值)"]);
      ws();
      if (text[i] === ",") { i++; continue; }
      if (text[i] === "}") { i++; break; }
      throw new Error(`${label}: 对象异常 @${i}`);
    }
  }
  function arr(p, store) {
    i++; ws();
    let k = 0;
    if (text[i] === "]") { i++; return; }
    for (;;) {
      val(`${p}[${k}]`, store); k++; ws();
      if (text[i] === ",") { i++; continue; }
      if (text[i] === "]") { i++; break; }
      throw new Error(`${label}: 数组异常 @${i}`);
    }
  }
  ws(); val("", null); ws();
  return dups;
}

const dupScan = [];
const scanTargets = [];
for (const c of chapters) scanTargets.push([`public/quiz-${c}.json`, path.join(ROOT, "public", `quiz-${c}.json`)]);
for (const c of chapters) scanTargets.push([`public/data-${c}.json`, path.join(ROOT, "public", `data-${c}.json`)]);
scanTargets.push(["public/quiz-index.json", path.join(ROOT, "public", "quiz-index.json")]);
for (const f of (await readdir(path.join(ROOT, "content", "quiz"))).filter((x) => x.endsWith(".json"))) {
  scanTargets.push([`content/quiz/${f}`, path.join(ROOT, "content", "quiz", f)]);
}
for (const [label, p] of scanTargets) {
  try {
    const d = scanDupKeys(await readFile(p, "utf8"), label);
    if (d.length) dupScan.push(...d);
  } catch (e) {
    dupScan.push({ file: label, error: String(e.message || e) });
  }
}

// ---------- 3)-5) 结构异常扫描 ----------
const extraItemFields = [], extraDistFields = [];
const textEnglish = [], textPinyin = [], textExplain = [], textNoneOfAbove = [];
const dupWhyInItem = [], dupTextInItem = [];
const kindDist = {}; let badKind = 0;
const whyTooLong = [], noteTooLong = [];
let whyLenSum = 0, whyLenN = 0;
let textEnglishN = 0;

for (const c of chapters) {
  for (const [id, item] of Object.entries(quiz.get(c).items || {})) {
    for (const k of Object.keys(item)) {
      if (!["need", "note", "distractors"].includes(k)) extraItemFields.push({ c, id, key: k });
    }
    const ds = item.distractors || [];
    const whys = ds.map((d) => String(d?.why ?? ""));
    const texts = ds.map((d) => String(d?.text ?? ""));
    if (new Set(whys).size < whys.length) dupWhyInItem.push({ c, id, whys });
    const nt = texts.map(normalize);
    if (new Set(nt).size < nt.length) dupTextInItem.push({ c, id, texts });
    for (const d of ds) {
      for (const k of Object.keys(d)) {
        if (!["text", "kind", "why"].includes(k)) extraDistFields.push({ c, id, key: k });
      }
      const kind = String(d?.kind ?? "");
      kindDist[kind] = (kindDist[kind] || 0) + 1;
      if (!["root", "form", "pos", "sense", "topic", "antonym"].includes(kind)) badKind++;
      const text = String(d?.text ?? ""), why = String(d?.why ?? "");
      whyLenSum += why.length; whyLenN++;
      if (why.length > 40 && whyTooLong.length < 5) whyTooLong.push({ c, id, why, len: why.length });
      if (/[A-Za-z]/.test(text)) {
        textEnglishN++;
        if (textEnglish.length < 12) textEnglish.push({ c, id, text });
      }
      if (/[āáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜü]/.test(text) && textPinyin.length < 10) textPinyin.push({ c, id, text });
      if (/(是指|意思是|指的是|所谓的|意思为)/.test(text) && textExplain.length < 10) textExplain.push({ c, id, text });
      if (/(以上都|以上皆|都不对|都对|全对|全部正确|都不是)/.test(text) && textNoneOfAbove.length < 10) textNoneOfAbove.push({ c, id, text });
    }
    if (item.note && item.note.length > 60) noteTooLong.push({ c, id, len: item.note.length });
  }
}

// why 复用≥3（章内）
const whyReuse = [];
for (const c of chapters) {
  const cnt = new Map();
  for (const [, item] of Object.entries(quiz.get(c).items || {})) {
    for (const d of item.distractors || []) {
      const w = String(d?.why ?? "");
      if (!w) continue;
      cnt.set(w, (cnt.get(w) || 0) + 1);
    }
  }
  for (const [w, n] of cnt) if (n >= 3) whyReuse.push({ c, why: w, n });
}
whyReuse.sort((a, b) => b.n - a.n);

// ---------- 6) note 丢失率（仅原始分片 N.json / N-k.json）----------
const noteLoss = [], noteGain = [];
let notePublished = 0, needRead = [];
const shardGenAudit = [];
for (const c of chapters) {
  const files = (await readdir(path.join(ROOT, "content", "quiz")))
    .filter((f) => new RegExp(`^${c}(-\\d+)?\\.json$`).test(f));
  files.sort((a, b) => {
    const na = Number((a.match(/^(\d+)-(\d+)/) || [0, 0, 0])[2] || 0);
    const nb = Number((b.match(/^(\d+)-(\d+)/) || [0, 0, 0])[2] || 0);
    return na - nb;
  });
  const orig = {};
  for (const f of files) {
    const doc = JSON.parse(await readFile(path.join(ROOT, "content", "quiz", f), "utf8"));
    shardGenAudit.push({ file: f, generator: doc.generator ?? "(空)", items: Object.keys(doc.items || {}).length });
    for (const [id, item] of Object.entries(doc.items || {})) orig[id] = item;
  }
  const pub = quiz.get(c).items || {};
  for (const [id, item] of Object.entries(orig)) {
    const p = pub[id];
    const shardNote = typeof item.note === "string" && item.note.trim() ? item.note : null;
    const pubNote = p && typeof p.note === "string" && p.note.trim() ? p.note : null;
    if (shardNote && !pubNote) noteLoss.push({ c, id, shardNote: shardNote.slice(0, 50) });
    if (!shardNote && pubNote) noteGain.push({ c, id });
  }
  for (const [id, item] of Object.entries(pub)) {
    if (item.note && String(item.note).trim()) notePublished++;
    if (item.need === "read") needRead.push({ c, id });
  }
}

const out = {
  meta,
  srcEmptyN: meta.filter((m) => m.srcEmpty).length,
  genEmptyN: meta.filter((m) => m.genEmpty).length,
  futureDates: meta.filter((m) => m.future).map((m) => m.file + ":" + m.updatedAt),
  chapterMismatch: meta.filter((m) => !m.chapterOk),
  dupScan,
  extraItemFields, extraDistFields,
  textEnglishN, textEnglish, textPinyin, textExplain, textNoneOfAbove,
  dupWhyInItem, dupTextInItem,
  kindDist, badKind,
  whyTooLong, noteTooLong,
  whyLenAvg: +(whyLenSum / Math.max(1, whyLenN)).toFixed(1),
  whyReuseTop: whyReuse.slice(0, 15),
  whyReuseDistinct: whyReuse.length,
  whyReuseInstances: whyReuse.reduce((a, b) => a + b.n, 0),
  notePublished, noteTotal: [...quiz.values()].reduce((a, d) => a + Object.keys(d.items || {}).length, 0),
  noteLossN: noteLoss.length,
  noteLossByChapter: noteLoss.reduce((m, x) => { m[x.c] = (m[x.c] || 0) + 1; return m; }, {}),
  noteLossSamples: noteLoss.slice(0, 12),
  noteGainN: noteGain.length,
  needReadN: needRead.length, needReadList: needRead,
  shardGenAudit,
};
await writeOut("s7-meta.json", JSON.stringify(out, null, 1));
console.log(`srcEmpty=${out.srcEmptyN}/22 genEmpty=${out.genEmptyN}/22 futureDates=${out.futureDates.length} chapterMismatch=${out.chapterMismatch.length}`);
console.log(`dupKeys=${dupScan.length} extraItemFields=${extraItemFields.length} extraDistFields=${extraDistFields.length}`);
console.log(`textEnglish=${textEnglishN} textPinyin=${textPinyin.length} textExplain=${textExplain.length} noneOfAbove=${textNoneOfAbove.length}`);
console.log(`dupWhyInItem=${dupWhyInItem.length} dupTextInItem=${dupTextInItem.length} badKind=${badKind}`);
console.log(`note=${notePublished}/${out.noteTotal} noteLoss=${noteLoss.length} noteGain=${noteGain.length} needRead=${needRead.length}`);
console.log(`whyReuse>=3: distinct=${out.whyReuseDistinct} instances=${out.whyReuseInstances}`);
