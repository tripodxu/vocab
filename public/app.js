// @ts-check
/**
 * app.js —— 刷词页（练习）
 *
 * 这一版解决的旧问题：
 *  1) 手机上无法输入：用隐藏 input + inputmode=latin 打通软键盘，桌面键盘照旧
 *  2) 云端会丢数据：恢复流程改成"先拉云端再渲染"，本地存档按账号命名空间隔离
 *  3) 每次按键 6 个请求：脏检查 + 800ms 防抖 + 串行队列 + 失败退避重试
 *  4) 破坏性操作无确认：统一确认弹窗 + 6 秒撤销
 *  5) 错题本只增不减：连续答对 2 次判定掌握并移出
 *  6) 正确率会 >100%：统计口径改为"本轮尝试 / 本轮正确"
 *  7) 打字时整排槽位闪烁：槽位 DOM 只创建一次，按键只改文本与类名
 */

import {
  STATUS,
  analyzeWord,
  judgeAnswer,
  applyResult,
  mergeWordStates,
  stateKey,
  statesForChapter,
  dueReviewIds,
  insertAhead,
  chapterProgress,
  computeStats,
  localDateKey,
  currentStreak,
  recordDaily,
  buildDeck,
  normalizeSettings,
  shuffle,
  cloudSettingsPayload,
  canMergeGuestInto,
} from "./core.js";
import { CHAPTERS, chapterTitle, CHAPTER_BY_ID } from "./chapters.js";
import Auth from "./vocab-auth.js";
import {
  $,
  $$,
  el,
  escapeHTML,
  toast,
  confirmDialog,
  promptDialog,
  openSheet,
  theme,
  initTheme,
  announce,
  flash,
  formatClock,
} from "./ui.js";

const LS_PREFIX = "vocab:v3:";
/** 记录"未登录期间的进度"已经并入过哪个账号，避免换账号时串号 */
const GUEST_MERGED_KEY = "vocab:guest-merged-into";

/* ============ 全局状态 ============ */

const state = {
  /** 本地存档命名空间：guest 或 u<userId> */
  userKey: "guest",
  settings: normalizeSettings(null),
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
  currentMode: /** @type {"chinese" | "audio"} */ ("chinese"),
  loading: false,
  loadError: /** @type {string|null} */ (null),
  loadingMessage: "正在加载词库…",
  // 同步
  sync: {
    dirty: /** @type {Set<string>} */ (new Set()),
    settingsDirty: false,
    timer: 0,
    inFlight: false,
    backoff: 0,
    lastError: /** @type {string|null} */ (null),
    pulledOnce: false,
  },
  // 计时
  timer: { deadline: 0, handle: 0, hiddenAt: 0 },
  // DOM 缓存
  dom: /** @type {Record<string, any>} */ ({}),
};

/* ============ 本地存储 ============ */

const storageKey = () => LS_PREFIX + state.userKey;

function saveLocal() {
  try {
    localStorage.setItem(
      storageKey(),
      JSON.stringify({
        v: 3,
        settings: state.settings,
        words: state.words,
        chapter: state.chapter,
        deck: state.deck,
        index: state.index,
        session: state.session,
        review: state.review,
        savedAt: Date.now(),
      })
    );
  } catch (err) {
    // 超出配额时降级：至少保住学习状态
    try {
      localStorage.setItem(
        storageKey(),
        JSON.stringify({ v: 3, settings: state.settings, words: state.words, chapter: state.chapter })
      );
    } catch {
      toast("本地存储空间不足，本次进度只保留在内存中", { type: "bad" });
    }
  }
}

/**
 * 读取本机存档。
 * 注意：**只读自己的命名空间**（用户的存档不会回退到 guest，否则换账号会把别人的数据并进来）；
 * 只有未登录档才允许回退到旧版 key 做一次迁移。
 * @param {string} key
 */
function loadLocal(key) {
  const candidates =
    key === "guest" ? [LS_PREFIX + "guest", "vocab-tool-state"] : [LS_PREFIX + key];
  for (const candidate of candidates) {
    const raw = localStorage.getItem(candidate);
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") continue;
      return parsed;
    } catch {
      continue;
    }
  }
  return null;
}

const canMergeGuest = (userId) => canMergeGuestInto(localStorage.getItem(GUEST_MERGED_KEY), userId);

const markGuestMerged = (userId) => {
  try {
    localStorage.setItem(GUEST_MERGED_KEY, String(userId));
  } catch {
    /* ignore */
  }
};

/* ============ 同步：脏检查 + 防抖 + 串行队列 ============ */

function markDirty(chapter, word) {
  state.sync.dirty.add(stateKey(chapter, word));
  scheduleFlush();
}

function scheduleFlush(delay = 800) {
  window.clearTimeout(state.sync.timer);
  state.sync.timer = window.setTimeout(() => void flush(), delay);
}

function serializableSettings() {
  return cloudSettingsPayload(state.settings);
}

async function flush() {
  if (!Auth.isLoggedIn()) {
    // 未登录：只保留在内存/本机，等登录后由 applyUser() 统一上报
    state.sync.dirty.clear();
    state.sync.settingsDirty = false;
    window.clearTimeout(state.sync.timer);
    return;
  }
  if (state.sync.inFlight) {
    scheduleFlush(600);
    return;
  }
  const keys = [...state.sync.dirty];
  const settingsDirty = state.sync.settingsDirty;
  if (!keys.length && !settingsDirty) {
    renderSync();
    return;
  }

  state.sync.inFlight = true;
  let failed = false;

  // 服务端单次最多 800 条，这里按 500 条切块，避免"登录后一次性上报"被 413 拒掉
  const CHUNK = 500;
  for (let i = 0; i < keys.length; i += CHUNK) {
    const slice = keys.slice(i, i + CHUNK);
    const changes = slice
      .map((key) => state.words[key])
      .filter(Boolean)
      .map((w) => ({ c: w.c, w: w.w, s: w.s, cs: w.cs, wc: w.wc, seen: w.seen, due: w.due }));
    if (!changes.length) {
      for (const key of slice) state.sync.dirty.delete(key);
      continue;
    }
    const res = await Auth.pushWords(changes);
    if (res.ok) {
      for (const key of slice) state.sync.dirty.delete(key);
    } else {
      failed = true;
      state.sync.lastError = res.msg || "同步失败";
      break;
    }
  }

  if (!failed && settingsDirty) {
    const res = await Auth.putSettings(serializableSettings());
    if (res.ok) state.sync.settingsDirty = false;
    else {
      failed = true;
      state.sync.lastError = res.msg || "设置同步失败";
    }
  }

  state.sync.inFlight = false;
  if (failed) {
    state.sync.backoff = Math.min(30000, Math.max(1000, state.sync.backoff * 2));
    scheduleFlush(state.sync.backoff);
  } else {
    state.sync.backoff = 0;
    state.sync.lastError = null;
  }
  renderSync();
}

/** 把当前所有词状态标记为待上传（登录后、导入备份后调用） */
function markAllDirty() {
  let count = 0;
  for (const key of Object.keys(state.words)) {
    const word = state.words[key];
    if (!word || !Number.isFinite(Number(word.c)) || !Number.isFinite(Number(word.w))) continue;
    state.sync.dirty.add(key);
    count++;
  }
  if (count) scheduleFlush(400);
  return count;
}

function markSettingsDirty() {
  state.sync.settingsDirty = true;
  scheduleFlush(1200);
}

/** 已同步过的最大 seen，用于增量拉取 */
function maxSeen() {
  let max = 0;
  for (const key of Object.keys(state.words)) {
    const seen = Number(state.words[key]?.seen) || 0;
    if (seen > max) max = seen;
  }
  return max;
}

/**
 * 从云端拉取并合并。
 * 关键点：**无论本地有没有存档都要拉**（旧版本地无存档时直接 return，导致新设备永远拿不到云端数据）
 * @param {{ full?: boolean }} [opts]
 */
async function syncPull(opts = {}) {
  if (!Auth.isLoggedIn()) return false;
  const since = opts.full || !state.sync.pulledOnce ? 0 : Math.max(0, maxSeen() - 60_000);
  const data = await Auth.pullWords(since);
  if (!data) {
    state.sync.lastError = "云端数据拉取失败";
    renderSync();
    return false;
  }
  const changed = mergeWordStates(state.words, data.words || []);
  state.sync.pulledOnce = true;
  state.sync.lastError = null;

  const settings = await Auth.getSettings();
  if (settings) {
    const localDaily = state.settings.daily;
    state.settings = normalizeSettings({
      ...state.settings,
      ...settings,
      // 每日目标取"更近的一天"和更大的计数，避免多端把当天进度改小
      daily:
        settings.daily && localDaily && settings.daily.date === localDaily.date
          ? { ...settings.daily, count: Math.max(settings.daily.count || 0, localDaily.count || 0) }
          : settings.daily || localDaily,
    });
  }
  if (changed || settings) {
    persistSettingsToUi();
    saveLocal();
  }
  renderSync();
  return changed > 0;
}

function renderSync() {
  const node = state.dom.syncBtn;
  if (!node) return;
  const pending = state.sync.dirty.size + (state.sync.settingsDirty ? 1 : 0);
  if (!Auth.isLoggedIn()) {
    node.textContent = "👤";
    node.title = "未登录：数据只保存在本机";
    node.classList.remove("spinning");
    return;
  }
  if (state.sync.lastError && pending) {
    node.textContent = "⚠️";
    node.title = `${state.sync.lastError}（点此重试）`;
  } else if (state.sync.inFlight || pending) {
    node.textContent = "☁️";
    node.title = `同步中… 待上传 ${pending} 项`;
  } else {
    node.textContent = "✅";
    node.title = `已同步 · ${Auth.email()}`;
  }
}

/* ============ 声音 ============ */

let audioCtx = /** @type {AudioContext|null} */ (null);
let voices = /** @type {SpeechSynthesisVoice[]} */ ([]);

function tone(freq, dur, type = "sine") {
  if (!state.settings.sfx) return;
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.16, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + dur);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + dur);
  } catch {
    /* 音频不可用不影响学习 */
  }
}

const sfxOk = () => {
  tone(880, 0.08);
  window.setTimeout(() => tone(1180, 0.1), 90);
};
const sfxBad = () => {
  tone(300, 0.14, "square");
  window.setTimeout(() => tone(200, 0.18, "square"), 140);
};

function loadVoices() {
  return new Promise((resolve) => {
    const list = window.speechSynthesis ? window.speechSynthesis.getVoices() : [];
    if (list && list.length) {
      voices = list;
      resolve(voices);
      return;
    }
    if (!window.speechSynthesis) {
      resolve([]);
      return;
    }
    window.speechSynthesis.addEventListener(
      "voiceschanged",
      () => {
        voices = window.speechSynthesis.getVoices();
        resolve(voices);
      },
      { once: true }
    );
    window.setTimeout(() => resolve(window.speechSynthesis.getVoices()), 1500);
  });
}

/**
 * 朗读单词。返回是否真的开始播放（iOS 需要用户手势，未播放时调用方给降级提示）
 * @param {string} word
 */
async function speak(word) {
  if (!state.settings.speech || !window.speechSynthesis || !word) return false;
  try {
    if (!voices.length) await loadVoices();
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(word);
    utter.lang = "en-US";
    utter.rate = state.settings.rate;
    const preferred =
      voices.find((v) => v.lang === "en-US") || voices.find((v) => v.lang?.startsWith("en")) || null;
    if (preferred) utter.voice = preferred;
    const btn = state.dom.speakBtn;
    utter.onstart = () => btn?.classList.add("speaking");
    utter.onend = () => btn?.classList.remove("speaking");
    utter.onerror = () => btn?.classList.remove("speaking");
    window.speechSynthesis.speak(utter);
    btn?.classList.remove("unsupported");
    return true;
  } catch {
    return false;
  }
}

/* ============ 章节加载 ============ */

const CHAPTER_FETCH_ATTEMPTS = 3;
const CHAPTER_CACHE_PREFIX = "vocab:cache:";
const CHAPTER_CACHE_KEEP = 2;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 把底层报错翻译成用户看得懂的话（原来直接把 "Failed to fetch" 甩给用户） */
function describeChapterError(err, attempts) {
  const raw = err instanceof Error ? err.message : String(err);
  const tail = `（已自动重试 ${attempts} 次）`;
  if (/^HTTP 404/.test(raw)) return "词库文件不存在（404）：这次部署里可能缺少 data-*.json 文件";
  if (/^HTTP /.test(raw)) return `服务器返回 ${raw.replace("HTTP ", "HTTP ")}${tail}`;
  if (/JSON|Unexpected token|Unexpected end|parse/i.test(raw)) return `词库数据解析失败${tail}`;
  if (/Failed to fetch|NetworkError|Load failed|network|fetch/i.test(raw)) return `网络连接中断${tail}`;
  return `${raw}${tail}`;
}

/** 词库本地缓存：网络抖动时兜底，最多留最近 2 章 */
function cacheChapter(chapterId, list) {
  const key = CHAPTER_CACHE_PREFIX + chapterId;
  try {
    localStorage.setItem(key, JSON.stringify({ at: Date.now(), list }));
    const entries = Object.keys(localStorage)
      .filter((k) => k.startsWith(CHAPTER_CACHE_PREFIX))
      .map((k) => {
        try {
          return { k, at: Number(JSON.parse(localStorage.getItem(k) || "{}").at) || 0 };
        } catch {
          return { k, at: 0 };
        }
      })
      .sort((a, b) => b.at - a.at);
    for (const stale of entries.slice(CHAPTER_CACHE_KEEP)) localStorage.removeItem(stale.k);
  } catch {
    // 配额不足：清掉词库缓存再试一次，仍失败就放弃（不影响正常使用）
    try {
      for (const k of Object.keys(localStorage)) if (k.startsWith(CHAPTER_CACHE_PREFIX)) localStorage.removeItem(k);
      localStorage.setItem(key, JSON.stringify({ at: Date.now(), list }));
    } catch {
      /* ignore */
    }
  }
}

function readChapterCache(chapterId) {
  try {
    const raw = localStorage.getItem(CHAPTER_CACHE_PREFIX + chapterId);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.list) && parsed.list.length ? parsed.list : null;
  } catch {
    return null;
  }
}

/** 取词库：失败自动重试（重试时绕过缓存） */
async function fetchChapterList(chapterId) {
  let lastError = new Error("未知错误");
  for (let attempt = 1; attempt <= CHAPTER_FETCH_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(`data-${Number(chapterId)}.json`, {
        headers: { accept: "application/json" },
        cache: attempt === 1 ? "default" : "reload",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const list = await res.json();
      if (!Array.isArray(list) || !list.length) throw new Error("词库内容为空");
      return list;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < CHAPTER_FETCH_ATTEMPTS) {
        state.loadingMessage = `加载失败，正在重试（${attempt + 1}/${CHAPTER_FETCH_ATTEMPTS}）…`;
        render();
        await sleep(400 * attempt);
      }
    }
  }
  throw lastError;
}

async function loadChapter(chapterId, opts = {}) {
  const id = Number(chapterId);
  state.loading = true;
  state.loadError = null;
  state.loadingMessage = "正在加载词库…";
  render();

  let list = null;
  let fromCache = false;
  try {
    list = await fetchChapterList(id);
  } catch (err) {
    const cached = readChapterCache(id);
    if (cached) {
      list = cached;
      fromCache = true;
    } else {
      state.loading = false;
      state.loadError = describeChapterError(err, CHAPTER_FETCH_ATTEMPTS);
      render();
      return false;
    }
  }

  state.loading = false;
  state.chapter = id;
  state.chapterWords = list;
  state.wordById = new Map(list.map((w) => [Number(w.id), w]));
  state.review = null;
  if (!fromCache) cacheChapter(id, list);
  startRound(opts);
  if (fromCache) toast("网络异常，正在使用本机缓存的词库", { type: "bad", duration: 4500 });
  return true;
}

/** 开始本轮（会重建牌堆） */
function startRound(opts = {}) {
  const chapterId = state.chapter;
  if (opts.fresh) state.review = null; // 「再练一轮」= 回到章节练习，不残留复习态
  const allIds = state.chapterWords.map((w) => Number(w.id));
  const due = dueReviewIds(state.words, chapterId, Date.now());
  const mastered = statesForChapter(state.words, chapterId)
    .filter((s) => s.s === STATUS.mastered)
    .map((s) => Number(s.w));

  const resume = state.settings.resume;
  const canResume =
    !opts.fresh &&
    resume &&
    Number(resume.chapter) === chapterId &&
    Array.isArray(resume.deck) &&
    resume.deck.length;

  if (canResume) {
    const valid = /** @type {number[]} */ (resume.deck).filter((id) => state.wordById.has(Number(id)));
    state.deck = valid.length ? valid : buildDeck(allIds, due, mastered);
    state.index = Math.min(Math.max(0, Number(resume.index) || 0), Math.max(0, state.deck.length - 1));
    state.session = {
      attempts: Math.max(0, Number(resume.attempts) || 0),
      correct: Math.max(0, Number(resume.correct) || 0),
    };
  } else {
    state.deck = buildDeck(allIds, due, mastered);
    state.index = 0;
    state.session = { attempts: 0, correct: 0 };
  }

  if (opts.jumpTo) {
    const target = Number(opts.jumpTo);
    if (state.wordById.has(target)) {
      const at = state.deck.indexOf(target);
      if (at >= 0) {
        [state.deck[state.index], state.deck[at]] = [state.deck[at], state.deck[state.index]];
      } else {
        state.deck[state.index] = target;
      }
      state.jumpHighlight = true;
    }
  }

  state.roundDone = false;
  renderWord({ focus: opts.focus !== false });
}

/** 进入错题 + 生词复习会话（可随时退出，不影响章节进度） */
function startReview() {
  const wrong = statesForChapter(state.words, state.chapter)
    .filter((s) => s.s === STATUS.wrong)
    .map((s) => Number(s.w));
  const stars = loadStars();
  const starIds = (stars[state.chapter] || []).filter((id) => !wrong.includes(id));
  const ids = [...wrong, ...starIds].filter((id) => state.wordById.has(id));
  if (!ids.length) {
    toast("当前章节还没有错题或生词", { type: "bad" });
    return false;
  }
  state.review = { ids, source: chapterTitle(state.chapter) };
  state.deck = shuffle(ids);
  state.index = 0;
  state.session = { attempts: 0, correct: 0 };
  state.roundDone = false;
  renderWord({ focus: true });
  return true;
}

function exitReview() {
  state.review = null;
  startRound({ fresh: true, focus: false });
  toast("已退出复习，回到章节练习");
}

/* ============ 生词本（与讲义页共用同一份 key，随设置一起同步） ============ */

/** 与 lecture.js 保持一致的命名空间，两个页面的生词本才会互通 */
const starsKey = () => `vocab:stars:${state.userKey}`;

function loadStars() {
  const candidates = [starsKey(), state.userKey === "guest" ? "vocab:stars" : null].filter(Boolean);
  for (const key of candidates) {
    try {
      const parsed = JSON.parse(localStorage.getItem(key) || "null");
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      /* 试下一个 */
    }
  }
  return {};
}

/** @param {Record<string, number[]>} stars */
function saveStars(stars) {
  try {
    localStorage.setItem(starsKey(), JSON.stringify(stars));
  } catch {
    /* ignore */
  }
}

const starIdsFor = (chapter) => loadStars()[chapter] || [];

function toggleStar(chapter, wordId) {
  const stars = loadStars();
  const list = new Set(stars[chapter] || []);
  let added;
  if (list.has(wordId)) {
    list.delete(wordId);
    added = false;
  } else {
    list.add(wordId);
    added = true;
  }
  stars[chapter] = [...list];
  saveStars(stars);
  return added;
}

/* ============ 当前词与渲染 ============ */

function currentWord() {
  const id = state.deck[state.index];
  return id ? state.wordById.get(Number(id)) ?? null : null;
}

/** @param {{ focus?: boolean }} [opts] */
function renderWord(opts = {}) {
  const word = currentWord();
  if (!word) {
    render();
    return;
  }
  const analysis = analyzeWord(word.word);
  state.slots = analysis.slots;

  // 提示位：按设置档位生成（首字母 or 随机 N 个）
  state.hintIdx = new Set();
  const letterIndexes = analysis.slots.map((s, i) => (s.sep ? -1 : i)).filter((i) => i >= 0);
  const hintCount = Math.min(state.settings.hint, letterIndexes.length - 1);
  if (hintCount > 0) {
    if (state.settings.hint === 1) {
      state.hintIdx.add(letterIndexes[0]);
    } else {
      for (const idx of shuffle(letterIndexes).slice(0, hintCount)) state.hintIdx.add(idx);
    }
  }

  state.editables = analysis.slots
    .map((s, i) => (s.sep || state.hintIdx.has(i) ? -1 : i))
    .filter((i) => i >= 0);
  state.values = new Array(state.editables.length).fill("");
  // 提示字母直接显示（不可编辑）
  state.cursor = 0;
  state.answered = false;
  state.lastResult = null;
  state.timedOut = false;
  state.roundDone = false;

  // 每题重新抽一次模式（随机模式）
  const mode = state.settings.mode === "random" ? (Math.random() < 0.5 ? "chinese" : "audio") : state.settings.mode;
  state.currentMode = mode;

  render();
  announce(mode === "chinese" ? `请拼写：${word.meaningCN}` : "请听音拼写当前单词");

  if (mode === "audio") {
    void speak(word.word).then((played) => {
      if (!played && state.dom.speakBtn) {
        state.dom.promptHint.textContent = "点 🔊 播放（浏览器可能要求先点一下）";
      }
    });
  }
  startTimer();
  if (opts.focus !== false) focusInput();
  saveLocal();
}

/** 把当前进度写进设置（断点续做） */
function persistResume() {
  state.settings.resume = {
    chapter: state.chapter,
    index: state.index,
    deck: state.deck.slice(0, 600),
    attempts: state.session.attempts,
    correct: state.session.correct,
    at: Date.now(),
  };
}

function render() {
  renderTopbar();
  renderStage();
  renderSync();
}

function renderTopbar() {
  const { brandSub } = state.dom;
  if (brandSub) {
    brandSub.textContent = state.review
      ? `复习：${state.review.source}`
      : `${chapterTitle(state.chapter)}`;
  }
}

function renderStage() {
  const dom = state.dom;
  const head = dom.stageHead;
  if (!head) return;

  if (state.loading) {
    // 加载中/重试中也保留章节按钮，避免用户被卡在加载页
    head.hidden = false;
    dom.loading.hidden = false;
    dom.loadingText.textContent = state.loadingMessage || "正在加载词库…";
    dom.loadError.hidden = true;
    dom.body.hidden = true;
    return;
  }
  if (state.loadError) {
    // 出错时同样保留章节按钮：用户可以直接换一章，而不是只能死等重试
    head.hidden = false;
    dom.loading.hidden = true;
    dom.loadError.hidden = false;
    dom.body.hidden = true;
    dom.loadErrorText.textContent = state.loadError;
    return;
  }
  head.hidden = false;
  dom.loading.hidden = true;
  dom.loadError.hidden = true;
  dom.body.hidden = false;

  const word = currentWord();
  const total = state.deck.length || 1;
  const done = Math.min(state.index + (state.answered ? 1 : 0), total);
  dom.meta.textContent = `${done}/${total}`;
  dom.progressFill.style.width = `${Math.round((state.index / total) * 100)}%`;
  dom.chapterBtn.textContent = `📚 ${chapterTitle(state.chapter)}`;
  dom.chapterBtn.title = state.review ? "复习模式：点此返回章节" : "切换章节";
  dom.reviewBanner.hidden = !state.review;

  const chart = chapterProgress(state.words, state.chapter, CHAPTER_BY_ID.get(state.chapter)?.count || 0);
  dom.chapterBtn.setAttribute(
    "aria-label",
    `${chapterTitle(state.chapter)}，已掌握 ${chart.mastered} 词，错题 ${chart.wrong} 词，点击切换章节`
  );

  // 模式分段控件
  for (const btn of $$("[data-mode]", dom.modeSeg)) {
    btn.setAttribute("aria-pressed", String(btn.dataset.mode === state.settings.mode));
  }

  // 提示与计时状态：提示档位在主界面常驻（与设置抽屉里的同一项保持同步）
  dom.timerChip.hidden = !state.settings.timerEnabled;
  dom.hintSelect.value = String(state.settings.hint);
  dom.hintPick.classList.toggle("on", state.settings.hint > 0);
  for (const btn of $$('[data-seg="hint"] button')) {
    btn.setAttribute("aria-pressed", String(Number(btn.dataset.value) === state.settings.hint));
  }

  if (!word) return;

  // 题干
  const mode = state.currentMode || state.settings.mode;
  if (mode === "audio") {
    dom.promptCn.hidden = true;
    dom.promptAudio.hidden = false;
    dom.promptHint.textContent = "听音拼写 · 可重复播放";
  } else {
    dom.promptCn.hidden = false;
    dom.promptAudio.hidden = true;
    dom.promptCn.textContent = word.meaningCN;
  }

  renderSlots();
  if (state.jumpHighlight) {
    state.jumpHighlight = false;
    flash(state.dom.slotsWrap);
  }

  // 反馈与示例
  dom.feedback.className = "feedback";
  dom.feedback.textContent = "";
  if (state.lastResult === "ok") {
    dom.feedback.classList.add("ok");
    dom.feedback.textContent = "✔️ 正确";
  } else if (state.lastResult === "bad") {
    dom.feedback.classList.add("bad");
    dom.feedback.innerHTML = `${state.timedOut ? "⏰ 时间到" : "❌ 拼写错误"} · 正确答案 <b class="answer-word">${escapeHTML(
      word.word
    )}</b>`;
  }
  if (state.answered && word.exampleEN) {
    dom.example.hidden = false;
    dom.exampleEn.textContent = word.exampleEN;
    dom.exampleCn.textContent = word.exampleCN || "";
  } else {
    dom.example.hidden = true;
  }

  // 主按钮：文案随状态变化（旧版永远是"提交 / 下一题"）
  if (state.roundDone) {
    dom.primaryBtn.textContent = "查看本轮报告";
  } else if (state.answered) {
    dom.primaryBtn.textContent = state.index + 1 >= total ? "完成本轮" : "下一题 ⏎";
  } else {
    dom.primaryBtn.textContent = "提交 ⏎";
  }
  dom.primaryBtn.disabled = !state.answered && !inputComplete();
  dom.starBtn.setAttribute("aria-pressed", String(starIdsFor(state.chapter).includes(Number(word.id))));
  dom.starBtn.textContent = dom.starBtn.getAttribute("aria-pressed") === "true" ? "★ 已收藏" : "☆ 生词";
}

/** 槽位 DOM 只创建一次，按键只改文本/类名（修掉"每次按键整排闪烁"） */
function renderSlots() {
  const host = state.dom.slots;
  const word = currentWord();
  if (!host || !word) return;

  if (host.childElementCount !== state.slots.length) {
    host.replaceChildren();
    state.slots.forEach((slot, index) => {
      const node = el("div", {
        class: `slot${slot.sep ? " sep" : ""}`,
        dataset: { index: String(index) },
      });
      // 入场动效只在换词时跑一次（打字时只改文本/类名，避免整排闪烁）
      node.classList.add("enter");
      node.style.animationDelay = `${Math.min(index * 18, 200)}ms`;
      host.append(node);
    });
    state.dom.slotNodes = Array.from(host.children);
    const fresh = /** @type {HTMLElement[]} */ (state.dom.slotNodes);
    window.setTimeout(() => {
      for (const node of fresh) {
        node.classList.remove("enter");
        node.style.animationDelay = "";
      }
    }, 650);
  }

  const nodes = /** @type {HTMLElement[]} */ (state.dom.slotNodes);
  state.slots.forEach((slot, index) => {
    const node = nodes[index];
    if (!node) return;
    node.classList.remove("cursor", "hint", "filled", "ok", "bad");
    if (slot.sep) {
      node.textContent = slot.ch === " " ? "␣" : slot.ch;
      return;
    }
    if (state.hintIdx.has(index)) {
      node.textContent = slot.ch.toLowerCase();
      node.classList.add("hint");
      return;
    }
    const pos = state.editables.indexOf(index);
    const value = pos >= 0 ? state.values[pos] || "" : "";
    node.textContent = value;
    if (value) node.classList.add("filled");
    if (!state.answered && pos === state.cursor) node.classList.add("cursor");
    if (state.answered) {
      const expected = slot.ch.toLowerCase();
      node.classList.add(value && value === expected ? "ok" : "bad");
    }
  });

  if (state.dom.tapHint) {
    const focused = document.activeElement === state.dom.answerInput;
    state.dom.tapHint.textContent = state.answered
      ? ""
      : focused || window.matchMedia("(pointer: fine)").matches
        ? ""
        : "点这里调出键盘开始输入";
  }
}

/** 当前输入是否已填满（判分前置条件） */
function inputComplete() {
  return state.values.length > 0 && state.values.every(Boolean);
}

/** 组装与 slots 对齐的输入数组，供 core.judgeAnswer 使用 */
function slotChars() {
  const out = state.slots.map((slot) => (slot.sep ? slot.ch : ""));
  for (let i = 0; i < state.editables.length; i++) {
    out[state.editables[i]] = state.values[i] || "";
  }
  return out;
}

/* ============ 输入 ============ */

function focusInput() {
  const input = state.dom.answerInput;
  if (!input) return;
  // 桌面端自动聚焦；触屏设备由用户点击触发（避免一进页面就弹键盘）
  try {
    input.focus({ preventScroll: true });
  } catch {
    /* ignore */
  }
}

/** @param {string} ch */
function typeLetter(ch) {
  if (state.answered) return;
  if (state.cursor >= state.editables.length) return;
  state.values[state.cursor] = ch.toLowerCase();
  const node = state.dom.slotNodes?.[state.editables[state.cursor]];
  if (node) {
    node.classList.remove("pop");
    void node.offsetWidth;
    node.classList.add("pop");
  }
  state.cursor += 1;
  renderSlots();
  renderPrimaryState();
}

function backspace() {
  if (state.answered) return;
  if (state.cursor <= 0) return;
  state.cursor -= 1;
  state.values[state.cursor] = "";
  renderSlots();
  renderPrimaryState();
}

function clearAtCursor() {
  if (state.answered) return;
  if (state.cursor >= state.editables.length) return;
  state.values[state.cursor] = "";
  renderSlots();
  renderPrimaryState();
}

function renderPrimaryState() {
  const btn = state.dom.primaryBtn;
  if (!btn) return;
  btn.disabled = !state.answered && !inputComplete();
}

/* ============ 判分与推进 ============ */

function submit() {
  if (state.answered || state.roundDone) return;
  const word = currentWord();
  if (!word) return;
  if (!inputComplete()) {
    state.dom.feedback.className = "feedback warn";
    state.dom.feedback.textContent = "先把单词补完整";
    return;
  }
  stopTimer();
  finalize(judgeAnswer(state.slots, slotChars(), word.word), false);
}
function handleTimeout() {
  if (state.answered) return;
  finalize(false, true);
}

/**
 * @param {boolean} correct
 * @param {boolean} timedOut
 */
function finalize(correct, timedOut) {
  const word = currentWord();
  if (!word) return;
  state.answered = true;
  state.timedOut = timedOut;
  state.lastResult = correct ? "ok" : "bad";

  const now = Date.now();
  const key = stateKey(state.chapter, Number(word.id));
  const prev = state.words[key];
  const next = applyResult(prev, correct, now);
  const becameMastered = next.s === STATUS.mastered && prev?.s !== STATUS.mastered;
  const leftWrongBook = prev?.s === STATUS.wrong && next.s !== STATUS.wrong;

  state.words[key] = { c: state.chapter, w: Number(word.id), ...next };
  markDirty(state.chapter, Number(word.id));

  state.session.attempts += 1;
  if (correct) state.session.correct += 1;

  if (correct) sfxOk();
  else sfxBad();

  if (!correct) {
    // 当天即再遇一次（回插到本轮的后面）
    state.deck = insertAhead(state.deck, state.index, Number(word.id));
  }

  const { daily, achievedNow } = recordDaily(state.settings.daily, localDateKey());
  state.settings.daily = daily;
  markSettingsDirty();
  if (achievedNow) {
    toast(`🎉 今日目标达成！连续 ${currentStreak(daily, localDateKey())} 天`, { type: "ok", duration: 5000 });
  }

  if (becameMastered) {
    toast("🎉 已掌握，移出错题本", { type: "ok" });
  } else if (leftWrongBook) {
    toast("已移出错题本（再答对一次即掌握）", { type: "ok" });
  }

  persistResume();
  void speak(word.word);
  render();
}

function advance() {
  if (state.roundDone) {
    showReport();
    return;
  }
  if (!state.answered) return;
  const total = state.deck.length;
  if (state.index + 1 >= total) {
    finishRound();
    return;
  }
  state.index += 1;
  persistResume();
  saveLocal();
  renderWord();
}

function finishRound() {
  state.roundDone = true;
  persistResume();
  saveLocal();
  render();
  showReport();
}

function skip() {
  if (state.roundDone) return;
  if (state.index + 1 >= state.deck.length) {
    finishRound();
    return;
  }
  state.index += 1;
  persistResume();
  saveLocal();
  renderWord();
}

/* ============ 计时器（基于时间戳，标签页切走不误判） ============ */

function startTimer() {
  stopTimer();
  if (!state.settings.timerEnabled || state.answered) return;
  state.timer.deadline = performance.now() + state.settings.timerSeconds * 1000;
  tickTimer();
}

function stopTimer() {
  if (state.timer.handle) {
    window.clearTimeout(state.timer.handle);
    state.timer.handle = 0;
  }
}

function tickTimer() {
  if (!state.settings.timerEnabled || state.answered) return;
  const left = (state.timer.deadline - performance.now()) / 1000;
  const chip = state.dom.timerChip;
  if (chip) {
    chip.textContent = `⏳ ${formatClock(Math.max(0, left))}`;
    chip.classList.toggle("urgent", left <= 3);
  }
  if (left <= 0) {
    handleTimeout();
    return;
  }
  state.timer.handle = window.setTimeout(tickTimer, 180);
}

function bindTimerVisibility() {
  document.addEventListener("visibilitychange", () => {
    if (!state.settings.timerEnabled) return;
    if (document.hidden) {
      state.timer.hiddenAt = performance.now();
    } else if (state.timer.hiddenAt) {
      // 切回页面时把隐藏期间的时间补给用户，避免"回来就超时"
      state.timer.deadline += performance.now() - state.timer.hiddenAt;
      state.timer.hiddenAt = 0;
      tickTimer();
    }
  });
}

/* ============ 报告 ============ */

function showReport() {
  const stats = computeStats(state.session);
  const chart = chapterProgress(state.words, state.chapter, CHAPTER_BY_ID.get(state.chapter)?.count || 0);
  const wrongWords = statesForChapter(state.words, state.chapter)
    .filter((s) => s.s === STATUS.wrong)
    .map((s) => state.wordById.get(Number(s.w)))
    .filter(Boolean);

  const sheet = openSheet({ title: state.review ? "复习报告" : "本轮报告" });
  const great = stats.accuracy >= 80;
  sheet.body.append(
    el("div", { class: `result-banner ${great ? "great" : "soso"}` }, [
      great ? `👍 本轮正确率 ${stats.accuracy}%` : `继续加油 · 本轮正确率 ${stats.accuracy}%`,
    ]),
    el("div", { class: "report-grid" }, [
      el("div", { class: "report-cell" }, [el("b", { text: String(stats.attempts) }), el("small", { text: "本轮尝试" })]),
      el("div", { class: "report-cell" }, [el("b", { text: String(stats.correct) }), el("small", { text: "答对" })]),
      el("div", { class: "report-cell" }, [el("b", { text: String(chart.mastered) }), el("small", { text: "本章已掌握" })]),
    ]),
    el("p", { class: "small muted", text: `本章进度：已掌握 ${chart.mastered} / ${chart.total}，错题 ${chart.wrong}，学习中 ${chart.learning}` })
  );

  if (wrongWords.length) {
    sheet.body.append(el("h3", { class: "small", text: `需要加固的词（${wrongWords.length}）` }));
    const chips = el("div", { class: "word-chips" });
    for (const word of wrongWords.slice(0, 200)) {
      chips.append(
        el("button", {
          class: "word-chip",
          type: "button",
          title: "点击朗读",
          onclick: () => void speak(word.word),
        }, [el("span", { text: word.word }), el("span", { class: "meaning", text: word.meaningCN })])
      );
    }
    sheet.body.append(chips);
  }

  sheet.body.append(
    el("div", { class: "dialog-actions" }, [
      el("button", {
        class: "btn",
        type: "button",
        text: "复习错题+生词",
        onclick: () => {
          sheet.close();
          startReview();
        },
      }),
      el("button", {
        class: "btn",
        type: "button",
        text: "切换章节",
        onclick: () => {
          sheet.close();
          openChapterSheet();
        },
      }),
      el("button", {
        class: "btn btn-primary",
        type: "button",
        text: "再练一轮",
        onclick: () => {
          sheet.close();
          startRound({ fresh: true, focus: true });
        },
      }),
    ])
  );
}

/* ============ 章节 / 菜单 / 设置 抽屉 ============ */

function openChapterSheet() {
  const sheet = openSheet({ title: "选择章节" });
  const list = el("div", { class: "list chapter-list" });
  const now = Date.now();

  sheet.body.append(
    el("p", { class: "small muted", text: `共 ${CHAPTERS.length} 章。进度按"已掌握"统计，错词会优先复现。` })
  );

  for (const chapter of CHAPTERS) {
    const progress = chapterProgress(state.words, chapter.id, chapter.count);
    const due = dueReviewIds(state.words, chapter.id, now, 99).length;
    const isCurrent = chapter.id === state.chapter;
    const bar = el("div", { class: "progress thin chapter-item-progress" }, [
      el("i", { style: `width:${progress.percent}%` }),
    ]);
    const item = el(
      "button",
      {
        class: "list-item",
        type: "button",
        "aria-current": String(isCurrent),
        onclick: () => {
          sheet.close();
          if (state.review) state.review = null;
          void loadChapter(chapter.id);
        },
      },
      [
        el("div", { class: "chapter-item-main" }, [
          el("strong", { text: `${chapter.emoji} 第${chapter.id}章 · ${chapter.title}` }),
          el("span", { class: "meta" }, [
            el("span", { text: `掌握 ${progress.mastered}/${chapter.count}` }),
            progress.wrong ? el("span", { class: "chip-bad chip", text: `错 ${progress.wrong}` }) : null,
            due ? el("span", { class: "chip-warn chip", text: `待复习 ${due}` }) : null,
          ]),
          bar,
        ]),
        el("span", { class: "go", text: isCurrent ? "当前" : "▶" }),
      ]
    );
    list.append(item);
  }
  sheet.body.append(list);
}

function openMenuSheet(tab = "settings") {
  const sheet = openSheet({ title: "学习面板" });
  const tabs = el("div", { class: "tabs", role: "tablist" });
  const panels = el("div");

  const renderTab = (/** @type {string} */ which) => {
    for (const btn of $$("button", tabs)) btn.setAttribute("aria-selected", String(btn.dataset.tab === which));
    panels.replaceChildren();
    if (which === "settings") panels.append(buildSettingsPanel(sheet));
    else if (which === "wrong") panels.append(buildBookPanel("wrong", sheet));
    else panels.append(buildBookPanel("star", sheet));
  };

  for (const [key, label] of [
    ["settings", "设置"],
    ["wrong", `错题本 ${statesForChapter(state.words, state.chapter).filter((s) => s.s === STATUS.wrong).length}`],
    ["star", `生词本 ${starIdsFor(state.chapter).length}`],
  ]) {
    tabs.append(
      el("button", {
        type: "button",
        role: "tab",
        dataset: { tab: key },
        text: label,
        onclick: () => renderTab(key),
      })
    );
  }
  sheet.body.append(tabs, panels);
  renderTab(tab);
}

/** 错题本 / 生词本面板 */
function buildBookPanel(which, sheet) {
  const wrap = el("div", { class: "stack-3" });
  const ids =
    which === "wrong"
      ? statesForChapter(state.words, state.chapter)
          .filter((s) => s.s === STATUS.wrong)
          .map((s) => Number(s.w))
      : starIdsFor(state.chapter);
  const words = ids.map((id) => state.wordById.get(Number(id))).filter(Boolean);

  if (!words.length) {
    wrap.append(el("p", { class: "empty", text: which === "wrong" ? "本章暂无错题 🎉" : "本章暂无生词，答题时点「☆ 生词」收藏" }));
  } else {
    const chips = el("div", { class: "word-chips" });
    for (const word of words) {
      const chip = el(
        "span",
        { class: `word-chip${which === "star" ? " new-word" : ""}` },
        [
          el("span", {
            text: word.word,
            title: "点击朗读",
            style: "cursor:pointer",
            onclick: () => void speak(word.word),
          }),
          el("span", { class: "meaning", text: word.meaningCN }),
        ]
      );
      chip.append(
        el("span", {
          class: "x",
          text: "✕",
          title: "移除",
          style: "cursor:pointer",
          onclick: () => {
            if (which === "wrong") {
              state.words[stateKey(state.chapter, Number(word.id))] = {
                ...(state.words[stateKey(state.chapter, Number(word.id))] || {}),
                c: state.chapter,
                w: Number(word.id),
                s: STATUS.learning,
                cs: 0,
                wc: Number(state.words[stateKey(state.chapter, Number(word.id))]?.wc) || 0,
                seen: Date.now(),
                due: 0,
              };
              markDirty(state.chapter, Number(word.id));
            } else {
              toggleStar(state.chapter, Number(word.id));
            }
            if (state.review) {
              state.review.ids = state.review.ids.filter((id) => Number(id) !== Number(word.id));
              state.deck = state.deck.filter((id) => Number(id) !== Number(word.id));
              if (state.index >= state.deck.length) state.index = Math.max(0, state.deck.length - 1);
            }
            sheet.close();
            openMenuSheet(which);
            render();
          },
        })
      );
      chips.append(chip);
    }
    wrap.append(chips);
  }

  if (words.length) {
    wrap.append(
      el("div", { class: "dialog-actions" }, [
        el("button", {
          class: "btn btn-danger",
          type: "button",
          text: which === "wrong" ? "清空错题本" : "清空生词本",
          onclick: async () => {
            const ok = await confirmDialog({
              title: which === "wrong" ? "清空本章错题本？" : "清空本章生词本？",
              message: "该操作会立即同步到云端，可以撤销。",
              confirmText: "清空",
              danger: true,
            });
            if (!ok) return;
            const snapshot = { ...state.words };
            const snapshotStars = loadStars();
            if (which === "wrong") {
              for (const id of ids) {
                const key = stateKey(state.chapter, Number(id));
                if (state.words[key]) {
                  state.words[key] = { ...state.words[key], s: STATUS.learning, cs: 0, seen: Date.now(), due: 0 };
                  markDirty(state.chapter, Number(id));
                }
              }
            } else {
              const stars = loadStars();
              stars[state.chapter] = [];
              saveStars(stars);
            }
            sheet.close();
            render();
            toast(which === "wrong" ? "已清空错题本" : "已清空生词本", {
              type: "ok",
              action: {
                label: "撤销",
                onClick: () => {
                  state.words = snapshot;
                  saveStars(snapshotStars);
                  for (const id of ids) markDirty(state.chapter, Number(id));
                  render();
                },
              },
            });
          },
        }),
        el("button", {
          class: "btn btn-primary",
          type: "button",
          text: "开始复习",
          onclick: () => {
            sheet.close();
            startReview();
          },
        }),
      ])
    );
  }
  return wrap;
}

/** 设置面板 */
function buildSettingsPanel(sheet) {
  const wrap = el("div");
  const settings = state.settings;

  /* 学习 */
  const dailyGroup = el("div", { class: "settings-group" }, [el("h3", { text: "学习" })]);
  const today = localDateKey();
  const streak = currentStreak(settings.daily, today);
  dailyGroup.append(
    el("div", { class: "setting-row" }, [
      el("div", { class: "label" }, [
        el("b", { text: "每日目标" }),
        el("small", {
          text: `今日 ${settings.daily.count}/${settings.daily.target}${settings.daily.achieved ? " · 已达成 🎉" : ""}${
            streak ? ` · 连续 ${streak} 天` : ""
          }`,
        }),
      ]),
      el("div", { class: "row" }, [
        el("button", {
          class: "btn btn-sm",
          type: "button",
          text: "修改",
          onclick: async () => {
            const value = await promptDialog({
              title: "每日目标",
              label: "每天要完成多少词？",
              value: String(settings.daily.target),
              type: "number",
              min: 1,
              max: 999,
              hint: "达标后不再清零，可累计超额完成",
            });
            if (value === null) return;
            const target = Math.max(1, Math.min(999, Number(value) || settings.daily.target));
            settings.daily = { ...settings.daily, target };
            markSettingsDirty();
            sheet.close();
            openMenuSheet("settings");
            render();
          },
        }),
      ]),
    ]),
    el("div", { class: "setting-row" }, [
      el("div", { class: "label" }, [el("b", { text: "提示字母" }), el("small", { text: "首字母或随机字母，降低起步难度" })]),
      buildSeg(
        [
          [0, "无"],
          [1, "首字母"],
          [2, "随机2"],
          [3, "随机3"],
        ],
        settings.hint,
        (value) => {
          settings.hint = Number(value);
          markSettingsDirty();
          if (!state.answered) renderWord({ focus: false });
          else render();
        },
        "hint"
      ),
    ]),
    el("div", { class: "setting-row" }, [
      el("div", { class: "label" }, [el("b", { text: "限时作答" }), el("small", { text: "每题倒计时，超时判定为错" })]),
      el("div", { class: "row" }, [
        buildSeg(
          [
            [5, "5s"],
            [10, "10s"],
            [15, "15s"],
            [20, "20s"],
          ],
          settings.timerSeconds,
          (value) => {
            settings.timerSeconds = Number(value);
            markSettingsDirty();
            if (settings.timerEnabled) startTimer();
          }
        ),
        buildSwitch(settings.timerEnabled, (on) => {
          settings.timerEnabled = on;
          markSettingsDirty();
          if (on) startTimer();
          else stopTimer();
          render();
        }),
      ]),
    ])
  );

  /* 声音 */
  const soundGroup = el("div", { class: "settings-group" }, [
    el("h3", { text: "声音" }),
    el("div", { class: "setting-row" }, [
      el("div", { class: "label" }, [el("b", { text: "答对/答错音效" })]),
      buildSwitch(settings.sfx, (on) => {
        settings.sfx = on;
        markSettingsDirty();
      }),
    ]),
    el("div", { class: "setting-row" }, [
      el("div", { class: "label" }, [el("b", { text: "朗读单词" }), el("small", { text: "判分后与听音模式都会朗读" })]),
      buildSwitch(settings.speech, (on) => {
        settings.speech = on;
        markSettingsDirty();
        if (on) void speak(currentWord()?.word || "");
      }),
    ]),
    el("div", { class: "setting-row" }, [
      el("div", { class: "label" }, [el("b", { text: "朗读语速" })]),
      buildSeg(
        [
          [0.7, "慢"],
          [0.9, "正常"],
          [1.1, "快"],
        ],
        settings.rate,
        (value) => {
          settings.rate = Number(value);
          markSettingsDirty();
          void speak(currentWord()?.word || "");
        }
      ),
    ]),
  ]);

  /* 外观 */
  const themeGroup = el("div", { class: "settings-group" }, [
    el("h3", { text: "外观" }),
    el("div", { class: "setting-row" }, [
      el("div", { class: "label" }, [el("b", { text: "主题" }), el("small", { text: "跟随系统 / 浅色 / 深色" })]),
      buildSeg(
        [
          ["system", "跟随系统"],
          ["light", "浅色"],
          ["dark", "深色"],
        ],
        theme.stored(),
        (value) => theme.set(/** @type {any} */ (value))
      ),
    ]),
  ]);

  /* 账号 */
  const accountGroup = el("div", { class: "settings-group" }, [el("h3", { text: "账号与同步" })]);
  if (Auth.isLoggedIn()) {
    accountGroup.append(
      el("div", { class: "setting-row" }, [
        el("div", { class: "label" }, [
          el("b", { text: Auth.nickname() || "已登录" }),
          el("small", { text: `${Auth.email()} · 进度、备注、配图都在云端` }),
        ]),
        el("div", { class: "row" }, [
          el("button", {
            class: "btn btn-sm",
            type: "button",
            text: "改昵称",
            onclick: async () => {
              const value = await promptDialog({ title: "修改昵称", value: Auth.nickname() });
              if (!value) return;
              const res = await Auth.updateNickname(value.trim());
              toast(res.ok ? "昵称已更新" : res.msg || "修改失败", { type: res.ok ? "ok" : "bad" });
              sheet.close();
              openMenuSheet("settings");
            },
          }),
          el("button", {
            class: "btn btn-sm",
            type: "button",
            text: "改密码",
            onclick: () => {
              sheet.close();
              openPasswordSheet();
            },
          }),
          el("button", {
            class: "btn btn-sm",
            type: "button",
            text: "退出登录",
            onclick: async () => {
              const ok = await confirmDialog({
                title: "退出登录？",
                message: "退出后本机数据仍保留，但不再上传；重新登录会与云端合并。",
                confirmText: "退出",
              });
              if (!ok) return;
              await Auth.logout();
              sheet.close();
              toast("已退出登录", { type: "ok" });
            },
          }),
        ]),
      ]),
    );
  } else {
    accountGroup.append(
      el("p", { class: "small muted", text: "登录后进度、错题本、讲义备注与配图会在多台设备间自动同步。" }),
      el("div", { class: "dialog-actions", style: "justify-content:flex-start" }, [
        el("button", {
          class: "btn btn-primary",
          type: "button",
          text: "登录 / 注册",
          onclick: () => {
            sheet.close();
            openAuthSheet();
          },
        }),
      ])
    );
  }

  /* 数据 */
  const dataGroup = el("div", { class: "settings-group" }, [
    el("h3", { text: "数据" }),
    el("div", { class: "row", style: "flex-wrap:wrap;gap:8px" }, [
      el("button", {
        class: "btn btn-sm",
        type: "button",
        text: "导出备份",
        onclick: async () => {
          if (!Auth.isLoggedIn()) {
            downloadJson({ version: 1, exportedAt: new Date().toISOString(), localWords: state.words, settings: state.settings }, "vocab-backup");
            toast("已导出本机数据", { type: "ok" });
            return;
          }
          const data = await Auth.exportAll(true);
          if (!data) {
            toast("导出失败，请稍后重试", { type: "bad" });
            return;
          }
          downloadJson(data, "vocab-backup");
          toast("已导出云端备份（含配图）", { type: "ok" });
        },
      }),
      el("button", {
        class: "btn btn-sm",
        type: "button",
        text: "导入备份",
        onclick: () => importBackup(),
      }),
    ]),
    el("div", { class: "danger-zone", style: "margin-top:12px" }, [
      el("p", { class: "small", style: "margin:0 0 8px", text: "以下操作会影响本章学习状态，均会同步到云端（可撤销）。" }),
      el("div", { class: "row", style: "flex-wrap:wrap;gap:8px" }, [
        el("button", {
          class: "btn btn-sm btn-danger",
          type: "button",
          text: "重置本章进度",
          onclick: async () => {
            const ok = await confirmDialog({
              title: `重置「${chapterTitle(state.chapter)}」？`,
              message: "本章的掌握状态、错题本会全部清空，无法恢复学习历史（10 秒内可撤销）。",
              confirmText: "重置",
              danger: true,
            });
            if (!ok) return;
            const snapshot = { ...state.words };
            const keys = statesForChapter(state.words, state.chapter).map((s) => stateKey(s.c, s.w));
            for (const key of keys) delete state.words[key];
            if (Auth.isLoggedIn()) void Auth.resetChapter(state.chapter);
            startRound({ fresh: true, focus: false });
            render();
            toast("已重置本章进度", {
              type: "ok",
              action: {
                label: "撤销",
                onClick: () => {
                  state.words = snapshot;
                  for (const key of keys) {
                    const [c, w] = key.split(":").map(Number);
                    state.words[key] = { ...state.words[key], seen: Date.now() };
                    markDirty(c, w);
                  }
                  render();
                },
              },
            });
          },
        }),
      ]),
    ]),
  ]);

  wrap.append(dailyGroup, soundGroup, themeGroup, accountGroup, dataGroup);
  return wrap;
}

/**
 * 分段控件
 * @param {Array<[any, string]>} options
 * @param {any} value
 * @param {(value: any) => void} onChange
 * @param {string} [name] 用于跨面板同步（例如主界面与设置里的"提示"是同一项）
 */
function buildSeg(options, value, onChange, name) {
  const seg = el("div", { class: "seg", role: "group", dataset: name ? { seg: name } : undefined });
  for (const [optionValue, label] of options) {
    seg.append(
      el("button", {
        type: "button",
        text: label,
        dataset: { value: String(optionValue) },
        "aria-pressed": String(String(optionValue) === String(value)),
        onclick: () => onChange(optionValue),
      })
    );
  }
  return seg;
}

/**
 * @param {boolean} checked
 * @param {(checked: boolean) => void} onChange
 */
function buildSwitch(checked, onChange) {
  const btn = el("button", {
    class: "switch",
    type: "button",
    role: "switch",
    "aria-checked": String(checked),
    "aria-label": checked ? "已开启" : "已关闭",
    onclick: () => {
      const next = btn.getAttribute("aria-checked") !== "true";
      btn.setAttribute("aria-checked", String(next));
      onChange(next);
    },
  });
  return btn;
}

/** 登录 / 注册（顶部有明确的切换，按钮文案说"登录 / 注册"就必须两者都能直接看到） */
function openAuthSheet(mode = "login") {
  const sheet = openSheet({ title: "账号" });
  const render = (/** @type {"login" | "register"} */ which) => {
    sheet.body.replaceChildren();
    const switchSeg = el("div", { class: "seg", role: "group", "aria-label": "登录或注册", style: "display:flex;margin-bottom:14px" }, [
      el("button", {
        type: "button",
        text: "登录",
        style: "flex:1",
        "aria-pressed": String(which === "login"),
        onclick: () => render("login"),
      }),
      el("button", {
        type: "button",
        text: "注册",
        style: "flex:1",
        "aria-pressed": String(which === "register"),
        onclick: () => render("register"),
      }),
    ]);
    const error = el("p", { class: "small", style: "color:var(--bad);min-height:1.2em;margin:0 0 8px" });
    const email = el("input", { class: "input", type: "email", autocomplete: "username", placeholder: "you@example.com", required: true });
    const password = el("input", {
      class: "input",
      type: "password",
      autocomplete: which === "login" ? "current-password" : "new-password",
      placeholder: which === "login" ? "密码" : "密码（至少 8 位）",
      required: true,
      minlength: "8",
    });
    const nickname = el("input", { class: "input", type: "text", autocomplete: "nickname", placeholder: "昵称（可选）" });
    const form = el("form", { class: "stack-3", novalidate: "false" });
    form.append(
      el("div", { class: "field" }, [el("label", { text: "邮箱" }), email]),
      el("div", { class: "field" }, [
        el("label", { text: "密码" }),
        password,
        which === "register" ? el("span", { class: "hint", text: "至少 8 位，建议混合字母和数字" }) : el("span"),
      ]),
      which === "register" ? el("div", { class: "field" }, [el("label", { text: "昵称" }), nickname]) : el("span"),
      error,
      el("button", { class: "btn btn-primary btn-block", type: "submit", text: which === "login" ? "登录" : "注册并登录" })
    );
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      error.textContent = "";
      const submitBtn = /** @type {HTMLButtonElement} */ ($("button[type=submit]", form));
      submitBtn.disabled = true;
      submitBtn.textContent = "请稍候…";
      const res =
        which === "login"
          ? await Auth.login(email.value.trim(), password.value)
          : await Auth.register(email.value.trim(), password.value, nickname.value.trim());
      submitBtn.disabled = false;
      submitBtn.textContent = which === "login" ? "登录" : "注册并登录";
      if (!res.ok) {
        error.textContent = res.msg || "操作失败";
        return;
      }
      sheet.close();
      toast("登录成功，正在合并云端进度…", { type: "ok" });
    });
    sheet.body.append(
      switchSeg,
      form,
      el("p", {
        class: "small muted",
        style: "margin-top:12px",
        text: which === "login" ? "首次使用请切到「注册」，用邮箱创建一个账号。" : "已有账号？切到「登录」。",
      })
    );
    return form;
  };
  const form = render(/** @type {any} */ (mode));
  form?.querySelector("input")?.focus?.();
}

function openPasswordSheet() {
  const sheet = openSheet({ title: "修改密码" });
  const current = el("input", { class: "input", type: "password", autocomplete: "current-password" });
  const next = el("input", { class: "input", type: "password", autocomplete: "new-password", minlength: "8" });
  const error = el("p", { class: "small", style: "color:var(--bad);min-height:1.2em" });
  const form = el("form", { class: "stack-3" });
  form.append(
    el("div", { class: "field" }, [el("label", { text: "当前密码" }), current]),
    el("div", { class: "field" }, [el("label", { text: "新密码" }), next, el("span", { class: "hint", text: "至少 8 位；修改后其它设备需重新登录" })]),
    error,
    el("button", { class: "btn btn-primary btn-block", type: "submit", text: "确认修改" })
  );
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const res = await Auth.changePassword(current.value, next.value);
    if (!res.ok) {
      error.textContent = res.msg || "修改失败";
      return;
    }
    sheet.close();
    toast("密码已修改，其它设备的登录已失效", { type: "ok" });
  });
  sheet.body.append(form);
}

/* ============ 备份导入导出 ============ */

/** @param {any} data @param {string} name */
function downloadJson(data, name) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = el("a", { href: url, download: `${name}-${localDateKey()}.json` });
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function importBackup() {
  const input = el("input", { type: "file", accept: "application/json,.json", style: "display:none" });
  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const payload = JSON.parse(text);
      const serverWords = Array.isArray(payload?.words) ? payload.words : [];
      const localMap = payload?.localWords && typeof payload.localWords === "object" ? payload.localWords : null;
      let merged = 0;
      if (serverWords.length) merged = mergeWordStates(state.words, serverWords);
      else if (localMap) {
        for (const [key, value] of Object.entries(localMap)) {
          if (!state.words[key] || Number(value.seen) > Number(state.words[key].seen)) {
            state.words[key] = value;
            merged++;
          }
        }
      }
      if (payload?.settings) state.settings = normalizeSettings({ ...state.settings, ...payload.settings });
      if (Auth.isLoggedIn() && (payload?.words || payload?.notes || payload?.images)) {
        const res = await Auth.importAll(payload);
        toast(res.ok ? `云端导入完成：${res.data.words} 词状态 / ${res.data.notes} 备注` : res.msg || "导入失败", {
          type: res.ok ? "ok" : "bad",
        });
      } else {
        toast(`已导入 ${merged} 条本地记录`, { type: "ok" });
      }
      for (const key of Object.keys(state.words)) {
        const [c, w] = key.split(":").map(Number);
        markDirty(c, w);
      }
      markSettingsDirty();
      saveLocal();
      render();
    } catch {
      toast("备份文件无法解析", { type: "bad" });
    } finally {
      input.remove();
    }
  });
  document.body.append(input);
  input.click();
}

/* ============ 事件绑定 ============ */

/** @param {KeyboardEvent} e */
function onKeydown(e) {
  const target = /** @type {HTMLElement} */ (e.target);
  const tag = target?.tagName;
  const isAnswerInput = target === state.dom.answerInput;
  if (!isAnswerInput && (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT")) return;
  if (e.isComposing || e.keyCode === 229) return; // 输入法组字中，交给 compositionend
  if (target?.isContentEditable) return;

  if (e.key === "Enter") {
    if (tag === "BUTTON" && !isAnswerInput) return;
    e.preventDefault();
    if (state.roundDone) showReport();
    else if (state.answered) advance();
    else submit();
    return;
  }
  if (e.key === " ") {
    // 空格在刷词页统一是"重读"（页面上没有其它需要空格的输入框）
    e.preventDefault();
    void speak(currentWord()?.word || "");
    return;
  }
  if (e.key === "Backspace") {
    if (!isAnswerInput) e.preventDefault();
    backspace();
    return;
  }
  if (e.key === "Delete") {
    e.preventDefault();
    clearAtCursor();
    return;
  }
  if (e.key === "ArrowLeft") {
    e.preventDefault();
    state.cursor = Math.max(0, state.cursor - 1);
    renderSlots();
    return;
  }
  if (e.key === "ArrowRight") {
    e.preventDefault();
    state.cursor = Math.min(state.values.length, state.cursor + 1);
    renderSlots();
    return;
  }
  if (e.key === "Tab" || e.key === "Escape") return;
  if (/^[a-zA-Z]$/.test(e.key)) {
    e.preventDefault();
    typeLetter(e.key);
  }
}

function bindAnswerInput() {
  const input = /** @type {HTMLInputElement} */ (state.dom.answerInput);
  // 输入法（中文/日文等）提交的结果走 compositionend
  input.addEventListener("compositionend", (e) => {
    const text = String(e.data || "");
    for (const ch of text) if (/[a-zA-Z]/.test(ch)) typeLetter(ch);
    input.value = "";
  });
  input.addEventListener("input", (e) => {
    if (e.isComposing) return;
    const text = String(input.value || "");
    for (const ch of text) if (/[a-zA-Z]/.test(ch)) typeLetter(ch);
    input.value = "";
  });
  input.addEventListener("blur", () => renderSlots());
  input.addEventListener("focus", () => {
    renderSlots();
    // 触屏上软键盘可能遮挡槽位，把它们带到视野中间
    if (window.matchMedia("(pointer: coarse)").matches) {
      window.setTimeout(() => state.dom.slotsWrap?.scrollIntoView({ block: "center", behavior: "smooth" }), 140);
    }
  });
}

/* ============ 初始化 ============ */

function cacheDom() {
  const dom = state.dom;
  dom.brandSub = $("#brandSub");
  dom.syncBtn = $("#syncBtn");
  dom.menuBtn = $("#menuBtn");
  dom.chapterBtn = $("#chapterBtn");
  dom.modeSeg = $("#modeSeg");
  dom.meta = $("#sessionMeta");
  dom.progressFill = $("#progressFill");
  dom.stageHead = $("#stageHead");
  dom.loading = $("#loadingCard");
  dom.loadingText = $("#loadingText");
  dom.loadError = $("#loadErrorCard");
  dom.loadErrorText = $("#loadErrorText");
  dom.retryBtn = $("#retryBtn");
  dom.errorChapterBtn = $("#errorChapterBtn");
  dom.body = $("#stageBody");
  dom.promptCn = $("#promptCn");
  dom.promptAudio = $("#promptAudio");
  dom.promptHint = $("#promptHint");
  dom.speakBtn = $("#speakBtn");
  dom.slots = $("#slots");
  dom.slotsWrap = $("#slotsWrap");
  dom.tapHint = $("#tapHint");
  dom.answerInput = $("#answerInput");
  dom.feedback = $("#feedback");
  dom.example = $("#example");
  dom.exampleEn = $("#exampleEn");
  dom.exampleCn = $("#exampleCn");
  dom.primaryBtn = $("#primaryBtn");
  dom.skipBtn = $("#skipBtn");
  dom.starBtn = $("#starBtn");
  dom.repeatBtn = $("#repeatBtn");
  dom.timerBtn = $("#timerBtn");
  dom.timerChip = $("#timerChip");
  dom.hintPick = $("#hintPick");
  dom.hintSelect = /** @type {HTMLSelectElement} */ ($("#hintSelect"));
  dom.reviewBanner = $("#reviewBanner");
  dom.reviewExit = $("#reviewExit");
}

function bindUi() {
  const dom = state.dom;

  dom.syncBtn.addEventListener("click", async () => {
    if (!Auth.isLoggedIn()) {
      openMenuSheet("settings");
      return;
    }
    toast("正在与云端同步…");
    // 先把待上传的写完，再回拉一次全量，最后重试队列
    await flush();
    await syncPull({ full: true });
    state.sync.backoff = 0;
    await flush();
    render();
    toast(state.sync.lastError ? `同步未完成：${state.sync.lastError}` : "同步完成", {
      type: state.sync.lastError ? "bad" : "ok",
    });
  });

  dom.menuBtn.addEventListener("click", () => openMenuSheet("settings"));
  dom.chapterBtn.addEventListener("click", () => {
    if (state.review) {
      exitReview();
      return;
    }
    openChapterSheet();
  });
  dom.reviewExit.addEventListener("click", exitReview);

  for (const btn of $$("[data-mode]", dom.modeSeg)) {
    btn.addEventListener("click", () => {
      state.settings.mode = btn.dataset.mode;
      markSettingsDirty();
      if (!state.answered) renderWord({ focus: false });
      else render();
    });
  }

  dom.primaryBtn.addEventListener("click", () => (state.roundDone ? showReport() : state.answered ? advance() : submit()));
  dom.skipBtn.addEventListener("click", skip);
  dom.repeatBtn.addEventListener("click", () => void speak(currentWord()?.word || ""));
  dom.timerBtn.addEventListener("click", () => {
    state.settings.timerEnabled = !state.settings.timerEnabled;
    markSettingsDirty();
    if (state.settings.timerEnabled) startTimer();
    else stopTimer();
    render();
  });
  dom.starBtn.addEventListener("click", () => {
    const word = currentWord();
    if (!word) return;
    const added = toggleStar(state.chapter, Number(word.id));
    toast(added ? "已加入生词本" : "已移出生词本", { type: "ok" });
    render();
  });
  dom.retryBtn.addEventListener("click", () => void loadChapter(state.chapter));
  dom.errorChapterBtn.addEventListener("click", () => openChapterSheet());

  // 主界面的提示字母：改了立刻对当前词生效
  dom.hintSelect.addEventListener("change", () => {
    state.settings.hint = Number(dom.hintSelect.value) || 0;
    markSettingsDirty();
    if (!state.answered) renderWord({ focus: false });
    else render();
  });

  // 点击题干/槽位区域调出键盘
  for (const node of [dom.slotsWrap, dom.promptCn, dom.promptAudio, dom.feedback]) {
    node?.addEventListener("pointerdown", (e) => {
      if (state.answered) return;
      const target = /** @type {HTMLElement} */ (e.target);
      if (target.closest("button")) return;
      e.preventDefault();
      focusInput();
    });
  }

  document.addEventListener("keydown", onKeydown);
  bindAnswerInput();
  bindTimerVisibility();

  // 鼠标点完动作按钮后把焦点还给答题输入框，避免"回车又触发刚才那个按钮"
  document.addEventListener("click", (e) => {
    const btn = /** @type {HTMLElement} */ (e.target)?.closest?.(".actions button, .stage-head button");
    if (!btn) return;
    /** @type {HTMLButtonElement} */ (btn).blur();
    if (!state.answered) window.setTimeout(() => focusInput(), 0);
  });

  window.addEventListener("beforeunload", () => {
    persistResume();
    saveLocal();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) saveLocal();
  });
}

/** 把设置同步到界面（拉云端后调用） */
function persistSettingsToUi() {
  for (const btn of $$("[data-mode]", state.dom.modeSeg)) {
    btn.setAttribute("aria-pressed", String(btn.dataset.mode === state.settings.mode));
  }
}

/**
 * 切换本地存档命名空间，并按需与云端合并。
 *  · 登录：把"未登录期间"的进度并入（每个浏览器只允许并入一个账号），拉云端，
 *          若本机完全没有进度则接着云端记住的章节继续
 *  · 登出：回到未登录存档，内存里的数据不再上行
 * @param {{ userId: number, email: string, nickname: string } | null} user
 * @param {{ switchChapter?: boolean }} [opts] 是否立即重载章节（从"点击登录"进来时为 true）
 */
async function applyUser(user, opts = {}) {
  const nextKey = user ? `u${user.userId}` : "guest";
  const prevKey = state.userKey;
  // 同一个账号且已经拉过云端 → 不重复处理（Auth.onAuthChange 会在注册时立即回调一次）
  if (nextKey === prevKey && state.sync.pulledOnce) return;

  if (user) {
    // 注意：要在合并之前判断"本机有没有自己的进度"
    const hadProgress = Object.keys(state.words).length > 0;
    state.userKey = nextKey;
    const scoped = loadLocal(nextKey);
    if (scoped?.words) mergeWordStates(state.words, Object.values(scoped.words));
    if (prevKey === "guest" && canMergeGuest(user.userId)) {
      const guest = loadLocal("guest");
      if (guest?.words) mergeWordStates(state.words, Object.values(guest.words));
      markGuestMerged(user.userId);
    }
    await syncPull({ full: true });

    // 新设备 / 清过缓存（本机无进度、也没有深链指定章节）→ 接着上次的章节
    const resumeChapter = Number(state.settings.resume?.chapter);
    if (
      !hadProgress &&
      !state.deepLinkChapter &&
      Number.isInteger(resumeChapter) &&
      resumeChapter >= 1 &&
      resumeChapter <= CHAPTERS.length &&
      resumeChapter !== state.chapter
    ) {
      state.chapter = resumeChapter;
      if (opts.switchChapter) await loadChapter(state.chapter);
    }

    // 登录前离线做的题不在 dirty 集合里，这里整体补传一次（服务端按 seen 做 LWW，不会覆盖更新的记录）
    const count = markAllDirty();
    if (count) toast(`正在同步本机 ${count} 条学习记录…`);
  } else {
    state.userKey = "guest";
    const guest = loadLocal("guest");
    state.words = guest?.words && typeof guest.words === "object" ? guest.words : {};
    state.settings = normalizeSettings(guest?.settings);
    state.sync.dirty.clear();
    state.sync.settingsDirty = false;
    window.clearTimeout(state.sync.timer);
  }
  saveLocal();
  render();
}

async function init() {
  initTheme();
  cacheDom();
  bindUi();

  // 1) 先恢复本机存档（guest 命名空间），保证离线也能立刻开始
  const local = loadLocal("guest");
  if (local) {
    state.settings = normalizeSettings(local.settings);
    state.words = local.words && typeof local.words === "object" ? local.words : {};
    state.chapter = Number(local.chapter) || 1;
    state.deck = Array.isArray(local.deck) ? local.deck : [];
    state.index = Number(local.index) || 0;
    state.session = local.session || { attempts: 0, correct: 0 };
  }

  const params = new URLSearchParams(location.search);
  const urlChapter = Number(params.get("chapter")) || 0;
  const urlWord = Number(params.get("word")) || 0;
  if (urlChapter) {
    state.chapter = urlChapter;
    state.deepLinkChapter = urlChapter;
  }

  render();

  // 2) 登录态：先拉云端，再渲染（旧版是新设备直接进第一章并覆盖云端）
  const user = await Auth.init();
  await applyUser(user, { switchChapter: false });
  renderSync();

  Auth.onAuthChange(async (current) => {
    renderSync();
    const targetKey = current ? `u${current.userId}` : "guest";
    if (targetKey === state.userKey && !current) return;
    await applyUser(current, { switchChapter: true });
  });

  // 3) 加载章节（深链优先；applyUser 可能已按云端记录改过 state.chapter）
  const ok = await loadChapter(state.deepLinkChapter || state.chapter, {
    jumpTo: urlWord || undefined,
    fresh: false,
  });
  if (!ok) return;

  // 4) 定期回拉（多端同步）
  window.setInterval(() => void syncPull({}), 120000);

  // 5) 桌面端直接聚焦，触屏等用户点
  if (window.matchMedia("(pointer: fine)").matches) focusInput();
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => void init());
  else void init();
}

export { init };
