// @ts-check
/**
 * 构建前端静态资源：压缩 + 内容指纹（计划 5.2）
 *
 * 为什么要这一步：
 *  - 线上一直是"源码原样上传"（app.js 161KB / lecture.js 85KB 未压缩），首屏白给的传输量；
 *  - 没有指纹就不敢发 immutable 缓存头，1.1 的那套指纹缓存对 JS/CSS 用不上。
 *
 * 设计取舍：
 *  - **产物进 `public/dist/`，源码留在原地**：`test/frontend-guards.test.js` 用正则断言 app.js 源码，
 *    `scripts/check.mjs` 也要读源码做静态校验，源码必须是可读的原始文件。
 *  - **JS 用 bundle + splitting**：4 个页面入口共享 ui.js / chapters.js / vocab-auth.js 等，
 *    拆成共享 chunk 后跨页复用同一个 URL（一次下载，三页受益），比逐文件 minify 少请求。
 *  - **CSS 逐文件 minify**：它们之间没有 @import，保持多个小文件才能让 tokens/ui 跨页命中同一份缓存；
 *    合成一个 per-page 大文件反而会让每页各缓存一份重复内容。
 *  - **指纹用 esbuild 自带的 `[hash]`**：它顺手解决了 chunk 之间的引用改写（自己改名要重写 import 说明符）。
 *    代价是字母表与 `contentHash()` 的 8 位十六进制不同（esbuild 用大写 base32），
 *    worker/sw 的识别正则因此写成两条（见 `HASHED_FILE`）。
 *  - **sourcemap 保留（external）**：线上排障依赖它，多一次 devtools 请求而已。
 *
 * 用法：`npm run build:assets`（`npm run dev` / `npm run deploy` 会自动先跑）。
 */
import { build } from "esbuild";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUB = path.join(ROOT, "public");
const DIST = path.join(PUB, "dist");
const MANIFEST = path.join(DIST, "manifest.json");

/** 4 个页面入口；sw.js 是 classic script，不参与打包 */
const JS_ENTRIES = ["app.js", "lecture.js", "报告.js", "admin.js"];
const CSS_ENTRIES = ["tokens.css", "ui.css", "app.css", "lecture.css", "报告.css", "admin.css"];
const PAGES = ["index.html", "课程讲义.html", "报告.html", "admin.html"];
/** esbuild 的 [hash] 字母表；用于把 HTML 里已有的指纹引用还原成源文件名（保证幂等） */
const HASH_RE = /\.[A-Za-z0-9]{8}\.(js|css)$/;

const contentHash = (text) => createHash("sha256").update(text, "utf8").digest("hex").slice(0, 8);
const kb = (n) => `${(n / 1024).toFixed(1)}KB`;

/** @param {string} rel @returns {Promise<string>} */
const readPub = async (rel) => readFile(path.join(PUB, rel), "utf8");

/**
 * esbuild 产物名 → 源文件名：`public/app.js` → `app.js`
 * @param {Record<string, any>} outputs
 */
function mapOutputs(outputs) {
  /** @type {Record<string, string>} */
  const map = {};
  for (const [out, meta] of Object.entries(outputs)) {
    if (!meta.entryPoint) continue; // 共享 chunk 不参与 HTML 改写
    const src = path.basename(meta.entryPoint);
    map[src] = path.basename(out);
  }
  return map;
}

async function clean() {
  await rm(DIST, { recursive: true, force: true });
  await mkdir(DIST, { recursive: true });
}

async function buildJs() {
  const result = await build({
    entryPoints: JS_ENTRIES.map((f) => path.join(PUB, f)),
    bundle: true,
    splitting: true,
    format: "esm",
    outdir: DIST,
    entryNames: "[name].[hash]",
    chunkNames: "chunk.[hash]",
    minify: true,
    sourcemap: "external",
    target: ["es2020"],
    charset: "utf8",
    legalComments: "none",
    metafile: true,
    logLevel: "warning",
  });
  return { map: mapOutputs(result.metafile.outputs), outputs: Object.keys(result.metafile.outputs) };
}

async function buildCss() {
  const result = await build({
    entryPoints: CSS_ENTRIES.map((f) => path.join(PUB, f)),
    bundle: true, // CSS 目前无 @import，开了只为以后加 @import 时不出意外
    outdir: DIST,
    entryNames: "[name].[hash]",
    minify: true,
    sourcemap: false,
    target: ["es2020"],
    charset: "utf8",
    metafile: true,
    logLevel: "warning",
  });
  return { map: mapOutputs(result.metafile.outputs), outputs: Object.keys(result.metafile.outputs) };
}

/**
 * 改写 HTML 引用。幂等：先把 `dist/x.<hash>.js` 还原成 `x.js`，再按新产物重写。
 * @param {Record<string, string>} map 源文件名 → 产物文件名
 */
async function rewriteHtml(map) {
  for (const page of PAGES) {
    const file = path.join(PUB, page);
    const original = await readPub(page);
    let html = original
      // 先还原：dist/app.HOBLRNQJ.js → app.js（去掉 dist 前缀与指纹）
      .replace(/dist\/([^"']+?)\.[A-Za-z0-9]{8}\.(js|css)/g, "$1.$2");
    for (const [src, out] of Object.entries(map)) {
      // 只改 href/src 里的值，避免误伤正文里同名的字符串
      html = html.replace(new RegExp(`((?:href|src)=")${escapeRe(src)}(")`, "g"), `$1dist/${out}$2`);
    }
    if (html !== original) await writeFile(file, html, "utf8");
  }
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * 参与构建的输入文件指纹（给 `npm run check` 判断 dist 是否过期）。
 * sw.js 不参与打包，排除；dist 自身排除。
 */
async function sourceHashes() {
  const files = (await readdir(PUB)).filter((f) => /\.(?:js|css)$/.test(f) && f !== "sw.js");
  /** @type {Record<string, string>} */
  const out = {};
  for (const f of files.sort()) out[f] = contentHash(await readPub(f));
  return out;
}

async function main() {
  const before = {};
  for (const f of [...JS_ENTRIES, ...CSS_ENTRIES]) before[f] = (await readPub(f)).length;

  await clean();
  const js = await buildJs();
  const css = await buildCss();
  const map = { ...js.map, ...css.map };
  await rewriteHtml(map);

  const manifest = {
    generatedAt: new Date().toISOString(),
    js: js.map,
    css: css.map,
    outputs: [...js.outputs, ...css.outputs].map((p) => path.relative(PUB, p).replace(/\\/g, "/")).sort(),
    sources: await sourceHashes(),
  };
  await writeFile(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  // 体积报告：只统计"页面实际要下载的部分"（入口 + 它依赖的所有 chunk）
  console.log("构建完成 → public/dist/");
  for (const [src, out] of Object.entries(map)) {
    const raw = await readFile(path.join(DIST, out));
    const cut = before[src] ? `（${kb(before[src])} → ${kb(raw.length)}，省 ${Math.round((1 - raw.length / before[src]) * 100)}%）` : "";
    console.log(`  ${src.padEnd(12)} → ${out}${cut}`);
  }
  const chunks = manifest.outputs.filter((p) => /\/chunk\./.test(p));
  if (chunks.length) console.log(`  共享 chunk ${chunks.length} 个（跨页复用同一 URL）`);
}

main().catch((err) => {
  console.error("构建失败：", err instanceof Error ? err.message : err);
  process.exit(1);
});
