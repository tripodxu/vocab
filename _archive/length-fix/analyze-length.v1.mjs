import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

function normalizeMeaning(text) {
  return String(text ?? "")
    .replace(/[\s\u3000]+/g, "")
    .replace(/[，,；;、。.．·・:：!！?？"'""''()（）[\]【】<>《》/\\|-]/g, "")
    .toLowerCase();
}

async function analyzeChapter(chapterNum) {
  const dataPath = `F:/目录/杂项/enlish/public/data-${chapterNum}.json`;
  const quizPath = `F:/目录/杂项/enlish/public/quiz-${chapterNum}.json`;
  
  const data = JSON.parse(await readFile(dataPath, "utf8"));
  const quiz = JSON.parse(await readFile(quizPath, "utf8"));
  
  // 创建正确释义映射
  const correctMeanings = {};
  for (const item of data) {
    correctMeanings[String(item.id)] = item.meaningCN;
  }
  
  const issues = [];
  
  for (const [id, item] of Object.entries(quiz.items)) {
    const correctMeaning = correctMeanings[id];
    if (!correctMeaning) continue;
    
    const correctLen = normalizeMeaning(correctMeaning).length;
    
    for (let i = 0; i < item.distractors.length; i++) {
      const d = item.distractors[i];
      const dLen = normalizeMeaning(d.text).length;
      const ratio = dLen / correctLen;
      
      if (ratio < 0.3 || ratio > 2.5) {
        issues.push({
          id,
          word: data.find(w => String(w.id) === id)?.word,
          correctMeaning,
          correctLen,
          distractorIndex: i,
          distractorText: d.text,
          distractorLen: dLen,
          ratio: Math.round(ratio * 100) / 100,
          kind: d.kind
        });
      }
    }
  }
  
  return { chapter: chapterNum, totalIssues: issues.length, issues };
}

// 分析所有三章
const results = [];
for (const ch of [16, 17, 18]) {
  const result = await analyzeChapter(ch);
  results.push(result);
  console.log(`第 ${ch} 章：${result.totalIssues} 个问题干扰项`);
}

// 输出详细问题
for (const result of results) {
  if (result.issues.length > 0) {
    console.log(`\n=== 第 ${result.chapter} 章详细问题 ===`);
    for (const issue of result.issues) {
      console.log(`#${issue.id} ${issue.word}: 正确释义"${issue.correctMeaning}"(${issue.correctLen}字) | 干扰项[${issue.distractorIndex}]"${issue.distractorText}"(${issue.distractorLen}字) ratio=${issue.ratio}`);
    }
  }
}
