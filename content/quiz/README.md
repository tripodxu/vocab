# content/quiz —— 认词题源的**分片**目录（不是前端资源）

这里放模型/人工产出、还没合并进 `public/quiz-N.json` 的题源分片，
方便"一片一片生成、一片一片校验"，也方便出错时回滚。

- 生成规范与完整流程：`docs/选择题资料生成规范.md`
- 合并进线上题源（会先校验，有错不写入）：

```bash
node scripts/quiz.mjs merge content/quiz/21-1.json --chapter 21 --dry-run   # 只看校验结果
node scripts/quiz.mjs merge content/quiz/21-1.json --chapter 21             # 真正写入 public/quiz-21.json
node scripts/quiz.mjs sample --chapter 21 --count 8                         # 抽查"页面上会看到的那道题"
```

- 命名建议：`<章号>-<起始序号>-<结束序号>.json`（例：`21-1-50.json`）
- 分片文件不需要是最终格式：只要包含 `items`（对象或数组都行），
  `merge` 会自动归一化；`chapter` 字段缺失时用 `--chapter` 指定。
- 这个目录里的文件**不会**被打包进站点，可以放心留档。
