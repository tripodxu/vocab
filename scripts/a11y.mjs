/**
 * a11y.mjs —— axe-core 无障碍扫描（P4 可靠性工具）
 *
 * 对两页注入 axe-core，critical/serious 级问题 >0 即 exit 1。
 * 依赖：playwright + axe-core（都是本地包；缺任一 exit 2，不阻塞其它门禁）。
 *
 *   npm i --no-save playwright axe-core
 *   node scripts/a11y.mjs [--base http://127.0.0.1:8787]
 */
import path from "node:path";
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

const browser = await launch();
let totalSerious = 0;
for (const url of ["/", "/课程讲义.html"]) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(BASE + url, { waitUntil: "networkidle" });
  await page.addScriptTag({ content: axeJs });
  const results = await page.evaluate(async () => {
    // @ts-ignore axe 已注入
    return await window.axe.run(document, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] },
    });
  });
  const bad = results.violations.filter((v) => v.impact === "critical" || v.impact === "serious");
  totalSerious += bad.length;
  console.log(`\n${url}：${results.violations.length} 条违规（critical/serious ${bad.length} 条）`);
  for (const v of bad.slice(0, 10)) {
    console.log(`  ✖ [${v.impact}] ${v.id} — ${v.help}（${v.nodes.length} 处，例：${v.nodes[0]?.target?.join(" ")}）`);
  }
  await page.close();
}
await browser.close();
console.log(`\n${totalSerious ? "✖" : "✔"} axe 门禁：critical/serious 共 ${totalSerious} 条`);
process.exit(totalSerious ? 1 : 0);
