// 一次性补丁：向规范文档插入 MODEL-PROMPT-REV 区段（用后即删）
import { readFileSync, writeFileSync } from "node:fs";

const file = "docs/选择题资料生成规范.md";
let s = readFileSync(file, "utf8");
const anchor = "<!-- MODEL-PROMPT:END -->";
if (!s.includes(anchor)) {
  console.error("anchor missing");
  process.exit(1);
}

const block = anchor + `

<!-- MODEL-PROMPT-REV:START -->
# 任务：为雅思核心词汇生成「看中文选英文」的反向干扰项（rev）

你是一名英语词汇教研员。下面给你一批雅思核心词（\`id\` / \`word\` / \`pos\` / \`meaningCN\` / \`root\`）。
反向题的题面是中文释义、答案是英文词，你要为每个词产出 **3 个英文干扰词**（text = 英文词），
并给每个干扰词写一句辨析（告诉学生「这个词其实是什么意思」）。

## 输出（只输出 JSON）

\`\`\`json
{
  "spec": "1.1",
  "chapter": <章号>,
  "source": "model",
  "generator": "<你的模型名>",
  "items": {
    "<词库里的 id>": {
      "rev": {
        "distractors": [
          { "text": "英文干扰词", "kind": "form", "why": "≤40 字，讲出该词的含义", "gloss": "词库外必填：该词的中文释义" }
        ]
      }
    }
  }
}
\`\`\`

## 硬性规则

1. \`text\` 必须是**纯英文词**，不得与答案同形或互为屈折（act/acts 互为屈折，判错）。
2. \`kind\` 只允许 \`root\`（同词根）/ \`form\`（拼写相近）/ \`topic\`（同章词）/ \`antonym\`（反义词，≤1）；
   **禁止 \`sense\`**——反向题里近义词就是另一个正确答案；**禁止 \`pos\`**——选项都是英文词，词性差异无从体现。
3. 干扰词若在词库里，其中文释义与题面互含即废（它也能回答这道题）；词库外的词**必须带 \`gloss\`**。
4. 每题至少 1 个 \`root\`/\`form\`/\`antonym\`，\`topic\` ≤2。
5. \`why\` ≤40 字、禁空话，且必须**讲出错误单词的含义**（如 \`reveal 与 repeal 拼写相近，reveal 指揭露\`）。
6. 反向里形近词杀伤力最大：优先找只差一两个字母、共享前后缀或词根的词（repeal/reveal、adapt/adopt）。
7. 答案不应总是最长的词：干扰词长度尽量与答案接近。
8. 只输出 JSON，不要解释。
<!-- MODEL-PROMPT-REV:END -->`;

s = s.replace(anchor, block);
writeFileSync(file, s);
console.log("spec rev prompt block added");
