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
  
  // 收集本章所有释义作为候选干扰项（按长度分类）
  const allMeanings = data.map(item => ({
    text: item.meaningCN,
    len: normalizeMeaning(item.meaningCN).length,
    word: item.word
  }));
  
  const fixes = { items: {} };
  let fixCount = 0;
  
  for (const [id, item] of Object.entries(quiz.items)) {
    const correctMeaning = correctMeanings[id];
    if (!correctMeaning) continue;
    
    const correctLen = normalizeMeaning(correctMeaning).length;
    const newDistractors = [];
    let needsFix = false;
    const usedTexts = new Set(item.distractors.map(d => d.text));
    
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
          usedTexts,
          d.kind,
          data.find(w => String(w.id) === id)?.word
        );
        
        if (candidate) {
          newDistractors.push({
            text: candidate.text,
            kind: d.kind,
            why: generateBetterWhy(d.kind, candidate.text, correctMeaning, data.find(w => String(w.id) === id)?.word, candidate.word)
          });
          usedTexts.add(candidate.text);
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

function findSuitableDistractor(allMeanings, correctMeaning, correctLen, usedTexts, kind, targetWord) {
  // 过滤掉已存在的干扰项和正确释义
  const candidates = allMeanings.filter(item => 
    item.text !== correctMeaning && 
    !usedTexts.has(item.text) &&
    item.len > 0 &&
    item.word !== targetWord // 排除目标词本身
  );
  
  // 按长度匹配度排序（目标ratio在0.4-2.5之间）
  const scored = candidates.map(item => {
    const ratio = item.len / correctLen;
    let score = 0;
    
    // 长度匹配度得分
    if (ratio >= 0.4 && ratio <= 2.5) {
      score += 100 - Math.abs(ratio - 1) * 30;
    } else if (ratio >= 0.3 && ratio <= 3.0) {
      score += 50;
    }
    
    // 语义相关性得分（根据kind）
    if (kind === 'root' && hasCommonRoot(item.word, targetWord)) score += 30;
    if (kind === 'form' && isFormSimilar(item.word, targetWord)) score += 30;
    if (kind === 'sense' && isSemanticallyRelated(item.text, correctMeaning)) score += 20;
    
    return { ...item, score, ratio };
  }).filter(x => x.score > 0);
  
  // 按分数排序，取前10个随机选择
  scored.sort((a, b) => b.score - a.score);
  const topCandidates = scored.slice(0, 10);
  
  if (topCandidates.length === 0) return null;
  
  // 随机选择一个
  const selected = topCandidates[Math.floor(Math.random() * topCandidates.length)];
  return selected;
}

function hasCommonRoot(word1, word2) {
  // 简单检查是否有共同前缀或词根
  const prefixes = ['re', 'un', 'in', 'im', 'il', 'ir', 'en', 'em', 'dis', 'mis', 'pre', 'pro', 'trans', 'sub', 'super', 'inter', 'auto', 'bi', 'co', 'com', 'con', 'de', 'ex', 'extra', 'hyper', 'hypo', 'macro', 'micro', 'mono', 'multi', 'non', 'omni', 'out', 'over', 'poly', 'post', 'semi', 'tri', 'ultra', 'under'];
  
  for (const prefix of prefixes) {
    if (word1.toLowerCase().startsWith(prefix) && word2.toLowerCase().startsWith(prefix)) {
      return true;
    }
  }
  
  // 检查共同后缀
  const suffixes = ['tion', 'sion', 'ment', 'ness', 'ity', 'ence', 'ance', 'er', 'or', 'ist', 'ism', 'able', 'ible', 'ful', 'less', 'ous', 'ive', 'al', 'ial', 'ical'];
  
  for (const suffix of suffixes) {
    if (word1.toLowerCase().endsWith(suffix) && word2.toLowerCase().endsWith(suffix)) {
      return true;
    }
  }
  
  return false;
}

function isFormSimilar(word1, word2) {
  // 检查是否形近（长度相近且有共同字符）
  if (Math.abs(word1.length - word2.length) > 2) return false;
  
  let commonChars = 0;
  const shorter = word1.length < word2.length ? word1 : word2;
  const longer = word1.length < word2.length ? word2 : word1;
  
  for (let i = 0; i < shorter.length; i++) {
    if (longer.includes(shorter[i])) {
      commonChars++;
    }
  }
  
  return commonChars / shorter.length > 0.6;
}

function isSemanticallyRelated(text1, text2) {
  // 简单检查是否有共同关键词
  const keywords1 = text1.split(/[，,；;、。.．·・:：!！?？"'""''()（）[\]【】<>《》/\\|-]/).filter(w => w.length > 1);
  const keywords2 = text2.split(/[，,；;、。.．·・:：!！?？"'""''()（）[\]【】<>《》/\\|-]/).filter(w => w.length > 1);
  
  for (const kw1 of keywords1) {
    for (const kw2 of keywords2) {
      if (kw1 === kw2 || kw1.includes(kw2) || kw2.includes(kw1)) {
        return true;
      }
    }
  }
  
  return false;
}

function generateBetterWhy(kind, distractorText, correctMeaning, targetWord, distractorWord) {
  const correctKeywords = correctMeaning.split(/[，,；;、。.．·・:：!！?？"'""''()（）[\]【】<>《》/\\|-]/).filter(w => w.length > 1);
  const distractorKeywords = distractorText.split(/[，,；;、。.．·・:：!！?？"'""''()（）[\]【】<>《》/\\|-]/).filter(w => w.length > 1);
  
  // 找到最相关的关键词对比
  let why = '';
  
  switch (kind) {
    case 'root':
      why = `"${distractorWord}"与"${targetWord}"有共同词根，但含义侧重不同`;
      break;
    case 'form':
      why = `"${distractorWord}"与"${targetWord}"形近易混，但实际含义不同`;
      break;
    case 'sense':
      if (correctKeywords.length > 0 && distractorKeywords.length > 0) {
        why = `"${distractorKeywords[0]}"侧重${getSemanticFocus(distractorText)}，而"${correctKeywords[0]}"侧重${getSemanticFocus(correctMeaning)}`;
      } else {
        why = `"${distractorText}"是相关概念，但具体含义与正确释义不同`;
      }
      break;
    case 'topic':
      why = `"${distractorText}"属于同一语义场，但具体所指不同`;
      break;
    case 'antonym':
      why = `"${distractorText}"是反义概念，方向相反`;
      break;
    case 'pos':
      why = `"${distractorText}"词性或语法功能不同`;
      break;
    default:
      why = `"${distractorText}"与正确释义含义不同`;
  }
  
  return why;
}

function getSemanticFocus(text) {
  // 提取语义焦点
  const focuses = {
    '经济': '宏观经济体系',
    '商业': '商业交易活动',
    '贸易': '商品买卖往来',
    '金融': '资金运作管理',
    '财政': '政府收支管理',
    '投资': '资金投入增值',
    '消费': '商品使用消耗',
    '生产': '产品制造过程',
    '管理': '组织协调控制',
    '技术': '工艺方法技能',
    '科学': '系统知识体系',
    '艺术': '审美创造活动',
    '法律': '规则制度体系',
    '政治': '权力分配运用',
    '社会': '人际关系网络',
    '文化': '精神物质遗产',
    '教育': '知识传授过程',
    '医疗': '疾病治疗保健',
    '军事': '武装力量行动',
    '宗教': '信仰崇拜体系'
  };
  
  for (const [key, focus] of Object.entries(focuses)) {
    if (text.includes(key)) {
      return focus;
    }
  }
  
  return '具体含义';
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
