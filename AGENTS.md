# AGENTS.md · 智能体入场须知

> 本仓库约 1.5 万行代码 + 22 章词库/题源数据，**不要一上来全量阅读**。
> 按下面的「三层读取法」取用，10 分钟内即可安全动手。

---

## 0. 三层读取法（省时间的关键）

| 层级 | 读什么 | 什么时候读 |
| --- | --- | --- |
| **L0 必读** | 本文件 + 根目录 `MEMORY.md`（项目记忆，**最新在最上面**） | **每次任务开始**，5 分钟 |
| **L1 选读** | `docs/agents/模块地图.md` → 按你要改的东西查「看哪些文件、跑哪些测试」 | 动手前，按需查表 |
| **L2 深入** | 具体规范/指南文档（见 `docs/README.md` 索引） | 只在任务确实涉及该子系统时 |

常见 L2 落点：**改界面/设计系统 → `docs/设计规范.md`**；改题源 → `docs/选择题资料生成规范.md`；
导入词书/跑题源管线 → `docs/词汇书导入与题源生成指南.md`。

**禁止**：为了"先了解一下"而通读 `public/app.js`（3900 行）或 `public/quiz-*.json`（6MB 数据）。需要时按 L1 表定位到函数/文件再读。

---

## 1. 项目一句话

雅思核心词汇刷词工具（22 章 / 3568 词）：前端是无框架原生 JS 静态页（刷词页 `/`、讲义页 `/课程讲义.html`、报告 `/报告.html`、后台 `/admin.html`），后端 Cloudflare Worker + D1，支持账号同步与 PWA。线上 <https://vocab.logicc.top>，`main` 推送后自动部署（约 1 分钟）。

---

## 2. 目录责任（简表，详见 `docs/目录结构.md`）

```
worker/index.js        后端唯一入口：鉴权 / 学习状态 / 备注配图 / 静态资源 / admin API
migrations/*.sql       D1 表结构（0001~0009，已应用过的不可改）
public/*.js|css|html   前端（app.js 刷词 · lecture.js 讲义 · core.js 纯逻辑 · quiz.js 出题 · ui.js 组件）
public/data-N.json     词库（唯一数据源）
public/quiz-N.json     认词题源（spec v1.2，正向 + rev 反向）
scripts/*.mjs          工具链：quiz-lib（纯逻辑）/ quiz-data（数据层）/ quiz*.mjs（题源 CLI）/ check·smoke·e2e（门禁）
test/*.js              node:test 单元测试（206 项）
docs/                  文档（索引见 docs/README.md）
content/quiz/          题源合并前的中间分片（溯源用，不是运行时数据源）
_archive/ _audit/      一次性证据与审计脚本（**禁止运行**，禁止被生产代码 import）
```

---

## 3. 命令与门禁（DoD）

| 命令 | 作用 | 何时必须跑 |
| --- | --- | --- |
| `npm test` | 206 项单元测试（无需网络/浏览器） | **任何代码改动后必跑** |
| `npm run check` | 56 项静态一致性（模块/接线/CSS 变量/题源/设计 lint） | **改前端、题源、词库后必跑** |
| `npm run quiz:check` | 校验题源并重建 `quiz-index.json` | **动过 `public/quiz-*.json` 后必跑** |
| `npm run quiz:scan:truncation` | 扫描辨析/记忆的截断痕迹（诊断，不阻断） | 题源大改后（FLAGGED 应清零） |
| `npm run e2e` | 67 项接口端到端（需先 `npm run dev`） | 改 `worker/index.js`、同步协议后 |
| `npm run smoke` | 105 项浏览器冒烟（需 dev 服务 + 系统 Chrome/Edge） | 改界面交互后（**只跑本地**） |
| `npm run verify:live` | 35 项线上只读核验 | 部署后 |
| `npm run db:migrate` / `db:migrate:local` | 应用迁移（线上 / 本地） | **部署前**，顺序不能反 |

**完成定义（DoD）**：改动涉及哪层，就跑哪层门禁；`npm test` 与 `npm run check` 是**最低要求**，二者全绿才算完成。

---

## 4. 硬约束（违反会出事故，改前必读）

> 速查版：每条一句话。**权威展开与例外见 `docs/项目规范.md`**；两处冲突以项目规范为准（不要改一处忘另一处）。

1. **先迁移后部署**：`npm run db:migrate` 必须在 `npm run deploy` **之前**；Worker 依赖新表，反序会全线 500。
2. **题源禁止只替换 `text`**：`why`/`kind` 会与选项错位（历史事故 916 条）。要改就整条重产出，走 `quiz.mjs merge` 校验收口。
3. **不允许硬截断用户可见文案**：辨析/记忆文案只设上限（WHY_MAX/NOTE_MAX=120），不得 slice 加「…」。
4. **界面禁 emoji**：结构性图标一律内联 SVG sprite（`ui.js` 的 `icon()/iconHTML()`）；`npm run check` 会拦。
5. **CSS 禁裸 hex**：颜色全部走 `tokens.css` 语义变量；双主题对比度有门禁。
6. **`docs/选择题资料生成规范.md` 被 `scripts/check.mjs` 硬引用**：改名或删除会让 `npm run check` 直接判错。
7. **`test/frontend-guards.test.js` 用正则断言 `app.js` 源码片段**（异步守卫）：重构 `switchPractice` / `flush` / `applyUser` / 同步相关代码时，必须同步更新该测试里的正则。
8. **日期相关测试必须传固定 `nowRef`**：`recordDaily`/streak 等依赖"昨天"的判定，写死日期的测试会随真实日期推移而失效。
9. **`public/data-N.json` 是唯一数据源**，`public/chapters.js` 由 `npm run build:data` 生成，不要手改。
10. **改前端静态资源后递增 `public/sw.js` 的 `VERSION`**，否则老用户拿不到更新。
11. **`_archive/` 与 `_audit/` 里的一次性脚本禁止运行**（仅作证据/复核），`_backup/` 同理；
    生产代码（`scripts/`、`test/`、`public/`）**禁止 import 这两个目录**（依赖只能 `_audit → scripts`，见 `docs/目录结构.md` §3）。
12. **密钥不入库**：`ADMIN_TOKEN` 等走 `wrangler secret put`；`.dev.vars` 已在 `.gitignore`。

---

## 5. 多 agent 协同与接力

- 规范：`docs/agents/协作与接力规范.md`（角色分工、并行边界、DoD、冲突避免）
- 模板：`docs/agents/任务卡与交接模板.md`（任务卡 / Handoff / 验收报告，可直接复制）
- 看板：`docs/agents/接力看板.md`（当前进行中的任务与交接状态，**交接双方都要更新**）

**接力铁律**：交接必须留下可验证的产物（改动文件 + 门禁结果 + 未竟事项），不允许口头"差不多了"。接手方先读 `MEMORY.md` 顶部最新条目 + 看板里的当前任务，再开工。

---

## 6. 提交规范（Conventional Commits）

```
<type>(<scope>): <中文简述>
type: feat | fix | docs | style | refactor | test | chore | polish
scope: app | ui | quiz | sync | worker | scripts | lecture | report | admin | docs …
```
例：`fix(quiz): 辨析文案不再硬截断（放宽上限并清理存量数据）`
提交前自查：`npm test` + `npm run check` 全绿；一次提交一件事。
