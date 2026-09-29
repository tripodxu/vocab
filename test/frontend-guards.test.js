// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
const stateSource = await readFile(new URL("../public/state.js", import.meta.url), "utf8");
const storageSource = await readFile(new URL("../public/storage.js", import.meta.url), "utf8");
const speechSource = await readFile(new URL("../public/speech.js", import.meta.url), "utf8");
const uiSource = await readFile(new URL("../public/ui.js", import.meta.url), "utf8");
const lectureSource = await readFile(new URL("../public/lecture.js", import.meta.url), "utf8");
const lectureStoreSource = await readFile(new URL("../public/lecture-store.js", import.meta.url), "utf8");
const idbSource = await readFile(new URL("../public/idb.js", import.meta.url), "utf8");
const authSource = await readFile(new URL("../public/vocab-auth.js", import.meta.url), "utf8");
const swSource = await readFile(new URL("../public/sw.js", import.meta.url), "utf8");
const workerSource = await readFile(new URL("../worker/index.js", import.meta.url), "utf8");
const buildSource = await readFile(new URL("../scripts/build-assets.mjs", import.meta.url), "utf8");
const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

test("frontend session guards cover the production continuation paths", () => {
  const flush = appSource.slice(appSource.indexOf("async function flush()"), appSource.indexOf("/** 把当前所有词状态标记为待上传"));
  assert.match(stateSource, /cursor: 0/);
  assert.match(appSource, /const since = opts\.full \|\| !state\.sync\.pulledOnce \? 0 : Math\.max\(0, state\.sync\.cursor - 60_000\);/);
  assert.doesNotMatch(appSource, /sessionChapter/);
  assert.match(appSource, /if \(!data \|\| !Array\.isArray\(data\.words\)\)/);
  assert.match(appSource, /const settingsSnapshot = settingsDirty \? JSON\.stringify\(serializableSettings\(\)\) : "";/);
  assert.match(appSource, /const isCurrent = \(\) => currentUserEpoch\(runEpoch, runUserKey, runAuthRevision\)/);
  assert.match(appSource, /async function switchPractice\([\s\S]*const runEpoch = userEpoch;[\s\S]*const runUserKey = state\.userKey;[\s\S]*const runAuthRevision = Auth\.revision\(\);[\s\S]*const runToken = sessionGuard\.capture\(runUserKey, runAuthRevision\)/);
  assert.match(appSource, /async function switchPractice\([\s\S]*if \(value === "choice"\) await loadQuiz\(state\.chapter\);[\s\S]*if \(!isCurrent\(\)\) return;/);
  assert.match(appSource, /const runEpoch = userEpoch;[\s\S]*const runUserKey = state\.userKey;[\s\S]*const runAuthRevision = Auth\.revision\(\)/);
  assert.match(appSource, /const runToken = sessionGuard\.capture\(runUserKey, runAuthRevision\)/);
  assert.match(appSource, /const settingsChangedDuringPull = JSON\.stringify\(state\.settings\) !== localSettingsSnapshot/);
  assert.match(flush, /const settingsSnapshot = settingsDirty \? JSON\.stringify\(serializableSettings\(\)\) : "";/);
  assert.match(flush, /JSON\.stringify\(serializableSettings\(\)\) === settingsSnapshot/);
  assert.match(flush, /const token = \{ epoch: runEpoch, userKey: runUserKey, authRevision: runAuthRevision \}/);
  assert.match(flush, /finally \{[\s\S]*state\.sync\.inFlight === token/);

  const applyUser = appSource.slice(appSource.indexOf("async function applyUser"), appSource.indexOf("async function init()"));
  assert.match(applyUser, /const isCurrent = \(\) => currentUserEpoch/);
  assert.match(applyUser, /await syncPull\(\{ full: true \}\);\s*if \(!isCurrent\(\)\) return;/);
  assert.match(applyUser, /await starSync\.pull\(\);\s*if \(!isCurrent\(\)\) return;/);
  assert.match(applyUser, /await starSync\.flush\(\);\s*if \(!isCurrent\(\)\) return;/);
  assert.match(applyUser, /await loadChapter\(state\.chapter, \{ fresh: true \}\);\s*if \(!isCurrent\(\)\) return;/);
  assert.match(applyUser, /state\.settings = normalizeSettings\(scoped\?\.settings\);/);
  assert.match(applyUser, /const keyChanged = nextKey !== prevKey;/);
  assert.match(applyUser, /if \(opts\.switchChapter && keyChanged\)[\s\S]*await loadChapter\(state\.chapter, \{ fresh: true \}\);[\s\S]*if \(!isCurrent\(\)\) return;/);
  assert.match(applyUser, /if \(opts\.switchChapter && !chapterLoaded\)[\s\S]*await loadChapter\(state\.chapter, \{ fresh: true \}\);[\s\S]*if \(!isCurrent\(\)\) return;/);
});

test("限时作答按目标时间戳判定，隐藏补偿不跨题残留", () => {
  // 计时必须是"deadline - now"而非每 tick 递减计数：后台节流/系统休眠都不该影响判负时机
  assert.match(appSource, /const left = \(state\.timer\.deadline - performance\.now\(\)\) \/ 1000/);
  assert.match(appSource, /if \(left <= 0\) \{\s*handleTimeout\(\);/);

  const start = appSource.slice(appSource.indexOf("function startTimer()"), appSource.indexOf("function stopTimer()"));
  assert.match(start, /state\.timer\.deadline = performance\.now\(\) \+ state\.settings\.timerSeconds \* 1000/);
  // 上一题的隐藏时刻若残留，切回页面时会把整段间隔补偿给用户，计时形同虚设
  assert.match(start, /state\.timer\.hiddenAt = 0/);

  const stop = appSource.slice(appSource.indexOf("function stopTimer()"), appSource.indexOf("function tickTimer()"));
  assert.match(stop, /window\.clearTimeout\(state\.timer\.handle\)/);
  assert.match(stop, /state\.timer\.hiddenAt = 0/);

  const vis = appSource.slice(appSource.indexOf("function bindTimerVisibility()"), appSource.indexOf("/* ============ 报告"));
  assert.match(vis, /if \(!state\.settings\.timerEnabled\) \{[\s\S]{0,200}state\.timer\.hiddenAt = 0/);
  assert.match(vis, /state\.timer\.deadline \+= performance\.now\(\) - state\.timer\.hiddenAt/);
});

test("关页最后一答走 keepalive 补发，且不会据此清空脏集合", () => {
  const leave = appSource.slice(appSource.indexOf("function flushOnLeave()"), appSource.indexOf("/**\n * 从云端拉取并合并"));
  // 交给浏览器接管（keepalive），普通 fetch 在页面销毁时会被中止
  assert.match(leave, /Auth\.pushWordsKeepalive\(changes\)/);
  // 读不到响应 → 绝不能清脏集合，否则丢的是真数据（下次进页面靠 markAllDirty 兜底重发）
  assert.doesNotMatch(leave, /dirty\.clear\(\)/);
  assert.doesNotMatch(leave, /dirty\.delete\(/);
  // keepalive 单包 64KB，必须有截断，否则整包被丢弃
  assert.match(leave, /58_000/);
  assert.match(appSource, /window\.addEventListener\("pagehide"[\s\S]{0,200}flushOnLeave\(\)/);
  assert.match(appSource, /window\.addEventListener\("beforeunload"[\s\S]{0,200}flushOnLeave\(\)/);

  const auth = authSource.slice(authSource.indexOf("pushWordsKeepalive(changes)"), authSource.indexOf("pushWordsKeepalive(changes)") + 1200);
  // 必须带鉴权头：sendBeacon 无法自定义头，所以它不适用本项目
  assert.match(auth, /authorization: `Bearer \$\{state\.token\}`/);
  assert.match(auth, /keepalive: true/);
  assert.match(auth, /60_000/);
});

test("弹层与「更多操作」菜单把焦点圈在浮层内，关闭后还回触发处", () => {
  // 所有抽屉/弹窗都走 ui.js 的 openLayer 基座：记录旧焦点 → 关闭还原 + Esc + Tab 循环
  assert.match(appSource, /openSheet,/);
  const layer = uiSource.slice(uiSource.indexOf("function openLayer(opts)"), uiSource.indexOf("export function openSheet"));
  assert.match(layer, /const previous = .*document\.activeElement/);
  assert.match(layer, /if \(previous && typeof previous\.focus === "function" && document\.contains\(previous\)\) previous\.focus\(\)/);
  assert.match(layer, /if \(e\.key === "Escape"\)/);
  assert.match(layer, /if \(e\.shiftKey && document\.activeElement === first\)/);

  const menu = appSource.slice(appSource.indexOf("if (dom.moreBtn && dom.quickMenu)"), appSource.indexOf("// 练习方式：拼写 / 认词"));
  assert.match(menu, /const focusInside = dom\.quickMenu\.contains\(document\.activeElement\)/);
  assert.match(menu, /if \(focusInside\) dom\.moreBtn\.focus\(\)/);
  assert.match(menu, /menuFocusables\(\)\[0\][\s\S]{0,160}first\.focus\(\)/);
  assert.match(menu, /if \(e\.key === "Escape"\) \{\s*closeMenu\(\);/);
  assert.match(menu, /const items = \[dom\.moreBtn, \.\.\.menuFocusables\(\)\]/);
});

test("本地缓存：题源按 spec 失效，预取只写缓存不碰状态", () => {
  // 题源缓存必须带 spec 并在读取时校验，否则升版后旧结构会被拿去出题
  assert.match(appSource, /if \(parsed\?\.spec !== QUIZ_SPEC_VERSION\) return null;/);
  // 缓存键必须带内容指纹：只按 spec 失效的话，同一 spec 下改过题源/词库仍会读旧数据
  assert.match(appSource, /JSON\.stringify\(\{ at: Date\.now\(\), spec: QUIZ_SPEC_VERSION, hash, items \}\)/);
  assert.match(appSource, /const QUIZ_CACHE_KEY = \(id, hash = ""\) => `\$\{QUIZ_CACHE_PREFIX\}\$\{id\}\$\{hash \? `@\$\{hash\}` : ""\}`;/);
  // 网络失败但缓存可用时不能把题源清成"无题源"
  assert.match(appSource, /if \(epoch === quizEpoch && !state\.quiz\.available\)/);
  // IDB 不可用时必须能回落 localStorage，不能整个缓存功能消失
  assert.match(appSource, /function legacyCacheChapter/);
  assert.match(appSource, /if \(idbAvailable\)/);

  const prefetch = appSource.slice(appSource.indexOf("function schedulePrefetch"), appSource.indexOf("async function prefetchChapter"));
  // 省流量/2g 下不许偷偷下载几百 KB
  assert.match(appSource, /if \(conn\.saveData === true\) return false;/);
  assert.match(appSource, /\/\^\(\?:slow-\)\?2g\$\/\.test\(conn\.effectiveType \|\| ""\)/);
  assert.match(prefetch, /if \(!CHAPTER_BY_ID\.has\(next\) \|\| prefetched\.has\(next\)\) return;/);

  const run = appSource.slice(appSource.indexOf("async function prefetchChapter"), appSource.indexOf("/* ============ 报告"));
  // 预取绝不能改 state（它只是"提前搬到本机"，改了会踩世代守卫的雷）
  assert.doesNotMatch(run, /state\.quiz = /);
  assert.doesNotMatch(run, /state\.chapter = /);
  assert.doesNotMatch(run, /state\.chapterWords = /);
  assert.match(run, /await cacheChapter\(chapterId, list\)/);
  assert.match(run, /await writeQuizCache\(chapterId, items, hash\)/);
});

test("内容指纹：词库/题源 URL 带 v=<hash8>，服务端与 SW 才敢长期缓存", () => {
  // 三处取数据都必须带指纹，漏一处就会出现"内容变了但还读旧缓存"
  assert.match(appSource, /const withVersion = \(url, hash\) => \(hash \? `\$\{url\}\?v=\$\{hash\}` : url\);/);
  assert.match(appSource, /await fetch\(withVersion\(`data-\$\{Number\(chapterId\)\}\.json`, chapterHash\(chapterId\)\)/);
  assert.match(appSource, /await fetch\(withVersion\(`data-\$\{chapterId\}\.json`, chapterHash\(chapterId\)\)/);
  assert.match(appSource, /await fetch\(withVersion\(`quiz-\$\{id\}\.json`, hash\)/);
  assert.match(appSource, /await fetch\(withVersion\(`quiz-\$\{chapterId\}\.json`, hash\)/);
  // 拿不到指纹时必须回落成普通 URL（不能拼出 ?v=undefined 这种永久缓存）
  assert.doesNotMatch(appSource, /withVersion\(`(?:data|quiz)-\$\{(?:id|chapterId)\}\.json`\)/);
  // 指纹来源：词库在 chapters.js 的 hash 字段，题源在 quiz-index.json 的 hashes 映射
  assert.match(appSource, /const chapterHash = \(chapterId\) => CHAPTER_BY_ID\.get\(Number\(chapterId\)\)\?\.hash \|\| "";/);
  assert.match(appSource, /quizHashCache = \/\*\* @type \{Record<string, string>\} \*\/ \(hashes\);/);
  assert.match(appSource, /return quizHashCache\[String\(Number\(chapterId\)\)\] \|\| "";/);

  // 清单文件本身不能 immutable：它是"指纹的载体"，必须先回源
  assert.match(workerSource, /const FINGERPRINTED = \/\[\?&\]v=\[0-9a-f\]\{8\}\(\?:\[&#\]\|\$\)\/\;/);
  assert.match(workerSource, /const HASHED_FILE = \/\\\.\[A-Za-z0-9\]\{8\}\\\.\(\?:js\|css\|map\)\$\/\;/);
  assert.match(workerSource, /if \(FINGERPRINTED\.test\(search\) \|\| HASHED_FILE\.test\(pathname\)\) \{[\s\S]{0,200}max-age=31536000, immutable/);
  assert.match(workerSource, /withCachePolicy\(res, pathname, url\.search\)/);
  assert.match(workerSource, /else if \(\/\\\.json\$\/i\.test\(pathname\)\)[\s\S]{0,200}cache-control", "no-cache"/);

  // SW 侧：带指纹才走 cache-first，否则仍网络优先保证发版即时
  assert.match(swSource, /if \(FINGERPRINTED\.test\(url\.search\) \|\| HASHED_FILE\.test\(url\.pathname\)\) \{\s*event\.respondWith\(cacheFirst\(req\)\);\s*return;\s*\}/);
  // 后台产物（dist/admin.<hash>.js）也必须被 ADMIN_PATH 排除，否则会落进 PWA 离线缓存
  assert.ok(
    swSource.includes('const ADMIN_PATH = /^\\/(?:dist\\/)?admin(?:\\.[A-Za-z0-9]{8})?\\.(?:html|js|css|map)$/;'),
    "ADMIN_PATH 未覆盖 dist/admin.<hash>.js",
  );
});

test("构建产物：压缩 + 指纹进 dist，部署前必须先构建", () => {
  // 指纹：产物名带 hash，内容一变 URL 就变（worker/SW 才敢发 immutable / cache-first）
  assert.match(buildSource, /entryNames: "\[name\]\.\[hash\]"/);
  // 共享 chunk：ui.js / chapters.js 等被四个页面共用，拆出来才能跨页复用同一 URL
  assert.match(buildSource, /splitting: true/);
  assert.match(buildSource, /chunkNames: "chunk\.\[hash\]"/);
  // sourcemap 必须留：线上排障只能靠它（external = 不内联进产物）
  assert.match(buildSource, /sourcemap: "external"/);
  // 先清目录：否则每次构建都留下一批旧指纹文件，public/dist 无限膨胀且被一起上传
  assert.match(buildSource, /await rm\(DIST, \{ recursive: true, force: true \}\)/);
  // HTML 改写必须幂等：先把 dist/x.<hash>.js 还原成 x.js，再按新产物重写，
  // 否则第二次构建会拼出 dist/dist/x.<hash>.<hash>.js
  assert.match(buildSource, /\.replace\(\/dist\\\/\(\[\^"'\]\+\?\)\\\.\[A-Za-z0-9\]\{8\}\\\.\(js\|css\)\/g, "\$1\.\$2"\)/);
  // 只改 href/src 的值，避免误伤正文里同名的字符串
  assert.ok(buildSource.includes('new RegExp(`((?:href|src)=")${escapeRe(src)}(")`, "g")'), "HTML 改写不再限定 href/src");
  // 源码指纹写进 manifest：`npm run check` 靠它判断 dist 是否过期
  assert.match(buildSource, /sources: await sourceHashes\(\)/);

  // 部署/本地起服务都必须先构建，否则 HTML 指向的 dist 产物不存在 → 整站白屏
  assert.match(pkg.scripts["build:assets"], /build-assets\.mjs/);
  assert.match(pkg.scripts.deploy, /npm run build:assets && wrangler deploy/);
  assert.match(pkg.scripts.predev, /npm run build:assets/);
});

test("模块拆分：state / storage / speech 单向依赖，app.js 不再内联它们", () => {
  // state.js 只依赖 core.js：它是依赖图的底端，反向依赖 app.js 会立刻成环
  assert.match(stateSource, /import \{ normalizeSettings \} from "\.\/core\.js";/);
  assert.doesNotMatch(stateSource, /from "\.\/app\.js"/);
  assert.doesNotMatch(storageSource, /from "\.\/app\.js"/);
  assert.doesNotMatch(speechSource, /from "\.\/app\.js"/);

  // 存档：登录档绝不回退读 guest 档，否则换账号会把别人的进度并进来
  assert.ok(
    storageSource.includes('key === "guest" ? [LS_PREFIX + "guest", "vocab-tool-state"] : [LS_PREFIX + key]'),
    "loadLocal 的命名空间回退规则被改动",
  );
  // 配额爆掉时保住学习状态（settings/words/modes/chapter），而不是整份存档写不进去
  assert.ok(
    storageSource.includes("JSON.stringify({ v: 3, settings: state.settings, words: state.words, modes: state.modes, chapter: state.chapter })"),
    "存档降级写入的字段集被改动",
  );

  // 语音：只依赖 state，且必须回传"是否真的播了"（iOS 需要用户手势，静默失败要能被感知）
  assert.match(speechSource, /import \{ state \} from "\.\/state\.js";/);
  assert.match(speechSource, /return true;\s*\} catch \{\s*return false;/);
  // getVoices() 首次常为空：必须等 voiceschanged，并留兜底超时
  assert.match(speechSource, /"voiceschanged"/);
  assert.match(speechSource, /,\s*1500\);/);

  // app.js 里不能再留这些实现（留下就是"拆了个寂寞，改一处忘一处"）
  for (const gone of [/function saveLocal\(\)/, /function loadLocal\(/, /async function speak\(/, /function tone\(/, /const storageKey = /, /let audioCtx/, /^let voices/m]) {
    assert.doesNotMatch(appSource, gone);
  }
  // 但必须把它们 import 回来（拆出去却没接线 = 直接 ReferenceError）
  assert.match(appSource, /import \{ state \} from "\.\/state\.js";/);
  assert.match(appSource, /import \{ saveLocal, loadLocal, canMergeGuest, markGuestMerged \} from "\.\/storage\.js";/);
  assert.match(appSource, /import \{ sfxOk, sfxBad, speak \} from "\.\/speech\.js";/);
});

test("讲义数据层：键名强制带 userKey，IDB 写失败必须回落 localStorage", () => {
  // 键名带用户后缀是"换账号不串号"的唯一保障；游客档无后缀是历史格式，靠 parseGuestLectureKey 反解
  assert.ok(
    lectureStoreSource.includes('export const localUserSuffix = (userKey) => (userKey === "guest" ? "" : `-${userKey}`);'),
    "localUserSuffix 规则被改动",
  );
  assert.ok(
    lectureStoreSource.includes("export const noteKey = (chapter, word, userKey) => `lecture-note${localUserSuffix(userKey)}-${chapter}-${word}`;"),
    "noteKey 不再带 userKey",
  );
  // 键名函数不能再默认取 state.userKey —— 那等于让数据层反向依赖 lecture.js，既成环又容易漏传
  assert.doesNotMatch(lectureStoreSource, /userKey = state\.userKey/);
  assert.doesNotMatch(lectureStoreSource, /from "\.\/lecture\.js"/);
  // IDB 写失败要回落 localStorage：绝不能让"升级到 IDB"变成"内容没了"
  assert.match(lectureStoreSource, /if \(await idbPut\(key, value\)\) \{[\s\S]{0,200}return safeSet\(key, value\);/);
  // 游客内容合并是"一次性"的：已并入过就别再并（否则每次登录都把旧游客内容盖回账号）
  assert.match(lectureStoreSource, /canMergeGuestInto\(safeGet\(LECTURE_GUEST_MERGE_KEY\), userId\)/);
});

test("渲染增量：换词重放入场动效，同题重渲染不重建选项节点", () => {
  const slots = appSource.slice(appSource.indexOf("/** 入场动效的收尾定时器"), appSource.indexOf("function renderSlots") + 1800);
  // 判据必须是"换了词"而不是"槽位数变了"：等长换词会复用节点，否则一帧动画都没有
  assert.match(slots, /const rebuilt = host\.childElementCount !== state\.slots\.length/);
  assert.match(slots, /if \(rebuilt \|\| state\.dom\.slotsFor !== wordKey\)/);
  // 连续换词时上一个收尾定时器会提前摘掉新词的 enter，必须先清掉
  assert.match(slots, /window\.clearTimeout\(slotEnterTimer\)/);

  const opts = appSource.slice(appSource.indexOf("/** @param {any} option @param {number} index"), appSource.indexOf("function renderOptions") + 2600);
  assert.match(opts, /if \(state\.dom\.optionsFor !== question \|\| state\.dom\.optionNodes\.length !== question\.options\.length\)/);
  assert.match(opts, /if \(node\.dataset\.sig !== sig\)/);
  // 同题重渲染不得整块重建（会让读屏重复播报四个选项）
  assert.doesNotMatch(opts, /host\.replaceChildren\(\);\s*question\.options\.forEach/);
});

test("lecture auth callback guards logout and async session continuations", () => {
  const callback = lectureSource.slice(lectureSource.indexOf("Auth.onAuthChange"), lectureSource.indexOf("window.setInterval"));
  assert.doesNotMatch(callback, /state\.userKey === "guest"[\s\S]{0,180}current\.userId/);
  assert.match(callback, /const runEpoch = nextEpoch/);
  assert.match(callback, /const token = sessionGuard\.begin\(\)/);
  assert.match(callback, /if \(!isCurrent\(\)\) return/);
});

test("lecture auth transition resets and hydrates the target session namespace", () => {
  const clear = lectureSource.slice(
    lectureSource.indexOf("function clearLectureSessionState"),
    lectureSource.indexOf("let voices"),
  );
  assert.match(clear, /state\.loading = false/);
  assert.match(clear, /state\.error = null/);
  assert.match(clear, /state\.query = ""/);
  assert.match(clear, /state\.filter = "all"/);
  assert.match(clear, /window\.clearTimeout\(stepTimer\)/);
  assert.match(clear, /stepTimer = 0/);
  assert.match(clear, /cleanupDraw\(\)/);
  assert.match(clear, /window\.clearTimeout\(brush\.timer\)/);
  assert.match(clear, /brush\.painting = false/);
  assert.match(clear, /drawState\.timer = 0/);

  const refresh = lectureSource.slice(
    lectureSource.indexOf("async function refreshLocalImages"),
    lectureSource.indexOf("/**\n * 云端备注/配图拉取"),
  );
  assert.match(refresh, /const runChapterEpoch = chapterEpoch/);
  assert.match(refresh, /const runUserKey = state\.userKey/);
  assert.match(refresh, /const runAuthRevision = Auth\.revision\(\)/);
  assert.match(refresh, /const keys = await idbKeys\(prefix\);\s*if \(!isCurrent\(\)\) return false;/);
  assert.match(refresh, /if \(!isCurrent\(\)\) return false;\s*state\.localImages = set;/);

  const callback = lectureSource.slice(lectureSource.indexOf("Auth.onAuthChange"), lectureSource.indexOf("window.setInterval"));
  assert.match(callback, /state\.userKey = nextKey;[\s\S]*loadLocalNotes\(\);[\s\S]*await refreshLocalImages\(\);[\s\S]*if \(!isCurrent\(\)\) return;[\s\S]*restoreBrush\(\);/);
  assert.match(lectureSource, /async function syncNotesFromCloud\(\)[\s\S]*const runUserKey = state\.userKey[\s\S]*const isCurrent =/);
  assert.match(lectureSource, /await Auth\.getNotes\(chapter\)[\s\S]*if \(!isCurrent\(\)\) return/);
  // 图片键必须显式带 userKey（键名函数不再默认取 state.userKey，漏传就会串号）
  assert.match(lectureSource, /const localImageKey = imgKey\(chapter, word\.id, context\.userKey\);[\s\S]*await idbGet\(localImageKey\)[\s\S]*if \(!isCurrent\(\)\) return/);
});

test("lecture async callbacks bind account, chapter, and detail identity", () => {
  assert.match(lectureSource, /function captureLectureContext\(/);
  assert.match(lectureSource, /const runUserKey = state\.userKey/);
  assert.match(lectureSource, /const runAuthRevision = Auth\.revision\(\)/);
  assert.match(lectureSource, /const runDetail = currentDetail/);
  assert.match(lectureSource, /const isCurrent = \(\) =>/);
  const note = lectureSource.slice(lectureSource.indexOf('textarea.addEventListener("input"'), lectureSource.indexOf("if (Auth.isLoggedIn()) noteStatus"));
  assert.match(note, /const runUserKey = state\.userKey/);
  assert.match(note, /if \(!isCurrent\(\)\) return/);
  assert.match(note, /await Auth\.putNote\(runChapter, runWord, value, at\)/);
  const pick = lectureSource.slice(lectureSource.indexOf("function pickImage"), lectureSource.indexOf("async function removeImage"));
  assert.match(pick, /const runChapter = state\.chapter/);
  assert.match(pick, /const runUserKey = state\.userKey/);
  assert.match(pick, /if \(!isCurrent\(\)\) return/);
  const remove = lectureSource.slice(lectureSource.indexOf("async function removeImage"), lectureSource.indexOf("/**\n * 压缩"));
  assert.match(remove, /const runChapter = state\.chapter/);
  assert.match(remove, /const runUserKey = state\.userKey/);
  assert.match(remove, /await idbDel\(imgKeyNow\)/);
  assert.match(remove, /if \(!isCurrent\(\)\) return/);
  assert.match(lectureSource, /const drawContext = captureLectureContext\(chapter, wordId\)/);
  assert.match(lectureSource, /const brushContext = captureLectureContext\(state\.chapter\)/);
  assert.match(lectureSource, /await migrateLegacy\(\)/);
});

test("IDB legacy migration is compare-and-set and preserves newer local values", () => {
  assert.match(idbSource, /async function migrateOneLegacyKey\(/);
  assert.match(idbSource, /if \(typeof req\.result === "string"\)/);
  assert.match(idbSource, /const put = store\.put\(value, key\)/);
  assert.match(idbSource, /localStorage\.getItem\(key\) === value/);
  assert.match(idbSource, /store\.put\(legacy, key\)/);
});

test("auth logout clears legacy fallback even when canonical storage is absent", () => {
  assert.match(authSource, /if \(!expectedToken \|\| stored === expectedToken \|\| !stored\)/);
});

test("re-answering a reset question cannot double-count scoring", () => {
  // 「重置本题」必须撤销上一笔 finalize：否则「答 → 重置 → 再答」会重复 recordDaily + attempts。
  const finalize = appSource.slice(appSource.indexOf("function finalize("), appSource.indexOf("function undoFinalize("));
  assert.match(finalize, /const undo = \{[\s\S]*prevDaily: state\.settings\.daily \? \{ \.\.\.state\.settings\.daily \} : null/);
  assert.match(finalize, /prevSession: \{ attempts: state\.session\.attempts, correct: state\.session\.correct \}/);
  assert.match(finalize, /prevDeck: \[\.\.\.state\.deck\]/);
  assert.match(finalize, /state\.answerLog\.set\(state\.index, \{[\s\S]*undo,/);

  const undoFn = appSource.slice(appSource.indexOf("function undoFinalize("), appSource.indexOf("function advance()"));
  assert.match(undoFn, /if \(undo\.prevDaily\) state\.settings\.daily = \{ \.\.\.undo\.prevDaily \};/);
  assert.match(undoFn, /state\.session\.attempts = undo\.prevSession\.attempts;/);
  assert.match(undoFn, /if \(Array\.isArray\(undo\.prevDeck\)\) state\.deck = \[\.\.\.undo\.prevDeck\];/);

  const reset = appSource.slice(
    appSource.indexOf("dom.resetQBtn?.addEventListener"),
    appSource.indexOf("dom.dontBtn.addEventListener"),
  );
  assert.match(reset, /snap\.wordId === Number\(cur\.id\)/);
  assert.match(reset, /undoFinalize\(snap\.undo \|\| null\)/);

  // 跳过也必须还原已答状态，否则回看后跳过会露出未答题面，诱发重复作答
  const skip = appSource.slice(appSource.indexOf("function skip()"), appSource.indexOf("/* ============ 计时器"));
  assert.match(skip, /renderWord\(\{ restore: true \}\)/);
});
