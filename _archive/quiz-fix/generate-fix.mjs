/**
 * 生成干扰项长度修复文件
 * 规范：干扰项长度在正确释义的 0.4-2.5 倍之间
 */
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseJsonLoose, normalizeMeaning, meaningsConflict } from "../../scripts/quiz-lib.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");

async function loadJson(file) {
  return parseJsonLoose(await readFile(file, "utf8"));
}

/**
 * 检查干扰项长度是否合规
 */
function isLengthValid(distractorText, correctMeaning) {
  const dLen = normalizeMeaning(distractorText).length;
  const cLen = normalizeMeaning(correctMeaning).length;
  if (cLen === 0) return true;
  const ratio = dLen / cLen;
  return ratio >= 0.4 && ratio <= 2.5;
}

/**
 * 计算长度比
 */
function getRatio(distractorText, correctMeaning) {
  const dLen = normalizeMeaning(distractorText).length;
  const cLen = normalizeMeaning(correctMeaning).length;
  if (cLen === 0) return 1;
  return dLen / cLen;
}

/**
 * 从词库中选取合适的干扰项
 */
function pickDistractor(word, pool, existingTexts) {
  const correctLen = normalizeMeaning(word.meaningCN).length;
  
  // 筛选候选词
  const candidates = pool.filter(w => {
    // 不能是自己
    if (w.id === word.id) return false;
    
    // 不能与正确释义冲突
    if (meaningsConflict(w.meaningCN, word.meaningCN)) return false;
    
    // 不能与已有干扰项冲突
    if (existingTexts.some(t => meaningsConflict(t, w.meaningCN))) return false;
    
    // 长度必须合规
    return isLengthValid(w.meaningCN, word.meaningCN);
  });
  
  if (candidates.length === 0) return null;
  
  // 优先选择同主题或同词根的
  const withRoot = candidates.filter(w => {
    if (!word.root || !w.word) return false;
    return word.root.includes(w.word) || w.root?.includes(word.word);
  });
  
  const pool2 = withRoot.length > 0 ? withRoot : candidates;
  
  // 随机选择
  return pool2[Math.floor(Math.random() * pool2.length)];
}

/**
 * 推断干扰项类型
 */
function inferKind(word, distractor) {
  if (!word.root || !distractor.word) return "sense";
  
  if (word.root.includes(distractor.word)) return "root";
  if (distractor.root?.includes(word.word)) return "root";
  
  if (word.pos !== distractor.pos) return "pos";
  
  return "sense";
}

/**
 * 生成简短的 why
 */
function generateWhy(word, distractor, kind) {
  const w = word.word;
  const d = distractor.word;
  
  switch (kind) {
    case "root":
      return `${d} 与 ${w} 同词根但含义不同`;
    case "pos":
      return `${d} 词性不同`;
    case "form":
      return `${d} 形近但意思不同`;
    case "sense":
      return `${d} 与 ${w} 意思有区别`;
    default:
      return `${d} 与 ${w} 不同`;
  }
}

/**
 * 修复单个章节
 */
async function fixChapter(chapter) {
  const dataFile = path.join(root, `public/data-${chapter}.json`);
  const quizFile = path.join(root, `public/quiz-${chapter}.json`);
  
  if (!existsSync(dataFile)) {
    console.log(`  词库文件不存在：${dataFile}`);
    return null;
  }
  
  if (!existsSync(quizFile)) {
    console.log(`  题源文件不存在：${quizFile}`);
    return null;
  }
  
  const pool = await loadJson(dataFile);
  const quiz = await loadJson(quizFile);
  
  const fixedItems = {};
  let fixCount = 0;
  let totalDistractors = 0;
  
  for (const [id, item] of Object.entries(quiz.items)) {
    const word = pool.find(w => String(w.id) === String(id));
    if (!word) {
      console.log(`  词库中找不到 id=${id}`);
      fixedItems[id] = item;
      continue;
    }
    
    const fixedDistractors = [];
    const existingTexts = [];
    
    for (const d of (item.distractors || [])) {
      totalDistractors++;
      
      if (isLengthValid(d.text, word.meaningCN)) {
        // 长度合规，保留
        fixedDistractors.push(d);
        existingTexts.push(d.text);
      } else {
        // 需要修复
        fixCount++;
        const ratio = getRatio(d.text, word.meaningCN);
        
        const picked = pickDistractor(word, pool, existingTexts);
        
        if (picked) {
          const kind = inferKind(word, picked);
          const why = generateWhy(word, picked, kind);
          
          fixedDistractors.push({
            text: picked.meaningCN,
            kind: d.kind, // 保持原 kind
            why: why.substring(0, 40)
          });
          existingTexts.push(picked.meaningCN);
        } else {
          // 找不到合适替代，保留原样
          console.log(`    #${id} 无法找到合适替代干扰项`);
          fixedDistractors.push(d);
          existingTexts.push(d.text);
        }
      }
    }
    
    fixedItems[id] = {
      ...(item.need ? { need: item.need } : {}),
      ...(item.note ? { note: item.note } : {}),
      distractors: fixedDistractors
    };
  }
  
  console.log(`  修复了 ${fixCount}/${totalDistractors} 个干扰项`);
  
  return {
    spec: "1.0",
    chapter: chapter,
    source: "model",
    generator: "mimo-v2.5-pro-length-fix",
    items: fixedItems
  };
}

async function main() {
  const chapters = [19, 20, 21, 22];
  
  for (const chapter of chapters) {
    console.log(`\n处理第 ${chapter} 章...`);
    const result = await fixChapter(chapter);
    
    if (result) {
      const outFile = path.join(here, `${chapter}-fix-length.json`);
      await writeFile(outFile, JSON.stringify(result, null, 2), "utf8");
      console.log(`  已生成：${outFile}`);
    }
  }
  
  console.log("\n完成！");
}

main().catch(console.error);
