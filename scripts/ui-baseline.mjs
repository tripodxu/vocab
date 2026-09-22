/**
 * ui-baseline.mjs —— 视觉回归基线截图（P4 可靠性工具）
 *
 * 把两页在多种视口/主题下的渲染截图存进 shots/baseline/（或 --current 存进
 * shots/current/），配合任意像素比对工具（如 pixelmatch）即可做视觉回归。
 * 本沙箱/CI 无浏览器时 exit 2，不影响其它门禁。
 *
 * 用法：
 *   node scripts/ui-baseline.mjs                # 写基线（shots/baseline/）
 *   node scripts/ui-baseline.mjs --current      # 写当前帧（shots/current/）
 *   node scripts/ui-baseline.mjs --base http://127.0.0.1:8787   # 指定 dev 服务
 *
 * 场景矩阵：{刷词页, 讲义页} × {390×844 移动, 1280×800 桌面} × {浅色, 深色}
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";

const args = process.argv.slice(2);
const BASE = args.find((a) => a.startsWith("http")) || "http://127.0.0.1:8787";
const mode = args.includes("--current") ? "current" : "baseline";
const outDir = path.join("shots", mode);

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

await mkdir(outDir, { recursive: true });

let n = 0;
try {
  const browser = await launch();
  const cases = [
    { name: "practice-mobile-light", url: "/", width: 390, height: 844, theme: "light" },
    { name: "practice-mobile-dark", url: "/", width: 390, height: 844, theme: "dark" },
    { name: "practice-desktop-light", url: "/", width: 1280, height: 800, theme: "light" },
    { name: "lecture-mobile-light", url: "/课程讲义.html", width: 390, height: 844, theme: "light" },
    { name: "lecture-desktop-dark", url: "/课程讲义.html", width: 1280, height: 800, theme: "dark" },
  ];

  for (const c of cases) {
    const ctx = await browser.newContext({
      viewport: { width: c.width, height: c.height },
      colorScheme: c.theme,
      deviceScaleFactor: 2,
    });
    const page = await ctx.newPage();
    await page.goto(BASE + c.url, { waitUntil: "networkidle" });
    await page.waitForTimeout(500); // 等首屏动画结束再截
    await page.screenshot({ path: path.join(outDir, `${c.name}.png`) });
    console.log(`✔ ${outDir}/${c.name}.png`);
    n++;
    await ctx.close();
  }
  await browser.close();
} catch (err) {
  console.error("截图失败（需要本地 dev 服务与 Chrome/Edge）：", err instanceof Error ? err.message : err);
  process.exit(1);
}
console.log(`\n${mode === "baseline" ? "基线" : "当前帧"}已写入 ${outDir}/（${n} 张）`);
