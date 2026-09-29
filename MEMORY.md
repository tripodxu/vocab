# MEMORY · 项目记忆（**最新在最上面**）

> 格式约定：**倒序**——最新条目永远在最顶部；每条含「结论 / 落点 / 影响」。
> 用途：任何 agent 或人接手前，先读本文件顶部 10 行即可知道"现在是什么状态、最近发生了什么"。
> 常青约定（长期有效）单独放在最前面，避免被时间线冲掉。本文件的 `.workbuddy` 副本同步维护。

---

## 一、常青约定（长期有效，不随提交变化）

| 主题 | 约定 |
| --- | --- |
| 技术栈 | Cloudflare Worker + D1（按词存储）；前端无框架原生 JS（ES Module），双主题「纸与墨」 |
| 数据规模 | 22 章 / 3568 词；认词题源 100% 精编（正向 + rev 反向），spec v1.2（why/note ≤120 字、禁硬截断） |
| 文档纪律 | `docs/选择题资料生成规范.md` 被 check.mjs 硬引用（**不可改名/删除**）；`frontend-guards.test.js` 正则断言 app.js 源码片段；**单一事实源**：设计→`docs/设计规范.md`，代码/发布→`docs/项目规范.md`，目录→`docs/目录结构.md`（AGENTS §4 只是速查） |
| 依赖方向 | `quiz-lib.mjs`（纯逻辑）← `quiz-data.mjs`（数据层）← `quiz*.mjs` ← `_audit/**`；**生产代码禁止 import `_audit`/`_archive`** |
| 文档升版 | 题源规范改版本必须同步 `quiz-lib.mjs` 的 `QUIZ_SPEC_VERSION` + 各 `quiz-N.json` 的 `spec` + 跑 `quiz:check` |
| 状态模型 | 按 (user, chapter, word) 一行；连续答对 2 次判掌握；按词 LWW（`seen_at`）合并 |
| 本机-only 数据 | 易错权重、分模式台账（spell/choice）、答题快照 `answerLog` —— 不上云，换设备重算 |
| 唯一数据源 | `public/data-N.json`；`chapters.js` 由 `build:data` 生成，禁止手改 |
| 门禁 | `npm test`(215) + `npm run check`(66) 是**最低**完成标准；动题源加 `quiz:check`，改前端加 `build:assets` |
| 发布 | push main → 自动部署（~1min）；**先 `db:migrate` 后 `deploy`** |
| 视觉纪律 | 禁 emoji（SVG sprite）、CSS 禁裸 hex（tokens 变量）、文案禁止硬截断 |

---

## 二、变更时间线（倒序）

### 2026-09-30 · 前端优化计划全量落地（三期 + 第一轮拆模块）

- **计划**：`docs/前端优化计划.md`（已升 v1.4，每项都有「✅ 落地情况」）。12 项全部落地，其中 4 项前提被证伪已就地更正。
- **指纹缓存（1.1）**：用**查询串** `data-1.json?v=<hash8>` 而不是改文件名——引用点零改动、不产生幽灵文件，收益等价。
  `contentHash()`（sha256 前 8 位）产出，词库指纹进 `chapters.js`、题源进 `quiz-index.json` 的 `hashes`；
  worker 命中即发 `immutable`，SW 走 `cacheFirst`，题源缓存键 `QUIZ_CACHE_KEY(id, hash)` 同步带指纹。
- **esbuild 构建（5.2）**：`npm run build:assets` → `public/dist/`，JS 用 bundle+splitting（共享 chunk 跨页复用），
  CSS 逐个 minify（保持跨页同 URL 命中缓存）。app.js 141→77KB。`dev` 挂 `predev`、`deploy` 显式串构建，
  `check` 第 10 节比对 manifest 源码指纹防漏构建。**`public/dist/` 不入库、禁止手改**。
- **三个会让测试「假绿」的坑**：① SW 的 `ADMIN_PATH` 要连 `dist/admin.<hash>.js` 一起匹配，否则后台产物落进 PWA 离线缓存；
  ② smoke 的 `page.route("**/data-*.json")` 匹配不上带查询串的 URL，必须换正则 `/\/data-\d+\.json/`；
  ③ `caches.match("/data-1.json")` 要加 `{ ignoreSearch: true }`。
- **拆模块（6.1/6.2 第一轮）**：app.js → `state.js` + `storage.js` + `speech.js`；lecture.js → `lecture-store.js`。
  **先拆 state 再拆其它**（否则反向依赖成环）。键名函数去掉 `userKey = state.userKey` 默认参数改为强制显式传，修掉一处漏传。
  下一步：sync.js / render / 画笔（画笔要先抽 `lecture-context.js`，且冒烟对它的覆盖很薄）。
- 门禁：test 215✅ · check 66/66✅ · e2e 69/69✅ · smoke 105/105✅（sw v9→v10）。

### 2026-09-28 · 题源截断全量收口：三种损伤形态，补 2876 条

- **背景**：历史题源被 40 字上限 slice 过。原以为只有"句末带「…」"一种（fix-truncated-why.mjs Pass 1 已修 1561 条），
  实际还有两种更隐蔽的，且**扫描器对它们完全看不见**（报 FLAGGED=0 是假绿）。
- **三种损伤形态**（已写进 `docs/选择题资料生成规范.md` 红线 14）：
  ① 末段带省略号 `tax 指税 v. 对...`；② **末段无省略号**（纯 slice，`frame 指（画`，884 条，占大头）；
  ③ **开头缺词名**（生成时 other 为空，把「\<other\> 指X」拼成「指X」，与字数无关，464 条）。
- **修法**（`scripts/fix-truncated-why.mjs` 三个 Pass，全部带校验、宁缺毋滥）：
  Pass 2 按词库补全末段到**完整第一义项**（**不要求句末有省略号**——这是原先漏掉 884 条的根因）→ 942 条；
  Pass 3 补回开头词名，反查口径「同章第一义项 == sense，**唯一命中才补**」，另加 sense 自身被砍时先补 sense 再反查、排除本题词 → 373 条。
- **扫描器同步收紧**（`quiz-truncation-scan.mjs`）：判定从"前缀匹配即 EXEMPT"改为"**相等**才 EXEMPT"（原逻辑必然把截断误判成词库自带），
  并新增 `SILENT_CUT` / `HEADLESS` 两个维度。现输出：SILENT_CUT 0 · FLAGGED 0 · HEADLESS 91。
- **剩余 91 条 HEADLESS 属人工项**（`npm run quiz:scan:truncation -- --json` 导出）：同章同义词成片无法定夺（moist/damp/humid）、
  或词不在本章。试过放宽到"任意义项段"反查——只多救 7 条且会把本题词补成 other（exquisite/shrink），**已放弃**，不要再去放宽。
- **坑**：词库释义本身用 `......`（6 个英文句点）表省略（`tax = 税 v. 对......征税`），
  任何"以「…」结尾才算截断"的判定都会整批漏；判定必须用 `/(?:…|\.{2,})\s*$/`。
  另：`per cent 指百分之......` 是词库原文、**不是截断**，白名单别误伤。

### 2026-09-28 · 文件结构优化：依赖方向修正 + 一次性脚本归档

- **结构矛盾**：4 个生产脚本（quiz-flag / quiz-optimize / quiz-rev-generate / quiz-truncation-scan）反向 import
  `_audit/indep/lib.mjs`——而 `_audit/` 被硬约束标注"禁止运行"。新增 **`scripts/quiz-data.mjs`**（数据层：loadAll / 建索引 /
  相似度 / why 解析 / 模板匹配）承接共用函数，生产脚本改引本地；`_audit/indep/lib.mjs` 转为转发层（审计脚本 s1~s9 不受影响）。
  分工固定：`quiz-lib.mjs` 纯逻辑可单测 · `quiz-data.mjs` 需要读词库/题源。
- **归档**：`scripts/{analyze-length,fix-length,gen-length-fix}.mjs` → `_archive/length-fix/`；`_archive/` 按运动分组为
  `length-fix/` + `quiz-fix/`，新增 `_archive/README.md`（说明 `.v1` = 更早版本，脚本已被 `quiz-optimize.mjs` 取代）。
- **清理**：`.zcode/skills/...` 误入库文件 `git rm --cached`（本地保留）。
- **新增 `docs/目录结构.md`**：顶层分层表 + **依赖方向（禁止生产代码 import `_audit`/`_archive`）**；AGENTS §2、硬约束 11、项目规范 §6、README 目录树同步。
- 落点：`scripts/quiz-data.mjs`（新）、4 个脚本 import、`_audit/indep/lib.mjs`、`_archive/**`、`docs/目录结构.md`、`README.md`。

### 2026-09-28 · 文档整理：单一事实源 + 规范版本化（v1.1 → v1.2）

- **题源规范升版 v1.2（实质变更）**：`why` / `note` 上限 40/60 → **120 字**，并写入「禁止硬截断」红线 14。
  同步改代码：`scripts/quiz-lib.mjs` 的 `QUIZ_SPEC_VERSION` 1.1 → **1.2**、22 个 `public/quiz-N.json` 的 `spec` 字段，
  `quiz:check` 重建索引通过。此前文档写 40 字、代码已是 120，属"规范与校验器脱节"，现已对齐。
- **新增 `scripts/quiz-truncation-scan.mjs`**（`npm run quiz:scan:truncation`）：扫描句末省略号，
  自动区分「真截断 FLAGGED」与「词库释义自带 EXEMPT」（如「百分之……」），已内置 1 条人工确认的修辞白名单；当前 **FLAGGED = 0**。
  它是诊断工具，不是门禁（校验器故意不判此项，避免误杀）。
- **拆出常青设计规范**：`docs/设计规范.md`（tokens v3 纸与墨 / 排版 / 色彩 / 动效 / 图标 / 设计 lint / 遗留项），
  `UI现代化计划.md` 与 `规范审查意见.md` 归档到 `docs/archive/`（后者顶部标注"结论已被 v1.2 推翻"）。
- **文档单一事实源**：`docs/README.md` 新增 §1 单一事实源表 + 全量文档清单（18 份逐个登记）；
  `AGENTS.md` §4 定位为"速查版"，权威归 `docs/项目规范.md`，两处不再各写一份条文。
- 落点：`docs/*`、`README.md`、`AGENTS.md`、`MEMORY.md`、`scripts/quiz-lib.mjs`、`public/quiz-*.json`、`package.json`。

### 2026-09-28 · 刷词体验四项优化 + 文档体系规范化

- **辨析不再截断**：生成端（quiz-optimize / quiz-rev-generate）与运行时（`quiz.js` reverseWhy）去掉 40/60 字硬截断，`WHY_MAX/NOTE_MAX` 放宽到 120；新增 `scripts/fix-truncated-why.mjs` 按原模板反推补全存量 **1561 条**半截文案（前缀校验，宁缺毋滥），`quiz:check` 通过。
- **答对也显示辨析、取消自动下一题**：`renderQuizNote` 答对时「记忆」下也逐条列干扰项辨析；删除 `scheduleAutoNext`/`clearAutoNext`/`autoNextHandle` 与设置里「答对自动下一题」开关（字段 `settings.autoNext` 仅为云端兼容保留）。
- **错题复现换序**：`ensureQuestion` 按本轮出现次数（`deckOccurrencesBefore`）换种子 `key#rN`，复现时干扰项与选项顺序重排；`buildChoiceQuestion` 新增 `opts.seed`。
- **上一题保留作答状态 + 重置本题**：`state.answerLog`（牌堆位置 → 快照：kind/values/cursor/chosen/hintIdx）；`prevBtn`/`advance` 走 `renderWord({restore:true})`；新增 `#resetQBtn`（答后可见，`keepKind` 重答）。快照按 wordId 校验防牌堆错位，**仅内存、刷新即失**。
- **附带修复**：`test/core.test.js` 每日 streak 用例日期敏感（`recordDaily` 默认用真实系统日期）→ 传入固定 `nowRef`；`test/quiz.test.js` 造数随 WHY_MAX=120 调整。`sw.js` VERSION v5→v6。
- **文档体系**：新增 `AGENTS.md`（agent 入口·三层读取法·硬约束）、`docs/README.md`（文档索引 + 文档规范）、`docs/项目规范.md`、`docs/agents/{模块地图,协作与接力规范,任务卡与交接模板,接力看板}.md`；已完成的计划/报告归档到 `docs/archive/`。
- 落点：`public/app.js`、`public/quiz.js`、`public/index.html`、`public/quiz-*.json`、`scripts/*`、`test/*`。

### 2026-09-25 · 后台管理与学习报告收口

- `feat(admin)`：`/admin.html` + `/api/admin/*`（Bearer `ADMIN_TOKEN`，未配置返回 503，令牌比较先 SHA-256 归一），报错可导出 CSV、状态闭环（迁移 `0009` 加 `status` 列）。
- `feat(report)`：`报告.html` 学习报告控制台（今日环/连续最佳累计、近 7 天活跃、22 章进度矩阵、跨章易错、分模式正确率），两页顶栏入口；除"我的报错"外全部本地聚合。
- `feat(sync)`：生词本云端同步（`user_word_stars`）+ 重置/删除持久化墓碑（按条 LWW，同毫秒删除优先）；两页接入、多标签会话守卫加固。
- `fix(ui)`：移动端操作坞挤压重叠、讲义空态残留竞态、进度条动画；`fix(scripts)`：`db:migrate` 补 `--remote`、verify-live 网络重试与轮询等待。

### 2026-09-22 · 第六期「单词即海报」UI 重构

- 纸/墨双主题 + 衬线词面 hero + 墨格字母槽 + 底部拇指操作坞 +「⋯」快捷菜单 + 顶栏目标环；滚动条细化、小屏菜单可滚、讲义无配图时空区块修复、标星闪光 `classList.add` 多词元抛错修复。
- 设计系统详见 `docs/设计规范.md`（tokens v3）。

### 2026-09-21 · 第五期：掌握判定、易错权重、举报、词汇书导入

- 掌握与易错权重（core.js 纯函数可单测）；错词权重升/对降、永不归零；`🙋 不会`、`⏮ 上一个`、`↺ 重置`、🚩 报错；词汇书导入与题源生成指南。计划见 `docs/archive/第五期计划.md`。

### 2026-09-20 · 题源整改 + 第三期反向认词 + PWA

- 全量 3568 题逐题整改（P0 模板 why、辨析错位 916 条等），校验器升级到 spec v1.1；反向认词（看中文选英文）上线，作答前隔离英文与发音；PWA（manifest + SW 离线）。
- 教训沉淀：**禁止任何脚本事后只替换 `text`**（错位根因）。

### 2026-09-18 ~ 09-20 · 认词模式与题源规范建立

- 认词（看英文选中文）上线，`docs/选择题资料生成规范.md` v1.1 定稿（六类 kind + 配额 + 辨析红线 + 反向专章 + MODEL-PROMPT）。

### 2026-09-16 ~ 09-17 · 全量同步、UI 现代化、端到端补洞

- 按词同步（progress/settings/删除传播）、无缓存头防陈旧、UI 全面重做（玻璃拟态）、隐藏状态卡常显 bug 修复、加线上核验脚本 `verify-live`。

### 2026-09-16 · 初始化

- `cdd78c0 init`：CF Worker 后端 + 认证 + 云同步的最小可用版本。

---

## 三、反复踩过的坑（按症状索引）

| 症状 | 原因 / 解法 |
| --- | --- |
| 单元测试随日期推移失败 | `recordDaily` 默认 `nowRef = new Date()`；测试写死日期 → 必须传固定 `nowRef` |
| 改了 app.js 异步逻辑后 frontend-guards 失败 | 该测试用正则断言源码片段（同步守卫），重构需同步改测试 |
| 部署后接口 500 / 缺表 | 忘了 `npm run db:migrate`（必须先于 deploy） |
| 老用户看不到新界面 | SW 缓存；改静态资源后递增 `public/sw.js` 的 `VERSION` |
| 题源辨析与选项对不上 | 脚本只替换了 `text`；应整条重产出 + `quiz.mjs merge` |
| `npm run check` 报"缺少规范文档" | `docs/选择题资料生成规范.md` 被硬引用，不可改名/删除 |
| 辨析显示成半句话 | 生成端历史硬截断；上限已放宽，存量由 `fix-truncated-why.mjs` 修复 |
