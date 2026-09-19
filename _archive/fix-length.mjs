/**
 * 修复干扰项长度异常的脚本
 * 规范：干扰项长度在正确释义的 0.4-2.5 倍之间
 */
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  QUIZ_SPEC_VERSION,
  normalizeMeaning,
  meaningsConflict,
  QUIZ_KINDS,
} from "../../scripts/quiz-lib.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");

/**
 * 从词库中随机选取干扰项
 */
function pickDistractorsFromPool(word, pool, existingDistractors, count = 3) {
  const candidates = pool.filter(w => {
    if (w.id === word.id) return false;
    if (meaningsConflict(w.meaningCN, word.meaningCN)) return false;
    if (existingDistractors.some(d => meaningsConflict(d.text, w.meaningCN))) return false;
    return true;
  });
  
  // 随机打乱
  const shuffled = candidates.sort(() => Math.random() - 0.5);
  return shuffled.slice(0, count);
}

/**
 * 判断干扰项类型
 */
function guessKind(word, distractor) {
  const wRoot = word.root || "";
  const dWord = distractor.word;
  
  if (wRoot && dWord && wRoot.includes(dWord)) return "root";
  if (word.pos !== distractor.pos) return "pos";
  return "sense";
}

/**
 * 生成 why
 */
function generateWhy(word, distractor, kind) {
  const w = word.word;
  const d = distractor.word;
  
  switch (kind) {
    case "root":
      return `${d} 与 ${w} 同词根，但含义不同`;
    case "pos":
      return `${d} 词性与 ${w} 不同`;
    case "sense":
      return `${d} 与 ${w} 意思相近但用法不同`;
    default:
      return `${d} 与 ${w} 有区别`;
  }
}

async function fixChapter(chapter) {
  const dataFile = path.join(root, `public/data-${chapter}.json`);
  const quizFile = path.join(root, `public/quiz-${chapter}.json`);
  
  if (!existsSync(dataFile)) {
    console.log(`第 ${chapter} 章词库不存在，跳过`);
    return null;
  }
  
  const pool = JSON.parse(await readFile(dataFile, "utf8"));
  const quiz = JSON.parse(await readFile(quizFile, "utf8"));
  
  const fixedItems = {};
  let fixCount = 0;
  
  for (const [id, item] of Object.entries(quiz.items)) {
    const word = pool.find(w => w.id === Number(id));
    if (!word) continue;
    
    const correctLen = normalizeMeaning(word.meaningCN).length;
    const fixedDistractors = [];
    
    for (const d of item.distractors) {
      const dLen = normalizeMeaning(d.text).length;
      const ratio = dLen / correctLen;
      
      if (ratio < 0.4 || ratio > 2.5) {
        // 需要修复
        fixCount++;
        
        // 从词库中选取合适的干扰项
        const candidates = pool.filter(w => {
          if (w.id === word.id) return false;
          if (meaningsConflict(w.meaningCN, word.meaningCN)) return false;
          if (fixedDistractors.some(fd => meaningsConflict(fd.text, w.meaningCN))) return false;
          
          const candidateLen = normalizeMeaning(w.meaningCN).length;
          const candidateRatio = candidateLen / correctLen;
          return candidateRatio >= 0.4 && candidateRatio <= 2.5;
        });
        
        if (candidates.length > 0) {
          const picked = candidates[Math.floor(Math.random() * candidates.length)];
          const kind = guessKind(word, picked);
          const why = generateWhy(word, picked, kind);
          
          fixedDistractors.push({
            text: picked.meaningCN,
            kind: kind,
            why: why.substring(0, 40)
          });
        } else {
          // 保留原干扰项
          fixedDistractors.push(d);
        }
      } else {
        fixedDistractors.push(d);
      }
    }
    
    fixedItems[id] = {
      note: item.note,
      distractors: fixedDistractors
    };
  }
  
  console.log(`第 ${chapter} 章：修复了 ${fixCount} 个干扰项`);
  
  return {
    spec: QUIZ_SPEC_VERSION,
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
      console.log(`已生成修复文件：${outFile}`);
    }
  }
}

main().catch(console.error);
