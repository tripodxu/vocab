/**
 * 反向题源（rev：看中文选英文）全量生成器。
 *
 * 为词库里的每个词自产 3 个英文干扰词（text = 英文词），与正向题源同源产出：
 *   - root：与目标词共享词根 token（来自 root 字段的 token（释义）对）
 *   - form：拼写相近（前缀 ≥3 / 后缀 ≥4 / 只差一个字母；短词放宽到前缀 ≥2）
 *   - topic：同章词（兜底）
 * 硬约束：不得与答案同形/互为屈折；干扰词的释义不得与题面互含（两个都说得通）；
 * 同一英文词在章内作为 rev 干扰项不超过 2 次；why 按关系生成（讲出错误单词的含义）。
 * 产出 content/quiz/N-rev.json（items = 完整条目 + rev），交由 quiz.mjs merge 校验收口。
 *
 * 用法：node scripts/quiz-rev-generate.mjs [--only 1,21]
 */

import { writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeMeaning, meaningsConflict, WHY_BLACKLIST } from "./quiz-lib.mjs";
import { senseCover, minOverlap } from "../_audit/indep/lib.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const only = (() => {
  const i = argv.indexOf("--only");
  if (i < 0) return null;
  return new Set(String(argv[i + 1] || "").split(",").map(Number).filter(Boolean));
})();

/* ---------- 与 quiz-optimize.mjs 同款的小工具 ---------- */
const charLen = (s) => String(s || "").length;
const shortOf = (text, n = 9) => {
  const s = String(text || "").split(/[，,；;、]/)[0].trim();
  return s.length > n ? s.slice(0, n) : s;
};
function rootPairs(entry) {
  const out = [];
  for (const m of String(entry?.root || "").matchAll(/([A-Za-z][A-Za-z-]*)\s*[（(]([^）)]*)[）)]/g)) {
    const tok = m[1].replace(/-+$/, "");
    if (tok.length >= 2 && m[2].trim()) out.push({ tok, gloss: m[2].trim() });
  }
  return out;
}
function formRel(a, b) {
  const x = String(a).toLowerCase(), y = String(b).toLowerCase();
  if (!x || !y || x === y) return false;
  let p = 0;
  while (p < x.length && p < y.length && x[p] === y[p]) p++;
  if (p >= 3 || (Math.min(x.length, y.length) <= 5 && p >= 2)) return true;
  let sfx = 0;
  while (sfx < x.length && sfx < y.length && x[x.length - 1 - sfx] === y[y.length - 1 - sfx]) sfx++;
  if (sfx >= 4) return true;
  if (x.length === y.length) {
    let diff = 0;
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) diff++;
    if (diff === 1) return true;
  }
  return false;
}
function jitter(a, b) {
  const s = `${a}|${b}`;
  let h = 11;
  for (let i = 0; i < s.length; i++) h = (h * 33 + s.charCodeAt(i)) >>> 0;
  return (h % 89) / 89 * 2.5;
}
const whyOk = (why) => charLen(why) >= 6 && charLen(why) <= 40 && !WHY_BLACKLIST.some((re) => re.test(why));

function genRevWhy(base, other, kind, sharedTok) {
  const om = shortOf(other?.meaningCN);
  const ow = String(other?.word || "");
  let why = "";
  if (kind === "root" && sharedTok) why = `${sharedTok}- 同根，${ow} 指${om}`;
  else if (kind === "root") why = `${ow} 与 ${base?.word} 同根，${ow} 指${om}`;
  else if (kind === "form") why = `${ow} 与 ${base?.word} 拼写相近，${ow} 指${om}`;
  else why = `${ow} 指${om}`;
  if (charLen(why) > 40) why = why.slice(0, 39) + "…";
  return why;
}

/* ---------- 加载 ---------- */
const chapters = [];
for (let c = 1; c <= 22; c++) {
  chapters.push({
    c,
    words: JSON.parse(readFileSync(join(root, "public", `data-${c}.json`), "utf8")),
    quiz: JSON.parse(readFileSync(join(root, "public", `quiz-${c}.json`), "utf8")),
  });
}
/** 全词库候选池（带章号） */
const globalPool = [];
for (const { c, words } of chapters) for (const w of words) globalPool.push({ ...w, _ch: c });

/* ---------- 逐章生成 ---------- */
const report = [];
for (const { c, words, quiz } of chapters) {
  if (only && !only.has(c)) continue;

  /** 章内 rev 干扰词频次（万能项约束） */
  const freq = new Map();
  const bump = (word, n) => freq.set(word, (freq.get(word) || 0) + n);

  const genItems = {};
  let noValuable = 0;
  for (const base of words) {
    const baseWord = String(base.word || "");
    const baseLen = Math.max(1, charLen(baseWord.replace(/[^A-Za-z]/g, "")));
    const baseMeaning = String(base.meaningCN || "");

    /** @type {{word:string, kind:string, why:string}[]} */
    const picked = [];
    const avoidWords = new Set([baseWord.toLowerCase()]);
    let round = 0;
    const want = 3;
    while (picked.length < want && round < 6) {
      const needValuable = !picked.some((p) => p.kind !== "topic") && round >= 0;
      const band = round < 2 ? [0.5, 2.0] : round < 4 ? [0.4, 2.5] : [0, 3.0];
      /** @type {{other:any, kind:string, score:number, why:string}[]} */
      const scored = [];
      outer: for (const other of globalPool) {
        const ow = String(other.word || "");
        if (!ow || avoidWords.has(ow.toLowerCase())) continue;
        if (ow.toLowerCase().startsWith(baseWord.toLowerCase()) || baseWord.toLowerCase().startsWith(ow.toLowerCase())) continue;
        if (meaningsConflict(other.meaningCN, baseMeaning)) continue; // 反向歧义：它也能回答这道题
        if (senseCover(other.meaningCN, baseMeaning)) continue;
        if ((freq.get(ow) || 0) >= 2) continue; // 万能项约束
        const wLen = charLen(ow.replace(/[^A-Za-z]/g, ""));
        const ratio = wLen / baseLen;
        if (ratio < band[0] || ratio > band[1]) continue;
        const sharedTok = rootPairs(base).find((p) => rootPairs(other).some((q) => q.tok.toLowerCase() === p.tok.toLowerCase()));
        let kind = null, score = 0;
        if (sharedTok) { kind = "root"; score = 30 + Math.min(8, sharedTok.gloss.length / 4); }
        else if (formRel(baseWord, ow)) { kind = "form"; score = 24; }
        else if (other._ch === c) { kind = "topic"; score = 4; }
        else continue;
        if (needValuable && kind === "topic" && round < 4) continue;
        if (minOverlap(baseMeaning, other.meaningCN) >= 0.8) continue; // 释义几乎相同的近义词
        const sameCh = other._ch === c;
        if (sameCh && kind !== "topic") score += 4;
        // 长度对冲：答案不该总是最长的词——与答案等长或更长的干扰项加分
        if (wLen > baseLen) score += 3;
        else if (wLen === baseLen) score += 1;
        score += jitter(baseWord, ow);
        const shared = sharedTok?.tok ?? null;
        const why = genRevWhy(base, other, kind, shared);
        if (!whyOk(why)) continue;
        scored.push({ other, kind, score, why });
      }
      if (!scored.length) break;
      scored.sort((a, b) => b.score - a.score || String(a.other.word).localeCompare(String(b.other.word)));
      const top = scored[0];
      picked.push({ word: top.other.word, kind: top.kind, why: top.why });
      avoidWords.add(top.other.word.toLowerCase());
      bump(top.other.word, 1);
      round++;
    }

    if (!picked.length || !picked.some((p) => p.kind !== "topic")) {
      // 没有任何可辨析候选（极罕见）：不写 rev，反向题走前端兜底
      noValuable++;
      continue;
    }
    if (picked.length < 3) continue; // 凑不满 3 条同样交给兜底，宁缺毋滥

    const cur = quiz.items[String(base.id)] || {};
    const item = {};
    if (cur.note) item.note = cur.note;
    if (cur.need && cur.need !== "spell") item.need = cur.need;
    if (cur.distractors) item.distractors = cur.distractors;
    // gloss = 干扰词的词库释义：同章词可省，跨章词必须带（校验器用它做"两个都说得通"判定）
    item.rev = {
      distractors: picked.map((p) => {
        const entry = globalPool.find((w) => w.word === p.word);
        return { text: p.word, kind: p.kind, why: p.why, gloss: String(entry?.meaningCN || "").trim() };
      }),
    };
    genItems[String(base.id)] = item;
  }

  writeFileSync(
    join(root, "content", "quiz", `${c}-rev.json`),
    JSON.stringify(
      { spec: "1.1", chapter: c, source: "model+human", generator: "zcode-rev-2026-09-20", updatedAt: "2026-09-20", items: genItems },
      null,
      1
    ) + "\n"
  );
  report.push({ chapter: c, rev: Object.keys(genItems).length, noRev: noValuable });
}

console.table(report);
const tot = report.reduce((a, r) => ({ rev: a.rev + r.rev, no: a.no + r.noRev }), { rev: 0, no: 0 });
console.log("TOTAL", JSON.stringify(tot));
