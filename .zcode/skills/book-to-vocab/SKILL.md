---
name: book-to-vocab
description: 从词汇书（xlsx/csv/tsv，仅需外语词列，中文释义可选）生成 vocab-tool 全套资源：分章词库 + 认词题源（正向+反向），含校验门禁与验收。当用户给出词汇书文件并要求导入/生成题源时使用。
---

# 词汇书 → vocab-tool 全套资源

目标仓库：vocab-tool（22+ 章雅思词库刷词系统）。输入一本词汇书，产出 `data-N.json` 分章词库与认词题源（正向 `distractors` + 反向 `rev`），全程过校验门禁。

## 必读规范（动手前先读）

1. `docs/选择题资料生成规范.md`（v1.1）——干扰项六类/配额/辨析写法/红线/反向题 §11/验收 §9
2. `docs/词汇书导入与题源生成指南.md`——管线总览与本 skill 的详细版
3. `docs/质检报告-认词题源.md` / `docs/整改验收报告.md`——历史事故教训（**禁止事后只替换 text**；模板句先入黑名单再修数据）

## 流程（每步有门禁，禁止跳步）

### ① 导入词汇书
```bash
node scripts/import-book.mjs "<词汇书路径>" --title "<书名>" --chapters <N> [--start <章号>] [--by-sheet] [--sheet <名>] [--dry-run]
```
- 先 `--dry-run` 看分章与词数，确认后去掉 `--dry-run` 正式写入 `public/data-N.json`
- 只有外语词 → 按 `docs/词汇书导入与题源生成指南.md` 的补释义提示词让模型补 `meaningCN`
- 跑 `npm run check` 确认 chapters.js 合并与词库一致性

### ② 生成题源（分片 40~60 词）
```bash
node scripts/quiz.mjs prompt <章> --limit 50 --out prompt-<章>-1.md          # 正向
node scripts/quiz.mjs prompt <章> --limit 50 --rev --out prompt-<章>-rev.md  # 反向
```
把提示词交给模型产出**纯 JSON**，存 `content/quiz/<章>-1.json`。自检提示词区段里的硬规则（在规范文档的 MODEL-PROMPT / MODEL-PROMPT-REV 区段）。

### ③ 合并与校验
```bash
node scripts/quiz.mjs merge content/quiz/<章>-1.json --chapter <章>
```
有 ✖ 必须修到 0 error 才算完成。常见错误：kind 配额超、why 空话（黑名单）、义项重合、同题 why 重复。

### ④ 抽查与缺陷扫描
```bash
node scripts/quiz.mjs sample --chapter <章> --count 8 [--rev]
node scripts/quiz-flag.mjs
```
人工核对 sample 输出：歧义（两个选项都说得通）、why 与选项错位、空话模板。发现新模板句 → 先加入 `scripts/quiz-lib.mjs` 黑名单再修数据。

### ⑤ 门禁与上线
```bash
npm run quiz:check && npm run check && npm test && npm run smoke
git push   # 自动部署，随后 npm run verify:live
```

## 硬性纪律

- **禁止事后只替换 text**（text/why/kind/note 必须同一次产出）——历史事故 916 条错位的根因
- 一切题源变更走 `quiz.mjs merge` 校验门禁，禁止直改 `public/quiz-N.json`
- 语义新判据先标定误报率再设为门禁
- 题源分片提交入库（`content/quiz/`），保证可回溯
