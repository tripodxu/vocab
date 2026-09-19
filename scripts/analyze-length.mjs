/**
 * 分析所有章节干扰项长度问题
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const publicDir = path.join(root, "public");

function normalizeMeaning(text) {
  return String(text ?? "")
    .replace(/[\s\u3000]+/g, "")
    .replace(/[，,；;、。.．·・:：!！?？"'""''()（）[\]【】<>《》/\\|-]/g, "")
    .toLowerCase();
}

function meaningsConflict(a, b) {
  const na = normalizeMeaning(a);
  const nb = normalizeMeaning(b);
  if (!na || !nb) return true;
  return na === nb || na.includes(nb) || nb.includes(na);
}

const chapters = [1, 2, 3];

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
