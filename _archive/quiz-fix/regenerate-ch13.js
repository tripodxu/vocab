// Regenerate chapter 13 fix file with better conflict avoidance
import fs from 'fs';

function normalizeMeaning(text) {
  return String(text ?? "")
    .replace(/[\s\u3000]+/g, "")
    .replace(/[，,；;、。.．·・:：!！?？"'""''()（）[\]【】<>《》/\\|-]/g, "")
    .toLowerCase();
}

const quiz = JSON.parse(fs.readFileSync('public/quiz-13.json', 'utf8'));
const data = JSON.parse(fs.readFileSync('public/data-13.json', 'utf8'));

const fixes = { spec: "1.0", chapter: 13, source: "model", generator: "mimo-v2.5-pro-length-fix", items: {} };

// Process each item
for (const [id, item] of Object.entries(quiz.items)) {
  const word = data.find(d => d.id === parseInt(id));
  if (!word) continue;

  const correctLen = normalizeMeaning(word.meaningCN).length;
  if (correctLen === 0) continue;

  const needsFix = item.distractors.some(dist => {
    const distLen = normalizeMeaning(dist.text).length;
    const ratio = distLen / correctLen;
    return ratio < 0.3 || ratio > 2.5;
  });

  if (needsFix) {
    const newDistractors = item.distractors.map(dist => {
      const distLen = normalizeMeaning(dist.text).length;
      const ratio = distLen / correctLen;

      if (ratio < 0.3 || ratio > 2.5) {
        // Find a better replacement
        const candidates = data.filter(d => {
          const dLen = normalizeMeaning(d.meaningCN).length;
          const r = dLen / correctLen;
          return r >= 0.4 && r <= 2.5 && d.id !== word.id;
        });

        if (candidates.length > 0) {
          const candidate = candidates[Math.floor(Math.random() * candidates.length)];
          const text = candidate.meaningCN.split('；')[0].trim();
          return {
            text: text,
            kind: dist.kind,
            why: `${candidate.word}指${text}，${word.word}指${word.meaningCN.split('；')[0].trim()}`
          };
        }
      }
      return dist;
    });

    fixes.items[id] = { distractors: newDistractors };
  }
}

fs.writeFileSync('content/quiz/13-fix-length.json', JSON.stringify(fixes, null, 2));
console.log(`Written chapter 13 fix with ${Object.keys(fixes.items).length} items`);
