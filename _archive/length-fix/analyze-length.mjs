/**
 * 分析所有章节干扰项长度问题（只读诊断）。
 *
 * 用法：node scripts/analyze-length.mjs [--chapters 1,2,3]
 *   缺省 --chapters 时按 public/data-*.json 目录发现处理全部章节（不再硬编码 [1,2,3]）。
 */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
// 归一化口径单源：与校验器/出题端同一实现（原先本地拷贝的标点集与 quiz-lib 已漂移）
import { normalizeMeaning, meaningsConflict } from "./quiz-lib.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const publicDir = path.join(root, "public");

const argv = process.argv.slice(2);
const chapterArg = argv.indexOf("--chapters");
let chapters;
if (chapterArg >= 0 && argv[chapterArg + 1]) {
  chapters = String(argv[chapterArg + 1]).split(",").map(Number).filter((n) => Number.isInteger(n) && n > 0);
} else {
  chapters = (await readdir(publicDir))
    .filter((f) => /^data-\d+\.json$/.test(f))
    .map((f) => Number(f.match(/\d+/)[0]))
    .sort((a, b) => a - b);
}

for (const ch of chapters) {
  const dataFile = path.join(publicDir, `data-${ch}.json`);
  const quizFile = path.join(publicDir, `quiz-${ch}.json`);

  const words = JSON.parse(await readFile(dataFile, "utf8"));
  const quiz = JSON.parse(await readFile(quizFile, "utf8"));

  const byId = new Map(words.map(w => [Number(w.id), w]));

  const problems = [];

  for (const [id, item] of Object.entries(quiz.items)) {
    const entry = byId.get(Number(id));
    if (!entry) continue;

    const correctLen = normalizeMeaning(entry.meaningCN).length;

    for (const [idx, d] of (item.distractors || []).entries()) {
      const dLen = normalizeMeaning(d.text).length;
      const ratio = dLen / Math.max(1, correctLen);

      if (ratio < 0.4 || ratio > 2.5) {
        problems.push({
          id: Number(id),
          word: entry.word,
          correctMeaning: entry.meaningCN,
          correctLen,
          distractorIdx: idx,
          distractorText: d.text,
          distractorKind: d.kind,
          distractorLen: dLen,
          ratio: Math.round(ratio * 100) / 100,
        });
      }
    }
  }

  console.log(`\n=== 第 ${ch} 章 ===`);
  console.log(`总词条: ${words.length}, 题源词条: ${Object.keys(quiz.items).length}`);
  console.log(`长度异常干扰项: ${problems.length}`);

  // Group by severity
  const tooShort = problems.filter(p => p.ratio < 0.4);
  const tooLong = problems.filter(p => p.ratio > 2.5);
  console.log(`  太短 (ratio<0.4): ${tooShort.length}`);
  console.log(`  太长 (ratio>2.5): ${tooLong.length}`);

  // Print details
  for (const p of problems) {
    console.log(`  #${p.id} ${p.word}: "${p.distractorText}" (len=${p.distractorLen}) vs "${p.correctMeaning}" (len=${p.correctLen}) → ratio=${p.ratio} [${p.distractorKind}]`);
  }
}
