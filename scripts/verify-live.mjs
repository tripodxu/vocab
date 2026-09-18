/**
 * verify-live.mjs —— 线上部署核验（每次 GitHub 自动部署完成后跑一次）
 *
 *   node scripts/verify-live.mjs [baseUrl] [--shot]
 *   默认 baseUrl = https://vocab.logicc.top
 *
 * 检查：静态资源可达、状态卡片确实是隐藏的（不再出现"词库加载失败"常驻）、
 *      提示字母控件可用、22 章词库都能取到、章节切换正常、认词模式能出题并给出辨析、
 *      题源清单可解析、接口按预期 401。
 * 需要本机装有 playwright（npm i --no-save playwright），默认复用系统 Chrome/Edge。
 */
import { mkdir } from "node:fs/promises";

const args = process.argv.slice(2);
const BASE = args.find((a) => !a.startsWith("--")) || "https://vocab.logicc.top";
const wantShot = args.includes("--shot");

let pass = 0;
let fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? "✔" : "✖"} ${name}${detail ? ` — ${detail}` : ""}`);
};

const { chromium } = await import("playwright").catch(() => {
  console.error("缺少 playwright：npm i --no-save playwright");
  process.exit(2);
});

async function launch() {
  for (const opts of [{ channel: "chrome" }, { channel: "msedge" }, {}]) {
    try {
      return await chromium.launch(opts);
    } catch {}
  }
  throw new Error("无法启动浏览器");
}

console.log(`\n核验目标：${BASE}\n`);
const browser = await launch();

/* ---------- 1. 静态资源 ---------- */
console.log("1) 静态资源与接口");
for (const [path, expectType] of [
  ["/", "text/html"],
  ["/app.js", "javascript"],
  ["/quiz.js", "javascript"],
  ["/chapters.js", "javascript"],
  ["/tokens.css", "text/css"],
  ["/data-1.json", "application/json"],
  ["/quiz-index.json", "application/json"],
]) {
  const res = await fetch(BASE + path);
  const type = res.headers.get("content-type") || "";
  check(`${path} 可达且类型正确`, res.status === 200 && type.includes(expectType), `${res.status} ${type}`);
}
const index = await fetch(BASE + "/quiz-index.json").then((r) => r.json()).catch(() => null);
check("题源清单可解析", Array.isArray(index?.chapters), index ? `已精编 ${index.chapters.length} 章` : "解析失败");
const unauth = await fetch(`${BASE}/api/vocab/words`);
check("未登录访问受保护接口返回 401", unauth.status === 401, String(unauth.status));
const csp = (await fetch(BASE + "/")).headers.get("content-security-policy") || "";
check("首页带 CSP", csp.includes("script-src 'self'"), csp.slice(0, 60));

/* ---------- 2. 22 章词库 ---------- */
console.log("\n2) 词库文件");
const bad = [];
for (let i = 1; i <= 22; i++) {
  const res = await fetch(`${BASE}/data-${i}.json`);
  let items = 0;
  try {
    items = (await res.json()).length;
  } catch {
    items = -1;
  }
  if (res.status !== 200 || items <= 0) bad.push(`${i}:${res.status}/${items}`);
}
check("22 章词库全部可获取", bad.length === 0, bad.length ? bad.join(" ") : "22/22");

/* ---------- 3. 真实浏览器：首屏没有幻影卡片 + 提示字母 ---------- */
console.log("\n3) 浏览器实际渲染");
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e).slice(0, 160)));
await page.goto(BASE, { waitUntil: "networkidle" });
await page.waitForSelector("#slots .slot", { timeout: 30000 });

const state = await page.evaluate(() => {
  const big = (sel) => Math.round(document.querySelector(sel)?.getBoundingClientRect().height || 0);
  return {
    slots: document.querySelectorAll("#slots .slot").length,
    loadingCard: big("#loadingCard"),
    loadErrorCard: big("#loadErrorCard"),
    timerChip: big("#timerChip"),
    reviewBanner: big("#reviewBanner"),
    hintVisible: big("#hintSelect") > 0,
    hintOptions: Array.from(document.querySelectorAll("#hintSelect option")).map((o) => o.textContent),
    brand: document.querySelector("#brandSub")?.textContent,
  };
});
check("字母槽位正常渲染", state.slots > 0, `${state.slots} 格`);
check("「正在加载词库…」不再常驻显示", state.loadingCard === 0, `${state.loadingCard}px`);
check("「词库加载失败」不再常驻显示", state.loadErrorCard === 0, `${state.loadErrorCard}px`);
check("计时/复习横幅没有被误显示", state.timerChip === 0 && state.reviewBanner === 0);
check("主界面有提示字母控件", state.hintVisible && state.hintOptions.length === 4, state.hintOptions.join("/"));

// 提示字母真的生效
await page.click('#modeSeg button[data-value="chinese"]');
await page.waitForTimeout(200);
await page.selectOption("#hintSelect", "1");
await page.waitForTimeout(300);
check("选择「首字母」后当前词出现提示字母", (await page.locator("#slots .slot.hint").count()) > 0);
await page.selectOption("#hintSelect", "0");
await page.waitForTimeout(200);
check("可切回「无提示」", (await page.locator("#slots .slot.hint").count()) === 0);

// 章节切换
await page.click("#chapterBtn");
await page.waitForSelector(".chapter-list .list-item", { timeout: 8000 });
check("章节抽屉列出 22 章", (await page.locator(".chapter-list .list-item").count()) === 22);
await page.locator(".chapter-list .list-item").nth(20).click();
await page.waitForTimeout(2500);
const ch21 = await page.evaluate(() => ({
  brand: document.querySelector("#brandSub")?.textContent || "",
  slots: document.querySelectorAll("#slots .slot").length,
}));
check("切换到第 21 章（最大词库 417 词）", ch21.brand.includes("第21章") && ch21.slots > 0, `${ch21.brand} slots=${ch21.slots}`);

/* ---------- 4. 认词模式（看英文选中文） ---------- */
console.log("\n4) 认词模式");
await page.click('[data-practice="choice"]');
await page.waitForSelector("#choiceArea:not([hidden])", { timeout: 8000 });
await page.waitForTimeout(700);
const quiz = await page.evaluate(async () => {
  const word = document.querySelector("#promptWordEn")?.textContent || "";
  const chapter = Number((document.querySelector("#brandSub")?.textContent || "").match(/\d+/)?.[0] || 1);
  const list = await (await fetch(`data-${chapter}.json`)).json();
  const entry = list.find((w) => w.word === word) || {};
  return {
    word,
    meaning: entry.meaningCN || "",
    options: Array.from(document.querySelectorAll("#options .option .text")).map((n) => n.textContent),
    spellHidden: document.querySelector("#spellArea")?.hidden === true,
    hintHidden: document.querySelector("#hintPick")?.hidden === true,
  };
});
check("认词模式给出英文题干", quiz.word.length > 0, quiz.word);
check("认词模式给出 4 个不重复的中文选项", quiz.options.length === 4 && new Set(quiz.options).size === 4, quiz.options.join(" / "));
check("认词模式隐藏拼写区与提示字母", quiz.spellHidden && quiz.hintHidden);

if (quiz.meaning && quiz.options.includes(quiz.meaning)) {
  const at = quiz.options.indexOf(quiz.meaning);
  await page.locator("#options .option").nth(at).click();
  await page.waitForTimeout(500);
  const answered = await page.evaluate(() => ({
    feedback: document.querySelector("#feedback")?.textContent || "",
    ok: document.querySelectorAll("#options .option.ok").length,
    note: document.querySelector("#quizNote")?.hidden === false,
  }));
  check("点对选项能判对", /正确/.test(answered.feedback) && answered.ok === 1, answered.feedback.trim());
  check("答完展示辨析卡片", answered.note);
  // 换一题点错，检查辨析逐条列出
  await page.keyboard.press("Enter");
  await page.waitForTimeout(700);
  const second = await page.evaluate(async () => {
    const word = document.querySelector("#promptWordEn")?.textContent || "";
    const chapter = Number((document.querySelector("#brandSub")?.textContent || "").match(/\d+/)?.[0] || 1);
    const list = await (await fetch(`data-${chapter}.json`)).json();
    return { meaning: (list.find((w) => w.word === word) || {}).meaningCN || "" };
  });
  const wrongAt = await page.evaluate(
    (meaning) => Array.from(document.querySelectorAll("#options .option .text")).findIndex((n) => n.textContent !== meaning),
    second.meaning
  );
  if (wrongAt >= 0) {
    await page.locator("#options .option").nth(wrongAt).click();
    await page.waitForTimeout(500);
    const wrongState = await page.evaluate(() => ({
      feedback: document.querySelector("#feedback")?.textContent || "",
      bad: document.querySelectorAll("#options .option.bad").length,
      items: Array.from(document.querySelectorAll("#quizNoteList li")).map((n) => n.textContent.trim()),
      foot: document.querySelector("#quizNoteFoot")?.textContent || "",
    }));
    check("选错能判错并标红", /选错/.test(wrongState.feedback) && wrongState.bad === 1, wrongState.feedback.trim());
    check("辨析逐条说明干扰项差在哪", wrongState.items.length === 3 && wrongState.items.every((t) => t.includes("——")));
    check("辨析标注干扰项来源", /干扰项来源/.test(wrongState.foot), wrongState.foot.trim());
  } else {
    check("选错能判错并标红", false, "找不到错误选项");
  }
  // 切回拼写，避免影响后续
  await page.click('[data-practice="spell"]');
  await page.waitForSelector("#slots .slot", { timeout: 8000 });
} else {
  check("点对选项能判对", false, `题干预释义对不上：${quiz.word} / ${quiz.meaning}`);
}
check("运行期无 JS 报错", errors.length === 0, errors.slice(0, 2).join(" | "));

if (wantShot) {
  await mkdir("shots", { recursive: true });
  await page.screenshot({ path: "shots/live-desktop.png" });
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const mp = await mobile.newPage();
  await mp.goto(BASE, { waitUntil: "networkidle" });
  await mp.waitForSelector("#slots .slot");
  await mp.waitForTimeout(600);
  await mp.screenshot({ path: "shots/live-mobile.png" });
  console.log("\n已截图 shots/live-desktop.png 与 shots/live-mobile.png");
  await mobile.close();
}

await browser.close();
console.log(`\n${fail ? "✖" : "✔"} 线上核验：${pass}/${pass + fail} 项通过`);
process.exit(fail ? 1 : 0);
