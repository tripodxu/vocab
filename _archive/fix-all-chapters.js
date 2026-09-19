// Comprehensive fix script for all chapters
import fs from 'fs';

function normalizeMeaning(text) {
  return String(text ?? "")
    .replace(/[\s\u3000]+/g, "")
    .replace(/[，,；;、。.．·・:：!！?？"'""''()（）[\]【】<>《》/\\|-]/g, "")
    .toLowerCase();
}

function truncate(text, maxLen = 40) {
  if (text.length <= maxLen) return text;
  return text.substring(0, maxLen - 1) + '…';
}

function generateWhy(word, distractor) {
  const w1 = word.word;
  const m1 = word.meaningCN.split('；')[0].trim();
  const w2 = distractor.word;
  const m2 = distractor.meaningCN.split('；')[0].trim();

  // Generate concise why
  const why = `${w2}指${m2}，${w1}指${m1}`;
  return truncate(why);
}

function findReplacement(word, data, excludeIds, correctLen) {
  // Find candidates with similar length
  const candidates = data.filter(d => {
    if (excludeIds.includes(d.id)) return false;
    const dLen = normalizeMeaning(d.meaningCN).length;
    const ratio = dLen / correctLen;
    return ratio >= 0.4 && ratio <= 2.5;
  });

  if (candidates.length === 0) return null;

  // Pick a random candidate
  const candidate = candidates[Math.floor(Math.random() * candidates.length)];
  return {
    text: candidate.meaningCN.split('；')[0].trim(),
    word: candidate.word,
    meaningCN: candidate.meaningCN
  };
}

const chapters = [12, 13, 14, 15];

for (const chapter of chapters) {
  console.log(`\nProcessing Chapter ${chapter}...`);

  const quiz = JSON.parse(fs.readFileSync(`public/quiz-${chapter}.json`, 'utf8'));
  const data = JSON.parse(fs.readFileSync(`public/data-${chapter}.json`, 'utf8'));

  const fixes = { spec: "1.0", chapter, source: "model", generator: "mimo-v2.5-pro-length-fix", items: {} };
  let fixCount = 0;

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
      const newDistractors = [];
      const usedTexts = new Set();
      const usedIds = new Set([word.id]);

      for (const dist of item.distractors) {
        const distLen = normalizeMeaning(dist.text).length;
        const ratio = distLen / correctLen;

        if (ratio < 0.3 || ratio > 2.5) {
          // Find replacement
          let replacement = null;
          for (let attempt = 0; attempt < 100; attempt++) {
            const candidate = findReplacement(word, data, Array.from(usedIds), correctLen);
            if (candidate && !usedTexts.has(candidate.text)) {
              replacement = {
                text: candidate.text,
                kind: dist.kind,
                why: generateWhy(word, candidate)
              };
              usedTexts.add(candidate.text);
              usedIds.add(candidate.word);
              break;
            }
          }

          if (!replacement) {
            // Fallback: keep original
            replacement = dist;
          }
          newDistractors.push(replacement);
        } else {
          usedTexts.add(dist.text);
          newDistractors.push(dist);
        }
      }

      fixes.items[id] = { distractors: newDistractors };
      fixCount++;
    }
  }

  // Write fix file
  const fixPath = `content/quiz/${chapter}-fix-length.json`;
  fs.mkdirSync('content/quiz', { recursive: true });
  fs.writeFileSync(fixPath, JSON.stringify(fixes, null, 2));
  console.log(`Written ${fixPath} with ${fixCount} items`);
}

console.log('\nDone! Now run merge commands.');
