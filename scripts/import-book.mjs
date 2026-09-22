/**
 * import-book.mjs —— 词汇书导入（第五期）
 *
 * 把一本词汇书（xlsx / csv / tsv，只要求"外语词"列，中文释义列可选）转成系统词库
 * `public/data-N.json` 分章文件，并更新 `public/chapters.js` 章节清单。
 * 之后按 docs/词汇书导入与题源生成指南.md 继续生成认词题源（正向 + 反向）。
 *
 * 用法：
 *   node scripts/import-book.mjs <词汇书文件> --title "书名" [--emoji 📕]
 *        [--chapters 10] [--by-sheet] [--start 23] [--out-dir public] [--dry-run]
 *
 * 列识别：优先按表头名（单词/word、解释/释义/meaning、音标/phonetic），
 * 没有表头时按内容猜（含拉丁字母最多的列 = 单词，含中文最多的列 = 释义）。
 * sheet 选择：--sheet <名称|序号> 指定工作表；默认自动挑"结构最完整"的一张（多 sheet 常是同一本书的多轮学习副本）。
 * 分章：--by-sheet（每个 sheet 一章）或 --chapters N（按行均匀切）；都不给则整本一章。
 */
import { readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as XLSX from "xlsx";
import { buildManifest } from "./convert-data.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const argv = process.argv.slice(2);
/** 带值 flag 的值不能当位置参数（原先 flag 的值也会进 positional，只是恰好没用到 [1+] 才没炸） */
const KNOWN_VALUE_FLAGS = new Set(["title", "emoji", "start", "out-dir", "sheet", "chapters"]);
const positional = argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && KNOWN_VALUE_FLAGS.has(argv[i - 1]?.slice(2))));
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, fallback = "") => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};

const input = positional.find((a) => !KNOWN_VALUE_FLAGS.has(a) && existsSync(a)) ||
  positional.find((a) => existsSync(a));
if (!input || !existsSync(input)) {
  console.error(
    '用法：node scripts/import-book.mjs <词汇书文件.xlsx|csv|tsv> --title "书名" [--chapters 10] [--by-sheet] [--start 23] [--out-dir public] [--dry-run]'
  );
  process.exit(2);
}
const title = opt("title", "导入词书");
const emoji = opt("emoji", "📕");
const startChapter = Number(opt("start", "0")) || 0;
const outDir = path.resolve(root, opt("out-dir", "public"));
const dryRun = flag("dry-run");
const sheetWanted = opt("sheet", "");
const bySheet = flag("by-sheet");
const chaptersWanted = Number(opt("chapters", "0")) || 0;

/* ---------- 读取 ---------- */
const CJK = /[\u4e00-\u9fff]/;
const LATIN = /[A-Za-z]/;

function rowsFromFile(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".xlsx" || ext === ".xls") {
    const wb = XLSX.read(readFileSync(file));
    return {
      sheets: wb.SheetNames.map((name) => ({
        name,
        rows: XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, blankrows: false, raw: false }),
      })),
    };
  }
  const text = readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  const first = text.split(/\r?\n/)[0] || "";
  const delim = first.includes("\t") ? "\t" : first.includes(";") && !first.includes(",") ? ";" : ",";
  const rows = text
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((line) => line.split(delim).map((c) => String(c ?? "").replace(/\s+/g, " ").trim()));
  return { sheets: [{ name: path.basename(file), rows }] };
}

/** 清理词头里的序号前缀（"1. a" → "a"） */
const stripIndex = (w) => String(w || "").replace(/^\s*\d+\s*[.、:：）)]?\s*/, "").trim();
const IPA = /[əɪʊæɒɜɑːeɪoʊaʊθʃŋ]/;

/** 判定一行的列语义：返回 { word, meaning, phonetic } 或 null（表头/说明行/无外语词） */
/** 表头词集合：一行内所有非空格都属于它 → 表头行 */
const HEADER_WORDS = new Set(["序号", "编号", "单词", "word", "解释", "释义", "meaning", "meaningcn", "音标", "phonetic", "random", "chapter", "章节", "序", "notes", "标签", "tag"]);

/** 判定一行的列语义：返回 { word, meaning, phonetic } 或 null（表头/说明行/无外语词） */
function parseRow(cells) {
  const arr = (cells || []).map((c) => String(c ?? "").trim()).filter(Boolean);
  if (!arr.length) return null;
  // 表头行：所有非空格都是表头词
  const lower = arr.map((v) => v.toLowerCase());
  if (lower.every((v) => HEADER_WORDS.has(v))) return null;
  const joined = arr.join("");
  if (!LATIN.test(joined)) return null;
  let bestWord = "";
  let wordScore = -1;
  let bestMean = "";
  let meanScore = -1;
  let phonetic = "";
  for (const raw of arr) {
    const v = stripIndex(raw);
    if (!v) continue;
    const latin = (v.match(/[A-Za-z]/g) || []).length;
    const cjk = (v.match(CJK) || []).length;
    // 音标：含 IPA 音素，或以 [ ] 包裹；且不含中文、不是纯英文单词
    const looksIpa = /[ɐ-ʯ̀-ͯ]/.test(v) || /^[[^]]*]$/.test(v);
    if (!phonetic && cjk === 0 && looksIpa && latin <= 30) {
      phonetic = v.replace(/[[]]/g, "");
      continue;
    }
    if (latin > wordScore && cjk === 0 && !looksIpa) {
      wordScore = latin;
      bestWord = v.replace(/[[(].*$/, "").trim();
    }
    if (cjk > meanScore) {
      meanScore = cjk;
      bestMean = v;
    }
  }
  if (!bestWord || wordScore < 2) return null;
  return { word: bestWord, meaning: bestMean, phonetic };
}
/* ---------- 解析所有 sheet ---------- */
const { sheets } = rowsFromFile(path.resolve(input));
/** @type {Array<{name: string, words: {word: string, meaningCN: string, phonetic: string}[]}>} */
const parsedSheets = [];
for (const { name, rows } of sheets) {
  const words = [];
  for (const row of rows) {
    if (!row.filter((c) => String(c ?? "").trim()).length) continue;
    const parsed = parseRow(row);
    if (!parsed) continue;
    const prev = words[words.length - 1];
    if (prev && prev.word.toLowerCase() === parsed.word.toLowerCase()) continue;
    words.push({ word: parsed.word, meaningCN: parsed.meaning, phonetic: parsed.phonetic });
  }
  if (words.length >= 10) parsedSheets.push({ name, words });
}
if (!parsedSheets.length) {
  console.error("没有解析出足够的词条（每表至少 10 行）——检查列格式");
  process.exit(2);
}

// sheet 选择：默认取结构最完整的一张（平均非空列数最高；同分取词多者），--sheet 可指定
let chosen = parsedSheets;
if (!bySheet) {
  let target = null;
  if (sheetWanted) {
    target =
      parsedSheets.find((s2) => s2.name === sheetWanted) ||
      parsedSheets[Number(sheetWanted) - 1] ||
      null;
    if (!target) {
      console.error(`找不到 sheet：${sheetWanted}（可选：${parsedSheets.map((s2) => s2.name).join(" / ")}）`);
      process.exit(2);
    }
  } else {
    let bestScore = -1;
    for (const cand of parsedSheets) {
      const cols = cand.words.slice(0, 50).reduce((a, w) => Math.max(a, (w.meaningCN ? 1 : 0) + (w.phonetic ? 1 : 0) + 1), 0);
      const score = cols * 1000 + cand.words.length;
      if (score > bestScore) { bestScore = score; target = cand; }
    }
  }
  chosen = [target];
  console.log(`使用工作表：${target.name}（${target.words.length} 词）`);
}

// 全书按词去重（大小写不敏感，先到先得）
{
  const seen = new Set();
  for (const sheet of chosen) {
    sheet.words = sheet.words.filter((w) => {
      const k = w.word.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }
}

/* ---------- 分章 ---------- */
/** @type {Array<{chapter: number, title: string, words: typeof parsedSheets[0]["words"]}>} */
const outChapters = [];
let cursor = startChapter || 1;
if (bySheet) {
  const used = new Set();
  for (const sheet of chosen) {
    let t = sheet.name;
    let i = 2;
    while (used.has(t)) t = `${sheet.name} ${i++}`;
    used.add(t);
    outChapters.push({ chapter: cursor++, title: t, words: sheet.words });
  }
} else {
  const all = chosen.flatMap((s) => s.words);
  const count = chaptersWanted || 1;
  const per = Math.ceil(all.length / count);
  for (let i = 0; i < count; i++) {
    const slice = all.slice(i * per, (i + 1) * per);
    if (!slice.length) break;
    outChapters.push({ chapter: cursor++, title: count > 1 ? `${title} ${i + 1}` : title, words: slice });
  }
}

/* ---------- 章号衔接（未指定 --start 时排在现有章节之后） ---------- */
const publicDir = path.join(root, "public");
if (!startChapter) {
  const files = (await readdir(outDir === publicDir ? publicDir : outDir))
    .map((f) => Number(f.match(/^data-(\d+)\.json$/)?.[1] || 0))
    .filter(Boolean);
  const next = files.length ? Math.max(...files) + 1 : 1;
  for (let i = 0; i < outChapters.length; i++) outChapters[i].chapter = next + i;
}

/* ---------- 写入（两阶段：先全量校验冲突，再统一写入） ---------- */
if (!dryRun) await mkdir(outDir, { recursive: true });

console.log(`《${title}》→ ${outChapters.length} 章 / ${outChapters.reduce((a, c) => a + c.words.length, 0)} 词`);
let noMeaning = 0;
for (const ch of outChapters) {
  noMeaning += ch.words.filter((w) => !CJK.test(w.meaningCN)).length;
}
// 阶段一：任何一章会覆盖现有文件就整体拒绝（原来边查边写：冲突时前面章节已落盘，
// 留下"半套词库 + chapters.js 未更新"的不一致状态）
if (!dryRun && outDir === publicDir) {
  const conflicts = outChapters.filter((ch) => existsSync(path.join(outDir, `data-${ch.chapter}.json`)));
  if (conflicts.length) {
    for (const ch of conflicts) {
      console.error(`✖ 第 ${ch.chapter} 章的 data-${ch.chapter}.json 已存在——导入会覆盖现有章节；请换 --start 或先备份`);
    }
    process.exit(3);
  }
}
// 阶段二：全部通过后统一写入
for (const ch of outChapters) {
  const list = ch.words.map((w, i) => ({
    id: i + 1,
    word: w.word,
    phonetic: w.phonetic || "",
    pos: "",
    meaningCN: w.meaningCN,
    root: "",
    exampleEN: "",
    exampleCN: "",
  }));
  const file = path.join(outDir, `data-${ch.chapter}.json`);
  console.log(
    `  第 ${ch.chapter} 章「${ch.title}」：${list.length} 词${dryRun ? "（dry-run 不写入）" : ""}${
      list.some((w) => !w.meaningCN) ? " ⚠ 含无释义词" : ""
    }`
  );
  if (!dryRun) await writeFile(file, `${JSON.stringify(list, null, 2)}\n`);
}
if (noMeaning) {
  console.log(`\n⚠ ${noMeaning} 个词没有中文释义（词汇书只有外语词）。补释义流程见 docs/词汇书导入与题源生成指南.md。`);
}

if (!dryRun && outDir === path.resolve(root, "public")) {
  // chapters.js：全量重生成（复用 convert-data 的模板；不再用正则改源码——旧正则
  // 匹配 `return [...]` 而生成物是 `export const CHAPTERS = [...]`，追加静默失效）
  const chaptersFile = path.join(publicDir, "chapters.js");
  const { CHAPTERS } = await import(`${pathToFileURL(chaptersFile).href}?t=${Date.now()}`);
  const merged = new Map(CHAPTERS.map((c) => [Number(c.id), c]));
  for (const ch of outChapters) {
    const count = JSON.parse(await readFile(path.join(publicDir, `data-${ch.chapter}.json`), "utf8")).length;
    merged.set(ch.chapter, { id: ch.chapter, title: ch.title, emoji, count });
  }
  const list = [...merged.values()].sort((a, b) => a.id - b.id);
  const totalWords = list.reduce((a, c) => a + (Number(c.count) || 0), 0);
  await writeFile(chaptersFile, buildManifest(list, totalWords), "utf8");
  const firstChapter = Math.min(...outChapters.map((ch) => ch.chapter));
  console.log(
    `\nchapters.js 已全量重生成：${list.length} 章 / ${totalWords} 词（本次追加 ${outChapters.length} 章：第 ${firstChapter}..${firstChapter + outChapters.length - 1} 章）`
  );
  console.log("下一步：npm run check 核对，然后按 docs/词汇书导入与题源生成指南.md 生成认词题源。");
}
