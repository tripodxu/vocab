/**
 * smoke.mjs —— 浏览器端到端冒烟测试
 *
 * 前置（本机执行）：
 *   npm i --no-save playwright        # 或 npm i -D playwright
 *   npm run db:migrate:local
 *   npm run dev                       # 另开终端，默认 http://127.0.0.1:8787
 *   npm run smoke                     # 或 node scripts/smoke.mjs [baseUrl]
 *
 * 默认复用系统已装的 Chrome / Edge（不下载 Chromium）；SMOKE_CHANNEL=msedge|chrome 可指定。
 *
 * 覆盖：桌面输入判分、判错反馈、章节抽屉、设置持久化、移动视口输入通道与布局、
 *       断网时的同步状态、以及"清空本机存档 → 重新登录 → 云端进度仍在"这条关键回归。
 */
const BASE = process.argv[2] || process.env.SMOKE_BASE || "http://127.0.0.1:8787";
const email = `smoke_${Date.now()}@example.com`;
const password = "smokepass123";

let pass = 0;
let fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? "✔" : "✖"} ${name}${detail ? ` — ${detail}` : ""}`);
};

async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch {
    console.error("缺少 playwright：npm i --no-save playwright（或 npm i -D playwright）");
    process.exit(2);
  }
}

async function launch(chromium) {
  const candidates = [
    process.env.SMOKE_CHANNEL ? { channel: process.env.SMOKE_CHANNEL } : null,
    { channel: "chrome" },
    { channel: "msedge" },
    {},
  ].filter(Boolean);
  let lastError;
  for (const options of candidates) {
    try {
      return await chromium.launch(options);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

const stripLetters = (word) => String(word).replace(/[^a-zA-Z]/g, "");

/** 保证当前是"看中文"模式（否则题干为空） */
async function ensureChinese(page) {
  if (!(await page.locator("#promptCn").isVisible())) {
    await page.click('#modeSeg button[data-value="chinese"]');
    await page.waitForTimeout(150);
  }
}

/** 解析当前题目对应的单词：中文释义 + 字母位数双重匹配 */
async function resolveWord(page, chapter) {
  await ensureChinese(page);
  const meaning = ((await page.textContent("#promptCn")) || "").trim();
  if (!meaning) return null;
  const id = chapter || (await page.evaluate(() => Number(localStorage.getItem("vocab:e2e-chapter") || 1)));
  const letters = await page.locator("#slots .slot:not(.sep)").count();
  const words = await page.evaluate(async (cid) => (await fetch(`data-${cid}.json`)).json(), id);
  const candidates = words.filter((w) => w.meaningCN === meaning);
  return (candidates.find((w) => stripLetters(w.word).length === letters) || candidates[0])?.word || null;
}

async function typeAnswer(page, text) {
  await page.locator("#slotsWrap").click({ position: { x: 5, y: 5 } });
  await page.keyboard.type(text, { delay: 10 });
}

/** 如果当前词已经作答（槽位是绿/红），先回车进入下一题，保证后面是在新词上操作 */
async function ensureFreshWord(page) {
  const answered = (await page.locator("#slots .slot.ok, #slots .slot.bad").count()) > 0;
  if (answered) {
    await page.keyboard.press("Enter");
    await page.waitForTimeout(450);
  }
}

/**
 * 回答当前题。注意应用是"回车提交 → 再回车下一题"两段式，
 * 所以需要继续下一题时要显式再按一次回车，否则会一直停在已答过的词上。
 * @param {"correct" | "wrong"} kind
 * @param {boolean} advance 是否顺带进入下一题
 */
async function answerCurrent(page, kind = "correct", advance = false) {
  await ensureFreshWord(page);
  const word = await resolveWord(page);
  if (!word) return null;
  await typeAnswer(page, kind === "correct" ? word : "z".repeat(stripLetters(word).length));
  await page.keyboard.press("Enter");
  await page.waitForTimeout(450);
  if (advance) {
    await page.keyboard.press("Enter");
    await page.waitForTimeout(450);
  }
  return word;
}

async function openMenu(page, tab) {
  await page.click("#menuBtn");
  await page.waitForSelector(".tabs");
  if (tab) await page.locator(`.tabs button[data-tab="${tab}"]`).click();
}

/** 打开账号弹层并切到指定页签 */
async function openAuth(page, which) {
  await openMenu(page, "settings");
  await page.getByRole("button", { name: "登录 / 注册" }).click();
  await page.waitForSelector(".scrim form");
  if (which === "register") {
    await page.getByRole("button", { name: "注册", exact: true }).click();
    await page.waitForTimeout(120);
  }
}

async function submitAuth(page, mail, pw) {
  await page.locator('.scrim form input[type="email"]').fill(mail);
  await page.locator('.scrim form input[type="password"]').fill(pw);
  await page.locator('.scrim form button[type="submit"]').click();
}

async function main() {
  const { chromium } = await loadPlaywright();
  const browser = await launch(chromium);
  console.log(`\n目标：${BASE}\n`);

  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  page.on("pageerror", (e) => consoleErrors.push(String(e)));

  /* ---------- 1. 桌面输入与判分 ---------- */
  console.log("1) 桌面端输入与判分");
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForSelector("#slots .slot", { timeout: 20000 });
  check("页面渲染出字母槽位", (await page.locator("#slots .slot").count()) > 0);
  // 回归：曾经因为 .stack{display:flex} 覆盖 [hidden]，导致"词库加载失败/正在加载"一直显示在页面上
  check(
    "首屏没有露出「加载中 / 加载失败」卡片",
    (await page.locator("#loadingCard").isHidden()) && (await page.locator("#loadErrorCard").isHidden())
  );
  await ensureChinese(page);

  const word = await resolveWord(page);
  check("能从词库解析出当前单词", Boolean(word), word || "题干为空");
  if (word) {
    const letters = stripLetters(word).length;
    const metaBefore = await page.textContent("#sessionMeta");
    await typeAnswer(page, word);
    await page.waitForTimeout(150);
    check("字母逐个填入槽位", (await page.locator("#slots .slot.filled").count()) === letters, `${letters} 个`);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(400);
    check("提交后判对", /正确/.test((await page.textContent("#feedback")) || ""), ((await page.textContent("#feedback")) || "").trim());
    check("判对后展示例句", await page.locator("#example").isVisible());
    check("正确字母槽位标绿", (await page.locator("#slots .slot.ok").count()) === letters);
    check("进度推进", (await page.textContent("#sessionMeta")) !== metaBefore, `${metaBefore} → ${await page.textContent("#sessionMeta")}`);
    await page.keyboard.press("Enter"); // 下一题
    await page.waitForTimeout(300);
    check("回车进入下一题（反馈已清空）", ((await page.textContent("#feedback")) || "").trim() === "");
  }

  /* ---------- 2. 判错 ---------- */
  console.log("\n2) 判错与反馈");
  const wrongTarget = await resolveWord(page);
  if (wrongTarget) {
    const letters = stripLetters(wrongTarget).length;
    await typeAnswer(page, "z".repeat(letters));
    await page.keyboard.press("Enter");
    await page.waitForTimeout(400);
    const feedback = (await page.textContent("#feedback")) || "";
    check("判错并给出正确答案", feedback.includes("正确答案") && feedback.includes(wrongTarget), feedback.trim());
    check("错词槽位标红", (await page.locator("#slots .slot.bad").count()) > 0);
  }

  /* ---------- 3. 章节抽屉 ---------- */
  console.log("\n3) 章节抽屉");
  await page.click("#chapterBtn");
  await page.waitForSelector(".chapter-list .list-item");
  const items = await page.locator(".chapter-list .list-item").count();
  check("列出全部 22 章", items === 22, `${items} 项`);
  const firstItemText = ((await page.locator(".chapter-list .list-item").first().textContent()) || "").replace(/\s+/g, " ");
  check("章节条目带掌握进度", /掌握\s*\d+\/\d+/.test(firstItemText), firstItemText.trim().slice(0, 50));
  await page.locator(".chapter-list .list-item").nth(2).click();
  await page.waitForTimeout(1500);
  check("切换章节生效", ((await page.textContent("#brandSub")) || "").includes("第3章"), ((await page.textContent("#brandSub")) || "").trim());
  await page.evaluate(() => localStorage.setItem("vocab:e2e-chapter", "3"));

  /* ---------- 4. 设置持久化 + 主界面提示控件 ---------- */
  console.log("\n4) 设置持久化与提示字母");
  check("主界面有常驻的提示字母控件", await page.locator("#hintSelect").isVisible());
  await openMenu(page, "settings");
  await page.getByRole("button", { name: "首字母" }).click();
  await page.keyboard.press("Escape");
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector("#slots .slot");
  check("提示档位刷新后仍生效（设置里的修改）", (await page.inputValue("#hintSelect")) === "1", await page.inputValue("#hintSelect"));
  check("提示控件高亮", (await page.locator("#hintPick.on").count()) === 1);
  check("刷新后恢复上次章节", ((await page.textContent("#brandSub")) || "").includes("第3章"));

  // 主界面直接改提示：应当立即对当前词生效（旧版就是这个下拉）
  const beforeHintSlots = await page.locator("#slots .slot.hint").count();
  await page.selectOption("#hintSelect", "2");
  await page.waitForTimeout(300);
  const afterHintSlots = await page.locator("#slots .slot.hint").count();
  check("主界面改提示后当前词立即出现提示字母", afterHintSlots > 0, `${beforeHintSlots} → ${afterHintSlots}`);
  await page.selectOption("#hintSelect", "0");
  await page.waitForTimeout(200);
  check("提示可以关掉", (await page.locator("#slots .slot.hint").count()) === 0);

  /* ---------- 5. 认词模式（看英文选中文） ---------- */
  console.log("\n5) 认词模式：看英文选中文");
  /** 认词模式下当前英文题干对应的释义（从词库反查，用于判断"应该点哪个"） */
  const currentMeaning = async () =>
    page.evaluate(async () => {
      const word = document.querySelector("#promptWordEn")?.textContent || "";
      const id = Number(localStorage.getItem("vocab:e2e-chapter") || 3);
      const list = await (await fetch(`data-${id}.json`)).json();
      return (list.find((entry) => entry.word === word) || {}).meaningCN || "";
    });
  const optionTexts = () =>
    page.evaluate(() => Array.from(document.querySelectorAll("#options .option .text")).map((n) => n.textContent));
  const clickOption = async (text) => {
    const index = await page.evaluate(
      (value) =>
        Array.from(document.querySelectorAll("#options .option")).findIndex(
          (n) => n.querySelector(".text")?.textContent === value
        ),
      text
    );
    if (index < 0) throw new Error(`找不到选项：${text}`);
    await page.locator("#options .option").nth(index).click();
    await page.waitForTimeout(400);
    return index;
  };

  await page.click('[data-practice="choice"]');
  await page.waitForSelector("#choiceArea:not([hidden])", { timeout: 8000 });
  await page.waitForTimeout(700);
  const choiceUi = await page.evaluate(() => ({
    word: document.querySelector("#promptWordEn")?.textContent || "",
    phonetic: document.querySelector("#promptPhonetic")?.textContent || "",
    spellHidden: document.querySelector("#spellArea")?.hidden === true,
    hintHidden: document.querySelector("#hintPick")?.hidden === true,
    options: document.querySelectorAll("#options .option").length,
    primaryDisabled: document.querySelector("#primaryBtn")?.disabled === true,
  }));
  check("切到认词后题干是英文单词", choiceUi.word.length > 0, `${choiceUi.word} ${choiceUi.phonetic}`);
  check("拼写区与提示字母被隐藏（认词不涉及打字）", choiceUi.spellHidden && choiceUi.hintHidden);
  check("未作答时主按钮不可点（点选项即作答）", choiceUi.primaryDisabled);

  const firstOptions = await optionTexts();
  check("给出 4 个中文选项", firstOptions.length === 4, firstOptions.join(" / "));
  check("选项之间不重复", new Set(firstOptions).size === 4);

  // 点对：判对 + 约 1.1 秒后自动进入下一题
  const firstMeaning = await currentMeaning();
  check("能反查出当前词的释义（用于验证判分）", Boolean(firstMeaning), firstMeaning);
  await clickOption(firstMeaning);
  const afterCorrect = await page.evaluate(() => ({
    feedback: document.querySelector("#feedback")?.textContent || "",
    ok: document.querySelectorAll("#options .option.ok").length,
    bad: document.querySelectorAll("#options .option.bad").length,
    note: document.querySelector("#quizNote")?.hidden === false,
    locked: Array.from(document.querySelectorAll("#options .option")).every((n) => n.disabled),
  }));
  check(
    "选对判对并标绿",
    /正确/.test(afterCorrect.feedback) && afterCorrect.ok === 1 && afterCorrect.bad === 0,
    afterCorrect.feedback.trim()
  );
  check("答完锁定选项（不能反复改）", afterCorrect.locked);
  check("答完展示辨析卡片", afterCorrect.note);
  const wordBeforeAuto = choiceUi.word;
  await page.waitForTimeout(1500);
  const autoNext = await page.evaluate(() => ({
    word: document.querySelector("#promptWordEn")?.textContent || "",
    answers: document.querySelectorAll("#options .option.ok, #options .option.bad").length,
  }));
  check(
    "答对后自动进入下一题（可在设置里关掉）",
    autoNext.answers === 0 && autoNext.word !== wordBeforeAuto,
    `${wordBeforeAuto} → ${autoNext.word}`
  );
  if (autoNext.answers > 0) {
    // 自动跳题没生效时不要把后面的用例一起拖垮：手动进下一题
    await page.keyboard.press("Enter");
    await page.waitForTimeout(700);
  }

  // 点错：判错、标红、逐条列出辨析
  const wrongMeaning = await currentMeaning();
  const wrongPick = (await optionTexts()).find((text) => text !== wrongMeaning);
  await clickOption(wrongPick);
  const afterWrong = await page.evaluate(() => ({
    feedback: document.querySelector("#feedback")?.textContent || "",
    ok: document.querySelectorAll("#options .option.ok").length,
    bad: document.querySelectorAll("#options .option.bad").length,
    noteHead: document.querySelector("#quizNoteHead")?.textContent || "",
    noteItems: Array.from(document.querySelectorAll("#quizNoteList li")).map((n) => n.textContent.trim()),
    noteFoot: document.querySelector("#quizNoteFoot")?.textContent || "",
  }));
  check(
    "选错判错、正确项标绿、所选项标红",
    /选错|时间到/.test(afterWrong.feedback) && afterWrong.ok === 1 && afterWrong.bad === 1,
    afterWrong.feedback.trim()
  );
  check("反馈里给出正确释义", afterWrong.feedback.includes(wrongMeaning), afterWrong.feedback.trim());
  check(
    "辨析卡片逐条说明干扰项差在哪",
    afterWrong.noteItems.length === 3 && afterWrong.noteItems.every((t) => t.includes("——")),
    afterWrong.noteHead.slice(0, 40)
  );
  check("辨析卡片说明干扰项来源", /干扰项来源/.test(afterWrong.noteFoot), afterWrong.noteFoot.trim());
  check("答错不自动跳题（留着看辨析）", ((await page.textContent("#choiceHint")) || "").includes("Enter"));

  // 键盘作答
  await page.keyboard.press("Enter");
  await page.waitForTimeout(600);
  const kbMeaning = await currentMeaning();
  await page.keyboard.press("1");
  await page.waitForTimeout(400);
  const kbPick = (await optionTexts())[0];
  const kbState = await page.evaluate(() => ({
    marks: document.querySelectorAll("#options .option.ok, #options .option.bad").length,
    picked: document.querySelectorAll('#options .option[aria-checked="true"]').length,
    correct: document.querySelectorAll("#options .option.ok").length,
  }));
  check(
    "键盘 1 可以选择第一个选项",
    kbState.marks >= 1 && kbState.picked === 1 && kbState.correct === 1,
    `标记 ${kbState.marks} 个 · 第 1 项：${kbPick}`
  );
  if (kbPick !== kbMeaning) await page.keyboard.press("Enter");
  await page.waitForTimeout(700);

  /* ---------- 5.5 反向认词（看中文选英文） ---------- */
  console.log("\n5.5) 反向认词：看中文选英文");
  // 先拿到一道未作答的新题，再把题面切到「看中文」
  await page.keyboard.press("Enter");
  await page.waitForTimeout(600);
  await page.click('#modeSeg button[data-value="zh"]');
  await page.waitForTimeout(700);
  const revUi = await page.evaluate(() => ({
    promptCnShown: document.querySelector("#promptCn")?.hidden === false,
    promptCnText: document.querySelector("#promptCn")?.textContent || "",
    wordHidden: document.querySelector("#promptWord")?.hidden === true,
    options: Array.from(document.querySelectorAll("#options .option .text")).map((n) => n.textContent),
    primary: document.querySelector("#primaryBtn")?.textContent || "",
    segPressed: document.querySelector('#modeSeg button[data-value="zh"]')?.getAttribute("aria-pressed"),
  }));
  check("出题方式段出现「看中文」档且可选中", revUi.segPressed === "true");
  check("切到看中文后题干显示中文释义", revUi.promptCnShown && revUi.promptCnText.length > 0, revUi.promptCnText);
  check("作答前英文词被隐藏（防泄底）", revUi.wordHidden);
  const revLatin = /^[A-Za-z][A-Za-z' -]*$/;
  check("4 个选项全是英文单词", revUi.options.length === 4 && revUi.options.every((t) => revLatin.test(t)), revUi.options.join(" / "));
  check("选项之间不重复", new Set(revUi.options).size === 4);
  check("主按钮文案随方向变化（请选出对应的单词）", revUi.primary.includes("单词"), revUi.primary.trim());

  // 泄底防护：作答前点「再读」不朗读，只给提示
  await page.click("#repeatBtn");
  await page.waitForTimeout(400);
  const leakToast = await page.evaluate(() => [...document.querySelectorAll(".toast")].some((n) => n.textContent.includes("泄底")));
  check("作答前点「再读」出现防泄底提示（不朗读答案）", leakToast);

  /** 反向：从词库反查当前中文题面对应的答案词 */
  const revAnswerWord = () =>
    page.evaluate(async () => {
      const meaning = document.querySelector("#promptCn")?.textContent || "";
      const chapter = Number(localStorage.getItem("vocab:e2e-chapter") || 3);
      const list = await (await fetch(`data-${chapter}.json`)).json();
      return (list.find((entry) => entry.meaningCN === meaning) || {}).word || "";
    });

  const revWord = await revAnswerWord();
  check("能从中文题干反查答案词（用于验证判分）", Boolean(revWord), revWord);
  if (revWord && revUi.options.includes(revWord)) {
    await clickOption(revWord);
    const revCorrect = await page.evaluate(() => ({
      ok: document.querySelectorAll("#options .option.ok").length,
      feedback: document.querySelector("#feedback")?.textContent || "",
      revealed: document.querySelector("#promptWord")?.hidden === false,
      revealedWord: document.querySelector("#promptWordEn")?.textContent || "",
    }));
    check("反向：选对英文词判对并标绿", revCorrect.ok === 1, revCorrect.feedback.trim());
    check("反向答对后揭示英文词与音标", revCorrect.revealed && revCorrect.revealedWord === revWord, revCorrect.revealedWord);
    await page.waitForTimeout(1400); // 等自动跳题（可在设置里关）
    const stillAnswered = await page.evaluate(() => document.querySelectorAll("#options .option.ok, #options .option.bad").length);
    if (stillAnswered > 0) {
      await page.keyboard.press("Enter");
      await page.waitForTimeout(700);
    }
  } else {
    check("反向：选对英文词判对并标绿", false, "反查答案词不在选项里");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(600);
  }

  // 反向答错：判错 + 方向感知文案 + 辨析逐条
  const revWrongWord = await revAnswerWord();
  const revWrongPick = (await optionTexts()).find((t) => t !== revWrongWord);
  if (revWrongPick) {
    await clickOption(revWrongPick);
    const revWrongState = await page.evaluate(() => ({
      bad: document.querySelectorAll("#options .option.bad").length,
      feedback: document.querySelector("#feedback")?.textContent || "",
      items: Array.from(document.querySelectorAll("#quizNoteList li")).length,
      foot: document.querySelector("#quizNoteFoot")?.textContent || "",
    }));
    check("反向：选错判错并标红", revWrongState.bad === 1);
    check("反向答错文案是「正确答案」+ 英文词（方向感知）", revWrongState.feedback.includes("正确答案 ") && revWrongState.feedback.includes(revWrongWord), revWrongState.feedback.trim());
    check("反向辨析卡片逐条说明", revWrongState.items === 3);
    check("反向辨析标注干扰项来源", /干扰项来源/.test(revWrongState.foot), revWrongState.foot.trim());
    await page.keyboard.press("Enter");
    await page.waitForTimeout(600);
  }

  // 持久化：刷新后仍是看中文
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(1000);
  const revPersist = await page.evaluate(() => ({
    saved: JSON.parse(localStorage.getItem("vocab:v3:guest") || "{}")?.settings?.quizPrompt,
    zhPressed: document.querySelector('#modeSeg button[data-value="zh"]')?.getAttribute("aria-pressed"),
    cnShown: document.querySelector("#promptCn")?.hidden === false,
  }));
  check("刷新后出题方式仍是看中文（设置持久化）", revPersist.saved === "zh" && revPersist.zhPressed === "true", JSON.stringify(revPersist));
  check("刷新后反向题干正常渲染", revPersist.cnShown);

  // 换回拼写模式：后面的用例都依赖拼写通道
  await page.click('[data-practice="spell"]');
  await page.waitForSelector("#slots .slot", { timeout: 8000 });
  await page.waitForTimeout(400);
  const backToSpell = await page.evaluate(() => ({
    slots: document.querySelectorAll("#slots .slot").length,
    choiceHidden: document.querySelector("#choiceArea")?.hidden === true,
    hintVisible: document.querySelector("#hintPick")?.hidden === false,
    options: document.querySelectorAll("#options .option").length,
  }));
  check(
    "切回拼写模式后恢复字母槽与提示控件",
    backToSpell.slots > 0 && backToSpell.choiceHidden && backToSpell.hintVisible,
    `${backToSpell.slots} 格`
  );
  check("切回拼写后不再渲染选项", backToSpell.options === 0);
  await ensureChinese(page);

  /* ---------- 6. 移动视口 ---------- */
  console.log("\n6) 移动视口：输入通道与布局");
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
  const mpage = await mobile.newPage();
  const mobileErrors = [];
  mpage.on("pageerror", (e) => mobileErrors.push(String(e)));
  await mpage.goto(BASE, { waitUntil: "networkidle" });
  await mpage.waitForSelector("#slots .slot");
  await ensureChinese(mpage);
  await mpage.waitForTimeout(400);

  // 用文档坐标判断是否重叠，和当前滚动位置无关
  const layout = await mpage.evaluate(() => {
    const box = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { top: Math.round(r.top + window.scrollY), bottom: Math.round(r.bottom + window.scrollY) };
    };
    const bar = box(".topbar");
    const head = box("#chapterBtn");
    const phantom = ["#loadingCard", "#loadErrorCard", "#timerChip", "#reviewBanner"]
      .map((sel) => ({ sel, h: Math.round(document.querySelector(sel)?.getBoundingClientRect().height || 0) }))
      .filter((x) => x.h > 0);
    return { gap: bar && head ? head.top - bar.bottom : -999, phantom };
  });
  check("顶栏不压住章节按钮", layout.gap > 0, `间距 ${layout.gap}px`);
  check(
    "用 hidden 隐藏的状态卡片确实是隐藏的（display 覆盖 hidden 的老问题）",
    layout.phantom.length === 0,
    layout.phantom.map((p) => `${p.sel}=${p.h}px`).join(", ")
  );

  await mpage.locator("#slotsWrap").tap({ position: { x: 5, y: 5 } });
  await mpage.waitForTimeout(250);
  const active = await mpage.evaluate(() => document.activeElement?.id || document.activeElement?.tagName || "");
  check("点击槽位后隐藏输入框获得焦点（软键盘会被唤起）", active === "answerInput", `activeElement=${active}`);
  const mword = await resolveWord(mpage);
  if (mword) {
    await mpage.keyboard.type(mword, { delay: 10 });
    await mpage.waitForTimeout(200);
    const typed = await mpage.locator("#slots .slot.filled").count();
    check("移动端可以输入字母", typed > 0, `已填入 ${typed} 个`);
    await mpage.keyboard.press("Enter");
    await mpage.waitForTimeout(400);
    check("移动端能提交并判分", /正确|错误/.test((await mpage.textContent("#feedback")) || ""), ((await mpage.textContent("#feedback")) || "").trim());
  }
  const overflow = await mpage.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check("移动端无横向溢出", overflow <= 1, `超出 ${overflow}px`);
  await mobile.close();

  /* ---------- 7. 注册 + 建立云端数据 ---------- */
  console.log("\n7) 注册与云同步");
  await openAuth(page, "register");
  await submitAuth(page, email, password);
  await page.waitForTimeout(2500);
  const syncTitle = (await page.getAttribute("#syncBtn", "title")) || "";
  check("注册后进入已登录态", syncTitle.includes(email) || syncTitle.includes("已同步"), syncTitle);

  // 一题答对（提交后进入下一题）+ 一题答错，制造"错题 1"这个可验证的云端状态
  const answered = await answerCurrent(page, "correct", true);
  const wrongAnswered = await answerCurrent(page, "wrong", false);
  check("登录后仍可正常作答", Boolean(answered && wrongAnswered), `${answered || "?"} / ${wrongAnswered || "?"}`);
  await page.waitForTimeout(2500); // 等防抖 + 上传
  const ariaLabel = (await page.getAttribute("#chapterBtn", "aria-label")) || "";
  check("本章已记录错题（可验证的云端状态）", /错题 [1-9]/.test(ariaLabel), ariaLabel);

  /* ---------- 8. 断网 ---------- */
  console.log("\n8) 断网时的同步状态");
  await context.setOffline(true);
  const offlineWord = await answerCurrent(page, "wrong", false);
  if (offlineWord) {
    await page.waitForTimeout(2200);
    const offlineTitle = (await page.getAttribute("#syncBtn", "title")) || "";
    check("断网时明确提示未同步", /重试|同步中|失败|网络/.test(offlineTitle), offlineTitle);
  }
  await context.setOffline(false);
  await page.waitForTimeout(3500);
  const backOnline = (await page.getAttribute("#syncBtn", "title")) || "";
  check("恢复网络后自动补传完成", backOnline.includes(email) || backOnline.includes("已同步"), backOnline);

  /* ---------- 9. 关键回归：清空本机存档 → 重新登录 ---------- */
  console.log("\n9) 关键回归：清空本机存档 → 重新登录");
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector("#slots .slot");
  await page.waitForTimeout(800);
  const guestTitle = (await page.getAttribute("#syncBtn", "title")) || "";
  check("清空后确实回到未登录态", guestTitle.includes("未登录"), guestTitle);

  await openAuth(page, "login");
  await submitAuth(page, email, password);
  await page.waitForTimeout(3500);
  const restoredTitle = (await page.getAttribute("#syncBtn", "title")) || "";
  check("重新登录成功", restoredTitle.includes(email) || restoredTitle.includes("已同步"), restoredTitle);

  const restoredChapter = (await page.textContent("#brandSub")) || "";
  check("新设备/清缓存后继续上次的章节（云端 resume）", restoredChapter.includes("第3章"), restoredChapter.trim());

  const restoredAria = (await page.getAttribute("#chapterBtn", "aria-label")) || "";
  check("云端错题已恢复到本机（旧版会在这里丢数据）", /错题 [1-9]/.test(restoredAria), restoredAria);

  await page.keyboard.press("Escape");
  await openMenu(page, "settings");
  // 按文案找"每日目标"那一行（设置面板顶部新增了"练习方式"，不能靠行号）
  const dailyText = (
    (await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll(".settings-group .setting-row"));
      const row = rows.find((r) => (r.textContent || "").includes("每日目标"));
      return (row?.textContent || "").replace(/\s+/g, " ");
    })) || ""
  ).trim();
  const dailyMatch = dailyText.match(/今日\s*(\d+)\s*\/\s*(\d+)/);
  check("云端设置（每日计数/目标）已恢复", Boolean(dailyMatch) && Number(dailyMatch[1]) >= 2, dailyText.slice(0, 60));

  /* ---------- 10. 讲义页 ---------- */
  console.log("\n10) 讲义页");
  const lecture = await context.newPage();
  const lectureErrors = [];
  lecture.on("pageerror", (e) => lectureErrors.push(String(e)));
  await lecture.goto(`${BASE}/课程讲义.html?chapter=1`, { waitUntil: "networkidle" });
  await lecture.waitForSelector(".word-card", { timeout: 20000 });
  const cards = await lecture.locator(".word-card").count();
  check("讲义卡片渲染（分批）", cards > 0, `${cards} 张`);
  check("讲义标题带章节名", ((await lecture.textContent("#lectureTitle")) || "").includes("核心词汇"));
  await lecture.locator(".word-card").first().click();
  await lecture.waitForSelector(".scrim");
  check("打开单词详情", await lecture.locator(".scrim .detail-meaning").isVisible());
  const href = await lecture.locator('.scrim a[href*="index.html?chapter="]').getAttribute("href");
  check("详情可深链到刷词页", /index\.html\?chapter=\d+&word=\d+/.test(href || ""), href || "");
  await lecture.locator(".scrim textarea").fill("冒烟测试备注");
  await lecture.waitForTimeout(1800);
  check("备注写入后有状态提示", /已保存|已同步|未登录/.test((await lecture.textContent(".note-status")) || ""), ((await lecture.textContent(".note-status")) || "").trim());
  await lecture.keyboard.press("Escape");
  await lecture.waitForTimeout(400);
  check("Esc 关闭弹层", (await lecture.locator(".scrim").count()) === 0);

  /* ---------- 11. 词库加载健壮性（真实网络抖动；SW 用例与纯应用用例分开跑） ---------- */
  console.log("\n11) 词库加载健壮性");

  // A) SW 启用的 context：验证 Service Worker 的 stale-while-revalidate 真的工作
  const sctx = await browser.newContext({ viewport: { width: 1100, height: 820 } });
  const spage = await sctx.newPage();
  await spage.goto(BASE, { waitUntil: "networkidle" });
  await spage.waitForSelector("#slots .slot");
  // 首次加载时 SW 尚未接管（注册是异步的），reload 一次让词库请求真正经过 SW 并入缓存
  await spage.reload({ waitUntil: "networkidle" });
  await spage.waitForTimeout(400);
  const swLive = await spage.evaluate(async () => ({
    registered: ((await navigator.serviceWorker?.getRegistrations?.()) || []).length > 0,
    cacheHasData: await (async () => {
      const keys = await caches.keys();
      for (const k of keys) {
        const hit = await caches.open(k).then((c) => c.match("/data-1.json")).catch(() => null);
        if (hit) return true;
      }
      return false;
    })(),
  }));
  check("PWA：Service Worker 已注册且缓存了词库（stale-while-revalidate）", swLive.registered && swLive.cacheHasData, JSON.stringify(swLive));
  // 真离线测试：setOffline 会拦住包括 SW 在内的所有请求，此时只能靠 SW 缓存
  await sctx.setOffline(true);
  await spage.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
  await spage.waitForSelector("#slots .slot", { timeout: 15000 }).catch(() => {});
  check("PWA：真离线重载仍能从 SW 缓存渲染题目", (await spage.locator("#slots .slot").count()) > 0);
  await sctx.setOffline(false);
  await sctx.close();

  // B) 屏蔽 SW 的 context：验证应用自身的重试/兜底/报错逻辑（SW 会接管网络，绕过 route 拦截，必须关掉）
  const blockSW = { viewport: { width: 1100, height: 820 }, serviceWorkers: "block" };

  const rctx = await browser.newContext(blockSW);
  const rpage = await rctx.newPage();
  let dataAttempts = 0;
  await rpage.route("**/data-1.json", async (route) => {
    dataAttempts++;
    if (dataAttempts === 1) return void route.abort("connectionreset");
    return void route.continue();
  });
  await rpage.goto(BASE, { waitUntil: "domcontentloaded" });
  await rpage.waitForSelector("#slots .slot", { timeout: 30000 }).catch(() => {});
  check("词库请求抖动一次后自动重试成功（不需要用户点重试）", (await rpage.locator("#slots .slot").count()) > 0 && dataAttempts >= 2, `共请求 ${dataAttempts} 次`);
  check("自动重试期间不弹错误卡片", await rpage.locator("#loadErrorCard").isHidden());
  await rctx.close();

  // 应用层本机缓存兜底（无 SW 环境）
  const cctx = await browser.newContext(blockSW);
  const cpage = await cctx.newPage();
  await cpage.goto(BASE, { waitUntil: "networkidle" });
  await cpage.waitForSelector("#slots .slot");
  const cacheKeys = await cpage.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("vocab:cache:")));
  check("词库成功加载后会写入本机缓存", cacheKeys.length > 0, cacheKeys.join(","));
  await cpage.route("**/data-*.json", (route) => route.abort("connectionreset"));
  await cpage.reload({ waitUntil: "domcontentloaded" });
  await cpage.waitForSelector("#slots .slot", { timeout: 30000 }).catch(() => {});
  const cacheToast = (await cpage.locator(".toast").first().textContent().catch(() => "")) || "";
  check("词库完全取不到时用本机缓存兜底", (await cpage.locator("#slots .slot").count()) > 0);
  check("兜底时明确提示用户", /缓存/.test(cacheToast), cacheToast.trim());
  await cctx.close();

  // 无缓存 + 持续失败：给出人话报错，且不卡死（还能换章节）
  const fctx = await browser.newContext(blockSW);
  const fpage = await fctx.newPage();
  await fpage.route("**/data-*.json", (route) => route.abort("connectionreset"));
  await fpage.goto(BASE, { waitUntil: "domcontentloaded" });
  await fpage.waitForSelector("#loadErrorCard:not([hidden])", { timeout: 30000 }).catch(() => {});
  const errorText = ((await fpage.textContent("#loadErrorText").catch(() => "")) || "").trim();
  check("彻底失败时给出人话报错（含已重试次数）", /网络连接中断/.test(errorText) && /重试/.test(errorText), errorText);
  check("失败时仍能看到章节按钮，不会卡死", await fpage.locator("#chapterBtn").isVisible());
  await fpage.click("#chapterBtn");
  await fpage.waitForSelector(".chapter-list .list-item", { timeout: 5000 }).catch(() => {});
  check("失败时仍能打开章节抽屉换章节", (await fpage.locator(".chapter-list .list-item").count()) === 22);
  await fctx.close();


  /* ---------- 12. 运行期错误 ---------- */
  console.log("\n12) 运行期错误");
  // 断网测试期间浏览器必然记录资源加载失败，这是预期内的噪音
  const offlineNoise = /ERR_INTERNET_DISCONNECTED|ERR_NETWORK|net::ERR_|Failed to load resource/;
  const realErrors = consoleErrors.filter((text) => !offlineNoise.test(text));
  check(
    "刷词页无 JS 报错",
    realErrors.length === 0,
    realErrors.length ? realErrors.slice(0, 2).join(" | ") : `（已忽略 ${consoleErrors.length - realErrors.length} 条断网期资源错误）`
  );
  check("移动端无 JS 报错", mobileErrors.length === 0, mobileErrors.slice(0, 2).join(" | "));
  check("讲义页无 JS 报错", lectureErrors.length === 0, lectureErrors.slice(0, 2).join(" | "));

  await browser.close();
  console.log(`\n${fail ? "✖" : "✔"} 浏览器冒烟：${pass}/${pass + fail} 项通过`);
  console.log(`  （测试账号：${email}）`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error("\n无法执行：", err?.message || err);
  console.error("请确认 npm run db:migrate:local 已执行、npm run dev 正在运行");
  process.exit(2);
});
