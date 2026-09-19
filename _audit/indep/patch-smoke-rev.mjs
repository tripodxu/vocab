// 一次性补丁：向 scripts/smoke.mjs 插入反向认词冒烟区块（用后即删）
import { readFileSync, writeFileSync } from "node:fs";

const file = "scripts/smoke.mjs";
let s = readFileSync(file, "utf8");
const anchor = "  // 换回拼写模式：后面的用例都依赖拼写通道";
if (!s.includes(anchor)) {
  console.error("anchor missing");
  process.exit(1);
}

const block = `  /* ---------- 5.5 反向认词（看中文选英文） ---------- */
  console.log("\\n5.5) 反向认词：看中文选英文");
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
      const list = await (await fetch(\`data-\${chapter}.json\`)).json();
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
    check("反向答错文案是「正确答案是」（方向感知）", revWrongState.feedback.includes("正确答案是"), revWrongState.feedback.trim());
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

`;

s = s.replace(anchor, block + anchor);
writeFileSync(file, s);
console.log("smoke reverse section inserted");
