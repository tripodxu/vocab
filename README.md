# 真经刷词神器（vocab-tool）

雅思核心词汇的**刷词练习 + 课程讲义**工具。前端是纯静态页面（无框架），后端是 Cloudflare Worker + D1，
账号、学习状态、讲义备注与配图都支持云端同步。词库共 **22 章 / 3568 词**。

- 刷词页 `/`（`index.html`）：两种答法 ——
  **拼写**（看中文 / 听音 / 随机，字母槽拼写）与 **认词**（看英文选中文，4 选 1 + 辨析）；
  错词自动复现。
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
> 「认词模式」不需要任何新表与新接口：题源是静态文件，学习状态仍走原来的按词接口。

## 2. 常用命令

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 本地开发（Worker + 静态资源 + 本地 D1） |
| `npm run deploy` | 部署 |
| `npm run db:migrate` / `db:migrate:local` | 应用数据库迁移（线上 / 本地） |
| `npm test` | 单元测试：核心学习逻辑 + 认词出题/题源校验 + Worker 接口（88 项，用内存 D1 假实现） |
| `npm run check` | 静态一致性检查（模块可导入、词库与章节清单一致、HTML 引用与 id 接线、CSS 变量、配置、题源校验） |
| `npm run e2e` | 接口端到端：真实 workerd + 真实 SQLite（63 项） |
| `npm run smoke` | 浏览器端到端：拼写/认词/移动视口/断网/双账号恢复/词库抖动重试（71 项） |
| `npm run verify:live` | **线上核验**：对已部署站点跑一遍（资源、状态卡片、提示字母、22 章词库、认词出题与辨析） |
| `npm run build:data` | 把 `data-N.js` 转成 `data-N.json` 并生成 `chapters.js` |
| `npm run quiz:prompt -- 21 --limit 50` | 生成给模型用的**出题提示词**（规范 + 本批词表，直接贴给任意模型） |
| `npm run quiz:merge -- content/quiz/21-1.json --chapter 21` | 合并模型产出的题源分片（先校验，有错不写入） |
| `node scripts/quiz-flag.mjs` | 逐题缺陷扫描（歧义/错位/模板/长度/万能项）→ `_audit/work/N-flags.json` |
| `npm run quiz:check` | 校验全部题源并重建 `public/quiz-index.json` |
| `npm run quiz:sample -- --chapter 21 --count 8 [--rev]` | 打印"用户实际会看到的那道题"（同一套算法与种子，`--rev` 看反向题），人工抽查语义质量 |

### 端到端测试（需要先起本地服务）

```bash
npm run db:migrate:local
npm run dev              # 另开一个终端
npm run e2e              # 接口层：静态资源头、鉴权、按词 LWW、备注配图、限流…
npm i --no-save playwright   # 仅装包，不下载浏览器（默认复用系统 Chrome/Edge）
npm run smoke            # 浏览器层：桌面/移动、拼写与认词两种答法、设置、断网、清缓存后恢复
```

`npm run e2e` 验证 SQL 语义本身（内存假实现测不到的部分，例如 `ON CONFLICT ... WHERE excluded.seen_at >= ...` 的按词 LWW）；
`npm run smoke` 验证真实交互（`SMOKE_CHANNEL=msedge` 可切换浏览器）。

### 上线后核验

本仓库没有 CI 配置——推送后由 GitHub 集成自动构建部署（约 1 分钟）。部署完可以跑：

```bash
npm run verify:live                          # 默认打 https://vocab.logicc.top
npm run verify:live -- https://vocab.logicc.top --shot   # 顺便截图到 shots/
```

核验失败最常见的原因就是本节开头那条：改动没进 `public/`，或部署还在进行中。

## 3. 目录结构

```
worker/index.js        Worker 入口：认证 / 按词学习状态 / 讲义备注与配图 / 静态资源与缓存策略
migrations/*.sql       D1 表结构（0003 引入按词存储）
public/
  index.html           刷词页（只留结构，样式与逻辑全部外链）
  课程讲义.html         讲义页
  app.js               刷词页交互：输入、判分、牌堆、同步队列、认词交互、各抽屉
  lecture.js           讲义页交互：卡片、详情、备注、配图压缩、批注
  core.js              纯逻辑核心（无 DOM）：判分、掌握判定、错词复现、统计、每日目标、分模式台账
  quiz.js              认词出题核心（无 DOM）：干扰项挑选、辨析文案、反作弊、可注入 rng
  ui.js                共用组件：主题、toast、确认框、输入框对话框、焦点陷阱
  vocab-auth.js        账号与云同步客户端
  chapters.js          章节清单（由 build:data 生成）
  data-N.json          分章词库（唯一数据源）
  quiz-N.json          分章**认词题源**（精编干扰项 + 辨析，可选；见 docs/选择题资料生成规范.md）
  quiz-index.json      题源清单（由 quiz:check 生成：哪些章有精编题源）
  tokens.css           设计变量（明暗两套，全站唯一来源）
  ui.css / app.css / lecture.css
scripts/               convert-data.mjs / check.mjs / smoke.mjs / quiz.mjs / quiz-lib.mjs
docs/                  选择题资料生成规范.md（v1.1 生成与验收规范）+ 审查意见 + 质检报告
content/quiz/          模型产出的题源分片（合并前的中间产物）
test/                  core.test.js / quiz.test.js / worker.test.js / fake-d1.js
```

## 4. 数据与同步模型

- 学习状态按 **(user, chapter, word)** 一行存储（`user_word_state`），状态为
  `learning / wrong / mastered`，并记录 `streak`（连续答对次数）、`wrong_count`、`due_at`。
- 判分规则：**连续答对 2 次判定掌握并移出错题本**；答错立刻回到错题本，并在次日到期复现。
  拼写与认词**共用这一份状态**（认识即掌握）。
- 冲突处理：每条记录带客户端逻辑时间戳 `seen_at`，服务端用
  `ON CONFLICT ... WHERE excluded.seen_at >= 现有.seen_at` 做**按词 LWW**，
  所以两端交替作答是合并不是覆盖（旧版整章 blob 只能整体覆盖）。
- 客户端同步：脏检查 → 800ms 防抖 → 串行队列 → 失败指数退避重试（最多 30s）→
  单次最多 500 条切块上传；登录后会把本机历史记录整体补传一次。
- 本地存档按账号分命名空间（`vocab:v3:u<id>` / `vocab:v3:guest`）。
  未登录期间的进度只允许并入**一个**账号，避免共用电脑时串号。
- **分模式台账**（本机，不上云）：`modes['c:w'] = { spell:{c,w}, choice:{c,w} }`。
  用途有二：报告里区分"认识 / 会拼"；拼写模式下**只做过选择题、没拼对过的词不算已掌握**，
  避免它因为"认词掌握"而再也不出现在拼写练习里。

## 5. 认词模式（看英文选中文）

一次认词练习的数据流：

```
quiz-index.json（有哪些章有题源）
      └─ 有 → quiz-N.json 里的精编干扰项 + 辨析        ← 语义质量最好
      └─ 无 → public/quiz.js 用同章词自动挑干扰项        ← 功能兜底，永远可用
                    ↓
           4 个选项（位置由 chapter:word 做种子打乱，同一题不跳位）
                    ↓
      点选项即判分 → 走原来的 applyResult（错题本 / 次日复现 / 每日目标 / 云端同步）
                    ↓
           答错：逐条列出每个干扰项的「辨析」；答对：给词根记忆点
```

- **干扰项类型**：`root` 同词根 / `form` 形近音近（含"只差一个字母"）/ `pos` 词性不同 /
  `sense` 近义 / `topic` 同主题 / `antonym` 反义。自动兜底时的排序与配额见 `public/quiz.js`。
- **只认不拼**：题源里标 `need: "read"` 的词不进拼写牌堆（选择题照常出现）。
- **设置**：练习方式（拼写 / 认词）、认词题干（**看英文 / 看中文 / 听音 / 随机**，三向混合）、答对自动下一题；
  都在设置抽屉里，随云端同步。
- **反向认词（看中文选英文）**：题面是大字中文释义，选项为英文词；`quiz-N.json` 可带 `rev` 精编反向干扰项（全库 3545/3568 词已精编，缺失走同章词兜底）；反向题在作答前不会朗读单词（防泄底）。
- **键盘**：`1-4` 或 `A-D` 选选项，`Enter` 下一题，`空格` 重读。

题源由**模型批量生成**（这正是"认词"最花人力的部分），流程：

```bash
node scripts/quiz.mjs prompt 21 --limit 50 --out prompt-21-1.md   # 1) 生成提示词
# 2) 把 prompt-21-1.md 贴给任意模型，把返回的 JSON 存成 content/quiz/21-1.json
node scripts/quiz.mjs merge content/quiz/21-1.json --chapter 21    # 3) 合并（先校验，有错不写入）
node scripts/quiz.mjs sample --chapter 21 --count 8                # 4) 人工抽查（打印页面上的那道题）
npm run check && npm run smoke                                     # 5) 门禁
```

**生成规范（务必先读）**：`docs/选择题资料生成规范.md` ——
干扰项六类与配额、辨析（`why`）写法与红线、正反例、可直接喂给模型的提示词区段、验收标准。
`npm run quiz:check` 只做**形式**校验（歧义、配额、字数、id 一致性）；
语义质量靠 `quiz:sample` 抽查 + 规范里的自检清单。

## 6. 词库维护

`public/data-N.json` 是唯一数据源，章节清单 `public/chapters.js` 由脚本生成，不要手改。

- 改词：直接编辑 `public/data-N.json`，然后 `npm run check` 校验。
  注意：题源里的 `why` 常常引用词根，改词根后建议跑一次 `npm run quiz:check` 看有没有失配。
- 新增一章：把 `data-23.js` 放到 `public/`，在 `scripts/convert-data.mjs` 的 `CHAPTER_META` 里补一条
  （标题 + emoji），执行 `npm run build:data`，再跑 `npm run check`。

## 7. 已知限制

- **单元测试 + 静态检查是本仓库的常规门禁**；端到端冒烟脚本 `scripts/smoke.mjs`
  需要本机能启动浏览器与 `wrangler dev`（CI 或本地）。
- `public/app.js` 仍偏大（刷词页的全部交互，约 2800 行）。纯逻辑已抽到 `core.js` / `quiz.js`，
  如果继续长大，建议按「抽屉/面板」再拆模块。
- **认词题源已全量精编**（22 章 3568 词，2026-09-20 完成“重建 + 逐题优化”，验收记录见 docs/质检报告-认词题源.md 与 docs/选择题资料生成规范.md v1.1）：
  校验 error 0；硬歧义/辨析错位/空话模板均已清零。残留警告级项：约 1000 条选项长度比在 40%~50% 区间（不影响判分）、少量“辨析在讲目标词本身”的软错位（选项释义无法追溯到词库的词上无法机判，需人工）。
- 分模式成绩（认识 / 会拼）与认词方向（看英文 / 看中文）不进云端台账，只存本机，换设备后重算。
- 反向题源（rev）覆盖 3545/3568 词：极少数找不到任何形近/同根词的词（如 ox）由同章词兜底出题。
- 离线可用性目前依赖浏览器自身缓存（词库 `max-age=3600`，HTML `no-store`），
  还没有 Service Worker / PWA 清单（计划里的可选项，未实现）。
- 语音朗读使用浏览器 `speechSynthesis`，iOS 需要用户手势触发；播放失败时界面会提示点 🔊。
