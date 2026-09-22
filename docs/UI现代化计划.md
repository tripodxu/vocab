# UI 现代化计划 ·「单词即海报」（第六期）

> 状态：**P0–P4 已执行完毕**（2026-09）。执行期间的偏差与遗留项见文末 §7「执行对账」。
> 前情：第五期结束时的全量评审见 `docs/archive/优化计划.md` 与 README。

## 0. 定位与方向

产品是雅思考生日用的刷词工具：会话短平快、移动端为主、PWA 离线优先。
选定方向 **A「学者桌面 / Editorial Study」**（备选 B 陶土玩具、C 专注暗舱，均否决：
B 与成人备考气质错位且先天弱深色；C 教材类内容暗底阅读性差）。

核心命题：**单词即海报** —— 每一屏只有一个视觉主角（当前词），
其余一切（控件、提示、次要操作）退到配角位。

## 1. 设计语言（tokens v3「纸与墨」）

### 1.1 排版

| 角色 | 字体栈（tokens.css `--font-*`） | 说明 |
|---|---|---|
| 词面 hero | `Fraunces → Georgia → Palatino → serif` | 题干单词、词卡词头、章节名、例句英文；`font-optical-sizing: auto` |
| 中文正文 | 系统 CJK 栈（Atkinson Hyperlegible 优先西文） | **不加载中文 webfont**（MB 级字库会毁掉离线与首屏） |
| 音标/数字/计时 | `IBM Plex Mono → ui-monospace` 系统等宽 | 一律 `tabular-nums`，数字不跳宽 |

**字体升级位**：本仓库构建环境无外网，无法下载 woff2。
自托管升级步骤（有网时执行，无需改代码）：

```bash
# 下载 latin 子集（约 30KB/个）放入 public/fonts/
#   Fraunces: https://cdn.jsdelivr.net/npm/@fontsource/fraunces/files/*.woff2
#   IBM Plex Mono: https://cdn.jsdelivr.net/npm/@fontsource/ibm-plex-mono/files/*.woff2
# 然后在 tokens.css 顶部追加 @font-face（font-display: swap），
# 两个 HTML 各加一行 <link rel="preload" as="font" …> 即自动生效。
```

字号 8 级（`--fs-xs … --fs-hero`）、正文行高 `--lh-body: 1.7`。

### 1.2 色彩（纸与墨）

- 浅色 = 暖纸 `#f6f2ea`（+ SVG feTurbulence 噪点纸纹，零图片请求）；深色 = 墨舱 `#12141c`。
- 三层 token：primitive → semantic（组件只许引用这层）→ component。
  `scripts/check.mjs` §8 设计 lint 强制：组件 CSS 裸 hex = 门禁失败。
- 六色 `data-accent` 调色盘机制**保留**（色值上一轮已完成 AA 调校，全部继承）。
- 事件色 =「批改」隐喻：`--ok` 墨绿、`--bad` 朱砂。

### 1.3 动效（全部受 `prefers-reduced-motion` 约束）

`--dur-fast 150ms / --dur 240ms / --dur-slow 360ms`，进入用 `--spring`。
高光只给判分时刻：答对槽格墨绿涟漪（ink-ripple）、换词槽位落墨入场（ink-in）、
辨析卡以「批注纸」形态弹入；讲义词卡→详情走 **View Transitions 词头共享元素**。

### 1.4 图标

emoji → **内联 SVG sprite**（`#i-*` 符号，两页同源，currentColor 着色）。
结构性控件（导航/同步态/朗读/报错/标记/分页）全部图标化；
★☆✓✗✕ 保留为文本字形（无 VS16、可着色，lint 白名单放行）；
章节 emoji 弃用，列表改**编号瓷片**（`.ch-tile`，衬线数字）。

## 2. 关键界面

- **刷词页**：词面 hero（`--fs-hero`）/ 墨格方格纸字母槽 / 答题卡（mono keycap + 抬升阴影）/
  **底部拇指坞**（`提交` 主 CTA 居中，`生词·不会·上一个` 侧翼，其余 6 项收进「⋯」快捷菜单——
  所有控件 **id 不变，事件绑定零改动**）/ 顶栏**每日目标 SVG 进度环** / 报告大数字 mono 化。
- **讲义页**：词卡衬线词头 + `content-visibility:auto`（400+ 词列表近虚拟化）/
  词条详情标题衬线 hero（VT 落点）/ **⌘K、Ctrl+K、`/` 命令面板**（搜词 + 跳章）/
  搜索框改 SVG 放大镜。
- **存储**：配图/批注/画笔 dataURL 迁 **IndexedDB**（`public/idb.js`），
  localStorage 只留备注与元数据；启动时 `migrateLegacy()` 幂等搬迁，读路径带 localStorage 回退。

## 3. 可靠性护栏（新增门禁）

| 机制 | 位置 | 内容 |
|---|---|---|
| 设计 lint | `check.mjs` §8（4 项） | ① 组件 CSS 禁裸 hex ② 两页 HTML+公共 JS/CSS 禁 emoji ③ 全 CSS 禁 `outline:none` ④ 禁外部字体源/@import |
| 对比度门禁 | `check.mjs` §6（继承） | 六盘 ink ≥4.5 双主题 + 正文 text-3/ok ≥4.5，页面底色改为读 tokens |
| 视觉回归 | `npm run ui:baseline` | Playwright 5 场景矩阵截图 → `shots/baseline/`（入库）/ `shots/current/`（忽略），配 pixelmatch 类工具比对 |
| a11y 扫描 | `npm run a11y` | axe-core 注入两页，critical/serious >0 → exit 1（缺本地包时 exit 2 不阻塞） |
| 回归底线 | 既有 | **122 单测 + 47 静态检查全绿**是每步合并前置；存储协议零改动（第六期不碰同步语义） |

## 4. 分期执行记录

| 期 | 内容 | 状态 |
|---|---|---|
| P0 底座 | tokens v3 纸与墨 / 图标 sprite 与迁移 / 字体栈（含升级位）/ 设计 lint 4 条 | ✅ |
| P1 刷词页 | hero 词面、墨格槽、答题卡、拇指坞+快捷菜单、目标环、判分动效、批改页大数字 | ✅ |
| P2 讲义页 | 词卡衬线+VT 共享元素、命令面板、IndexedDB 迁移、content-visibility | ✅ |
| P3 收口 | 两页 emoji 清零（lint 兜底）、空态/骨架沿用既有实现 | ✅ |
| P4 工具与文档 | ui:baseline、a11y、sw v3、manifest/meta 色统一、本文档 | ✅ |

## 5. 明确不做（及理由）

- **不引框架重写**：低组件数、高状态密度的工具型页面，框架 ROI 为负（见评审 §3.1）。
- **不上中文 webfont**、**不做视差/粒子装饰**（动效只出现在判分时刻）。
- **双皮肤并行**：原计划的 `@layer classic/next` 双皮肤在 CSS 层叠上被判定
  比 git 按期回滚更脆弱 → **改用「每期一个 commit，出问题按期 revert」**（见 §7）。
- 存储协议/同步语义不动（第五期刚修好的 LWW/队列是可靠性资产）。

## 6. 验收清单（发布前本地跑）

```bash
npm run check          # 47 项（含设计 lint 4 项）
npm test               # 122 项
npm run dev            # 另开终端
npm run smoke          # 浏览器冒烟（既有 89 项）
npm run ui:baseline    # 写视觉基线
npm i --no-save axe-core && npm run a11y   # 无障碍门禁
npm run verify:live    # 线上核验
```

真机走查：iPhone SE / 大屏 / 平板 / 横屏；reduced-motion 开关；系统字号最大档；
深色主题下六个 accent 盘各切一遍。

## 7. 执行对账（偏差与遗留）

1. **字体**：环境无外网 → 走 Georgia/Plex 回退栈，woff2 升级位已备（§1.1）。
2. **双皮肤** → 改 git 按期回滚（§5，属计划内替换）。
3. **app.js 模块拆分**（P1 附带项）**未做**：UI 重铸不依赖它；在无法起浏览器的
   环境里做 3000 行级搬移是本项目剩余的最高回归风险项，留作 P1.5 单独一期
   （建议在能跑 `npm run dev` + smoke 的环境执行）。
4. **PWA 图标 192/512 PNG 与 maskable 位图**：需出图素材，仍为 SVG 单图标
   （`purpose: any maskable` 已声明）；深色主题白闪修复受 CSP `script-src 'self'`
   约束需内联脚本豁免，维持现状（HTML 已带 `data-theme` 初值）。
5. **axe/视觉回归需本地执行**：沙箱无浏览器，工具与门禁已就位（exit 2 语义），验收清单 §6。
6. 设置面板渐进披露未做（现有五分组已够清晰，低优先级）。
