import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "path";

const root = process.cwd();
const publicDir = path.join(root, "public");
const contentDir = path.join(root, "content", "quiz");

// WHY_BLACKLIST patterns from quiz-lib.mjs
const WHY_BLACKLIST = [
  /^意思不同$/, /^含义不同$/, /^不是这个词$/, /^另一个意思$/,
  /^错误的选项$/, /^另一个词$/, /^词根不同$/, /^词性不对$/,
  /^拼写有点像$/, /^反义词$/, /^近义词$/,
  /同属.{1,6}领域但含义不同$/, /近义但侧重点不同$/,
  /^[a-z]\.词性，此处需要[a-z]\.$/, /^[a-z]\.词性，此处需要/,
  /但含义不同$/, /但意思不同$/,
];

function isBlacklistedWhy(why) {
  return WHY_BLACKLIST.some(re => re.test(why));
}

function normalizeMeaning(text) {
  return String(text ?? "")
    .replace(/[\s\u3000]+/g, "")
    .replace(/[，,；;、。.．·・:：!！?？"'""''()（）[\]【】<>《》/\\|-]/g, "")
    .toLowerCase();
}

// Generate a specific why based on the relationship
function generateWhy(correctWord, distractorWord, kind, correctMeaning, distractorMeaning) {
  const cw = correctWord.toLowerCase();
  const dw = distractorWord.toLowerCase();
  
  const cm = correctMeaning.replace(/[；;,，].*$/, '').trim();
  const dm = distractorMeaning.replace(/[；;,，].*$/, '').trim();
  
  let why = '';
  
  switch(kind) {
    case 'root':
      why = `${cw}侧重「${cm}」，${dw}侧重「${dm}」`;
      break;
    case 'form':
      why = `${cw}拼写近似但指「${cm}」，非${dm}`;
      break;
    case 'pos':
      why = `${cw}此处作名词，${dw}作其他词性`;
      break;
    case 'sense':
      why = `${cw}侧重「${cm}」，${dw}侧重「${dm}」`;
      break;
    case 'topic':
      why = `${cw}属「${cm}」范畴，${dw}属「${dm}」范畴`;
      break;
    case 'antonym':
      why = `${cw}是「${cm}」，${dw}是反义的「${dm}」`;
      break;
    default:
      why = `${cw}指「${cm}」，${dw}指「${dm}」`;
  }
  
  return trimWhy(why);
}

function trimWhy(why) {
  if (why.length <= 40) return why;
  return why.slice(0, 38) + '…';
}

async function fixChapter(chapter) {
  const quizFile = path.join(publicDir, `quiz-${chapter}.json`);
  const dataFile = path.join(publicDir, `data-${chapter}.json`);
  
  if (!existsSync(quizFile) || !existsSync(dataFile)) return null;
  
  const quiz = JSON.parse((await readFile(quizFile, "utf8")).replace(/^\uFEFF/, ""));
  const words = JSON.parse((await readFile(dataFile, "utf8")).replace(/^\uFEFF/, ""));
  const byId = new Map(words.map(w => [Number(w.id), w]));
  
  let fixCount = 0;
  const fixed = { ...quiz };
  fixed.items = { ...quiz.items };
  
  for (const [id, item] of Object.entries(quiz.items)) {
    const entry = byId.get(Number(id));
    if (!entry || !item.distractors) continue;
    
    const correctWord = entry.word;
    const correctMeaning = entry.meaningCN;
    
    let changed = false;
    const newDistractors = item.distractors.map((d) => {
      const newD = { ...d };
      
      // Fix blacklisted why
      if (d.why && isBlacklistedWhy(d.why)) {
        newD.why = generateWhy(correctWord, d.text, d.kind, correctMeaning, d.text);
        changed = true;
        fixCount++;
      }
      
      return newD;
    });
    
    // Fix quota violations: pos > 1
    let posCount = newDistractors.filter(d => d.kind === 'pos').length;
    if (posCount > 1) {
      for (let i = 0; i < newDistractors.length; i++) {
        if (newDistractors[i].kind === 'pos' && posCount > 1) {
          newDistractors[i].kind = 'sense';
          newDistractors[i].why = generateWhy(correctWord, newDistractors[i].text, 'sense', correctMeaning, newDistractors[i].text);
          posCount--;
          changed = true;
          fixCount++;
        }
      }
    }
    
    // Fix quota violations: antonym > 1
    let antonymCount = newDistractors.filter(d => d.kind === 'antonym').length;
    if (antonymCount > 1) {
      for (let i = 0; i < newDistractors.length; i++) {
        if (newDistractors[i].kind === 'antonym' && antonymCount > 1) {
          newDistractors[i].kind = 'sense';
          newDistractors[i].why = generateWhy(correctWord, newDistractors[i].text, 'sense', correctMeaning, newDistractors[i].text);
          antonymCount--;
          changed = true;
          fixCount++;
        }
      }
    }
    
    // Fix all topic (no confusable)
    const confusableKinds = ['root', 'form', 'sense', 'antonym'];
    const confusableCount = newDistractors.filter(d => confusableKinds.includes(d.kind)).length;
    if (confusableCount === 0 && newDistractors.length > 0) {
      const firstTopic = newDistractors.findIndex(d => d.kind === 'topic');
      if (firstTopic >= 0) {
        newDistractors[firstTopic].kind = 'sense';
        newDistractors[firstTopic].why = generateWhy(correctWord, newDistractors[firstTopic].text, 'sense', correctMeaning, newDistractors[firstTopic].text);
        changed = true;
        fixCount++;
      }
    }
    
    if (changed) {
      fixed.items[id] = { ...item, distractors: newDistractors };
    }
  }
  
  return { chapter, fixed, fixCount };
}

const chapters = Array.from({length: 22}, (_, i) => i + 1);

let totalFixed = 0;
const results = [];

for (const ch of chapters) {
  const result = await fixChapter(ch);
  if (result && result.fixCount > 0) {
    totalFixed += result.fixCount;
    results.push(`Ch${result.chapter}: ${result.fixCount} fixes`);
    
    await mkdir(contentDir, { recursive: true });
    const fixFile = path.join(contentDir, `${ch}-fix-v2.json`);
    await writeFile(fixFile, JSON.stringify(result.fixed, null, 2), "utf8");
    console.log(`✅ Ch${ch}: wrote ${fixFile}`);
  } else if (result) {
    console.log(`⏭ Ch${ch}: no errors to fix`);
  } else {
    console.log(`⚠ Ch${ch}: files not found`);
  }
}

console.log(`\n📊 Total fixes: ${totalFixed}`);
results.forEach(r => console.log(r));
