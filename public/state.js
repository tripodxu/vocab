// @ts-check
/**
 * app-state.js —— 刷词页的全局状态（单一可变对象）
 *
 * 为什么单独成文件：`storage.js` / `speech.js` 都要读它，如果它还留在 app.js 里，
 * 那两个模块就得反过来 import app.js，形成循环依赖（app.js → storage.js → app.js）。
 * 抽出来之后依赖方向是单向的：app.js → {state, storage, speech} → {core}。
 *
 * 注意：这里是**同一个对象的引用**，不是副本。各处 `state.xxx = ...` 的写法照旧成立；
 * 真正要小心的是"整块替换"（`state = {...}`）——那是做不到的，要改就改字段。
 */
import { normalizeSettings } from "./core.js";

/** 本地存档键前缀（后面接 userKey：guest 或 u<userId>） */
export const LS_PREFIX = "vocab:v3:";

export const state = {
  /** 本地存档命名空间：guest 或 u<userId> */
  userKey: "guest",
  settings: normalizeSettings(null),
  /** 易错词权重（本机，随存档持久化；系统无权移除，只有用户手动删除） */
  weights: {},
  /** @type {Record<string, any>} 'c:w' → 词状态 */
  words: {},
  chapter: 1,
  /** @type {any[]} */
  chapterWords: [],
  /** @type {Map<number, any>} */
  wordById: new Map(),
  /** @type {number[]} */
  deck: [],
  index: 0,
  /** @type {{ ids: number[], source: string } | null} 复习会话 */
  review: null,
  session: { attempts: 0, correct: 0 },
  // 当前词
  slots: /** @type {{ ch: string, sep: boolean }[]} */ ([]),
  editables: /** @type {number[]} */ ([]),
  values: /** @type {string[]} */ ([]),
  hintIdx: /** @type {Set<number>} */ (new Set()),
  cursor: 0,
  answered: false,
  lastResult: /** @type {null | "ok" | "bad"} */ (null),
  timedOut: false,
  roundDone: false,
  /** 从讲义页深链跳进来时高亮一次槽位 */
  jumpHighlight: false,
  /** 深链显式指定的章节（>0 时优先级最高，云端 resume 不能覆盖它） */
  deepLinkChapter: 0,
  /** 当前题面：spell → chinese/audio；choice → en/audio */
  promptKind: /** @type {"chinese" | "audio" | "en"} */ ("chinese"),
  /** 认词题源：quiz-<chapter>.json；没有题源时用同章词自动生成干扰项 */
  quiz: {
    chapter: 0,
    items: /** @type {Record<string, any>} */ ({}),
    /** 本章是否有精编题源 */
    available: false,
    /** 本章题源是否已经尝试加载过（避免反复请求） */
    loaded: false,
  },
  /** 认词题目缓存（同一轮回插/重渲染时选项位置不变） */
  questions: /** @type {Map<string, any>} */ (new Map()),
  question: /** @type {any} */ (null),
  /** 本轮作答快照：牌堆位置 → 该题的作答状态（回看上一题时还原，可重置重答） */
  answerLog: /** @type {Map<number, any>} */ (new Map()),
  /** 认词模式选中的选项下标 */
  chosen: -1,
  /** 分模式台账（本机，不上云）：'c:w' → { spell:{c,w}, choice:{c,w} } */
  modes: /** @type {Record<string, any>} */ ({}),
  loading: false,
  loadError: /** @type {string|null} */ (null),
  loadingMessage: "正在加载词库…",
  // 同步
  sync: {
    dirty: /** @type {Set<string>} */ (new Set()),
    settingsDirty: false,
    timer: 0,
    /** 第一次变脏的时刻：防抖被连续作答不断重置时，最迟 FLUSH_MAX_WAIT 也必须发出去 */
    firstDirtyAt: 0,
    inFlight: /** @type {{ epoch: number, userKey: string, authRevision: number } | null} */ (null),
    backoff: 0,
    lastError: /** @type {string|null} */ (null),
    pulledOnce: false,
    cursor: 0,
  },
  // 计时
  timer: { deadline: 0, handle: 0, hiddenAt: 0 },
  // DOM 缓存
  dom: /** @type {Record<string, any>} */ ({}),
};
