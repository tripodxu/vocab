/**
 * 生成干扰项长度修复文件
 *
 * 策略：
 * 1. 对每个 ratio < 0.4 或 > 2.5 的干扰项，需要重写
 * 2. 重写时保持 kind 不变
 * 3. 优先从同章其它词的 meaningCN 中选取长度接近的作为干扰项
 * 4. 如果找不到合适的同章词释义，则扩写/缩写当前干扰项文本
 *
 * 用法：node scripts/gen-length-fix.mjs --chapters 8,9,10,11
 *   必须显式给章号：本脚本会覆盖 content/quiz/N-fix-length.json，隐式全量跑容易误覆盖。
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
// 归一化口径单源：与校验器/出题端同一实现（原先本地拷贝的标点集与 quiz-lib 已漂移）
import { normalizeMeaning, meaningsConflict, QUIZ_SPEC_VERSION } from "./quiz-lib.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const publicDir = path.join(root, "public");

const argv = process.argv.slice(2);
const chapterArg = argv.indexOf("--chapters");
const chapters = chapterArg >= 0 && argv[chapterArg + 1]
  ? String(argv[chapterArg + 1]).split(",").map(Number).filter((n) => Number.isInteger(n) && n > 0)
  : null;
if (!chapters || !chapters.length) {
  console.error("必须显式指定要修复的章：node scripts/gen-length-fix.mjs --chapters 8,9,10,11");
  process.exit(2);
}

// 从同章词库中找合适的干扰项释义
function findReplacement(correctMeaning, otherTexts, kind, allMeanings) {
  const correctLen = normalizeMeaning(correctMeaning).length;
  const targetMin = Math.ceil(correctLen * 0.4);
  const targetMax = Math.floor(correctLen * 2.5);

  // 从同章词的 meaningCN 中找长度匹配的
  const candidates = [];
  for (const m of allMeanings) {
    const mLen = normalizeMeaning(m).length;
    if (mLen >= targetMin && mLen <= targetMax) {
      // 不能与正确释义冲突
      if (!meaningsConflict(m, correctMeaning)) {
        // 不能与其它干扰项重复
        if (!otherTexts.some(t => meaningsConflict(t, m))) {
          candidates.push(m);
        }
      }
    }
  }

  // 按长度接近度排序
  candidates.sort((a, b) => {
    const aDiff = Math.abs(normalizeMeaning(a).length - correctLen);
    const bDiff = Math.abs(normalizeMeaning(b).length - correctLen);
    return aDiff - bDiff;
  });

  return candidates.length > 0 ? candidates[0] : null;
}

for (const ch of chapters) {
  const dataFile = path.join(publicDir, `data-${ch}.json`);
  const quizFile = path.join(publicDir, `quiz-${ch}.json`);

  const words = JSON.parse(await readFile(dataFile, "utf8"));
  const quiz = JSON.parse(await readFile(quizFile, "utf8"));

  const byId = new Map(words.map(w => [Number(w.id), w]));

  // 收集所有 meaningCN 作为候选干扰项池
  const allMeanings = words.map(w => w.meaningCN);

  const fixItems = {};
  let fixCount = 0;

  for (const [id, item] of Object.entries(quiz.items)) {
    const entry = byId.get(Number(id));
    if (!entry) continue;

    const correctMeaning = entry.meaningCN;
    const correctLen = normalizeMeaning(correctMeaning).length;

    const newDistractors = [];
    let hasChanges = false;
    const otherTexts = [];

    for (const d of (item.distractors || [])) {
      const dLen = normalizeMeaning(d.text).length;
      const ratio = dLen / Math.max(1, correctLen);

      if (ratio < 0.4 || ratio > 2.5) {
        // 需要修复
        const replacement = findReplacement(correctMeaning, otherTexts, d.kind, allMeanings);
        if (replacement) {
          newDistractors.push({
            text: replacement,
            kind: d.kind,
            why: d.why
          });
          otherTexts.push(replacement);
          hasChanges = true;
          fixCount++;
        } else {
          // 找不到合适的替换，保留原文本
          newDistractors.push(d);
          otherTexts.push(d.text);
        }
      } else {
        newDistractors.push(d);
        otherTexts.push(d.text);
      }
    }

    if (hasChanges) {
      fixItems[id] = { distractors: newDistractors };
    }
  }

  const today = new Date().toISOString().slice(0, 10);
  const fixDoc = {
    spec: QUIZ_SPEC_VERSION,
    chapter: ch,
    source: "model",
    generator: `length-fix-${today}`,
    updatedAt: today,
    items: fixItems
  };

  const outDir = path.join(root, "content", "quiz");
  if (!existsSync(outDir)) await mkdir(outDir, { recursive: true });
  const outFile = path.join(outDir, `${ch}-fix-length.json`);
  await writeFile(outFile, JSON.stringify(fixDoc, null, 2), "utf8");
  console.log(`第 ${ch} 章：修复 ${fixCount} 个干扰项 → ${outFile}`);
}
