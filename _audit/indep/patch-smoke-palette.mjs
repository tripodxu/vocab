// 一次性补丁：向 scripts/smoke.mjs 插入调色盘冒烟区块（用后即删）
import { readFileSync, writeFileSync } from "node:fs";

const file = "scripts/smoke.mjs";
let s = readFileSync(file, "utf8");
const nl = s.includes("\r\n") ? "\r\n" : "\n";
const j = (a) => a.join(nl);

const anchor = "  // 换回拼写模式：后面的用例都依赖拼写通道";
if (!s.includes(anchor)) {
  console.error("anchor missing");
  process.exit(1);
}

const block = j([
  "  /* ---------- 5.6 主题调色盘 ---------- */",
  "  console.log(\"\\n5.6) 主题调色盘\");",
  "  await openMenu(page, \"settings\");",
  "  await page.waitForSelector(\".swatches\", { timeout: 8000 });",
  "  check(\"设置面板出现色卡网格（6 预设 + 自定义）\", (await page.locator(\".swatch\").count()) === 7);",
  "  await page.click('.swatch[data-palette=\"emerald\"]');",
  "  await page.waitForTimeout(300);",
  "  check(\"点翡翠色卡立即生效（data-accent=emerald）\", (await page.evaluate(() => document.documentElement.dataset.accent)) === \"emerald\");",
  "  await page.keyboard.press(\"Escape\");",
  "  await page.waitForTimeout(400);",
  "  await page.waitForTimeout(1400); // 等设置防抖落盘",
  "  await page.reload({ waitUntil: \"networkidle\" });",
  "  await page.waitForTimeout(800);",
  "  check(\"刷新后调色盘选择保持\", (await page.evaluate(() => document.documentElement.dataset.accent)) === \"emerald\");",
  "",
  "  // 自定义取色",
  "  await openMenu(page, \"settings\");",
  "  await page.waitForSelector(\".swatches\", { timeout: 8000 });",
  "  await page.evaluate(() => {",
  "    const input = document.querySelector(\".swatch-custom input[type=color]\");",
  "    input.value = \"#e11d48\";",
  "    input.dispatchEvent(new Event(\"input\", { bubbles: true }));",
  "  });",
  "  await page.waitForTimeout(400);",
  "  const customApplied = await page.evaluate(() => ({",
  "    accent: document.documentElement.dataset.accent,",
  "    inline: document.documentElement.style.getPropertyValue(\"--accent\").trim(),",
  "  }));",
  "  check(\"自定义取色生效（data-accent=custom + 内联变量）\", customApplied.accent === \"custom\" && customApplied.inline === \"#e11d48\", JSON.stringify(customApplied));",
  "  await page.keyboard.press(\"Escape\");",
  "  await page.waitForTimeout(400);",
  "",
  "  // 讲义页跟随（镜像通道）",
  "  await page.goto(BASE + \"/课程讲义.html\", { waitUntil: \"networkidle\" });",
  "  await page.waitForTimeout(800);",
  "  check(\"讲义页跟随调色盘选择（镜像通道）\", (await page.evaluate(() => document.documentElement.dataset.accent)) === \"custom\");",
  "",
  "  // 收尾：切回天蓝默认盘，并回到刷词页",
  "  await page.goto(BASE, { waitUntil: \"networkidle\" });",
  "  await page.waitForTimeout(600);",
  "  await openMenu(page, \"settings\");",
  "  await page.waitForSelector(\".swatches\", { timeout: 8000 });",
  "  await page.click('.swatch[data-palette=\"sky\"]');",
  "  await page.waitForTimeout(300);",
  "  check(\"切回天蓝（默认盘）\", (await page.evaluate(() => document.documentElement.dataset.accent)) === \"sky\");",
  "  await page.keyboard.press(\"Escape\");",
  "  await page.waitForTimeout(300);",
  "",
]);

s = s.replace(anchor, block + anchor);
writeFileSync(file, s);
console.log("smoke palette section inserted");
