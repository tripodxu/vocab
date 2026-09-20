/**
 * check.mjs —— 静态一致性检查
 *
 * 环境限制说明：本机沙箱不允许派生带管道的子进程（wrangler dev / workerd / 浏览器都起不来），
 * 所以这里用一组"能在 Node 里做"的检查替代一部分端到端验证：
 *   1) 每个前端模块都能被真实 import（语法、导入路径、顶层副作用）
 *   2) chapters.js 与实际 data-N.json 完全对得上（章节数、词数、id 唯一）
 *   3) HTML 引用的本地资源都存在；没有内联 <script>（否则 CSP 会拦掉）
 *   4) JS 里 $("...") 引用的元素 id 在对应 HTML 中确实存在
 *   5) CSS 里用到的自定义属性都有定义；同一文件内没有重复 id
 *
 * 用法：npm run check
 */
import { readFile, readdir, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const publicDir = path.join(root, "public");

let failures = 0;
let checks = 0;

const ok = (msg) => console.log(`  ✔ ${msg}`);
const bad = (msg) => {
  failures++;
  console.log(`  ✖ ${msg}`);
};

function section(title) {
  console.log(`\n${title}`);
}

const exists = async (file) => {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
};

/** 动态创建的 id（不在 HTML 里） */
const DYNAMIC_IDS = new Set([
  "aria-live",
  "sheet-title",
  "confirm-title",
  "prompt-title",
  "prompt-input",
  "detailCanvas",
  "detailImage",
  "detailNote",
  "sentinel",
]);

/* ============ 1. 模块可导入 ============ */

section("1) 前端模块 import 检查");
const modules = ["core.js", "quiz.js", "chapters.js", "ui.js", "vocab-auth.js", "app.js", "lecture.js"];
for (const name of modules) {
  checks++;
  const file = path.join(publicDir, name);
  if (!(await exists(file))) {
    bad(`${name} 不存在`);
    continue;
  }
  try {
    // 加时间戳绕过 import 缓存，保证每次都是真的重新解析
    await import(`${pathToFileURL(file).href}?t=${Date.now()}`);
    ok(`public/${name} 可被导入`);
  } catch (err) {
    bad(`public/${name} 导入失败：${err instanceof Error ? err.message : err}`);
  }
}

/* ============ 2. 词库与章节清单一致 ============ */

section("2) 词库一致性");
let chapters = [];
try {
  chapters = (await import(`${pathToFileURL(path.join(publicDir, "chapters.js")).href}?t=${Date.now()}`)).CHAPTERS;
  ok(`chapters.js 解析成功：${chapters.length} 章`);
} catch (err) {
  bad(`chapters.js 无法解析：${err.message}`);
}

let totalWords = 0;
for (const chapter of chapters) {
  checks++;
  const file = path.join(publicDir, `data-${chapter.id}.json`);
  if (!(await exists(file))) {
    bad(`缺少 data-${chapter.id}.json`);
    continue;
  }
  try {
    const words = JSON.parse(await readFile(file, "utf8"));
    const ids = new Set(words.map((w) => Number(w.id)));
    const problems = [];
    if (words.length !== chapter.count) problems.push(`词数与 chapters.js 不一致（${words.length} vs ${chapter.count}）`);
    if (ids.size !== words.length) problems.push("存在重复 id");
    if (words.some((w) => !w.word || !w.meaningCN)) problems.push("存在缺 word/meaningCN 的词条");
    if (problems.length) bad(`data-${chapter.id}.json：${problems.join("；")}`);
    else ok(`data-${chapter.id}.json：${words.length} 词，id 唯一`);
    totalWords += words.length;
  } catch (err) {
    bad(`data-${chapter.id}.json 解析失败：${err.message}`);
  }
}
console.log(`  → 合计 ${totalWords} 词`);

/* ============ 3. HTML 引用与 CSP ============ */

section("3) HTML 资源引用 / 无内联脚本");
const pages = [
  { html: "index.html", script: "app.js" },
  { html: "课程讲义.html", script: "lecture.js" },
];

for (const page of pages) {
  checks++;
  const htmlPath = path.join(publicDir, page.html);
  if (!(await exists(htmlPath))) {
    bad(`${page.html} 不存在`);
    continue;
  }
  const html = await readFile(htmlPath, "utf8");

  // 3a. 本地资源存在
  const refs = [...html.matchAll(/(?:src|href)="([^"#?:]+)"/g)].map((m) => m[1]);
  const missing = [];
  for (const ref of refs) {
    if (ref.startsWith("http") || ref.startsWith("data:")) continue;
    if (!(await exists(path.join(publicDir, ref)))) missing.push(ref);
  }
  if (missing.length) bad(`${page.html} 引用了不存在的文件：${missing.join(", ")}`);
  else ok(`${page.html} 引用的 ${refs.length} 个本地资源都存在`);

  // 3b. 不允许内联 <script>（worker 里配了 script-src 'self'）
  const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].filter(
    (m) => m[1].trim().length > 0
  );
  if (inline.length) bad(`${page.html} 存在内联 <script>，会被 CSP 拦截`);
  else ok(`${page.html} 无内联脚本（CSP script-src 'self' 兼容）`);

  // 3c. 重复 id
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dup.length) bad(`${page.html} 存在重复 id：${[...new Set(dup)].join(", ")}`);
  else ok(`${page.html} 无重复 id（${ids.length} 个）`);

  // 3d. JS 里引用的 id 存在
  checks++;
  const js = await readFile(path.join(publicDir, page.script), "utf8");
  const referenced = new Set(
    [...js.matchAll(/\$\("#([A-Za-z0-9_-]+)"\)/g)].map((m) => m[1]).filter((id) => !DYNAMIC_IDS.has(id))
  );
  const idSet = new Set(ids);
  const notFound = [...referenced].filter((id) => !idSet.has(id));
  if (notFound.length) bad(`${page.script} 引用了 ${page.html} 中不存在的 id：${notFound.join(", ")}`);
  else ok(`${page.script} 引用的 ${referenced.size} 个元素 id 都存在`);

  // 3e. 页面必须通过 module 方式引入自己的脚本
  if (!html.includes(`type="module" src="${page.script}"`)) {
    bad(`${page.html} 未以 type="module" 引入 ${page.script}`);
  }
}

/* ============ 4. 旧文件不应再被引用 ============ */

section("4) 旧引用清理");
checks++;
const legacyRefs = [];
for (const page of pages) {
  const html = await readFile(path.join(publicDir, page.html), "utf8");
  if (/data-\d+\.js/.test(html)) legacyRefs.push(`${page.html} 仍引用 data-N.js`);
  if (/<script src="vocab-auth\.js"/.test(html)) legacyRefs.push(`${page.html} 仍以传统 script 引入 vocab-auth.js`);
}
const legacyFiles = (await readdir(publicDir)).filter((f) => /^data-\d+\.js$/.test(f));
if (legacyFiles.length) legacyRefs.push(`public/ 下仍存在 ${legacyFiles.length} 个 data-N.js`);
if (legacyRefs.length) bad(legacyRefs.join("；"));
else ok("没有遗留的 data-N.js / 传统 script 引入");

/* ============ 5. CSS 变量定义 ============ */

section("5) CSS 自定义属性");
checks++;
const cssFiles = (await readdir(publicDir)).filter((f) => f.endsWith(".css"));
const defined = new Set();
const used = new Map();
for (const file of cssFiles) {
  const css = await readFile(path.join(publicDir, file), "utf8");
  for (const m of css.matchAll(/(--[a-z0-9-]+)\s*:/gi)) defined.add(m[1]);
  for (const m of css.matchAll(/var\((--[a-z0-9-]+)/gi)) {
    if (!used.has(m[1])) used.set(m[1], file);
  }
}
const undefinedVars = [...used.keys()].filter((name) => !defined.has(name));
if (undefinedVars.length) bad(`以下变量被使用但未定义：${undefinedVars.map((v) => `${v}(${used.get(v)})`).join(", ")}`);
else ok(`${cssFiles.length} 个 CSS 文件，${used.size} 个变量引用全部有定义`);

/* ============ 6. Worker / 配置一致性 ============ */

section("6) Worker 与部署配置");
checks++;
const wrangler = await readFile(path.join(root, "wrangler.jsonc"), "utf8");
const main = wrangler.match(/"main"\s*:\s*"([^"]+)"/)?.[1];
if (main && (await exists(path.join(root, main)))) ok(`wrangler main → ${main} 存在`);
else bad(`wrangler main 指向的文件不存在：${main}`);
if (/worker\/index\.ts/.test(wrangler)) bad("wrangler.jsonc 仍指向 worker/index.ts");
checks++;
if (await exists(path.join(root, "worker", "index.ts"))) bad("旧的 worker/index.ts 仍然存在");
else ok("旧的 worker/index.ts 已移除");

checks++;
const migrations = (await readdir(path.join(root, "migrations"))).filter((f) => f.endsWith(".sql"));
const hasWordState = (
  await Promise.all(
    migrations.map((f) => readFile(path.join(root, "migrations", f), "utf8"))
  )
).some((sql) => /CREATE TABLE IF NOT EXISTS user_word_state/.test(sql));
if (hasWordState) ok(`迁移文件 ${migrations.length} 个，包含 user_word_state`);
else bad("迁移里缺少 user_word_state 表");

/* ============ 7. 认词题源（选择题资料） ============ */

section("7) 认词题源");
const {
  QUIZ_SPEC_VERSION,
  PROMPT_MARKERS,
  extractModelPrompt,
  normalizeQuizDoc,
  quizIndexPath,
  quizPath,
  validateQuizDoc,
} = await import("./quiz-lib.mjs");

checks++;
const specFile = path.join(root, "docs", "选择题资料生成规范.md");
if (!(await exists(specFile))) {
  bad("缺少 docs/选择题资料生成规范.md");
} else {
  const spec = await readFile(specFile, "utf8");
  const prompt = extractModelPrompt(spec);
  if (!spec.includes(PROMPT_MARKERS[0]) || !spec.includes(PROMPT_MARKERS[1]) || prompt.length < 500) {
    bad("生成规范缺少 MODEL-PROMPT 区段（quiz.mjs prompt 依赖它）");
  } else {
    ok(`生成规范存在，模型提示词 ${prompt.length} 字（规范 v${QUIZ_SPEC_VERSION}）`);
  }
}

// 每一份题源都要能被本模块校验器接受（错误会让 quizzes 失去精编内容，所以直接判失败）
checks++;
const quizFiles = (await readdir(publicDir)).filter((f) => /^quiz-\d+\.json$/.test(f));
const usableChapters = [];
for (const file of quizFiles) {
  const chapter = Number(file.match(/\d+/)[0]);
  const wordsFile = path.join(publicDir, `data-${chapter}.json`);
  if (!(await exists(wordsFile))) {
    bad(`${file} 没有对应的 data-${chapter}.json`);
    continue;
  }
  try {
    const words = JSON.parse(await readFile(wordsFile, "utf8"));
    const doc = JSON.parse(await readFile(path.join(publicDir, file), "utf8"));
    const { errors, warnings, stats } = validateQuizDoc(doc, { chapter, words });
    if (errors.length) {
      bad(`${file}：${errors.slice(0, 4).join("；")}${errors.length > 4 ? ` …等 ${errors.length} 条` : ""}`);
    } else {
      usableChapters.push(chapter);
      ok(
        `${file}：精编 ${stats.covered}/${stats.total} 词（${Math.round(stats.coverage * 100)}%），辨析均值 ${stats.avgWhy} 字${
          warnings.length ? `，${warnings.length} 条建议` : ""
        }`
      );
      for (const warning of warnings.slice(0, 3)) console.log(`      ! ${warning}`);
    }
  } catch (err) {
    bad(`${file} 解析失败：${err.message}`);
  }
}
if (!quizFiles.length) ok("暂无精编题源（认词模式使用同章自动生成的干扰项，功能正常）");

// 清单必须与实际题源一致：前端只按清单取文件，不一致会导致"有题源却用不上"
checks++;
const indexFile = path.join(root, quizIndexPath);
if (!(await exists(indexFile))) {
  bad(`缺少 ${quizIndexPath}（运行 npm run quiz:check 生成）`);
} else {
  try {
    const index = JSON.parse(await readFile(indexFile, "utf8"));
    const listed = Array.isArray(index.chapters) ? index.chapters.map(Number).sort((a, b) => a - b) : null;
    const expected = usableChapters.slice().sort((a, b) => a - b);
    if (!listed) bad(`${quizIndexPath} 缺少 chapters 数组`);
    else if (JSON.stringify(listed) !== JSON.stringify(expected)) {
      bad(`${quizIndexPath} 与实际题源不一致（清单 ${listed.join(",") || "空"} / 实际 ${expected.join(",") || "空"}）`);
    } else ok(`${quizIndexPath} 与 ${quizFiles.length} 份题源一致（${expected.length} 章可用）`);
  } catch (err) {
    bad(`${quizIndexPath} 解析失败：${err.message}`);
  }
}

// 前端出题模块引用的 id/字段与题源一致（防止改名后静默失效）
checks++;
const quizJs = await readFile(path.join(publicDir, "quiz.js"), "utf8");
const sampleDoc = { chapter: 1, items: { 1: { distractors: [{ text: "x", kind: "root", why: "y" }] } } };
const normalized = normalizeQuizDoc(sampleDoc);
if (!normalized.items["1"] || !quizJs.includes("distractors") || !quizJs.includes("QUIZ_KIND")) {
  bad("public/quiz.js 与题源字段约定不一致（distractors / QUIZ_KIND）");
} else {
  ok("public/quiz.js 与题源字段约定一致");
}

/* ============ 6. 主题调色盘（对比度门禁） ============ */

section("6) 主题调色盘");
{
  const tokens = await readFile(path.join(publicDir, "tokens.css"), "utf8");
  /** 从指定选择器块里提取自定义属性的值 */
  const pick = (selector, prop) => {
    const idx = tokens.indexOf(selector);
    if (idx < 0) return null;
    const block = tokens.slice(idx, tokens.indexOf("}", idx));
    const line = block.split(/\r?\n/).find((l) => l.includes(prop + ":"));
    return line ? line.split(":").slice(1).join(":").trim().replace(/;$/, "") : null;
  };
  const lum = (hex) => {
    const h = String(hex || "").replace("#", "");
    const ch = (i) => {
      const v = parseInt(h.slice(i, i + 2), 16) / 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * ch(0) + 0.7152 * ch(2) + 0.0722 * ch(4);
  };
  const ratio = (a, b) => {
    const la = lum(a), lb = lum(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  };
  const pageDark = "#0a0d19";
  const pageLight = "#eef0f7";
  const palettes = ["sky", "violet", "emerald", "rose", "amber", "slate"];
  let allOk = true;
  for (const p of palettes) {
    const lAccent = pick(`[data-accent="${p}"]`, "--accent");
    const lInk = pick(`[data-accent="${p}"]`, "--accent-ink");
    const dAccent = pick(`[data-accent="${p}"][data-theme="dark"]`, "--accent");
    const dInk = pick(`[data-accent="${p}"][data-theme="dark"]`, "--accent-ink");
    if (!lAccent || !lInk || !dAccent || !dInk) {
      bad(`${p}：变量缺失（accent/ink 需在两主题块中都有定义）`);
      allOk = false;
      continue;
    }
    const r1 = ratio(lAccent, pageLight);
    const r2 = ratio(dAccent, pageDark);
    const r3 = ratio(dInk, dAccent);
    const r4 = ratio(lInk, lAccent);
    const okP = r1 >= 3 && r2 >= 7 && r3 >= 4.5 && r4 >= 3;
    if (!okP) allOk = false;
    console.log(`      ${okP ? "✔" : "✖"} ${p}：浅 accent/页面 ${r1.toFixed(1)} · 深 accent/页面 ${r2.toFixed(1)} · 深 ink/accent ${r3.toFixed(1)} · 浅 ink/accent ${r4.toFixed(1)}`);
  }
  if (allOk) ok(`六盘对比度全部达标（浅≥3.0 / 深≥7.0 / ink≥4.5）`);
  else bad("存在对比度不达标的调色盘（见上）");
  checks++;
  if (!allOk) failures++;
}

/* ============ 结果 ============ */

console.log(`\n${failures ? "✖" : "✔"} 检查完成：${checks - failures}/${checks} 项通过`);
process.exit(failures ? 1 : 0);
