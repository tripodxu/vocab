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
| 门禁 | `npm test`(217) + `npm run check`(69) 是**最低**完成标准；动题源加 `quiz:check`，改前端加 `build:assets` |
| 发布 | push main → 自动部署（~1min）；**先 `db:migrate` 后 `deploy`** |
| 视觉纪律 | 禁 emoji（SVG sprite 唯一定义在 `ui.js`）、CSS 禁裸 hex（tokens 变量）、层级只用 `--z-*` 阶梯、文案禁止硬截断 |

---

## 二、变更时间线（倒序）

### 2026-10-29~30 · 全功能验收（35 项用户走查）→ 修复四处发现 → 部署并线上复验

- **验收**：五层门禁实跑全绿（test 217 / check 69 / e2e 69 / smoke 105 / a11y 8×0）+ 自建 35 项真实用户走查
  （34 过），报告见 `docs/archive/验收报告-2026-10-29.md`（含逐条根因与线上核验附录）。
- **修复（5 提交，sw v21→v22，已推送部署）**：
  ① `afbfcc7 fix(lecture)`：词头过渡 `cleanup()` 挪进 `startViewTransition` 更新回调——原先新快照树里
  词头与详情标题同名 `word-hero`，浏览器放弃整个过渡，**动画自上线起从未生效**且每次开详情一条 console error；
  ② `ac517ae fix(sync)`：**注册丢偏好的真根因是 applyUser 合并顺序**——先 `normalizeSettings(scoped)` 把内存
  设置重置成账号命名空间默认值，随后 guest 合并的"内存优先"实际是"默认值优先"；改为覆盖前捕获
  `memorySettings`，另在 `syncPull` 云端 settings 为 null 时种子上云。探针复验：访客翡翠→注册→刷新保持；
  ③ `5c1ff25 polish(report)`：「连续天数」→「连续达标」（口径＝连续达成每日目标，core.js `recordDaily`）；
  ④ `8e19c03 polish(lecture)`：⌘K 占位符标明仅限本章（跨章全局搜索列为后续项）；
  ⑤ `c03aeee chore(release)`：sw v22 + dist 重建。
- **线上复验**：部署后 `verify:live` **36/36** 全绿；playwright 线上 7/7（四修复点 + SW v22 + 0 console error，
  F1 用真实注册账号验证——生产库多一个 `livefix_*` 一次性账号）。
- **坑（本机）**：① dev 页面加载的是 `dist/` 指纹产物，改源码后必须 `npm run build:assets` 再用浏览器验证，
  否则"改了没生效"是假象；② 本机 workerd 照旧崩溃循环（crash #14），对策＝起服务与跑测试放同一条命令不留空闲窗口；
  ③ `git commit` 挂起＝Windows gpg-agent 没起来，且 `gpg.program` 指向 `C:\Program Files (x86)\GnuPG\bin\gpg.exe`
  ——**必须拉起 Windows 侧 agent**（`"C:\Program Files (x86)\GnuPG\bin\gpg-connect-agent.exe" /bye`），
  MSYS 的 gpg-connect-agent 无效；口令在 pinentry-w32 弹窗输入一次后本会话内复用。
- **遗留**：⌘K 跨章全局搜索、wrangler 4.132.0→4.155.0 升级（本机 dev 崩溃循环疑似相关）、
  verify:live 建议常态跑在稳定网络/CI。

### 2026-10-28（拆分 3/3）· 抽出 brush.js（讲义整页画笔），check 68→69

- **背景**：lecture.js 2056 行，其中「整页画笔」（全屏 canvas 绘制 + 按章节持久化/恢复）约 450 行，
  与词卡渲染、搜索筛选没有交集。
- **做法**：新建 `public/brush.js`（280 行），导出 `brush` 状态对象与 `initBrush / detachBrush /
  flushBrush / resizeBrush / restoreBrush`；lecture.js 2056 → 1808 行。
- **关键解耦**：`isBrushInstanceActive` 里要判断"上下文是否仍属当前会话"（chapterEpoch / authEpoch /
  currentDetail），这属于 lecture 的会话模型 → 改成 `initBrush({ getContext, isCurrent })` 注入，
  未初始化时默认 `() => false`（宁可不画，也不默认可信地画到别的账号上）。
- **坑（与上一轮 `stateKey` 同类）**：抽完首跑报 `isLectureContextCurrent is not defined`——
  只搬函数、没搬它引用的判定函数。**页面照常渲染、只有一条 pageerror**，靠绘制探针才发现。
  规律记牢：搬函数必须连「它引用的常量 / 判定 / 工具函数」一起搬或注入。
- **验证**：探针实测 绘制 672px → 关闭隐藏 → **重载后恢复 672px**（IDB 持久化正常）、零报错；
  guards 的 `brushContext` 断言改为 `initBrush({ getContext…, isCurrent: isLectureContextCurrent })`
  并新增 brush.js 单向依赖断言。
- **门禁**：test 217 / check 69 / e2e 69 / smoke 105 / a11y 8×0（sw v20→v21）。

### 2026-10-28（拆分 2/3）· 抽出 sync.js（同步队列），check 67→68

- **背景**：同步是"会不会丢数据"的核心路径。抽它必须先解决两处反向依赖——页面侧的
  `renderSync`（状态灯）与 `persistSettingsToUi`（设置回填）。
- **做法**：新建 `public/sync.js`（265 行）：脏标记 / 防抖 / 串行队列 / 退避重试 / 关页补发 /
  会话世代（`userEpoch` 用 live binding 导出）。app.js 保留 `transitionUserSession`（浮层与计时器
  属页面侧）与 `syncPull`（设置合并 + 回填 UI），3852 → 3848 行。
- **解耦**：`setSyncNotifier(renderSync)` 端口回调替代 "sync.js → app.js" 的反向 import；
  `beginSyncSession()` 接走 userEpoch/sessionGuard/队列与游标重置。
- **坑（smoke 抓到，单测与 check 都抓不到）**：搬 `scheduleFlush` 时漏了两个模块级依赖——
  常量 `FLUSH_MAX_WAIT` 与 core 的 `stateKey`，运行期报 `stateKey is not defined`，
  表现为"点选项不判分 / 切认词不出题"，而页面照样渲染、控制台只有一条 pageerror。
  **教训：搬函数要连它引用的常量与工具函数一起搬；这类错误只有 smoke 全流程能兜住。**
- **guards**：`flush`、`flushOnLeave`、`markSettingsDirty` 三处断言改指向 sync.js
  （实现搬了断言跟着走，否则对着空切片始终失败），另加 sync.js 单向依赖断言。
- **门禁**：test 217 / check 68 / e2e 69 / smoke 105 / a11y 8×0（sw v19→v20）。

### 2026-10-28（拆分）· 抽出 dom.js（拆分第一步），check 66→67

- **背景**：app.js 4042 行，任何后续拆分（sync / render / brush）都要先共享同一份句柄表；
  而 `cacheDom()` 里的 60 个 `$("#id")` 写在 app.js，直接搬走会让 `check` §3d（扫 app.js 的 `$("#id")`
  核对 HTML 里有没有对应 id）**静默失去覆盖（假绿）**。
- **做法**：新建 `public/dom.js`（导出 `cacheDom()`，只依赖 `ui.js` 的 `$` 与 `state.js`）；app.js 改为
  `import { cacheDom } from "./dom.js"`。`state.dom` 仍是唯一句柄表，各函数 `const dom = state.dom` 一行不改。
- **门禁同步**：check §1 模块可导入清单加 `dom.js`；§3d 新增 `also` 字段（index.html 同时扫
  `app.js + dom.js`），实测引用 id 仍 60 个、全部命中 → 覆盖没掉。**check 66 → 67 项**，已同步
  AGENTS / README / 项目规范 / 协作规范 / 本文件常青行（历史条目里的 66 不改，那是当时的证据）。
- **guards**：新增 `dom.js` 反向依赖断言 + app.js 的 `cacheDom` 导入断言（test 仍 217 项）。
- **门禁**：test 217 / check 67 / smoke 105 / a11y 8×0（sw v18→v19）。
- **下一步**：`sync.js`（抽 flush/syncPull/markDirty 一带，需同步更新 frontend-guards 里 15 条正则），
  再 `render/*.js` 与讲义 `brush.js`。

### 2026-10-28（动效）· 主题切换改 View Transitions 交叉淡入 + 入口模块预载

- **主题**：此前是硬切（设计规范遗留项）。新增 `ui.js` 的 `setThemeAnimated()`：设置里主动切换走
  `document.startViewTransition`（240ms 根快照交叉淡入）；不支持或 `prefers-reduced-motion` 时退回瞬时。
  **首屏主题脚本与跨标签页 storage 跟随仍走 `theme.apply()`（不参与过渡）**，所以不与"防闪白"打架。
  实测：一次切换只触发 1 次 `startViewTransition`，`data-theme` 与 `vocab:theme` 同步、零 pageerror。
- **预载**：四页 `<head>` 加 `<link rel="modulepreload" href="app.js">`（构建自动改写为 `dist` 指纹路径）。
  实测 app chunk 只有 1 次请求（预载与 module script 去重），不会双下载。
- **文档**：设计规范 §1.3 补主题过渡、§4 遗留项标记已解决、变更记录新增一行。
- **门禁**：test 217 / check 66 / smoke 105 / a11y 8×0（sw v17→v18）。

### 2026-10-28（优化）· 无障碍验收：a11y 扩到四页并修好 CSP 注入，三个语义色补齐 AA

- **发现（两件事）**：① `npm run a11y` 一直是坏的——`page.addScriptTag` 注入 axe 会被 worker 的
  CSP（`script-src 'self'` + 哈希白名单）拦下，真机上必 exit 1，说明这个门禁长期没人跑通；
  ② 覆盖只有「两页 × 浅色」，报告页 / 后台页 / 深色主题从未过 axe。
- **改法**：注入改 `page.evaluate(axeJs)`（CDP 侧求值不经过页面 CSP）；矩阵扩为**四页 × 明暗 = 8 次扫描**。
- **axe 抓到的真问题**（浅色）：讲义 `.tag-core` 22 处、报告 `.ch-meta .wrong` 22 处 serious → 修后
  `.tag-recog` 3 处 → 全零。根因是语义色只测过白底。
- **色值修正**（三处都只动浅色文字色，`*-soft` 淡底保留原色相）：
  `--bad #c9372c→#b3261e`（次面板 4.46→5.6）、`--warn #a75a09→#8b4a0a`（4.42→5.9）、
  `--ok #0a7f58→#076a4a`（4.33→5.7）。`check` §6 把三者纳入「面板 + 次面板」双基座，防回归。
- **瘦身**：删 5 个从未被 `var()` 引用的死令牌（`accent-grad` / `bg-glow-2` / `glow` / `grid` / `dock-h`，39 行）；
  sprite 28→24（删 `cloud` / `skip-fwd` / `skip-back` / `check`）；讲义画笔 FAB 的 `z-index:70` 改
  `var(--z-fab)`（此前 z 阶梯定义了却没被用上）。
- **坑**：`npm i --no-save axe-core` 会把之前 `--no-save` 装的 playwright 当 extraneous 清掉，
  必须 `npm i --no-save playwright axe-core` 一起装。
- **门禁**：test 217 / check 66 / smoke 105 / **a11y 8 个页面×主题 0 违规**（sw v16→v17，dist 重建）。

### 2026-10-28（收口）· 五日提交集中收口：功能零缺失，修 3 处代码 + 8 处文档漂移

- **范围**：10-23~10-28 共 9 个提交（a9b24c5 → 6339129）；工作区干净、HEAD = origin/main。
- **判定**：功能面无缺失、无已知回归。证据：`npm test` 217 / `check` 66 / `e2e` 69 / `smoke` 105 /
  `verify:live` 36 全部**本轮实跑**；能力 → 证据的逐项矩阵见 `docs/archive/收口报告-2026-10-28.md` §3。
- **代码修复**：① `app.js` 注释与 `function openReportSheet` 被挤在同一行（`*/function`）；
  ② 3 处注释 emoji（🚩×2 / 🙋，`check` 剥注释所以没拦）；③ 弹层锁 `body` 滚动补 `padding-right`
  补偿——桌面经典滚动条消失会让整页横移 ~15px（headless 是 overlay 滚动条，测不出，靠公式补）。
- **文档纠偏（8 处，均为"与代码不符"）**：`MEMORY.md` 与当日日志把 theme-color 记成 `#f7f4ee`/`#14161f`
  （实际 `#f7f5f1`/`#101218`，`git log -S "#f7f4ee"` 证明代码从未用过该值）；`AGENTS.md` 3900→4100 行、
  verify:live 35→36；`README.md` 35→36；`docs/项目规范.md` 3900→4100；
  **`docs/目录结构.md` 把 `public/dist` 写成"`.gitignore` 已忽略"（实为已入库）**——这条最危险，
  照它办事会重演 10-27 白屏；`docs/README.md` 里前端优化计划"执行中（v1.0）"→"已落地 v1.4"。
- **新增**：`docs/archive/收口报告-2026-10-28.md`（提交矩阵 / 功能完整性 / 逐条风险判定 / 残留观察），
  已在 `docs/README.md` 文档清单登记。
- **踩坑**：核对色值别信文档，直接 `grep public/*.html public/ui.js`；文档里的历史色值可能是草稿期抄错的。

### 2026-10-28（第二轮）· tokens v4：层级/结构/可访问性深化，已推送部署

> 与同日上一条「四页视觉现代化」的区别：上一轮收敛装饰与层级（配色/阴影/toast 位置），
> 这一轮动的是**系统层**——z 阶梯、动效节奏、结构去重（sprite）、键盘与偏好适配。

- **z-index 阶梯**：tokens 新增 `--z-dock 15 / --z-menu 20 / --z-sticky 30 / --z-overlay 60 / --z-fab 70 /
  --z-canvas 80 / --z-toast 90`，替换四页散装的 15/20/30/60/70/80/90（含 lecture 的 `#globalCanvas`、
  `#brushToggle` 内联 70）。**新增浮层只许挂档，不许写数字。**
- **动效**：新增 `--ease-in`（退场用；toast 退场从 `--ease` 改 `--ease-in`）；词卡错落入场
  （`buildCard(word, animate, stagger)` 写 `--enter-i` 0-7，CSS `animation-delay: calc(var(--enter-i,0) * 35ms)`，
  封顶 245ms）；输入位 `.slot.cursor` 加 `caret-breathe` 呼吸光环；`.dock-star[aria-pressed="true"]` 补强调视觉态
  （aria-pressed 本就由 app.js 维护，纯 CSS 增强）。
- **结构去重（重点）**：四页 HTML 的 28 符号 sprite 块（112 行逐字重复）收编到 `ui.js` 的 `SPRITE_HTML` +
  `ensureSprite()`，**模块求值时同步注入**（早于各页 init 与首帧，静态 `<use href="#i-*">` 不会晚一帧）；
  `typeof document !== "undefined"` 守卫保证 `check.mjs` 在 Node 里 import 不炸。HTML 体积 14138→10272 等。
- **可访问性**：① 四页 `.skip-link`（`跳到主内容` → `main#main[tabindex=-1]`，报告页指 `#reportRoot`），
  `html` 加 `scroll-padding-top` 与 `scroll-behavior`（reduced-motion 下降级）；
  ② 弹层 `openLayer` 锁 `body` 滚动（嵌套浮层计数防提前解锁）；③ `touch-action: manipulation` 去掉触屏 300ms 迟滞；
  ④ `::placeholder` 走 `--text-3`（UA 默认灰深色下不可读）；⑤ 搜索框清除钮用两道渐变画 ×（无图片请求）；
  ⑥ `text-size-adjust: 100%`、`text-wrap: pretty`；⑦ `prefers-contrast: more` 只加深 `--line`/`--line-2`。
- **令牌补全**：`--scrim`（浅暖墨 `rgba(28,22,14,.42)` / 深浓墨 `rgba(4,6,12,.66)`，替换 ui.css 写死的 `rgba(8,12,22,.62)`）；
  `--sp-6: 32px`（桌面题面上留白 `sp-5`→`sp-6`）；`.topbar-inner` 描边 `--line-2`→`--line`（吸顶栏在内容上更立得住）。
- **坑**：`--enter-i` 只在 JS 内联写入时，`check` §5「变量必须有定义」会判失败 → 必须在 `.grid` 里给默认值 `0`。
- **门禁**：test **217/217** · check **66/66** · smoke **105/105**（sw v14→v15，dist 已重建）。
  另用 playwright 目检 6 态截图（1280/390 × 明暗 × 三页 + skip-link 聚焦态）：sprite 28 符号注入正常、
  无 JS 报错、skip-link 聚焦后 top 12px 可见。
- **上线**：提交 `c7c8686`，push main 自动部署（无 schema 变更，免 `db:migrate`）；
  线上确认 sw **v15**、HTML 引用 `dist/app.TSYWC6ST.js`，`npm run verify:live` **36/36** 全绿。
- **落点**：`public/{tokens,ui,app,lecture}.css`、`public/{ui,lecture}.js`、四页 HTML、`public/sw.js`、
  `public/dist/**`、`docs/设计规范.md`（v4 + 变更记录 + 门禁表 + 遗留项修正）、`docs/README.md`、`README.md`、本文件。

### 2026-10-28 · 四页视觉现代化（现代·简洁·优雅），已推送部署

- 提交 `cc57cf0`（push main 自动部署，无 schema 变更故免 `db:migrate`）；线上确认 sw **v14**、
  HTML 引用 `dist/app.PPC24RSH.js` 且 200、`verify:live` **36/36**。
- 视觉收敛：tokens/app.css 阴影减重与层级留白收敛；**桌面 toast 移到右上角**（原底部 18px 恰好压住
  「提交/下一题」主操作坞）；讲义外观设置条改单行横滑 chip（`.look-bar` 去 `flex-wrap` → `overflow-x:auto`），
  词卡网格 212→232px；报告/后台表头与空态小字对齐全局语言。
- 报告页章节卡断词：`.ch-title { word-break: keep-all }`，只在「第X章」后空格折行，修掉「自然地/理」。
- 主题色同步：4 页 `theme-color` 与 `ui.js` 统一 `#f7f5f1` / `#101218`（原文误记为 `#f7f4ee` / `#14161f`，2026-10-28 收口按代码更正），**`worker/index.js` 的
  `THEME_BOOT_SHA256` 重算**（check §3f/§3g）；sw v13→v14。
- 门禁：test 217/217 · check 66/66 · e2e 69/69 · smoke 105/105。
- 踩坑：**`git commit` 报 `gpg: can't connect to the gpg-agent`** → `gpg-connect-agent /bye` 拉起 agent
  （顺带清 stale lockfile）后提交成功；不要退而用 `--no-gpg-sign`。

### 2026-10-27 · 真实网页视觉走查：线上整站失效（dist 未上线）+ 5 处界面缺陷

- **怎么发现的**：不看截图、直接开线上 <https://vocab.logicc.top> 的多状态截图（playwright，390/834/1440 × 明暗）。
  第一张就是事故现场：**页面完全无样式、无脚本**，只剩品牌名和几个巨大黑图形。
- **根因（P0，线上一直是坏的）**：HTML（入库）引用 `dist/app.<hash>.js`，而 `public/dist/` 被 `.gitignore` 的
  `dist/` 规则排除 → 部署上去的产物里没有 dist → 4 个页面 CSS/JS 全 404。9-30 上 esbuild 那天起就是这样，
  旧 `verify:live` 只逐条列死 `/app.js` `/tokens.css`，看不到"页面自己引用的 dist 路径"。
- **修法（三层）**：① `.gitignore` 加 `!public/dist/`，**构建产物入库**（部署即带）；② worker 新增
  `distFallbackSource()`：`/dist/x.<hash>.js` 404 时回落到 `/x.js` 并打 `x-asset-fallback`，
  产物缺失/指纹错配都不会再白屏；③ `verify:live` 新增"逐页解析 HTML，引用的 JS/CSS 必须 200 + MIME 正确"，
  `check` 的 3a/3e 从"没构建算中性"改成**判错**。
- **视觉走查修掉的 5 处**：① toast 在桌面停 18px 正好压住「提交/下一题」主按钮 → 宽屏抬到操作坞之上、
  移动端改挂顶部（底部是拇指区+辨析卡，放哪儿都压内容）；② 移动端键盘快捷键脚注白占 ~70px →
  `(hover:none) and (pointer:coarse)` 隐藏；③ 宽屏操作坞主 CTA 夹在中间（"上一个/重置/⋯"反在主按钮右侧）→
  `order:1` 落到行末；④ 报告页章节卡两栏把「第1章 自然地理」折断 → ≤430px 单栏；⑤ 报告页「近 7 天活跃」
  全 0 时七根 2px 灰条像没渲染 → 补空态句子。另加"答完把辨析卡轻推入视野"（`revealQuizNote`）。
- **顺带修的真 bug（smoke 抓的）**：设置类改动只 `markSettingsDirty()` 走云端，**从不落本机** →
  游客点主题色刷新即回退（`vocab:accent` 镜子写了、`vocab:v3:<user>.settings.accent` 还是旧值）。
  改法：`markSettingsDirty()` 里补 `saveLocal()`（微任务合并，不放大写入）+ `frontend-guards` 加断言。
- **门禁**：test **217** ✅（+1 dist 回落用例）· check 66/66 ✅ · e2e 69/69 ✅ · smoke 105/105 ✅（sw v12→v13）。
  `npm run verify:live` 现在会**准确报错**（`/ → dist/tokens.2ECU2BLM.css: 404`），部署后应变全绿。
- **落点**：`.gitignore`、`worker/index.js`、`public/{app,ui,报告}.css|js`、`public/sw.js`、`scripts/{check,verify-live}.mjs`、
  `test/{worker,frontend-guards}.test.js`、`public/dist/**`（入库）、AGENTS/README/项目规范/目录结构/协作规范/前端优化计划、本文件。
- **上线结果（2026-10-27 23:12）**：`npm run deploy` 两次（第一次上传 22 个资源、补齐整套 `dist/`，
  Version `547aaa26`；第二次只传 1 个 manifest，Version `4e2650d0`），`verify:live` **36/36 全绿**。
  线上实测兜底：旧指纹 `/dist/app.5L3NUYTW.js` → 200 + `x-asset-fallback: /app.js`，源码也缺时 404。
  **同时修掉 `build:assets` 的时间戳抖动**：manifest 每次重写 `generatedAt`，导致每次 deploy 留一个纯时间戳 diff；
  现改为「除 generatedAt 外内容一致就写回旧内容」（坑：不能跳过写入，`clean()` 已清空 dist/，跳过 manifest 会消失）。提交 `7b2e56c`。
- **未做**：`_audit` 里的历史一次性脚本没动。

### 2026-10-25 · 全量代码审查：修 5 处缺陷（报告正确率 / 题源假告警 / 注册死限流 / 后台统计错位 / 表单校验失效）

- **背景**：应要求"全量阅读代码，发现问题并优化"。逐文件精读了 worker/index.js、public 全部 JS/CSS/HTML、
  scripts 工具链、test 与 migrations（基线 test 216 ✅ / check 66/66 ✅ 均为工作区未提交的 10-17 存档优化状态）。
- **修的五处（均为高置信度、有测试或输出可验证）**：
  ① `报告.js` aggregate：分模式正确率的分母只累加答错数（c/w 口径=对/错，会显示 >100%）→ 改为对+错；
  ② `scripts/quiz-lib.mjs` SPEC_VERSIONS_OK 漏加当前版本 1.2 → 22 章题源在 check 里全部误报
  "spec 版本是 1.2，当前规范是 1.2"（噪音掩盖真信号）→ 集合加入 QUIZ_SPEC_VERSION，升版不再漏；
  ③ worker handleRegister 限流**只查不记**（blockedUntil 恒 0，注册口等于无限流，可无限枚举邮箱）→
  email_taken 路径计入 throttleRecordFailure（每 env 测试只有 1 次重复注册，不触阈值，测试不受影响）；
  ④ worker handleAdminOverview：question_report.created_at 是 sqlite datetime('now')（空格分隔），
  却拿 ISO 的 "T" 格式比较（" " < "T"，临界日整天被误判为更早）→ 报错统计单独用 sqlite 格式时间串；
  ⑤ ui.js openAuthSheet `novalidate:"false"`：布尔属性存在即生效，实际把 required/minlength/type=email
  的原生校验全关了 → 移除该属性，原生校验恢复。
- **记录未修（评估后认为收益<风险，后续可做）**：worker handleImport 备注逐条 `.run()`（大备份最多 1 万次串行
  D1 往返，可批处理化，但本机 wrangler 起不了 e2e，不宜盲改同步协议）；lecture.js syncNotesFromCloud 首登
  可能并发触发几十个 putNote（fire-and-forget 无重试）；sw.js cacheFirst 离线且无缓存时 respondWith 直接拒绝。
- **门禁**：build:assets 已重建（ui/报告 产物变更）· sw.js VERSION **v11 → v12** · **test 216 ✅ · check 66/66 ✅**
  （check 第 7 节的假 spec 告警清零，各章建议数 -1）。
- **落点**：public/报告.js、public/ui.js、public/sw.js、worker/index.js、scripts/quiz-lib.mjs、
  public/dist/**（构建产物）、public/*.html（构建改写引用）、本文件。

### 2026-10-17 · 存档写入合并：重度用户每次切题少一次 376KB 序列化

- **怎么发现的**：本机起不了 wrangler（见本条目末尾环境坑），改用「node 静态服务器 + playwright 直连 public/」自建探针，
  伪造 2600 词 / 376KB 存档做基线：每次点「下一题」同步耗时 **p50 10.4ms**，其中 **约 8ms 是两次 376KB JSON.stringify**
  （setItem 本体只有 0.3ms/次；Object.keys 全量扫描 2600 条只要 0.24ms，所以 chapterProgress 无需改动）。
  两遍的来源：advance()/skip() 里一次 saveLocal() + renderWord() 末尾又一次。
- **改法（storage.js）**：saveLocal() 改为**置脏 + queueMicrotask**，同一任务内只写一次，且写的是**微任务里的最终状态**
  （不丢字段，仍早于渲染/关页）；新增 export function flushLocalSave() 保留同步语义。
  app.js：beforeunload / pagehide / visibilitychange 三处改调 flushLocalSave()；
  applyUser() 开头（改 state.userKey **之前**）必须 flushLocalSave()，否则排队中的写入会落到新命名空间。
  导入语句单独加一行（原有那行的名字集合被 frontend-guards 精确断言，不能改）。
- **实测收益**（同一重档 12 次切题）：同步 handler p50 **10.4ms → 2.8ms**，每次切换的 setItem 次数 **2 → 1**；
  单帧总耗时 p50 约 12ms（含微任务里的那一次序列化）。功能面无回归：认词模式 4 选项与辨析卡正常、0 console/pageerror。
- **落盘可靠性专测**：点完「下一题」立刻 page.reload()（不等 networkidle），重载后 index 与 words 计数正确 ——
  即「微任务一定早于卸载」这条前提在真实浏览器上成立（smoke 第 447-450 行正是这种 reload 后读 localStorage 的断言）。
- **新增守卫**：test/frontend-guards.test.js 加「存档写入」用例（合并写结构、flushLocalSave 存在、三处事件同步落盘、
  applyUser 先 flush 再改 userKey）。门禁：**test 216 ✅ · check 66/66 ✅**（sw.js VERSION v10 → v11，dist 已重建）。
- **落点**：public/storage.js、public/app.js、test/frontend-guards.test.js、public/sw.js、public/dist/**（构建产物）、
  docs/前端优化计划.md（新 §9 + v1.5）、本文件、docs/agents/接力看板.md，以及 AGENTS/README/项目规范/目录结构/协作文档里 215 → 216 的门禁数字。
- **环境坑（本机，勿重试）**：wrangler 4.132.0 的 wrangler-dist/cli.js 把**自身脚本路径当成位置参数**（Unknown arguments: … cli.js, dev），
  npm run dev 因此起不来 → npm run e2e / npm run smoke 在本机跑不了；三种绕法（npm run dev / ASCII 目录联接 / argv shim）均无效。
  替代方案：自建静态服务 + playwright 探针（playwright 已装，axe-core 未装）。临时探针与目录联接已在收尾时清理。

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
