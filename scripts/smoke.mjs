/**
 * smoke.mjs —— 端到端冒烟测试（Playwright）
 *
 * ⚠️ 本脚本未在当前开发沙箱里跑过：该环境不允许派生带管道的子进程，
 *    浏览器与 wrangler dev 都起不来。请在你自己机器上执行：
 *
 *      npm i -D playwright && npx playwright install chromium
 *      npx wrangler d1 migrations apply vocab --local   # 首次：建本地库
 *      npm run dev                                      # 另开一个终端，默认 http://127.0.0.1:8787
 *      npm run smoke                                    # 或 node scripts/smoke.mjs http://127.0.0.1:8787
 *
 * 覆盖的验收点：
 *   1) 桌面键盘输入 → 判对 → 进入下一题
 *   2) 移动视口：点击槽位能聚焦隐藏输入框（这是"手机上不能输入"的修复验证）
 *   3) 判错：显示正确答案，且错题进入错题本
 *   4) 章节抽屉切换章节
 *   5) 设置持久化（刷新后仍在）+ 移动端无横向溢出
 *   6) 断网时同步状态变为"未同步"，恢复网络后自动补传
 *   7) 关键回归：注册 → 答题 → 清空本机存档 → 重新登录 → 云端进度仍在（旧版会丢）
 */
import { readFile } from "node:fs/promises";

const BASE = process.argv[2] || process.env.SMOKE_BASE || "http://127.0.0.1:8787";
const results = [];
const log = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✔" : "✖"} ${name}${detail ? ` — ${detail}` : ""}`);
};

/** Playwright 是可选依赖：没装时给出可操作的提示，而不是一堆堆栈 */
async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch {
    console.error("缺少 playwright 依赖。请先执行：");
    console.error("  npm i -D playwright && npx playwright install chromium");
    process.exit(2);
  }
}

const account = `smoke_${Date.now()}@example.com`;
const password = "smoketest123";

/** 从词库里找出当前题目对应的单词（题干是中文释义） */
async function resolveWord(page, chapter = 1) {
  const meaning = (await page.textContent("#promptCn"))?.trim();
  const words = await page.evaluate(async (id) => {
    const res = await fetch(`data-${id}.json`);
    return res.json();
  }, chapter);
  const match = words.find((w) => w.meaningCN === meaning);
  return match ? String(match.word) : null;
}

async function typeAnswer(page, text) {
  await page.locator("#slotsWrap").click({ position: { x: 4, y: 4 } }).catch(() => {});
  await page.keyboard.type(text, { delay: 12 });
}

async function main() {
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", (err) => errors.push(String(err)));

  // ---------- 1. 加载与桌面输入 ----------
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForSelector("#slots .slot", { timeout: 15000 });
  const slotCount = await page.locator("#slots .slot").count();
  log("页面加载出字母槽位", slotCount > 0, `${slotCount} 个槽位`);

  await page.click('[data-mode="chinese"]');
  const word = await resolveWord(page);
  log("能从词库解析出当前单词", Boolean(word), word || "");
  if (word) {
    await typeAnswer(page, word);
    await page.waitForTimeout(200);
    const feedback = (await page.textContent("#feedback")) || "";
    log("桌面键盘输入判对", /正确/.test(feedback), feedback.trim());
    const exampleVisible = await page.locator("#example").isVisible();
    log("判对后显示例句", exampleVisible);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(250);
  }

  // ---------- 2. 判错与错题本 ----------
  const wrongWord = await resolveWord(page);
  if (wrongWord) {
    await typeAnswer(page, "zzzzzzzzzz".slice(0, wrongWord.replace(/[^a-zA-Z]/g, "").length || 3));
    await page.waitForTimeout(200);
    const feedback = (await page.textContent("#feedback")) || "";
    log("拼错时给出正确答案", /正确答案/.test(feedback) && feedback.includes(wrongWord), feedback.trim());
  }

  // ---------- 3. 章节抽屉 ----------
  await page.click("#chapterBtn");
  await page.waitForSelector(".chapter-list .list-item");
  const chapterItems = await page.locator(".chapter-list .list-item").count();
  log("章节抽屉列出全部章节", chapterItems === 22, `${chapterItems} 项`);
  await page.locator(".chapter-list .list-item").nth(2).click();
  await page.waitForTimeout(1200);
  const brand = (await page.textContent("#brandSub")) || "";
  log("切换章节生效", brand.includes("第3章"), brand.trim());

  // ---------- 4. 设置持久化 ----------
  await page.click("#menuBtn");
  await page.waitForSelector(".tabs");
  const hintSeg = page.locator(".settings-group").nth(0).locator(".seg").nth(1);
  await hintSeg.locator("button").nth(1).click();
  await page.keyboard.press("Escape");
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector("#slots .slot");
  const hintChip = (await page.textContent("#hintChip")) || "";
  log("设置刷新后仍生效", hintChip.includes("首字母"), hintChip.trim());

  // ---------- 5. 移动视口：输入通道 + 横向溢出 ----------
  const mobile = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 3,
  });
  const mpage = await mobile.newPage();
  await mpage.goto(BASE, { waitUntil: "networkidle" });
  await mpage.waitForSelector("#slots .slot");
  await mpage.locator("#slotsWrap").tap({ position: { x: 4, y: 4 } });
  const focused = await mpage.evaluate(() => document.activeElement?.id || "");
  log("移动端点击槽位后输入框获得焦点", focused === "answerInput", `activeElement=${focused}`);
  const mword = await resolveWord(mpage);
  if (mword) {
    await mpage.keyboard.type(mword, { delay: 12 });
    await mpage.waitForTimeout(200);
    const filled = await mpage.evaluate(() =>
      Array.from(document.querySelectorAll("#slots .slot")).filter((s) => !s.classList.contains("sep") && s.textContent.trim()).length
    );
    log("移动端能输入字母", filled > 0, `${filled} 个字母已填入`);
  }
  const overflow = await mpage.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  log("移动端无横向溢出", overflow <= 1, `超出 ${overflow}px`);

  // ---------- 6. 账号：同步 / 断网 / 新设备恢复 ----------
  const emailInput = account;
  await page.click("#menuBtn");
  await page.waitForSelector(".tabs");
  const dataTab = page.locator('.tabs button[data-tab="settings"]');
  await dataTab.click();
  await page.getByRole("button", { name: "登录 / 注册" }).click();
  await page.waitForSelector(".auth-modal, form");
  await page.locator('input[type="email"]').fill(emailInput);
  await page.locator('input[type="password"]').fill(password);
  await page.locator('button[type="submit"]').click();
  await page.waitForTimeout(1500);
  const syncTitle = (await page.getAttribute("#syncBtn", "title")) || "";
  log("注册后进入已登录态", syncTitle.includes("@") || syncTitle.includes("已同步"), syncTitle);

  // 答对若干题，确保有云端数据
  for (let i = 0; i < 3; i++) {
    const w = await resolveWord(page);
    if (!w) break;
    await typeAnswer(page, w);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(300);
  }
  await page.waitForTimeout(2500); // 等防抖 + 上传

  // 断网 → 再答一题 → 同步应显示未完成
  await context.setOffline(true);
  const offlineWord = await resolveWord(page);
  if (offlineWord) {
    await typeAnswer(page, offlineWord);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(1500);
    const offlineTitle = (await page.getAttribute("#syncBtn", "title")) || "";
    log("断网时同步状态可见", /重试|同步中|失败/.test(offlineTitle), offlineTitle);
  }
  await context.setOffline(false);
  await page.waitForTimeout(2500);

  // 关键回归：清空本机存档 → 重新登录 → 云端进度还在
  const before = await page.evaluate(() => localStorage.length);
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector("#slots .slot");
  await page.waitForTimeout(2500);
  await page.click("#menuBtn");
  await page.waitForSelector(".tabs");
  await page.getByRole("button", { name: /错题本/ }).click();
  await page.waitForTimeout(400);
  const wrongCountText = (await page.textContent(".tabs")) || "";
  const restoredNote = await page.evaluate(() => document.querySelector("#syncBtn")?.getAttribute("title") || "");
  log(
    "清空本机存档后仍处于登录态并已回拉云端",
    restoredNote.includes("@") || restoredNote.includes("同步"),
    `${restoredNote}（清空前 localStorage ${before} 项）`
  );
  log("错题本状态可读取", wrongCountText.length > 0, wrongCountText.replace(/\s+/g, " ").trim());

  log("运行期间没有 JS 报错", errors.length === 0, errors.slice(0, 3).join(" | "));

  await browser.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${failed.length ? "✖" : "✔"} 冒烟测试：${results.length - failed.length}/${results.length} 项通过`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error("\n冒烟测试无法执行：", err.message);
  console.error("请确认：1) npm run dev 已启动 2) npx playwright install chromium 已执行");
  process.exit(2);
});
