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
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

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
/** 提醒但不阻断：这类问题依赖发版时的判断，不该卡住本地开发 */
const warn = (msg) => console.log(`  ⚠ ${msg}`);

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
// 拆出来的模块也要能被独立 import：它们一旦反向依赖 app.js / lecture.js 就会成环，
// 在 Node 里 import 会直接暴露（浏览器里则是"偶发 undefined"的玄学故障）
const modules = [
  "core.js",
  "quiz.js",
  "chapters.js",
  "ui.js",
  "vocab-auth.js",
  "session-guard.js",
  "star-store.js",
  "star-sync.js",
  "state.js",
  "storage.js",
  "speech.js",
  "lecture-store.js",
  "app.js",
  "lecture.js",
  "admin.js",
  "报告.js",
];
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

section("3) HTML 资源引用 / 内联脚本白名单");

/**
 * 首屏主题引导脚本：必须在样式生效前同步执行（防暗色用户闪白），因此不能外链。
 * CSP 用内容哈希放行，见 worker/index.js 的 THEME_BOOT_SHA256。
 * 这里列出它的"指纹"——四份 HTML 的内联脚本必须都长这样，多一个字符都要重新登记哈希。
 */
const THEME_BOOT_MARKERS = ["vocab:theme", "prefers-color-scheme: dark", 'meta[name="theme-color"]'];
/** 每页收集到的引导脚本哈希，稍后与 worker CSP 比对 */
const bootHashes = new Map();

const pages = [
  { html: "index.html", script: "app.js" },
  { html: "课程讲义.html", script: "lecture.js" },
  { html: "admin.html", script: "admin.js" },
  { html: "报告.html", script: "报告.js" },
];

/**
 * 构建产物清单（`npm run build:assets` 产出）。
 * 没跑过构建时为 null：`public/dist/` 不入库，全新克隆就是这种状态，此时 HTML 里那些
 * `dist/app.<hash>.js` 引用暂时指向不存在的文件——这是"还没构建"而不是"引用写错了"，
 * 所以相关校验降级成告警（见 3a / 3e），别把它判成失败。
 */
const distManifest = await (async () => {
  try {
    return JSON.parse(await readFile(path.join(publicDir, "dist", "manifest.json"), "utf8"));
  } catch {
    return null;
  }
})();

for (const page of pages) {
  checks++;
  const htmlPath = path.join(publicDir, page.html);
  if (!(await exists(htmlPath))) {
    bad(`${page.html} 不存在`);
    continue;
  }
  const html = await readFile(htmlPath, "utf8");

  // 3a. 本地资源存在（dist/ 在没构建过时不查，见 distManifest 的说明）
  const refs = [...html.matchAll(/(?:src|href)="([^"#?:]+)"/g)].map((m) => m[1]);
  const missing = [];
  const pendingDist = [];
  for (const ref of refs) {
    if (ref.startsWith("http") || ref.startsWith("data:")) continue;
    if (await exists(path.join(publicDir, ref))) continue;
    if (!distManifest && ref.startsWith("dist/")) pendingDist.push(ref);
    else missing.push(ref);
  }
  if (missing.length) bad(`${page.html} 引用了不存在的文件：${missing.join(", ")}`);
  else if (pendingDist.length) warn(`${page.html} 引用了 ${pendingDist.length} 个尚未构建的产物（跑 npm run build:assets）`);
  else ok(`${page.html} 引用的 ${refs.length} 个本地资源都存在`);

  // 3b. 默认不允许内联 <script>（worker 里配了 script-src 'self'）；
  //     唯一例外是首屏主题引导脚本，它靠 CSP 哈希源放行，哈希稍后与 worker 比对。
  const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]
    .map((m) => m[1])
    .filter((body) => body.trim().length > 0);
  const boot = inline.filter((body) => THEME_BOOT_MARKERS.every((mk) => body.includes(mk)));
  const stray = inline.filter((body) => !boot.includes(body));
  if (stray.length) bad(`${page.html} 存在 ${stray.length} 段未登记的内联 <script>，会被 CSP 拦截`);
  else if (!boot.length) bad(`${page.html} 缺少首屏主题引导脚本（暗色用户会闪一帧亮色）`);
  else {
    const hash = createHash("sha256").update(boot[0], "utf8").digest("base64");
    bootHashes.set(page.html, hash);
    ok(`${page.html} 含首屏主题引导脚本（sha256-${hash.slice(0, 12)}…）`);
  }

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

  // 3e. 页面必须通过 module 方式引入自己的脚本（构建后指向 dist/app.<hash>.js）
  const builtScript = distManifest?.js?.[page.script] ? `dist/${distManifest.js[page.script]}` : page.script;
  const distRef = html.match(/type="module" src="(dist\/[^"]+)"/)?.[1];
  if (html.includes(`type="module" src="${builtScript}"`)) {
    /* 与清单一致（或尚未构建时直指源码） */
  } else if (!distManifest && distRef) {
    // 没构建过但 HTML 已经是构建后的形态：文件还没生成，不算写错
    warn(`${page.html} 指向 ${distRef}，但 public/dist 尚未构建（跑 npm run build:assets）`);
  } else {
    bad(`${page.html} 未以 type="module" 引入 ${builtScript}`);
  }
}

// 3f. 首屏主题引导脚本：四页内容一致 + 哈希已在 worker CSP 登记
//     （改了那段脚本而忘记重新登记哈希 → 首屏主题被 CSP 静默拦掉，暗色用户重新闪白）
checks++;
{
  const workerSrc = await readFile(path.join(root, "worker", "index.js"), "utf8");
  const declared = workerSrc.match(/const THEME_BOOT_SHA256\s*=\s*"([^"]+)"/)?.[1];
  const unique = [...new Set(bootHashes.values())];
  if (!declared) bad("worker/index.js 缺少 THEME_BOOT_SHA256（首屏主题脚本会被 CSP 拦掉）");
  else if (bootHashes.size !== pages.length) bad(`${pages.length - bootHashes.size} 个页面缺少首屏主题引导脚本`);
  else if (unique.length !== 1) bad(`各页首屏主题脚本内容不一致（CSP 只能登记一个哈希）：${unique.join(" / ")}`);
  else if (unique[0] !== declared) {
    bad(`首屏主题脚本哈希与 worker CSP 不一致：HTML=${unique[0]} worker=${declared}（改脚本后请同步 THEME_BOOT_SHA256）`);
  } else ok(`首屏主题脚本哈希与 worker CSP 一致（${declared.slice(0, 12)}…，四页同内容）`);
}

// 3g. 首屏脚本的主题解析逻辑与 ui.js 保持一致（存储键 + 双主题 theme-color 取值）
checks++;
{
  const uiSrc = await readFile(path.join(publicDir, "ui.js"), "utf8");
  const bootSrc = await readFile(path.join(publicDir, "index.html"), "utf8");
  // ui.js: resolved === "dark" ? "#12141c" : "#f6f2ea" ／ 首屏脚本: dark ? "#12141c" : "#f6f2ea"
  const pickHex = (src) => src.match(/dark["']?\s*\?\s*"(#[0-9a-fA-F]{3,8})"\s*:\s*"(#[0-9a-fA-F]{3,8})"/);
  const uiHex = pickHex(uiSrc);
  const bootHex = pickHex(bootSrc);
  const problems = [];
  if (!/const THEME_KEY\s*=\s*"vocab:theme"/.test(uiSrc)) problems.push("ui.js 的 THEME_KEY 不再是 vocab:theme");
  if (!bootSrc.includes("vocab:theme")) problems.push("首屏脚本的存储键不再是 vocab:theme");
  if (!uiHex || !bootHex) problems.push("未能解析出 theme-color 取值（ui.js / 首屏脚本）");
  else if (uiHex[1] !== bootHex[1] || uiHex[2] !== bootHex[2]) {
    problems.push(`theme-color 取值不一致：ui.js=${uiHex[1]}/${uiHex[2]} 首屏=${bootHex[1]}/${bootHex[2]}`);
  }
  if (problems.length) bad(`首屏主题与 ui.js 漂移：${problems.join("；")}`);
  else ok(`首屏主题逻辑与 ui.js 一致（键 vocab:theme，${uiHex?.[1]} / ${uiHex?.[2]}）`);
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
const hasWordStars = (
  await Promise.all(
    migrations.map((f) => readFile(path.join(root, "migrations", f), "utf8"))
  )
).some((sql) => /CREATE TABLE IF NOT EXISTS user_word_stars/.test(sql));
if (hasWordState) ok(`迁移文件 ${migrations.length} 个，包含 user_word_state`);
else bad("迁移里缺少 user_word_state 表");
if (hasWordStars) ok("迁移里包含 user_word_stars");
else bad("迁移里缺少 user_word_stars 表");

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

// 构建期必须 minify：带缩进的 JSON 白占传输带宽、IDB 缓存体积与解析期内存
// （可读性由 content/quiz/ 的中间分片负责，运行时产物只给机器读）
checks++;
{
  const payloads = (await readdir(publicDir)).filter((f) => /^(?:data|quiz)-\d+\.json$/.test(f));
  let bytes = 0;
  const pretty = [];
  for (const file of payloads) {
    const raw = await readFile(path.join(publicDir, file), "utf8");
    bytes += Buffer.byteLength(raw);
    if (/\n\s/.test(raw)) pretty.push(file);
  }
  if (pretty.length) bad(`以下 JSON 仍是带缩进输出（应 JSON.stringify 不带空格）：${pretty.slice(0, 5).join(", ")}${pretty.length > 5 ? ` …等 ${pretty.length} 个` : ""}`);
  else ok(`${payloads.length} 份词库/题源均为 minify 输出（合计 ${(bytes / 1024 / 1024).toFixed(2)} MB）`);
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

// 前端的 QUIZ_SPEC_VERSION 是本地题源缓存的失效开关，必须与脚本侧一致
// （前端偏旧 → 旧结构缓存不失效；前端偏新 → 缓存永不命中，每次都重新下载）
checks++;
{
  const declared = quizJs.match(/export const QUIZ_SPEC_VERSION\s*=\s*"([^"]+)"/)?.[1];
  if (!declared) bad("public/quiz.js 缺少 QUIZ_SPEC_VERSION（本地题源缓存无法在升版后失效）");
  else if (declared !== QUIZ_SPEC_VERSION) {
    bad(`QUIZ_SPEC_VERSION 不一致：public/quiz.js=${declared} scripts/quiz-lib.mjs=${QUIZ_SPEC_VERSION}`);
  } else ok(`题源 spec 版本前后端一致（v${declared}）`);
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
    // 浅色盘 ink/accent 按"彩色底上的文字"要求 4.5（原为 3.0，白字压主色长期不达标却能过门禁）
    const okP = r1 >= 3 && r2 >= 7 && r3 >= 4.5 && r4 >= 4.5;
    if (!okP) allOk = false;
    console.log(`      ${okP ? "✔" : "✖"} ${p}：浅 accent/页面 ${r1.toFixed(1)} · 深 accent/页面 ${r2.toFixed(1)} · 深 ink/accent ${r3.toFixed(1)} · 浅 ink/accent ${r4.toFixed(1)}`);
  }
  if (allOk) ok(`六盘对比度全部达标（浅≥3.0 / 深≥7.0 / ink≥4.5 双主题）`);
  else bad("存在对比度不达标的调色盘（见上）");

  // 正文小字的对比度（--text-3 承载 0.72~0.8rem 的音标/脚注，--ok 是反馈文字）：
  // 两个主题下都要 ≥4.5（WCAG AA），原先这块没有任何门禁
  checks++;
  {
    const pairs = [
      ["浅 text-3/面板", pick(":root", "--text-3"), pick(":root", "--surface")],
      ["浅 text-3/次面板", pick(":root", "--text-3"), pick(":root", "--surface-2")],
      ["浅 ok/面板", pick(":root", "--ok"), pick(":root", "--surface")],
      ["深 text-3/面板", pick('[data-theme="dark"]', "--text-3"), pick('[data-theme="dark"]', "--surface")],
      ["深 text-3/次面板", pick('[data-theme="dark"]', "--text-3"), pick('[data-theme="dark"]', "--surface-2")],
      ["深 ok/面板", pick('[data-theme="dark"]', "--ok"), pick('[data-theme="dark"]', "--surface")],
    ];
    let bodyOk = true;
    for (const [label, fg, bg] of pairs) {
      if (!fg || !bg) {
        bad(`正文对比度：${label} 变量缺失`);
        bodyOk = false;
        continue;
      }
      const r = ratio(fg, bg);
      const pass = r >= 4.5;
      if (!pass) bodyOk = false;
      console.log(`      ${pass ? "✔" : "✖"} ${label} ${r.toFixed(1)}`);
    }
    if (bodyOk) ok("正文小字（text-3 / ok）两主题均达 AA（≥4.5）");
    else bad("存在正文文字对比度不达标（见上）");
  }
}

/* ============ 8. 设计 lint（「纸与墨」设计系统护栏） ============ */

section("8) 设计 lint");

/** 去掉 CSS/JS 注释（注释里提到 emoji/hex 不算违规） */
const stripComments = (src, kind) =>
  kind === "css" ? src.replace(/\/\*[\s\S]*?\*\//g, "") : src.replace(/^\s*(\/\/.*$|\/\*[\s\S]*?\*\/)/gm, "");

// 8a) 组件 CSS 禁裸 hex：tokens.css 是唯一色源；ui.css 因"色卡预览"有少量豁免色值
checks++;
{
  const bads = [];
  for (const f of ["app.css", "lecture.css", "admin.css", "报告.css"]) {
    const css = stripComments(await readFile(path.join(publicDir, f), "utf8"), "css");
    for (const m of css.match(/#[0-9a-fA-F]{3,8}\b/g) || []) bads.push(`${f}:${m}`);
  }
  if (bads.length) bad(`组件 CSS 出现裸 hex（应引用 tokens 语义变量）：${bads.slice(0, 6).join(", ")}${bads.length > 6 ? ` …等 ${bads.length} 处` : ""}`);
  else ok("组件 CSS（app/lecture）无裸 hex，颜色全部走 tokens");
}

// 8b) 结构性界面禁 emoji（图标必须是 SVG sprite）。
//     范围：两页 HTML 全量 + 公共 JS/CSS 非注释行；chapters.js 是数据文件（emoji 已不再渲染到控件）豁免；
//     允许文本字形 ★☆✓✗✕（无 VS16，按文本渲染，可主题化着色）。
checks++;
{
  const ALLOW = new Set([0x2605, 0x2606, 0x2713, 0x2717, 0x2715]);
  const emojiRe = /[\u{2300}-\u{23FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{2B00}-\u{2BFF}\u{1F000}-\u{1FAFF}\u{FE0F}]/gu;
  const targets = [
    { file: "index.html", kind: "html" },
    { file: "课程讲义.html", kind: "html" },
    { file: "admin.html", kind: "html" },
    { file: "报告.html", kind: "html" },
    { file: "app.js", kind: "code" },
    { file: "lecture.js", kind: "code" },
    { file: "ui.js", kind: "code" },
    { file: "idb.js", kind: "code" },
    { file: "core.js", kind: "code" },
    { file: "quiz.js", kind: "code" },
    { file: "vocab-auth.js", kind: "code" },
    { file: "app.css", kind: "css" },
    { file: "lecture.css", kind: "css" },
    { file: "ui.css", kind: "css" },
    { file: "tokens.css", kind: "css" },
  ];
  const offenders = [];
  for (const { file, kind } of targets) {
    const src = await readFile(path.join(publicDir, file), "utf8");
    const body = kind === "html" ? src : stripComments(src, kind === "css" ? "css" : "js");
    const lines = body.split(/\r?\n/);
    lines.forEach((line, i) => {
      for (const m of line.matchAll(emojiRe)) {
        const ch = m[0];
        const cp = ch.codePointAt(0);
        if (ALLOW.has(cp)) continue;
        offenders.push(`${file}:${i + 1} U+${cp.toString(16).toUpperCase()}`);
      }
    });
  }
  if (offenders.length) bad(`界面出现 emoji（应改为 SVG 图标/纯文本）：${offenders.slice(0, 8).join(", ")}${offenders.length > 8 ? ` …等 ${offenders.length} 处` : ""}`);
  else ok("两页 HTML 与公共 JS/CSS 零 emoji（结构性图标全部走 SVG sprite）");
}

// 8c) 焦点可见性：全局 :focus-visible 是唯一焦点通道，禁止组件再写 outline:none
checks++;
{
  const hits = [];
  for (const f of cssFiles) {
    const css = stripComments(await readFile(path.join(publicDir, f), "utf8"), "css");
    if (/outline\s*:\s*none/.test(css)) hits.push(f);
  }
  if (hits.length) bad(`以下 CSS 用 outline:none 关掉了焦点环：${hits.join(", ")}`);
  else ok("无 outline:none（键盘焦点环全局可见，含 forced-colors）");
}

// 8d) 字体自托管：CSP style-src 'self' 与离线 PWA 都要求字体本地化，禁止外部字体源/@import
checks++;
{
  const hits = [];
  for (const f of cssFiles) {
    const css = await readFile(path.join(publicDir, f), "utf8");
    if (/@import\s+url\(/i.test(css)) hits.push(`${f}: @import`);
    if (/fonts\.(googleapis|gstatic)\.com/.test(css)) hits.push(`${f}: google fonts`);
  }
  for (const f of ["index.html", "课程讲义.html"]) {
    const html = await readFile(path.join(publicDir, f), "utf8");
    if (/fonts\.(googleapis|gstatic)\.com/.test(html)) hits.push(`${f}: google fonts`);
  }
  if (hits.length) bad(`引用了外部字体源（应自托管到 public/fonts/）：${hits.join(", ")}`);
  else ok("无外部字体引用（字族走 tokens.css 本地栈：Fraunces→Georgia / Plex Mono→系统等宽）");
}

/* ============ 9. 发布门禁：Service Worker 版本号 ============ */

section("9) 发布门禁（sw.js VERSION）");
{
  /** @param {string[]} args @returns {Promise<string[] | null>} 失败（非 git 仓库/无 git）返回 null */
  const gitLines = async (args) => {
    try {
      const { stdout } = await execFileAsync("git", ["-c", "core.quotepath=false", ...args], { cwd: root });
      return stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    } catch {
      return null;
    }
  };

  // 未提交的工作区改动 + 上一次提交改动：前者覆盖"开发到一半跑 check"，后者覆盖 CI 事后复查
  const status = await gitLines(["status", "--porcelain", "--", "public/"]);
  const lastCommit = await gitLines(["diff", "--name-only", "HEAD~1", "--", "public/"]);

  if (status === null && lastCommit === null) {
    console.log("  – 无法读取 git 状态（非仓库或无 git），跳过 VERSION 门禁");
  } else {
    const normalize = (line) => line.replace(/^\S+\s+/, "").replace(/.*->\s*/, "").trim();
    const changed = new Set([...(status ?? []).map(normalize), ...(lastCommit ?? []).map(normalize)]);
    // 只有真正会被 SW 缓存的静态资源才要求递增；data-*/quiz-*.json 是内容数据，
    // 走 network-first 且按章节请求，不在此列
    const assets = [...changed].filter((p) => /^public\/[^/]+\.(?:html|js|css)$/.test(p) && !p.endsWith("/sw.js"));
    const swTouched = [...changed].some((p) => p.endsWith("public/sw.js"));
    if (assets.length && !swTouched) {
      warn(
        `改动了 ${assets.length} 个前端静态资源却没动 public/sw.js：请递增 VERSION，否则老用户拿不到更新（${assets.slice(0, 4).join(", ")}${
          assets.length > 4 ? " …" : ""
        }）`
      );
    } else if (assets.length) {
      ok(`前端静态资源与 public/sw.js 同步变更（${assets.length} 个资源）`);
    } else {
      ok("本轮没有前端静态资源变更，无需递增 VERSION");
    }
  }
}

// 8e) 毛玻璃纪律：全屏遮罩禁用 backdrop-filter；降级/不支持时必须换成不透明底色
checks++;
{
  const ui = await readFile(path.join(publicDir, "ui.css"), "utf8");
  const tokens = await readFile(path.join(publicDir, "tokens.css"), "utf8");
  const problems = [];
  // 先剥注释：注释里解释"为什么不用 backdrop-filter"不该被判成违规
  const uiBody = stripComments(ui, "css");
  const scrim = uiBody.slice(uiBody.indexOf(".scrim {"), uiBody.indexOf(".scrim.sheet-mode"));
  if (scrim && /backdrop-filter/.test(scrim)) problems.push(".scrim 仍有 backdrop-filter（整屏模糊是移动端掉帧主因）");
  if (!/prefers-reduced-motion: reduce[\s\S]{0,600}backdrop-filter: none/.test(tokens)) {
    problems.push("tokens.css 未把 backdrop-filter 纳入 reduced-motion 降级");
  }
  if (!/@supports not \(/.test(tokens)) problems.push("tokens.css 缺少 backdrop-filter 不支持时的回落");
  // 玻璃底被换成不透明时必须有对应变量，否则半透明底会透出底层文字
  const opaque = (tokens.match(/--glass-opaque:/g) || []).length;
  if (opaque < 2) problems.push(`--glass-opaque 需在浅/深两套主题里各定义一次（当前 ${opaque} 处）`);
  if (problems.length) bad(`毛玻璃降级不合规：${problems.join("；")}`);
  else ok("毛玻璃降级合规（全屏遮罩无模糊、reduced-motion 与 @supports 均有不透明回落）");
}

section("10) 构建产物（public/dist 新鲜度）");
checks++;
{
  if (!distManifest) {
    warn("public/dist/manifest.json 不存在：HTML 仍直指源码（未压缩、无指纹）。部署前请跑 npm run build:assets");
  } else {
    const problems = [];
    // 10a. 清单里声明的产物都在
    const outputs = Array.isArray(distManifest.outputs) ? distManifest.outputs : [];
    const missingOut = [];
    for (const rel of outputs) if (!(await exists(path.join(publicDir, rel)))) missingOut.push(rel);
    if (!outputs.length) problems.push("清单里没有产物记录");
    else if (missingOut.length) problems.push(`清单声明的产物缺失 ${missingOut.length} 个（${missingOut.slice(0, 3).join(", ")}）`);

    // 10b. 源码没变过（指纹对得上）→ dist 是新鲜的；否则部署上去的是旧代码
    const declaredSources = distManifest.sources && typeof distManifest.sources === "object" ? distManifest.sources : {};
    const stale = [];
    for (const [file, hash] of Object.entries(declaredSources)) {
      try {
        const now = createHash("sha256").update(await readFile(path.join(publicDir, file), "utf8"), "utf8").digest("hex").slice(0, 8);
        if (now !== hash) stale.push(file);
      } catch {
        stale.push(`${file}（已删除）`);
      }
    }
    if (stale.length) problems.push(`源码已改动但 dist 未重建：${stale.join(", ")}`);

    // 10c. HTML 的引用与清单一致（防止手改 HTML 指向不存在的产物）
    const refProblems = [];
    for (const page of pages) {
      const html = await readFile(path.join(publicDir, page.html), "utf8");
      const jsOut = distManifest.js?.[page.script];
      if (jsOut && !html.includes(`src="dist/${jsOut}"`)) refProblems.push(`${page.html} 未引用 dist/${jsOut}`);
      for (const [src, out] of Object.entries(distManifest.css || {})) {
        if (html.includes(`href="${src}"`) && !html.includes(`href="dist/${out}"`)) {
          refProblems.push(`${page.html} 仍引用未构建的 ${src}`);
        }
      }
    }
    if (refProblems.length) problems.push(`HTML 与清单不一致：${refProblems.join("；")}`);

    if (problems.length) warn(`public/dist 需要重建（npm run build:assets）：${problems.join("；")}`);
    else ok(`public/dist 与源码同步（${outputs.length} 个产物，构建于 ${String(distManifest.generatedAt).slice(0, 10)}）`);
  }
}

/* ============ 结果 ============ */

console.log(`\n${failures ? "✖" : "✔"} 检查完成：${checks - failures}/${checks} 项通过`);
process.exit(failures ? 1 : 0);
