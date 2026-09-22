/**
 * 词库转换脚本：public/data-N.js → public/data-N.json + public/chapters.js
 *
 * 用法：node scripts/convert-data.mjs [--keep-js]
 *   --keep-js  保留原始 data-N.js（默认转换成功后删除，避免两份数据源漂移）
 *
 * data-N.js 的原格式为 `vocabulary = [ {...}, ... ];`（隐式全局赋值），
 * 这里用 new Function 求值（本地可信数据），避免手写解析器出错。
 */
import { readFile, writeFile, unlink, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(here, "..", "public");
const keepJs = process.argv.includes("--keep-js");

/** 章节标题与图标（单一数据源，两个页面共用） */
const CHAPTER_META = [
  { title: "自然地理", emoji: "🌍" },
  { title: "植物研究", emoji: "🌱" },
  { title: "动物保护", emoji: "🐾" },
  { title: "太空探索", emoji: "🚀" },
  { title: "学校教育", emoji: "🎓" },
  { title: "科技文明", emoji: "🔬" },
  { title: "文化历史", emoji: "📜" },
  { title: "语言演化", emoji: "🗣️" },
  { title: "文化娱乐", emoji: "🎭" },
  { title: "物品材料", emoji: "🧱" },
  { title: "时尚潮流", emoji: "👗" },
  { title: "饮食健康", emoji: "🥗" },
  { title: "建筑场所", emoji: "🏗️" },
  { title: "交通旅行", emoji: "✈️" },
  { title: "国家政府", emoji: "🏛️" },
  { title: "社会经济", emoji: "💹" },
  { title: "法律法规", emoji: "⚖️" },
  { title: "沙场争锋", emoji: "⚔️" },
  { title: "社会角色", emoji: "👥" },
  { title: "行为动作", emoji: "🏃" },
  { title: "身心健康", emoji: "💚" },
  { title: "时间日期", emoji: "🕰️" },
];

function parseDataFile(source) {
  const body = source
    .replace(/^\uFEFF/, "")
    .trim()
    .replace(/^\s*(?:var|let|const)?\s*vocabulary\s*=/, "")
    .replace(/;\s*$/, "");
  const value = new Function(`return (${body});`)();
  if (!Array.isArray(value)) throw new Error("解析结果不是数组");
  return value;
}

function normalizeWord(raw, index) {
  const word = String(raw.word ?? "").trim();
  if (!word) throw new Error(`第 ${index + 1} 条缺少 word`);
  return {
    id: Number(raw.id) || index + 1,
    word,
    phonetic: String(raw.phonetic ?? ""),
    pos: String(raw.pos ?? ""),
    meaningCN: String(raw.meaningCN ?? ""),
    tag: String(raw.tag ?? ""),
    root: String(raw.root ?? ""),
    exampleEN: String(raw.exampleEN ?? ""),
    exampleCN: String(raw.exampleCN ?? ""),
    extra: String(raw.extra ?? ""),
  };
}

/**
 * 生成 public/chapters.js 的完整内容。
 * 导出给 import-book.mjs 复用：清单**永远全量重生成**，
 * 不允许各处用正则去改源码（旧实现匹配 `return [...]` 而生成物是 `export const CHAPTERS = [...]`，
 * 追加静默失效；且字段名 `chapter:` 与消费端 `c.id` 不一致）。
 * @param {Array<{id:number,title:string,emoji:string,count:number}>} chapters
 * @param {number} totalWords
 */
export function buildManifest(chapters, totalWords) {
  return `/**
 * 章节清单 —— 由 scripts/convert-data.mjs 生成，请勿手改。
 * 新增章节：把 data-N.js 放进 public/ 并在 scripts/convert-data.mjs 的 CHAPTER_META 里补一条，然后 npm run build:data
 * （词汇书导入走 scripts/import-book.mjs，它会调用本模板全量重生成）
 */
export const CHAPTERS = ${JSON.stringify(chapters, null, 2)};

export const TOTAL_WORDS = ${totalWords};

export const CHAPTER_BY_ID = new Map(CHAPTERS.map((c) => [c.id, c]));

export function chapterTitle(id) {
  const c = CHAPTER_BY_ID.get(Number(id));
  return c ? \`第\${c.id}章 · \${c.title}\` : \`第\${id}章\`;
}
`;
}

async function main() {
  const files = (await readdir(PUBLIC_DIR))
    .filter((f) => /^data-\d+\.js$/.test(f))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));

  if (!files.length) {
    console.error("未找到 public/data-N.js，无需转换");
    process.exit(1);
  }

  const chapters = [];
  let totalWords = 0;

  for (const file of files) {
    const id = Number(file.match(/\d+/)[0]);
    const raw = await readFile(path.join(PUBLIC_DIR, file), "utf8");
    const words = parseDataFile(raw).map(normalizeWord);
    const ids = new Set(words.map((w) => w.id));
    if (ids.size !== words.length) throw new Error(`${file}: id 重复`);

    const outName = `data-${id}.json`;
    await writeFile(path.join(PUBLIC_DIR, outName), JSON.stringify(words), "utf8");
    totalWords += words.length;

    const meta = CHAPTER_META[id - 1] ?? { title: `第${id}章`, emoji: "📘" };
    chapters.push({ id, title: meta.title, emoji: meta.emoji, count: words.length });
    console.log(`${file} → ${outName}  ${String(words.length).padStart(4)} 词  ${meta.emoji} ${meta.title}`);
  }

  const manifest = buildManifest(chapters, totalWords);
  await writeFile(path.join(PUBLIC_DIR, "chapters.js"), manifest, "utf8");
  console.log(`\n生成 public/chapters.js：${chapters.length} 章，共 ${totalWords} 词`);

  if (!keepJs) {
    for (const file of files) await unlink(path.join(PUBLIC_DIR, file));
    console.log(`已删除 ${files.length} 个 data-N.js（词库唯一数据源现在是 data-N.json）`);
  }

  // 章节数按实际 data 文件发现（不再硬编码 22）
  const dataFiles = (await readdir(PUBLIC_DIR)).filter((f) => /^data-\d+\.json$/.test(f));
  const missing = dataFiles
    .map((f) => Number(f.match(/\d+/)[0]))
    .filter((id) => !chapters.some((c) => c.id === id));
  if (missing.length) console.warn(`警告：缺少章节 ${missing.join(", ")}`);
  if (!existsSync(path.join(PUBLIC_DIR, "data-1.json"))) process.exit(1);
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((err) => {
    console.error("转换失败：", err.message);
    process.exit(1);
  });
}
