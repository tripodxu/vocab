/**
 * 从 quiz-flag.mjs 的输出生成逐章"修复工作清单"（给逐题优化用，精简版）。
 *
 * 收录：P0（校验错误/歧义/错位/模板/英文夹带/同题重复why）
 *      + 极端长度（比率 <40% 或 >250%）
 *      + 万能干扰项（章内同一 text ≥5 次）
 *      + 缺 note（ch1）
 * basewhy（辨析在讲目标词自己）单独列出，由优化者自行判断是否值得改。
 *
 * 用法：node scripts/quiz-fixlist.mjs   → _audit/work/N-fixlist.json
 */

import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { normalize } from "../_audit/indep/lib.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const work = join(root, "_audit", "work");

for (let c = 1; c <= 22; c++) {
  const flagFile = join(work, `${c}-flags.json`);
  if (!existsSafe(flagFile)) continue;
  const { stats, flagged } = JSON.parse(readFileSync(flagFile, "utf8"));

  // 章内 text 复用计数（univ 依据）
  const textCount = new Map();
  for (const f of Object.values(flagged))
    for (const d of f.item?.distractors || []) {
      const k = normalize(d.text);
      textCount.set(k, (textCount.get(k) || 0) + 1);
    }

  /** @type {any[]} */
  const must = [];
  /** @type {any[]} */
  const review = []; // basewhy-only：交给优化者判断
  for (const [id, f] of Object.entries(flagged)) {
    const fl = f.flags || {};
    const isP0 = fl.err || fl.ambig || fl.misalign || fl.tmpl || fl.eng || fl.dupwhy;
    const extreme = (fl.lenOut || []).some((x) => x.ratio < 40 || x.ratio > 250);
    const univ = fl.univ;
    if (isP0 || fl.lenOut || univ || fl.noNote || fl.basewhy) {
      must.push({
        id: Number(id),
        word: f.word,
        pos: f.pos,
        meaningCN: f.meaningCN,
        root: f.root,
        reasons: {
          err: fl.err || undefined,
          ambig: fl.ambig || undefined,
          misalign: fl.misalign || undefined,
          tmpl: fl.tmpl || undefined,
          eng: fl.eng || undefined,
          dupwhy: fl.dupwhy || undefined,
          extremeLen: fl.lenOut,
          univ: univ || undefined,
          noNote: fl.noNote || undefined,
          basewhy: fl.basewhy || undefined,
        },
        current: f.item,
      });
    } else if (false) {
      review.push({ id: Number(id), word: f.word, meaningCN: f.meaningCN, note: "why 疑似在讲目标词而非所挂选项，判断后决定是否重写" });
    }
  }
  must.sort((a, b) => a.id - b.id);

  // 章内被滥用的 text 榜（≥5 次）：这些不要再当干扰项用
  const overused = [...textCount.entries()]
    .filter(([, n]) => n >= 3)
    .map(([k, n]) => ({ text: k, count: n }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 15);

  writeFileSync(join(work, `${c}-fixlist.json`), JSON.stringify({ chapter: c, stats, overused, mustCount: must.length, reviewCount: review.length, must, review }, null, 1));
  console.log(`ch${c}: must=${must.length} review=${review.length} overused=${overused.length}`);
}

function existsSafe(p) {
  try {
    readFileSync(p);
    return true;
  } catch {
    return false;
  }
}
