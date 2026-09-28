# _archive · 一次性脚本与证据（**禁止运行**）

> 这里的东西**只作证据**：说明"当时的题源是怎么被改出来的"，供事后复核与追责。
> 一律**禁止运行**（`AGENTS.md` 硬约束 11）——它们多是一次性批量改写脚本，重跑会覆盖发布数据。
> 现行工具链在 `scripts/`，别到这里找"能用的脚本"。

## 目录

| 子目录 | 内容 | 对应事件 |
| --- | --- | --- |
| `length-fix/` | 「长度修复运动」：修复干扰项长度比失衡（避免"最长的那个就是答案"） | 见 `docs/archive/质检报告-认词题源.md` |
| `quiz-fix/` | 「题源缺陷整改运动」：模板句 why、错位辨析、重建分片等 | 同上 |

## 命名说明（同名文件不是同一份）

同一轮运动里存在多个版本，`v1` 后缀表示"更早的那版"，无后缀的是最终版：

- `length-fix/fix-length.v1.mjs` → `length-fix/fix-length.mjs`（现行归档版）
- `length-fix/analyze-length.v1.mjs` → `length-fix/analyze-length.mjs`
- `.js` 与 `.mjs` 并存的是同一脚本的 CommonJS / ESM 两版

**这些脚本已被 `scripts/quiz-optimize.mjs`（约束式逐题修复）取代**——新修复一律走后者 + `quiz.mjs merge` 收口。

## 相关

- `docs/archive/整改验收报告.md`：当时的收口记录
- `docs/选择题资料生成规范.md`：现行规范（v1.2）
