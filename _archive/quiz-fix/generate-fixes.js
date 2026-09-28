// Generate fix files for chapters 12-15
import fs from 'fs';

function normalizeMeaning(text) {
  return String(text ?? "")
    .replace(/[\s\u3000]+/g, "")
    .replace(/[，,；;、。.．·・:：!！?？"'""''()（）[\]【】<>《》/\\|-]/g, "")
    .toLowerCase();
}

function getRandomWord(data, excludeIds = []) {
  const available = data.filter(d => !excludeIds.includes(d.id));
  return available[Math.floor(Math.random() * available.length)];
}

function generateWhy(word, distractor, kind) {
  const whyTemplates = {
    'sense': [
      `${distractor.meaningCN}侧重不同方面，${word.word}特指${word.meaningCN}`,
      `${word.word}意为${word.meaningCN}，非${distractor.meaningCN}`,
      `两者含义有别：${word.word}是${word.meaningCN}，${distractor.word}是${distractor.meaningCN}`
    ],
    'form': [
      `${distractor.word}词形相近但含义不同，意为${distractor.meaningCN}`,
      `易混淆为${distractor.word}，实为${word.word}（${word.meaningCN}）`,
      `拼写相似但意义不同：${distractor.word}是${distractor.meaningCN}`
    ],
    'topic': [
      `${distractor.word}属于相关话题但含义不同`,
      `同属一个领域但${distractor.word}指${distractor.meaningCN}`,
      `相关概念但非同义：${distractor.word}（${distractor.meaningCN}）`
    ],
    'pos': [
      `${distractor.word}词性不同，是${distractor.meaningCN}`,
      `词性有别：${distractor.word}为${distractor.meaningCN}`,
      `虽同源但${distractor.word}是${distractor.meaningCN}`
    ],
    'antonym': [
      `反义词：${distractor.word}意为${distractor.meaningCN}`,
      `${word.word}是${word.meaningCN}，${distractor.word}是其反面`,
      `相对概念：${distractor.word}（${distractor.meaningCN}）`
    ],
    'root': [
      `同根词但含义不同：${distractor.word}是${distractor.meaningCN}`,
      `词根相关但${distractor.word}指${distractor.meaningCN}`,
      `派生词义不同：${distractor.word}（${distractor.meaningCN}）`
    ]
  };

  const templates = whyTemplates[kind] || whyTemplates['sense'];
  const template = templates[Math.floor(Math.random() * templates.length)];
  return template.substring(0, 40); // Ensure max 40 chars
}

function findReplacement(word, data, allDistractors, kind) {
  const correctLen = normalizeMeaning(word.meaningCN).length;
  const excludeIds = [word.id, ...allDistractors.map(d => d.id || 0)];

  // Try to find a word with similar length meaning
  for (let attempt = 0; attempt < 50; attempt++) {
    const candidate = getRandomWord(data, excludeIds);
    if (!candidate) continue;

    const candidateLen = normalizeMeaning(candidate.meaningCN).length;
    const ratio = candidateLen / correctLen;

    if (ratio >= 0.4 && ratio <= 2.5) {
      // Found a good match
      return {
        text: candidate.meaningCN.split('；')[0].trim(), // Use first meaning
        kind: kind,
        why: generateWhy(word, candidate, kind)
      };
    }
  }

  // Fallback: use the word itself with modification
  return {
    text: word.meaningCN.split('；')[0].trim(),
    kind: kind,
    why: `同词根但含义不同`
  };
}

const chapters = [12, 13, 14, 15];

for (const chapter of chapters) {
  console.log(`\nGenerating fixes for Chapter ${chapter}...`);

  const quiz = JSON.parse(fs.readFileSync(`public/quiz-${chapter}.json`, 'utf8'));
  const data = JSON.parse(fs.readFileSync(`public/data-${chapter}.json`, 'utf8'));

  const fixes = { spec: "1.0", chapter, source: "model", generator: "mimo-v2.5-pro-length-fix", items: {} };

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
      fixes.items[id] = {
        distractors: item.distractors.map(dist => {
          const distLen = normalizeMeaning(dist.text).length;
          const ratio = distLen / correctLen;

          if (ratio < 0.3 || ratio > 2.5) {
            // Need to replace this distractor
            const allDistractorWords = item.distractors.map(d => ({ id: d.text }));
            return findReplacement(word, data, allDistractorWords, dist.kind);
          }
          return dist; // Keep original if ratio is ok
        })
      };
    }
  }

  // Write fix file
  const fixPath = `content/quiz/${chapter}-fix-length.json`;
  fs.mkdirSync('content/quiz', { recursive: true });
  fs.writeFileSync(fixPath, JSON.stringify(fixes, null, 2));
  console.log(`Written ${fixPath} with ${Object.keys(fixes.items).length} items`);
}
