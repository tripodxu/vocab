// 一次性补丁：向 scripts/quiz-lib.mjs 插入 rev 侧校验块（用后即删）
import { readFileSync, writeFileSync } from "node:fs";

const file = "scripts/quiz-lib.mjs";
let s = readFileSync(file, "utf8");

const anchor = `    if (confusableCount === 0 && distractors.length) {
      bad(
        id,
        \`至少要有一个有辨析价值的干扰项（\${CONFUSABLE_KINDS.join(" / ")}），不能全是"同主题不同概念" \${label}\`
      );
    }`;
if (!s.includes(anchor)) {
  console.error("anchor missing");
  process.exit(1);
}

const revBlock = anchor + `

    /* ---------- 反向题源（rev：看中文选英文，text = 英文词） ---------- */
    const rev = item?.rev;
    if (rev != null) {
      const revList = Array.isArray(rev?.distractors) ? rev.distractors : null;
      if (!revList || revList.length !== DISTRACTOR_COUNT) {
        bad(id, \`rev.distractors 必须恰好 \${DISTRACTOR_COUNT} 条（反向也是 4 选 1） \${label}\`);
      } else {
        let revConfusable = 0;
        const revTopic = revList.filter((d) => d?.kind === "topic").length;
        const revAntonym = revList.filter((d) => d?.kind === "antonym").length;
        /** @type {string[]} */ const revWhys = [];
        revList.forEach((d, index) => {
          const revWhere = \`rev 第 \${index + 1} 个干扰项 \${label}\`;
          const text = String(d?.text ?? "").trim();
          if (!/^[A-Za-z][A-Za-z' -]*$/.test(text)) {
            bad(id, \`\${revWhere}的 text 必须是纯英文词：\${JSON.stringify(text)}\`);
          } else {
            // 与答案同形/互为屈折（act/acts）→ 两个选项都说得通
            const lt = text.toLowerCase();
            const lw = String(entry?.word || "").toLowerCase();
            if (!lw || lt === lw || lt.startsWith(lw) || lw.startsWith(lt)) {
              bad(id, \`\${revWhere}与答案词形相同或互为屈折：「\${text}」\`);
            } else {
              const poolEntry = wordByWord.get(lt);
              if (poolEntry) {
                if (meaningsConflict(poolEntry.meaningCN, entry.meaningCN)) {
                  bad(id, \`\${revWhere}的词义与题面互含（它也能回答这道题）：「\${text}（\${String(poolEntry.meaningCN).slice(0, 14)}）」\`);
                }
              } else if (!String(d?.gloss || "").trim()) {
                bad(id, \`\${revWhere}的词不在词库里，必须带 gloss（一句中文释义）：「\${text}」\`);
              } else if (meaningsConflict(d.gloss, entry.meaningCN)) {
                bad(id, \`\${revWhere}的 gloss 与题面互含：「\${text}」\`);
              }
            }
          }
          if (!QUIZ_KIND.includes(d?.kind)) {
            bad(id, \`\${revWhere}的 kind 非法：\${JSON.stringify(d?.kind)}（反向只允许 \${REV_KINDS.join("/")}）\`);
          } else if (d.kind === "sense") {
            bad(id, \`\${revWhere}不能是 sense（反向里近义词就是另一个正确答案）\`);
          } else if (d.kind === "pos") {
            bad(id, \`\${revWhere}不能是 pos（反向选项都是英文词，词性差异无从体现）\`);
          } else if (d.kind !== "topic") {
            revConfusable += 1;
          }
          const revWhy = String(d?.why ?? "").trim();
          if (!revWhy) bad(id, \`\${revWhere}缺少 why\`);
          else {
            if (revWhy.length > WHY_MAX) bad(id, \`\${revWhere}的 why 超过 \${WHY_MAX} 字（\${revWhy.length} 字）：\${revWhy}\`);
            if (WHY_BLACKLIST.some((re) => re.test(revWhy))) bad(id, \`\${revWhere}的 why 是空话模板：\${revWhy}\`);
            if (revWhys.includes(revWhy)) bad(id, \`\${revWhere}的 why 与同题另一条完全相同\`);
            revWhys.push(revWhy);
          }
        });
        if (revTopic > TOPIC_MAX) bad(id, \`rev 的 topic 干扰项最多 \${TOPIC_MAX} 个，实际 \${revTopic} 个 \${label}\`);
        if (revAntonym > 1) bad(id, \`rev 的 antonym 干扰项最多 1 个，实际 \${revAntonym} 个 \${label}\`);
        if (revConfusable === 0) bad(id, \`rev 至少要有一个有辨析价值的干扰项（root / form / antonym） \${label}\`);
        revCovered += 1;
      }
    }`;

s = s.replace(anchor, revBlock);

// stats 增加 revCovered
const statsAnchor = "  return {\n    errors,\n    warnings,\n    stats: {\n      total,\n      covered,\n      coverage,";
if (!s.includes(statsAnchor)) {
  console.error("stats anchor missing");
  process.exit(1);
}
s = s.replace(statsAnchor, "  return {\n    errors,\n    warnings,\n    stats: {\n      total,\n      covered,\n      revCovered,\n      coverage,");

// 常量：REV_KINDS（与 public/quiz.js 保持同步）
s = s.replace(
  'export const CONFUSABLE_KINDS = ["root", "form", "sense", "antonym"];',
  'export const CONFUSABLE_KINDS = ["root", "form", "sense", "antonym"];\n/** 反向题（rev）允许的干扰项类型（与 public/quiz.js 的 REV_KINDS 同步；sense/pos 在反向无意义或有害） */\nexport const REV_KINDS = ["root", "form", "topic", "antonym"];'
);

writeFileSync(file, s);
console.log("rev validation inserted, REV_KINDS added");
