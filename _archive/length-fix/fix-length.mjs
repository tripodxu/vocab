/**
 * fix-length.mjs — 修复干扰项长度异常（ratio < 0.3 或 > 2.5）
 *
 * 用法：node scripts/fix-length.mjs
 *
 * 流程：
 * 1. 读取 public/quiz-N.json 和 public/data-N.json（N=4,5,6,7）
 * 2. 对每个词条，检查干扰项与正确释义的 normalizeMeaning 长度比
 * 3. 如果 ratio < 0.3 或 > 2.5，重写该干扰项（保持 kind 不变，用同章其它词释义替换）
 * 4. 生成 content/quiz/N-fix-length.json
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  normalizeMeaning,
  meaningsConflict,
  QUIZ_KINDS,
  WHY_MAX,
} from "./quiz-lib.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

const CHAPTERS = [4, 5, 6, 7];
const LOWER = 0.4;
const UPPER = 2.5;
const TOO_LOW = 0.3; // detection threshold (stricter than 0.4 to only fix truly bad ones)

const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));

function ratio(a, b) {
  const da = normalizeMeaning(a).length;
  const db = normalizeMeaning(b).length;
  return db === 0 ? 9999 : da / db;
}

function pickReplacement(correctMeaning, avoidTexts, bank, itemKind) {
  const correctLen = normalizeMeaning(correctMeaning).length;
  const avoidKeys = new Set([
    ...avoidTexts.map((t) => normalizeMeaning(t).toLowerCase()),
    normalizeMeaning(correctMeaning).toLowerCase(),
  ]);

  // Filter candidates: same kind first, then any kind
  const filterPool = (kindFilter) =>
    bank.filter((entry) => {
      const nk = normalizeMeaning(entry.meaningCN).toLowerCase();
      if (avoidKeys.has(nk)) return false;
      const r = normalizeMeaning(entry.meaningCN).length / Math.max(1, correctLen);
      if (r < LOWER || r > UPPER) return false;
      if (kindFilter && entry.kind && entry.kind !== kindFilter) return false;
      return true;
    });

  // Try same kind first
  let pool = filterPool(itemKind);
  // Then try any kind
  if (pool.length === 0) pool = filterPool(null);

  // If still none, relax ratio to > 0.25
  if (pool.length === 0) {
    pool = bank.filter((entry) => {
      const nk = normalizeMeaning(entry.meaningCN).toLowerCase();
      if (avoidKeys.has(nk)) return false;
      const r = normalizeMeaning(entry.meaningCN).length / Math.max(1, correctLen);
      return r > 0.25;
    });
  }

  // Sort by closeness to ratio 1.0
  pool.sort((a, b) => {
    const ra = Math.abs(normalizeMeaning(a.meaningCN).length / Math.max(1, correctLen) - 1);
    const rb = Math.abs(normalizeMeaning(b.meaningCN).length / Math.max(1, correctLen) - 1);
    return ra - rb;
  });

  return pool[0] || null;
}

function makeWhy(correctText, distractorText) {
  // Three-part style, ≤40 chars
  const s = `${correctText}≠${distractorText}`;
  const tag = "长度修复";
  const tail = "避免最长项可猜";
  const base = `${s}|${tag}|${tail}`;
  if (base.length <= 40) return base;
  // Truncate middle part
  return `${s}|修复|${tail}`.slice(0, 40);
}

async function main() {
  const outDir = path.join(root, "content", "quiz");
  await mkdir(outDir, { recursive: true });

  for (const ch of CHAPTERS) {
    console.log(`\n=== 第 ${ch} 章 ===`);

    const quizPath = path.join(root, "public", `quiz-${ch}.json`);
    const dataPath = path.join(root, "public", `data-${ch}.json`);

    if (!existsSync(quizPath)) { console.log(`  缺少 quiz-${ch}.json`); continue; }
    if (!existsSync(dataPath)) { console.log(`  缺少 data-${ch}.json`); continue; }

    const quiz = await readJson(quizPath);
    const data = await readJson(dataPath);

    // Build bank of all words in this chapter with their meanings
    const bank = data.map((w) => ({
      id: w.id,
      word: w.word,
      meaningCN: w.meaningCN,
      kind: null, // will be assigned per-use
    }));

    // Build a text->entry map for quick lookup
    const meaningToEntry = new Map();
    for (const entry of bank) {
      const nk = normalizeMeaning(entry.meaningCN).toLowerCase();
      if (!meaningToEntry.has(nk)) meaningToEntry.set(nk, entry);
    }

    const fixDoc = {
      spec: "1.0",
      chapter: ch,
      source: "model",
      generator: "mimo-v2.5-pro-length-fix",
      items: {},
    };

    let totalItems = 0;
    let totalFixed = 0;

    for (const [id, item] of Object.entries(quiz.items || {})) {
      if (!item.distractors || !Array.isArray(item.distractors)) continue;

      // Find correct meaning from data
      const wordEntry = bank.find((w) => String(w.id) === String(id));
      if (!wordEntry) { console.log(`  #${id} 在 data 中找不到`); continue; }

      const correctMeaning = wordEntry.meaningCN;
      const usedTexts = [];
      const newDistractors = [];
      let itemDirty = false;

      for (const di of item.distractors) {
        const text = String(di.text || "");
        const r = ratio(text, correctMeaning);

        if (r >= LOWER && r <= UPPER) {
          // Good ratio, keep
          newDistractors.push(di);
          usedTexts.push(text);
        } else {
          // Bad ratio, need replacement
          itemDirty = true;
          totalFixed++;
          const pick = pickReplacement(correctMeaning, usedTexts, bank, di.kind);
          if (pick) {
            const newText = pick.meaningCN;
            const newWhy = makeWhy(correctMeaning, newText);
            newDistractors.push({ kind: di.kind, text: newText, why: newWhy });
            usedTexts.push(newText);
            console.log(`  #${id} ${di.kind}: "${text}" (ratio=${r.toFixed(2)}) → "${newText}"`);
          } else {
            // No replacement found, keep original
            newDistractors.push(di);
            usedTexts.push(text);
            console.log(`  #${id} ${di.kind}: "${text}" (ratio=${r.toFixed(2)}) → 无合适替换，保留`);
          }
        }
      }

      if (itemDirty) {
        fixDoc.items[id] = { distractors: newDistractors };
        totalItems++;
      }
    }

    console.log(`  需修复词条: ${totalItems}, 干扰项修复数: ${totalFixed}`);

    const outPath = path.join(outDir, `${ch}-fix-length.json`);
    await writeFile(outPath, JSON.stringify(fixDoc, null, 2), "utf8");
    console.log(`  已写入: ${outPath}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
