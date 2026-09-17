# 真经刷词神器（vocab-tool）

雅思核心词汇的**拼写练习 + 课程讲义**工具。前端是纯静态页面（无框架），后端是 Cloudflare Worker + D1，
账号、学习状态、讲义备注与配图都支持云端同步。词库共 **22 章 / 3568 词**。

- 刷词页 `/`（`index.html`）：看中文 / 听音 / 随机三种模式，字母槽拼写，错词自动复现。
- 讲义页 `/课程讲义.html`：词根词源、例句、备注、配图、批注，卡片可一键跳到刷词页练这个词。

---

## 1. 快速开始

```bash
npm install

# 首次：建本地 D1 并应用迁移（顺序不能反）
npm run db:migrate:local

npm run dev          # http://127.0.0.1:8787
```

部署到线上：

```bash
# 1) 先给线上库应用迁移（必须，否则接口会 500 / 缺表）
npm run db:migrate
# 2) 再部署 Worker 与静态资源
npm run deploy
```

> ⚠️ 升级到本版本**必须先跑 `npm run db:migrate`**：新增了 `user_word_state` / `user_notes` /
> `user_note_images` / `auth_throttle` 四张表。旧版 `vocab_progress`（整章 JSON blob）里的错题本与生词本
> 会在用户第一次拉取学习状态时**自动迁移**成按词记录，无需手动处理。

## 2. 常用命令

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 本地开发（Worker + 静态资源 + 本地 D1） |
| `npm run deploy` | 部署 |
| `npm run db:migrate` / `db:migrate:local` | 应用数据库迁移（线上 / 本地） |
| `npm test` | 单元测试：核心学习逻辑 + Worker 接口（41 项，用内存 D1 假实现） |
| `npm run check` | 静态一致性检查（模块可导入、词库与章节清单一致、HTML 引用与 id 接线、CSS 变量、配置） |
| `npm run e2e` | 接口端到端：真实 workerd + 真实 SQLite（63 项） |
| `npm run smoke` | 浏览器端到端：桌面输入 / 移动视口 / 断网 / 双账号恢复（38 项） |
| `npm run build:data` | 把 `data-N.js` 转成 `data-N.json` 并生成 `chapters.js` |

### 端到端测试（需要先起本地服务）

```bash
npm run db:migrate:local
npm run dev              # 另开一个终端
npm run e2e              # 接口层：静态资源头、鉴权、按词 LWW、备注配图、限流…
npm i --no-save playwright   # 仅装包，不下载浏览器（默认复用系统 Chrome/Edge）
npm run smoke            # 浏览器层：移动端输入通道、判分、章节、设置、断网、清缓存后恢复
```

`npm run e2e` 验证 SQL 语义本身（内存假实现测不到的部分，例如 `ON CONFLICT ... WHERE excluded.seen_at >= ...` 的按词 LWW）；
`npm run smoke` 验证真实交互（`SMOKE_CHANNEL=msedge` 可切换浏览器）。

## 3. 目录结构

```
worker/index.js        Worker 入口：认证 / 按词学习状态 / 讲义备注与配图 / 静态资源与缓存策略
migrations/*.sql       D1 表结构（0003 引入按词存储）
public/
  index.html           刷词页（只留结构，样式与逻辑全部外链）
  课程讲义.html         讲义页
  app.js               刷词页交互：输入、判分、牌堆、同步队列、各抽屉
  lecture.js           讲义页交互：卡片、详情、备注、配图压缩、批注
  core.js              纯逻辑核心（无 DOM）：判分、掌握判定、错词复现、统计、每日目标、合并
  ui.js                共用组件：主题、toast、确认框、输入框对话框、焦点陷阱
  vocab-auth.js        账号与云同步客户端
  chapters.js          章节清单（由 build:data 生成）
  data-N.json          分章词库（唯一数据源）
  tokens.css           设计变量（明暗两套，全站唯一来源）
  ui.css / app.css / lecture.css
scripts/               convert-data.mjs / check.mjs / smoke.mjs
test/                  core.test.js / worker.test.js / fake-d1.js
```

## 4. 数据与同步模型

- 学习状态按 **(user, chapter, word)** 一行存储（`user_word_state`），状态为
  `learning / wrong / mastered`，并记录 `streak`（连续答对次数）、`wrong_count`、`due_at`。
- 判分规则：**连续答对 2 次判定掌握并移出错题本**；答错立刻回到错题本，并在次日到期复现。
- 冲突处理：每条记录带客户端逻辑时间戳 `seen_at`，服务端用
  `ON CONFLICT ... WHERE excluded.seen_at >= 现有.seen_at` 做**按词 LWW**，
  所以两端交替作答是合并不是覆盖（旧版整章 blob 只能整体覆盖）。
- 客户端同步：脏检查 → 800ms 防抖 → 串行队列 → 失败指数退避重试（最多 30s）→
  单次最多 500 条切块上传；登录后会把本机历史记录整体补传一次。
- 本地存档按账号分命名空间（`vocab:v3:u<id>` / `vocab:v3:guest`）。
  未登录期间的进度只允许并入**一个**账号，避免共用电脑时串号。

## 5. 词库维护

`public/data-N.json` 是唯一数据源，章节清单 `public/chapters.js` 由脚本生成，不要手改。

- 改词：直接编辑 `public/data-N.json`，然后 `npm run check` 校验。
- 新增一章：把 `data-23.js` 放到 `public/`，在 `scripts/convert-data.mjs` 的 `CHAPTER_META` 里补一条
  （标题 + emoji），执行 `npm run build:data`，再跑 `npm run check`。

## 6. 已知限制

- **单元测试 + 静态检查是本仓库的常规门禁**；端到端冒烟脚本 `scripts/smoke.mjs`
  需要本机能启动浏览器与 `wrangler dev`（CI 或本地）。
- `public/app.js` 仍偏大（刷词页的全部交互，约 2100 行）。纯逻辑已抽到可单测的 `core.js`，
  HTML/CSS/JS 也已分离；如果继续长大，建议按「抽屉/面板」再拆一个模块。
- 离线可用性目前依赖浏览器自身缓存（词库 `max-age=3600`，HTML `no-store`），
  还没有 Service Worker / PWA 清单（计划里的可选项，未实现）。
- 语音朗读使用浏览器 `speechSynthesis`，iOS 需要用户手势触发；播放失败时界面会提示点 🔊。
