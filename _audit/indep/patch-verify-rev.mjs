// 一次性补丁：向 scripts/verify-live.mjs 插入反向核验区块（用后即删）
import { readFileSync, writeFileSync } from "node:fs";

const file = "scripts/verify-live.mjs";
let s = readFileSync(file, "utf8");
const anchor = "  // 切回拼写，避免影响后续";
if (!s.includes(anchor)) {
  console.error("anchor missing");
  process.exit(1);
}

const block = `  /* ---------- 4.5 反向认词（看中文选英文） ---------- */
  await page.click('#modeSeg button[data-value="zh"]');
  await page.waitForTimeout(700);
  const rev = await page.evaluate(async () => {
    const meaning = document.querySelector("#promptCn")?.textContent || "";
    const chapter = Number((document.querySelector("#brandSub")?.textContent || "").match(/\\d+/)?.[0] || 1);
    const list = await (await fetch(\`data-\${chapter}.json\`)).json();
    return {
      meaning,
      word: (list.find((w) => w.meaningCN === meaning) || {}).word || "",
      options: Array.from(document.querySelectorAll("#options .option .text")).map((n) => n.textContent),
      cnShown: document.querySelector("#promptCn")?.hidden === false,
      wordHidden: document.querySelector("#promptWord")?.hidden === true,
      primary: document.querySelector("#primaryBtn")?.textContent || "",
      segPressed: document.querySelector('#modeSeg button[data-value="zh"]')?.getAttribute("aria-pressed"),
    };
  });
  const revLatin = /^[A-Za-z][A-Za-z' -]*$/;
  check("反向：看中文档可选中", rev.segPressed === "true");
  check("反向：题干是中文且作答前隐藏英文词", rev.cnShown && rev.wordHidden, rev.meaning);
  check("反向：4 个不重复的英文词选项", rev.options.length === 4 && new Set(rev.options).size === 4 && rev.options.every((t) => revLatin.test(t)), rev.options.join(" / "));
  check("反向：主按钮文案随方向变化", rev.primary.includes("单词"), rev.primary.trim());
  if (rev.word && rev.options.includes(rev.word)) {
    const revAt = rev.options.indexOf(rev.word);
    await page.locator("#options .option").nth(revAt).click();
    await page.waitForTimeout(500);
    const revOk = await page.evaluate(() => ({
      ok: document.querySelectorAll("#options .option.ok").length,
      revealed: document.querySelector("#promptWord")?.hidden === false,
      revealedWord: document.querySelector("#promptWordEn")?.textContent || "",
    }));
    check("反向：选对英文词能判对", revOk.ok === 1, revOk.revealedWord);
    check("反向：答对后揭示英文词", revOk.revealed);
  } else {
    check("反向：选对英文词能判对", false, \`反查答案词失败：\${rev.meaning}\`);
  }
  // 切回正向，保持常规出题状态
  await page.click('#modeSeg button[data-value="en"]');
  await page.waitForTimeout(500);
`;

s = s.replace(anchor, block + anchor);
writeFileSync(file, s);
console.log("verify-live reverse section inserted");
