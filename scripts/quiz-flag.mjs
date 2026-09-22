/**
 * 逐题缺陷标记：对 public/quiz-N.json 的每一条题源打出缺陷标签，生成逐章修复工作清单。
 *
 * 标签（P0 = 硬伤必须修，P1 = 应修，P2 = 可选）：
 *   err      校验器判错（配额/黑名单/冲突等，引用 quiz-lib validateQuizDoc）
 *   ambig    选项与正确释义义项集合重合（选了也算对）或归一化后互为子串
 *   misalign 辨析在讲别的词（why 点名的词与所挂选项、与正确释义都对不上）
 *   tmpl     空话模板 why（黑名单 / 已知模板正则）
 *   eng      干扰项 text 夹带英文单词（非词性标记/形态注记）
 *   dupwhy   同一题内两条 why 逐字重复
 *   basewhy  辨析在讲目标词自己而非所挂选项（半错位）
 *   lenOut   干扰项/正确释义长度比 <0.5 或 >2.0（作弊风险）
 *   univ     万能干扰项（同一 text 在本章被用 ≥3 次）
 *   noNote   缺 note（原始分片也没有，可补）
 *
 * 用法：node scripts/quiz-flag.mjs            # 全部章节 → _audit/work/
 *       node scripts/quiz-flag.mjs --only 1,5
 */

import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { validateQuizDoc, WHY_BLACKLIST, UNIVERSAL_MIN } from "./quiz-lib.mjs";
import {
  loadAll,
  buildTokenIndex,
  resolveWhy,
  normalize,
  minOverlap,
  senseCover,
  matchTemplate,
} from "../_audit/indep/lib.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = join(root, "_audit", "work");
mkdirSync(outDir, { recursive: true });

const argv = process.argv.slice(2);
const only = (() => {
  const i = argv.indexOf("--only");
  if (i < 0) return null;
  return new Set(String(argv[i + 1] || "").split(",").map(Number).filter(Boolean));
})();

const { chapters, data, quiz } = await loadAll();
const tokenIndex = buildTokenIndex(data);

/** 干扰项 text 是否夹带英文词（剔除词性标记/形态注记后仍有 ≥2 连续字母） */
function englishInText(text) {
  const t = String(text || "")
    .replace(/\([^)]*[A-Za-z][^)]*\)/g, "") // （bacterium的复数）/ (= gymnasium)
    .replace(/\[[^\]]*\]/g, "") // [the G-] [-s]
    .replace(/\b(vi|vt|v|n|adj|adv|prep|conj|pron|num|int|pl|sing|abbr)\./gi, "")
    .replace(/[~≈]/g, "");
  const m = t.match(/[A-Za-z]{2,}/);
  return m ? m[0] : null;
}

/** why 是否命中黑名单（正则口径，与校验器一致） */
function hitBlacklist(why) {
  const s = String(why || "").trim();
  for (const re of WHY_BLACKLIST) if (re.test(s)) return String(re);
  return null;
}

/** 汇总每章校验结果并按 id 归组 */
function chapterValidation(c, doc, wordList) {
  const { errors, warnings } = validateQuizDoc(doc, { chapter: c, words: wordList });
  const byId = new Map();
  const grab = (line) => {
    const m = String(line).match(/#(\d+)/);
    if (!m) return;
    const id = Number(m[1]);
    if (!byId.has(id)) byId.set(id, { errors: [], warnings: [] });
    return byId.get(id);
  };
  for (const e of errors) grab(e)?.errors.push(String(e).replace(/#\d+\s*/, ""));
  for (const w of warnings) grab(w)?.warnings.push(String(w).replace(/#\d+\s*/, ""));
  return { errors, warnings, byId };
}

const summary = [];
for (const c of chapters) {
  if (only && !only.has(c)) continue;
  const doc = quiz.get(c);
  const wordList = data.get(c) || [];
  const byId = new Map(wordList.map((w) => [Number(w.id), w]));
  const { errors, warnings, byId: valById } = chapterValidation(c, doc, wordList);

  // 万能干扰项：章内归一化 text 计数
  const textCount = new Map();
  for (const item of Object.values(doc.items || {}))
    for (const d of item.distractors || []) {
      const k = normalize(d.text);
      textCount.set(k, (textCount.get(k) || 0) + 1);
    }

  /** @type {Record<string, any>} */
  const flagged = {};
  let stats = { err: 0, ambig: 0, misalign: 0, tmpl: 0, eng: 0, dupwhy: 0, basewhy: 0, lenOut: 0, univ: 0, noNote: 0 };

  for (const [idStr, item] of Object.entries(doc.items || {})) {
    const id = Number(idStr);
    const entry = byId.get(id);
    const flags = {};
    const detail = {};

    const ve = valById.get(id);
    if (ve?.errors?.length) { flags.err = ve.errors; stats.err++; }
    if (!item.note) { flags.noNote = true; stats.noNote++; }

    const answerText = entry?.meaningCN || "";
    const seenWhy = new Map();
    (item.distractors || []).forEach((d, di) => {
      const why = String(d.why || "");
      // 模板/黑名单
      const tpl = matchTemplate(why);
      const bl = tpl ? null : hitBlacklist(why);
      if (tpl || bl) {
        flags.tmpl = flags.tmpl || [];
        flags.tmpl.push(di);
        stats.tmpl++;
      }
      // 歧义：义项集合覆盖 / 子串
      const na = normalize(d.text), ns = normalize(answerText);
      const covered = senseCover(d.text, answerText);
      const sub = na && ns && (ns.includes(na) || na === ns);
      if (covered || sub) {
        flags.ambig = flags.ambig || [];
        flags.ambig.push({ di, why: covered ? "义项覆盖" : "子串" });
        stats.ambig++;
      }
      // 错位：why 点名的词与选项/答案都对不上（中文近义改写：允许共享任一汉字）
      const sharesChar = (a, b) => {
        const x = normalize(a), y = normalize(b);
        if (!x || !y) return false;
        for (const ch of y) if (x.includes(ch)) return true;
        return false;
      };
      const r = resolveWhy(why, tokenIndex);
      if (r.tokens.length && r.named.size) {
        const relatesOpt = [...r.named].some((w) => minOverlap(w.meaningCN, d.text) >= 0.34 || sharesChar(w.meaningCN, d.text));
        const relatesAns = [...r.named].some((w) => minOverlap(w.meaningCN, answerText) >= 0.34 || sharesChar(w.meaningCN, answerText));
        if (!relatesOpt && !relatesAns) {
          flags.misalign = flags.misalign || [];
          flags.misalign.push({ di, named: [...r.named].map((w) => w.word).slice(0, 3) });
          stats.misalign++;
        } else if (!relatesOpt) {
          flags.basewhy = flags.basewhy || [];
          flags.basewhy.push(di);
          stats.basewhy++;
        }
      }
      // 长度
      const la = String(d.text || "").length, lb = String(answerText).length;
      const ratio = lb ? la / lb : 1;
      if (ratio < 0.5 || ratio > 2.0) {
        flags.lenOut = flags.lenOut || [];
        flags.lenOut.push({ di, ratio: Math.round(ratio * 100) });
        stats.lenOut++;
      }
      // 英文夹带
      const eng = englishInText(d.text);
      if (eng) {
        flags.eng = flags.eng || [];
        flags.eng.push({ di, word: eng });
        stats.eng++;
      }
      // 同题 why 重复
      if (why) {
        if (seenWhy.has(why)) {
          flags.dupwhy = flags.dupwhy || [];
          flags.dupwhy.push({ di, other: seenWhy.get(why) });
          stats.dupwhy++;
        } else seenWhy.set(why, di);
      }
      // 万能项（同一 text 在本章被复用 ≥ UNIVERSAL_MIN 次才算滥用，与校验器/fixlist 同口径）
      const k = normalize(d.text);
      if ((textCount.get(k) || 0) >= UNIVERSAL_MIN) {
        flags.univ = flags.univ || [];
        flags.univ.push({ di, count: textCount.get(k) });
        stats.univ++;
      }
    });

    if (Object.keys(flags).length) {
      flagged[idStr] = {
        word: entry?.word || "",
        pos: entry?.pos || "",
        meaningCN: answerText,
        root: entry?.root || "",
        priority: flags.err || flags.ambig || flags.misalign || flags.tmpl || flags.eng || flags.dupwhy ? "P0" : "P1",
        flags,
        item,
      };
    }
  }

  const file = join(outDir, `${c}-flags.json`);
  writeFileSync(
    file,
    JSON.stringify({ chapter: c, stats, validationErrors: errors, validationWarningCount: warnings.length, flagged }, null, 1)
  );
  summary.push({ chapter: c, total: Object.keys(doc.items || {}).length, flagged: Object.keys(flagged).length, ...stats });
}

console.table(summary);
console.log(`工作清单已写入 ${outDir}/N-flags.json`);
// 退出码约定：0 = 无校验错误；--strict 时"存在任何标记"也视为 1（供自动化门禁使用）
if (process.argv.includes("--strict") && summary.some((s) => s.err || s.ambig || s.misalign || s.tmpl)) {
  console.error("strict：存在 P0 级缺陷（err/ambig/misalign/tmpl）");
  process.exit(1);
}
