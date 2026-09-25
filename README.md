# 真经刷词神器（vocab-tool）

雅思核心词汇的**刷词练习 + 课程讲义**工具。前端是纯静态页面（无框架），后端是 Cloudflare Worker + D1，
账号、学习状态、讲义备注与配图都支持云端同步。词库共 **22 章 / 3568 词**，
认词题源（正向 + 反向）已 **100% 全量精编**并由校验器与逐题缺陷扫描把关。

**界面（第六期「单词即海报」）**：暖纸/墨舱双主题、衬线词面 hero 排版、墨格字母槽、
底部拇指操作坞 +「⋯」快捷菜单、顶栏每日目标环、讲义词卡 View Transition 与 ⌘K 命令面板；
结构性图标全部走内联 SVG sprite（禁 emoji，`npm run check` 设计 lint 把关），
配图/批注存 IndexedDB。设计规范见 `docs/UI现代化计划.md`。

- 刷词页 `/`（`index.html`）：两种答法 ——
  **拼写**（看中文 / 听音 / 随机，字母槽拼写）与 **认词**（**看英文选中文 / 看中文选英文** / 听音 / 随机，
  4 选 1 + 辨析）；错词自动复现；PWA 可安装、词库经 Service Worker 离线可用；**六色主题调色盘**（设置 → 外观，可选预设渐变或自定义取色，双页跟随、随云端同步）。
- 讲义页 `/课程讲义.html`：词根词源、例句、备注、配图、批注，卡片可一键跳到刷词页练这个词。
- 部署地址：<https://vocab.logicc.top>（push 到 main 自动部署，约 1 分钟）。

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

> ⚠️ 升级到按词存储版本**必须先跑 `npm run db:migrate`**：
> `user_word_state` / `user_notes` / `user_note_images` / `auth_throttle` 四张表。
> 旧版 `vocab_progress`（整章 JSON blob）会在用户第一次拉取学习状态时**自动迁移**为按词记录。
>
> 本次生词本/墓碑版本新增 `0006`~`0008` 三个迁移（`user_word_stars` / 重置与备注墓碑 / 旧迁移标记表），
> 同样**必须先 `npm run db:migrate` 再 `npm run deploy`**——Worker 代码已依赖这三张表，先部署会导致生词、
> 备注删除与整章重置接口全部 500。

## 2. 常用命令

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 本地开发（Worker + 静态资源 + 本地 D1） |
| `npm run deploy` | 部署 |
| `npm run db:migrate` / `db:migrate:local` | 应用数据库迁移（线上 / 本地） |
| `npm test` | 单元测试（192 项：核心逻辑、认词/反向出题、Worker 接口、跨页生词 LWW、会话守卫、前端异步守卫、认证与备份导入） |
| `npm run check` | 静态一致性检查（50 项：模块导入、词库清单、HTML 接线、CSS 变量、题源校验、双主题对比度门禁、**设计 lint**——组件裸 hex / 界面 emoji / outline:none / 外部字体源） |
| `npm run e2e` | 接口端到端（63 项，真实 workerd + SQLite；需先起 `npm run dev`） |
| `npm run smoke` | 浏览器冒烟（89 项，含反向认词 16 项与 PWA 离线；需 playwright + dev 服务） |
| `npm run verify:live` | **线上核验**（35 项，含反向认词；默认打 vocab.logicc.top，`--shot` 截图） |
| `npm run ui:baseline` | 视觉回归截图（5 场景矩阵 → `shots/baseline/`；需 dev 服务 + Chrome/Edge） |
| `npm run a11y` | axe-core 无障碍扫描两页（critical/serious >0 失败；需 `npm i --no-save playwright axe-core`） |

认词题源工具链：

| 命令 | 作用 |
| --- | --- |
| `npm run quiz:prompt -- 21 --limit 50 [--rev]` | 生成给模型的**出题提示词**（`--rev` 出反向版，提示词取自规范的 MODEL-PROMPT-REV 区段） |
| `npm run quiz:merge -- content/quiz/21-1.json --chapter 21` | 合并模型产出的题源分片（先校验，有错不写入） |
| `npm run quiz:check` | 校验全部题源（正向 + rev 侧规则）并重建 `quiz-index.json`（含 revCoverage） |
| `npm run quiz:sample -- --chapter 21 --count 8 [--rev]` | 打印"用户实际会看到的那道题"，人工抽查语义质量 |
| `node scripts/quiz-flag.mjs` | 逐题缺陷扫描（歧义/错位/模板/长度/万能项/同题重复）→ `_audit/work/N-flags.json` |
| `node scripts/quiz-fixlist.mjs` | 把缺陷标记整理成逐章修复清单 → `_audit/work/N-fixlist.json` |
| `node scripts/quiz-optimize.mjs` | 约束式逐题修复（text/why/kind/note 同源产出，跑完仍需 merge 收口） |
| `node scripts/quiz-rev-generate.mjs` | 反向（rev）题源全量生成器 |
| `node scripts/quiz-rebuild.mjs` | 从 `content/quiz/` 原始分片重建发布文件（推翻重来的专用通道） |

### 端到端测试（需要先起本地服务）

```bash
npm run db:migrate:local
npm run dev              # 另开一个终端
npm run e2e              # 接口层：静态资源头、鉴权、按词 LWW、备注配图、限流…
npm i --no-save playwright   # 仅装包，不下载浏览器（默认复用系统 Chrome/Edge）
npm run smoke            # 浏览器层：桌面/移动、拼写/认词/反向、断网、PWA 离线、双账号恢复
```

> smoke 会注册测试账号、写入本地 D1，因此**只跑本地**；线上核验用 `verify:live`（只读）。

### 上线后核验

本仓库没有 CI 配置——推送后由 GitHub 集成自动构建部署（约 1 分钟）。部署完可以跑：

```bash
npm run verify:live                          # 默认打 https://vocab.logicc.top
npm run verify:live -- https://vocab.logicc.top --shot   # 顺便截图到 shots/
```

## 3. 目录结构

```
worker/index.js        Worker 入口：认证 / 按词学习状态 / 讲义备注与配图 / 静态资源与缓存策略
migrations/*.sql       D1 表结构（0003 引入按词存储）
public/
  index.html           刷词页（结构 + 内联 SVG 图标 sprite；样式与逻辑全部外链）
  课程讲义.html         讲义页（同款 sprite）
  app.js               刷词页交互：输入、判分、牌堆、同步队列、认词/反向交互、各抽屉
  lecture.js           讲义页交互：卡片、详情（View Transition）、备注、配图压缩、批注、⌘K 命令面板
  core.js              纯逻辑核心（无 DOM）：判分、掌握判定、错词复现、统计、每日目标、分模式台账
  quiz.js              认词出题核心（无 DOM）：正反两向干扰项挑选、辨析文案、反作弊、可注入 rng
  ui.js                共用组件：主题、toast、确认框、输入框对话框、焦点陷阱、icon()/iconHTML()
  idb.js               IndexedDB KV 存储：配图/批注/画笔（含 localStorage 旧数据幂等迁移）
  vocab-auth.js        账号与云同步客户端
  chapters.js          章节清单（由 build:data 生成）
  data-N.json          分章词库（唯一数据源）
  quiz-N.json          分章认词题源：正向 distractors + 可选 rev（反向），spec 1.1
  quiz-index.json      题源清单（quiz:check 生成：覆盖数 + revCoverage）
  manifest.webmanifest / sw.js   PWA：可安装 + 词库 stale-while-revalidate 离线缓存
  tokens.css / ui.css / app.css / lecture.css   设计系统「纸与墨」（tokens v3，唯一色源）
scripts/
  convert-data.mjs / check.mjs / smoke.mjs / api-e2e.mjs / verify-live.mjs
  ui-baseline.mjs / a11y.mjs    视觉回归截图与 axe 无障碍门禁
  quiz.mjs / quiz-lib.mjs          认词题源 CLI 与校验器（规范 v1.1 的机器可判部分）
  quiz-flag.mjs / quiz-fixlist.mjs / quiz-optimize.mjs / quiz-rev-generate.mjs / quiz-rebuild.mjs
docs/
  UI现代化计划.md        第六期「单词即海报」：纸与墨设计系统、图标/动效/存储规范与执行对账
  选择题资料生成规范.md  v1.1：六类 kind、配额、辨析写法、红线、反向题（rev）、MODEL-PROMPT(-REV)
  规范审查意见.md        对规范本身的评审记录
  质检报告-认词题源.md    全量生成后的质检记录
  整改验收报告.md        本轮"审计→整改→反向认词→上线验收"的收口记录
  主题调色盘与界面优化计划.md  第四期：六色可选拾色盘（data-accent 架构 + 精调色值 + 验收门禁）
  archive/优化计划.md    第一~三期总计划（已执行完毕，仅存档）
content/quiz/          模型/引擎产出的题源分片（合并前的中间产物）
_audit/                审计脚本与可复跑的独立复核工具（lib.mjs 被题源工具链引用）
_archive/              历史"长度修复运动"的一次性脚本（仅作证据，禁止再运行）
test/                  core.test.js / quiz.test.js / worker.test.js / stars.test.js / session-guard.test.js / frontend-guards.test.js / auth.test.js / backup-import.test.js / fake-d1.js
```

## 4. 数据与同步模型

- 学习状态按 **(user, chapter, word)** 一行存储（`user_word_state`），状态为
  `learning / wrong / mastered`，并记录 `streak`（连续答对次数）、`wrong_count`、`due_at`。
- 判分规则：**连续答对 2 次判定掌握并移出错题本**；答错立刻回到错题本，并在次日到期复现。
  拼写与认词**共用这一份状态**（认识即掌握）。
- 冲突处理：每条记录带客户端逻辑时间戳 `seen_at`，服务端用
  `ON CONFLICT ... WHERE excluded.seen_at >= 现有.seen_at` 做**按词 LWW**，
  所以两端交替作答是合并不是覆盖。
- 客户端同步：脏检查 → 800ms 防抖 → 串行队列 → 失败指数退避重试（最多 30s）→
  单次最多 500 条切块上传；登录后会把本机历史记录整体补传一次。
- 生词本也按 **(user, chapter, word)** 同步到 `user_word_stars`：活动列表和带
  `starred=false` 墓碑的记录表分开保存；每条用客户端 `updated_at` 做 LWW，同
  毫秒冲突时删除优先，避免旧设备把已取消的生词复活。刷词页、讲义页、登
  录/聚焦/定时同步共用同一队列，切换账号会清空内存脏队列。
- 备份格式 v2 同时包含 `stars`（云端备份）或 `localStars` + `starRecords`（本机
  备份），导入会先按 LWW 合并，再拉取云端 canonical 值。
- 本地存档按账号分命名空间（`vocab:v3:u<id>` / `vocab:v3:guest`）。
  未登录期间的进度只允许并入**一个**账号，避免共用电脑时串号。
- **分模式台账与认词方向**（本机，不上云）：`modes['c:w'] = { spell:{c,w}, choice:{c,w} }`。
  用途：报告区分"认识 / 会拼"；拼写模式下只做过选择题、没拼对过的词不算已掌握。

## 5. 认词模式（正向 + 反向）

一次认词练习的数据流：

```
quiz-index.json（哪些章有题源；含 revCoverage）
      └─ 有 → quiz-N.json 的精编干扰项 + 辨析（正向 distractors / 反向 rev）
      └─ 无 → public/quiz.js 用同章词自动挑干扰项（功能兜底，永远可用）
                    ↓
           4 个选项（位置由 chapter:word:方向 做种子打乱，同一题正反向各自不跳位）
                    ↓
      点选项即判分 → applyResult（认词答对一次即掌握；错过的词进易错池并按权重复现）
                    ↓
      答错：逐条列出每个干扰项的「辨析」；答对：给词根记忆点（精编 note 优先）
```

- **出题方向**挂在 `quizPrompt` 设置上：`看英文 / 看中文 / 听音 / 随机`（随机 = 三向混合）。
  反向题（看中文选英文）题面是大字中文释义，选项是英文词；
  作答前英文词与发音都被隔离（空格与 🔊 再读都会提示防泄底）。
- **干扰项类型**：`root` 同词根 / `form` 形近音近（含"只差一个字母"）/ `pos` 词性不同 /
  `sense` 近义 / `topic` 同主题 / `antonym` 反义。反向题源禁用 `sense` / `pos`（语义原因，见规范 §11）。
- **只认不拼**：题源里标 `need: "read"` 的词不进拼写牌堆（选择题照常出现）。
- **键盘**：`1-4` 或 `A-D` 选选项，`Enter` 下一题，`空格` 重读。
- **操作补全**：`🙋 不会`（标生词 + 展示答案 + 计入易错）、`⏮ 上一个`（回看上一词补标生词）、`↺ 重置`（确认 + 可撤销）；答对后默认**停留**在当前题看解析（设置里可开自动跳题）。
- **🚩 报错**：辨析卡上一键反馈题目问题（选项过于相近 / 答案有误等）；后台经 `/api/quiz/report/export?token=ADMIN_TOKEN` 导出 CSV。

题源生成流程（正向与反向同一套规范与工具链）：

```bash
node scripts/quiz.mjs prompt 21 --limit 50 --out prompt-21-1.md         # 1) 正向提示词
node scripts/quiz.mjs prompt 21 --limit 50 --rev --out prompt-21-rev.md # 1') 反向提示词
# 2) 把 prompt 贴给任意模型，把返回的 JSON 存成 content/quiz/21-1.json
node scripts/quiz.mjs merge content/quiz/21-1.json --chapter 21         # 3) 合并（先校验，有错不写入）
node scripts/quiz.mjs sample --chapter 21 --count 8 --rev               # 4) 人工抽查（含反向）
npm run check && npm run smoke                                          # 5) 门禁
```

**生成规范（务必先读）**：`docs/选择题资料生成规范.md`（v1.1）——
干扰项六类与配额、辨析写法与红线、反向题（rev）专章、可直接喂给模型的提示词区段、验收标准。
`quiz:check` 只做**形式**校验（歧义、配额、字数、id 一致性、义项覆盖、万能项、同题 why 重复）；
语义质量靠 `quiz:sample` 抽查 + `quiz-flag` 扫描 + 规范里的自检清单。

**重要纪律**：禁止任何脚本事后只替换 `text`（`why`/`kind` 会与选项错位——历史事故 916 条的根因）。
要改题就整条重产出，走 `merge` 校验收口。

## 6. 词库维护

`public/data-N.json` 是唯一数据源，章节清单 `public/chapters.js` 由脚本生成，不要手改。

- 改词：直接编辑 `public/data-N.json`，然后 `npm run check` 校验。
  注意：题源里的 `why` 常常引用词根，改词根后建议跑一次 `npm run quiz:check` 看有没有失配。
- 新增一章：把 `data-23.js` 放到 `public/`，在 `scripts/convert-data.mjs` 的 `CHAPTER_META` 里补一条
  （标题 + emoji），执行 `npm run build:data`，再跑 `npm run check`。

## 7. 已知限制

- **题源残留（警告级，机器不可约）**：约 180 条干扰项长度比在 2.0~2.5 倍之间（集中在"现象"类
  超短释义词——topic 限同章导致短候选不足）；约 24 处"辨析在讲目标词本身"的软错位
  （选项释义无法追溯到词库，机器不敢改，需人工）；反向 rev 覆盖 3555/3568（12 个词无任何
  形近/同根词，由同章词兜底出题）。随时可用 `node scripts/quiz-flag.mjs` 复查。
- **分模式成绩与认词方向只存本机**，换设备后重算（上云需改 D1 表与同步协议，收益不匹配）。
- **易错词权重只存本机**（随存档持久化，不进云端协议）：错过的词永久留在易错池（答错权重升、答对降、永不归零），只有手动删除才移除；换设备后权重重算。
- **PWA**：manifest + Service Worker（词库 stale-while-revalidate、页面网络优先）已上线；
  但 shell 预缓存仍是最小实现，离线时讲义页的配图不保证可用。
- **单元测试 + 静态检查是常规门禁**；e2e/smoke 需要本地起 dev 服务与浏览器，未接 CI。
- `public/app.js` 仍偏大（刷词页全部交互）。纯逻辑已抽到 `core.js` / `quiz.js`，
  如果继续长大，建议按「抽屉/面板」再拆模块。
- 语音朗读使用浏览器 `speechSynthesis`，iOS 需要用户手势触发；播放失败时界面会提示点 🔊。
