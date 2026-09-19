// Generate fix files for chapters 12-15 (improved version)
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

function truncateWhy(text, maxLen = 40) {
  if (text.length <= maxLen) return text;
  return text.substring(0, maxLen - 1) + '…';
}

function generateBetterWhy(word, distractor, kind) {
  const w1 = word.word;
  const m1 = word.meaningCN.split('；')[0].trim();
  const w2 = distractor.word;
  const m2 = distractor.meaningCN.split('；')[0].trim();

  const templates = {
    'sense': [
      `${w1}是${m1}，${w2}是${m2}`,
      `${w2}指${m2}，${w1}指${m1}`,
      `非${m2}，${w1}特指${m1}`
    ],
    'form': [
      `${w2}词形相近，但意为${m2}`,
      `易混淆为${w2}（${m2}）`,
      `形似${w2}，实为${w1}`
    ],
    'topic': [
      `${w2}属相关话题，指${m2}`,
      `同领域但${w2}是${m2}`,
      `${w2}指${m2}，与${w1}不同`
    ],
    'pos': [
      `${w2}是${m2}，词性有别`,
      `词性不同：${w2}为${m2}`,
      `${w2}意为${m2}，词性不同`
    ],
    'antonym': [
      `反义：${w2}意为${m2}`,
      `${w1}是${m1}，${w2}是反义`,
      `${w2}指${m2}，意义相反`
    ],
    'root': [
      `同根但${w2}意为${m2}`,
      `词根相关：${w2}是${m2}`,
      `派生义不同：${w2}`
    ]
  };

  const templates_list = templates[kind] || templates['sense'];
  const template = templates_list[Math.floor(Math.random() * templates_list.length)];
  return truncateWhy(template);
}

function findReplacement(word, data, allDistractors, kind) {
  const correctLen = normalizeMeaning(word.meaningCN).length;
  const excludeIds = [word.id, ...allDistractors.map(d => d.id || 0)];

  // Try to find a word with similar length meaning
  for (let attempt = 0; attempt < 100; attempt++) {
    const candidate = getRandomWord(data, excludeIds);
    if (!candidate) continue;

    const candidateLen = normalizeMeaning(candidate.meaningCN).length;
    const ratio = candidateLen / correctLen;

    if (ratio >= 0.4 && ratio <= 2.5) {
      // Found a good match
      const text = candidate.meaningCN.split('；')[0].trim();
      return {
        text: text,
        kind: kind,
        why: generateBetterWhy(word, candidate, kind)
      };
    }
  }

  // Fallback: use the word itself with modification
  const text = word.meaningCN.split('；')[0].trim();
  return {
    text: text,
    kind: kind,
    why: truncateWhy(`同词根但含义不同`)
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
      const newDistractors = [];
      const usedTexts = new Set();

      for (const dist of item.distractors) {
        const distLen = normalizeMeaning(dist.text).length;
        const ratio = distLen / correctLen;

        if (ratio < 0.3 || ratio > 2.5) {
          // Need to replace this distractor
          let replacement;
          for (let i = 0; i < 50; i++) {
            replacement = findReplacement(word, data, newDistractors, dist.kind);
            if (!usedTexts.has(replacement.text)) {
              usedTexts.add(replacement.text);
              break;
            }
          }
          newDistractors.push(replacement);
        } else {
          usedTexts.add(dist.text);
          newDistractors.push(dist);
        }
      }

      fixes.items[id] = { distractors: newDistractors };
    }
  }

  // Write fix file
  const fixPath = `content/quiz/${chapter}-fix-length.json`;
  fs.mkdirSync('content/quiz', { recursive: true });
  fs.writeFileSync(fixPath, JSON.stringify(fixes, null, 2));
  console.log(`Written ${fixPath} with ${Object.keys(fixes.items).length} items`);
}

console.log('\nDone! Now run merge commands.');
