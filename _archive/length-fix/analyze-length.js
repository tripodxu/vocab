// Script to analyze distractor length ratios
import fs from 'fs';

function normalizeMeaning(text) {
  return String(text ?? "")
    .replace(/[\s\u3000]+/g, "")
    .replace(/[，,；;、。.．·・:：!！?？"'""''()（）[\]【】<>《》/\\|-]/g, "")
    .toLowerCase();
}

const chapters = [12, 13, 14, 15];

for (const chapter of chapters) {
  console.log(`\n=== Chapter ${chapter} ===`);
  const quiz = JSON.parse(fs.readFileSync(`public/quiz-${chapter}.json`, 'utf8'));
  const data = JSON.parse(fs.readFileSync(`public/data-${chapter}.json`, 'utf8'));

  const issues = [];

  for (const [id, item] of Object.entries(quiz.items)) {
    const word = data.find(d => d.id === parseInt(id));
    if (!word) continue;

    const correctLen = normalizeMeaning(word.meaningCN).length;
    if (correctLen === 0) continue;

    item.distractors.forEach((dist, index) => {
      const distLen = normalizeMeaning(dist.text).length;
      const ratio = distLen / correctLen;

      if (ratio < 0.3 || ratio > 2.5) {
        issues.push({
          id,
          word: word.word,
          meaningCN: word.meaningCN,
          distIndex: index,
          distText: dist.text,
          ratio: ratio.toFixed(2),
          correctLen,
          distLen
        });
      }
    });
  }

  console.log(`Total issues: ${issues.length}`);
  if (issues.length > 0) {
    console.table(issues.slice(0, 20)); // Show first 20 issues
  }
}
