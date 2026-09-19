// s8-ab.mjs —— A/B 复现：当前发布版 vs 仅合并原始分片（文件名不含 fix 的 N.json / N-k.json）
// 绝不写 public/；全部只在内存中构建。
// 附：分片命名假设核验（fix 命名 = 脚本产物？generator 字段佐证 + 反例指出）。
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { ROOT, OUT, loadAll, writeOut, buildTokenIndex, resolveWhy, minOverlap, normalize, senseCover, jaccard, matchTemplate, WHY_BLACKLIST, pct } from "./lib.mjs";

const { chapters, data, quiz } = await loadAll();
const idx = buildTokenIndex(data);

const meaningIndex = new Map();
for (const [, words] of data) {
  for (const w of words) {
    const k = normalize(w.meaningCN);
    if (!k) continue;
    if (!meaningIndex.has(k)) meaningIndex.set(k, []);
    meaningIndex.get(k).push(w);
  }
}

/** 对“章 → items”的内存变体跑同一套指标 */
function audit(itemsByChapter) {
  const R = { items: 0, dist: 0, idNotInVocab: 0, template: 0, blacklist: 0,
    misalignHard: 0, misalignAnswerRelated: 0, noEnglish: 0, unresolved: 0, aligned: 0,
    alignedLoose: 0, templateHits: [],
    a1: 0, a2: 0, a3: 0, ambigUnion: 0, lenLow: 0, lenHigh: 0, note: 0, badDistCount: 0 };
  const missing = {};
  for (const c of chapters) {
    const words = data.get(c);
    const byId = new Map(words.map((w) => [Number(w.id), w]));
    const items = itemsByChapter[c] || {};
    const have = new Set(Object.keys(items).map(String));
    const miss = words.filter((w) => !have.has(String(w.id))).map((w) => String(w.id));
    if (miss.length) missing[c] = miss;
    for (const [id, item] of Object.entries(items)) {
      const w = byId.get(Number(id));
      if (!w) { R.idNotInVocab++; continue; }
      R.items++;
      if (item.note && String(item.note).trim()) R.note++;
      const ds = item.distractors || [];
      if (ds.length !== 3) R.badDistCount++;
      const answer = String(w.meaningCN ?? "");
      const na = normalize(answer);
      for (const d of ds) {
        R.dist++;
        const text = String(d?.text ?? ""), why = String(d?.why ?? "");
        const tpl = matchTemplate(why);
        if (tpl) {
          R.template++;
          if (R.templateHits.length < 6) R.templateHits.push({ c, id, word: w.word, pattern: tpl.key, why });
        }
        if (WHY_BLACKLIST.some((re) => re.test(why))) R.blacklist++;
        // 错位（严格：全部 token 可解析才判定）
        const r = resolveWhy(why, idx);
        if (!r.tokens.length) R.noEnglish++;
        else if (!r.allResolved) R.unresolved++;
        else if (minOverlap(why, text) > 0) R.aligned++;
        else {
          const matchesOption = [...r.named].some((n) => n.word === normalize(text) || minOverlap(n.meaningCN, text) > 0);
          if (matchesOption) R.aligned++;
          else {
            const matchesAnswer = [...r.named].some((n) => String(n.id) === String(w.id) || minOverlap(n.meaningCN, w.meaningCN) > 0);
            if (matchesAnswer) R.misalignAnswerRelated++; else R.misalignHard++;
          }
        }
        // 错位（宽松口径 = _audit/recover.mjs：不设可判定门槛，无法解析的英文词直接算不一致）
        if (minOverlap(why, text) > 0) R.alignedLoose++;
        else {
          const namedLoose = new Set();
          for (const m of why.matchAll(/[A-Za-z][A-Za-z-]{2,}/g)) {
            const raw = m[0].toLowerCase().replace(/-$/, "");
            if (idx.has(raw)) { for (const h of idx.get(raw)) namedLoose.add(h); continue; }
            if (raw.length >= 4) for (const [tok, list] of idx) if (tok.startsWith(raw)) for (const h of list) namedLoose.add(h);
          }
          const okLoose = [...namedLoose].some((n) => n.word === normalize(text) || minOverlap(n.meaningCN, text) > 0);
          if (okLoose) R.alignedLoose++;
        }
        // 歧义
        const nt = normalize(text);
        let amb = false;
        if (nt && na && (nt === na || nt.includes(na) || na.includes(nt))) { R.a1++; amb = true; }
        const cov = senseCover(text, answer);
        if (cov === "covered") { R.a2++; amb = true; }
        if (!amb && jaccard(text, answer) >= 0.6) { R.a3++; amb = true; }
        if (amb) R.ambigUnion++;
        // 长度
        const ratio = nt.length / Math.max(1, na.length);
        if (ratio < 0.5) R.lenLow++;
        if (ratio > 2.0) R.lenHigh++;
      }
    }
  }
  R.strictCompat = R.misalignHard + R.misalignAnswerRelated;
  R.looseMisaligned = R.dist - R.alignedLoose;
  R.loosePct = pct(R.looseMisaligned, R.dist);
  R.missing = missing;
  R.missingTotal = Object.values(missing).reduce((a, b) => a + b.length, 0);
  return R;
}

// ---- A：当前发布版 ----
const A = {};
for (const c of chapters) A[c] = quiz.get(c).items || {};
const RA = audit(A);

// ---- B：仅原始分片（文件名不含 fix）----
async function buildOriginal(includeFix61110 = false) {
  const out = {};
  const shardFiles = {};
  for (const c of chapters) {
    let files = (await readdir(path.join(ROOT, "content", "quiz")))
      .filter((f) => new RegExp(`^${c}(-\\d+)?\\.json$`).test(f));
    files.sort((a, b) => {
      const na = Number((a.match(/^(\d+)-(\d+)/) || [0, 0, 0])[2] || 0);
      const nb = Number((b.match(/^(\d+)-(\d+)/) || [0, 0, 0])[2] || 0);
      return na - nb;
    });
    shardFiles[c] = files;
    const items = {};
    for (const f of files) {
      const doc = JSON.parse(await readFile(path.join(ROOT, "content", "quiz", f), "utf8"));
      Object.assign(items, doc.items || {});
    }
    if (includeFix61110 && c === 16) {
      const doc = JSON.parse(await readFile(path.join(ROOT, "content", "quiz", "16-fix-61-110.json"), "utf8"));
      Object.assign(items, doc.items || {});
    }
    out[c] = items;
  }
  return { items: out, shardFiles };
}

const Bb = await buildOriginal(false);
const RB = audit(Bb.items);
const B2 = await buildOriginal(true);
const RB2 = audit(B2.items);

// ---- 分片命名假设核验 ----
const allShards = [];
for (const f of (await readdir(path.join(ROOT, "content", "quiz"))).filter((x) => x.endsWith(".json"))) {
  const doc = JSON.parse(await readFile(path.join(ROOT, "content", "quiz", f), "utf8"));
  allShards.push({
    file: f, generator: doc.generator ?? "(空)", source: doc.source ?? "(空)",
    isFixNamed: /fix/.test(f),
    genIsScript: /length-fix/i.test(String(doc.generator || "")),
  });
}
const counterExamples = allShards.filter((s) => s.isFixNamed !== (s.genIsScript || s.generator === "(空)"));

const show = (label, R) => ({
  label, items: R.items, dist: R.dist,
  template: R.template, blacklist: R.blacklist, templateHits: R.templateHits,
  misalignHard: R.misalignHard, misalignAnswerRelated: R.misalignAnswerRelated,
  strictCompat: R.strictCompat, strictPct: pct(R.strictCompat, R.dist),
  misalignHardPct: pct(R.misalignHard, R.dist),
  looseMisaligned: R.looseMisaligned, loosePct: R.loosePct,
  ambigUnion: R.ambigUnion, a1: R.a1, a2: R.a2, a3: R.a3,
  lenLow: R.lenLow, lenHigh: R.lenHigh, lenFailTotal: R.lenLow + R.lenHigh,
  note: R.note, notePct: pct(R.note, R.items),
  idNotInVocab: R.idNotInVocab, missingTotal: R.missingTotal,
  missingByChapter: Object.fromEntries(Object.entries(R.missing).map(([c, m]) => [c, m.length])),
});

const out = {
  A: show("当前发布版", RA),
  B: show("仅原始分片（不含 fix）", RB),
  B2: show("仅原始分片 + 16-fix-61-110（模型重生成片）", RB2),
  BMissingChapters: RB.missing,
  shardHypothesis: {
    all: allShards,
    counterExamples,
  },
};
await writeOut("s8-ab.json", JSON.stringify(out, null, 1));
for (const s of [out.A, out.B, out.B2]) {
  console.log(`--- ${s.label}`);
  console.log(`  items=${s.items} dist=${s.dist} missing=${s.missingTotal} idNotInVocab=${s.idNotInVocab}`);
  console.log(`  template=${s.template} misalignHard=${s.misalignHard} (${s.misalignHardPct}%) strictCompat=${s.strictCompat} (${s.strictPct}%) looseMis=${s.looseMisaligned} (${s.loosePct}%)`);
  console.log(`  ambigUnion=${s.ambigUnion} (A1=${s.a1} A2=${s.a2} A3=${s.a3}) lenFail=${s.lenFailTotal} note=${s.notePct}%`);
}
console.log(`counterExamples(fix命名≠脚本产物 或 反之)=${counterExamples.length}`);
console.log(JSON.stringify(counterExamples.map((x) => x.file + " gen=" + x.generator), null, 0));
