/**
 * a11y.mjs —— axe-core 无障碍扫描（P4 可靠性工具）
 *
 * 对**四个页面 × 明/暗双主题**注入 axe-core，critical/serious 级问题 >0 即 exit 1。
 * 原先只扫刷词页与讲义页（浅色）：报告页、后台页与深色主题从未过 axe，
 * 而深色是自定义色值最容易失守的地方（对比度、焦点可见性）。
 * 依赖：playwright + axe-core（都是本地包；缺任一 exit 2，不阻塞其它门禁）。
 *
 *   npm i --no-save playwright axe-core
 *   node scripts/a11y.mjs [--base http://127.0.0.1:8787]
 */
import { createRequire } from "node:module";

const args = process.argv.slice(2);
const BASE = args.find((a) => a.startsWith("http")) || "http://127.0.0.1:8787";
const require = createRequire(import.meta.url);

/** @type {string} */
let axeSource;
try {
  axeSource = require.resolve("axe-core/axe.min.js");
} catch {
  console.error("缺少 axe-core：npm i --no-save axe-core");
  process.exit(2);
}
const { readFileSync } = await import("node:fs");
const axeJs = readFileSync(axeSource, "utf8");

const { chromium } = await import("playwright").catch(() => {
  console.error("缺少 playwright：npm i --no-save playwright");
  process.exit(2);
});

async function launch() {
  for (const opts of [{ channel: "chrome" }, { channel: "msedge" }, {}]) {
    try {
      return await chromium.launch(opts);
    } catch {
      /* 换下一种 */
    }
  }
  throw new Error("无法启动浏览器");
}

/** 四页：刷词 / 讲义 / 报告 / 后台（后台未登录时扫的是登录门，仍属真实首屏） */
const PAGES = [
  { url: "/", name: "刷词页" },
  { url: "/课程讲义.html", name: "讲义页" },
  { url: "/报告.html", name: "报告页" },
  { url: "/admin.html", name: "后台页" },
];
const THEMES = ["light", "dark"];

const browser = await launch();
let totalSerious = 0;
let scanned = 0;
for (const pageInfo of PAGES) {
  for (const theme of THEMES) {
    // colorScheme 决定 theme.resolved()：本地没存 vocab:theme 时跟系统走
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, colorScheme: theme });
    await page.goto(BASE + pageInfo.url, { waitUntil: "networkidle" });
    await page.waitForTimeout(300); // 等首屏渲染（报告页是 JS 生成）
    // 用 evaluate 注入而不是 addScriptTag：worker 的 CSP 是 script-src 'self' + 哈希白名单，
    // 内联 <script> 会被拦（本工具因此长期 exit 1 而无人发现）。CDP 侧求值不经过页面 CSP。
    await page.evaluate(axeJs);
    const results = await page.evaluate(async () => {
      // @ts-ignore axe 已注入
      return await window.axe.run(document, {
        runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] },
      });
    });
    const bad = results.violations.filter((v) => v.impact === "critical" || v.impact === "serious");
    totalSerious += bad.length;
    scanned++;
    console.log(
      `\n${pageInfo.name}（${theme === "dark" ? "深色" : "浅色"}）：${results.violations.length} 条违规（critical/serious ${bad.length} 条）`
    );
    for (const v of bad.slice(0, 10)) {
      console.log(`  ✖ [${v.impact}] ${v.id} — ${v.help}（${v.nodes.length} 处，例：${v.nodes[0]?.target?.join(" ")}）`);
    }
    await page.close();
  }
}
await browser.close();
console.log(`\n${totalSerious ? "✖" : "✔"} axe 门禁：${scanned} 个页面×主题，critical/serious 共 ${totalSerious} 条`);
process.exit(totalSerious ? 1 : 0);
