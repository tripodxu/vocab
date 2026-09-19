import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

function normalizeMeaning(text) {
  return String(text ?? "")
    .replace(/[\s\u3000]+/g, "")
    .replace(/[，,；;、。.．·・:：!！?？"'""''()（）[\]【】<>《》/\\|-]/g, "")
    .toLowerCase();
}

async function generateFixes(chapterNum) {
  const dataPath = `F:/目录/杂项/enlish/public/data-${chapterNum}.json`;
  const quizPath = `F:/目录/杂项/enlish/public/quiz-${chapterNum}.json`;
  
  const data = JSON.parse(await readFile(dataPath, "utf8"));
  const quiz = JSON.parse(await readFile(quizPath, "utf8"));
  
  // 创建正确释义映射
  const correctMeanings = {};
  for (const item of data) {
    correctMeanings[String(item.id)] = item.meaningCN;
  }
  
  // 收集本章所有释义作为候选干扰项
  const allMeanings = data.map(item => item.meaningCN);
  
  const fixes = { items: {} };
  let fixCount = 0;
  
  for (const [id, item] of Object.entries(quiz.items)) {
    const correctMeaning = correctMeanings[id];
    if (!correctMeaning) continue;
    
    const correctLen = normalizeMeaning(correctMeaning).length;
    const newDistractors = [];
    let needsFix = false;
    
    for (let i = 0; i < item.distractors.length; i++) {
      const d = item.distractors[i];
      const dLen = normalizeMeaning(d.text).length;
      const ratio = dLen / correctLen;
      
      if (ratio < 0.3 || ratio > 2.5) {
        needsFix = true;
        // 找一个合适的替换干扰项
        const candidate = findSuitableDistractor(
          allMeanings, 
          correctMeaning, 
          correctLen, 
          item.distractors.map(x => x.text),
          d.kind
        );
        
        if (candidate) {
          newDistractors.push({
            text: candidate.text,
            kind: d.kind,
            why: generateWhy(d.kind, candidate.text, correctMeaning, data.find(w => String(w.id) === id)?.word)
          });
          fixCount++;
        } else {
          // 如果找不到合适的，保留原样
          newDistractors.push(d);
        }
      } else {
        newDistractors.push(d);
      }
    }
    
    if (needsFix) {
      fixes.items[id] = { distractors: newDistractors };
    }
  }
  
  return { chapter: chapterNum, fixCount, fixes };
}

function findSuitableDistractor(allMeanings, correctMeaning, correctLen, existingTexts, kind) {
  // 过滤掉已存在的干扰项和正确释义
  const candidates = allMeanings.filter(text => 
    text !== correctMeaning && 
    !existingTexts.includes(text) &&
    normalizeMeaning(text).length > 0
  );
  
  // 按长度匹配度排序
  const scored = candidates.map(text => {
    const len = normalizeMeaning(text).length;
    const ratio = len / correctLen;
    const score = ratio >= 0.4 && ratio <= 2.5 ? 100 - Math.abs(ratio - 1) * 50 : 0;
    return { text, score, ratio };
  }).filter(x => x.score > 0);
  
  // 按分数排序，取前5个随机选择
  scored.sort((a, b) => b.score - a.score);
  const topCandidates = scored.slice(0, 5);
  
  if (topCandidates.length === 0) return null;
  
  // 随机选择一个
  const selected = topCandidates[Math.floor(Math.random() * topCandidates.length)];
  return selected;
}

function generateWhy(kind, distractorText, correctMeaning, word) {
  const templates = {
    root: `"${distractorText}"与"${word}"词根相关但含义不同`,
    form: `"${distractorText}"与"${word}"形近但含义不同`,
    sense: `"${distractorText}"是相关概念但侧重点不同`,
    topic: `"${distractorText}"属于同一领域但具体含义不同`,
    antonym: `"${distractorText}"是反义词但方向相反`,
    pos: `"${distractorText}"词性不同或用法不同`
  };
  
  return templates[kind] || `"${distractorText}"与正确释义含义不同`;
}

async function main() {
  // 创建输出目录
  const outputDir = "F:/目录/杂项/enlish/content/quiz";
  await mkdir(outputDir, { recursive: true });
  
  const results = [];
  for (const ch of [16, 17, 18]) {
    const result = await generateFixes(ch);
    results.push(result);
    
    // 写入修复文件
    const outputPath = path.join(outputDir, `${ch}-fix-length.json`);
    const output = {
      spec: "1.0",
      chapter: ch,
      source: "model",
      generator: "mimo-v2.5-pro-length-fix",
      items: result.fixes.items
    };
    
    await writeFile(outputPath, JSON.stringify(output, null, 2), "utf8");
    console.log(`第 ${ch} 章：修复了 ${result.fixCount} 个干扰项，写入 ${outputPath}`);
  }
  
  // 总结
  const totalFixes = results.reduce((sum, r) => sum + r.fixCount, 0);
  console.log(`\n总计修复了 ${totalFixes} 个干扰项长度问题`);
}

main().catch(console.error);
