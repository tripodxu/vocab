// @ts-check
// PWA：Service Worker（与刷词页共用；注册失败静默；typeof 守卫保证 Node 导入不炸）
if (
  typeof navigator !== "undefined" &&
  "serviceWorker" in navigator &&
  (location.protocol === "https:" || ["localhost", "127.0.0.1"].includes(location.hostname))
) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

/**
 * lecture.js —— 课程讲义页
 *
 * 相对旧版的改动：
 *  · 章节清单与标题来自 chapters.js（不再在每个页面各写一份 22 项，标题不再永远是 🌍）
 *  · 备注与配图入云（配图先压缩到 ≤1280px / JPEG 0.8、≤300KB），换设备也在
 *  · 卡片不再用 backdrop-filter，长列表分批渲染（400+ 词的章节在手机上也能滑）
 *  · 批注画布会持久化，窗口 resize 不再把已画的内容清掉
 *  · 卡片可深链到刷词页：index.html?chapter=N&word=ID
 */

import { CHAPTERS, chapterTitle, CHAPTER_BY_ID } from "./chapters.js";
import Auth from "./vocab-auth.js";
import {
  $,
  $$,
  el,
  icon,
  iconHTML,
  toast,
  confirmDialog,
  openSheet,
  theme,
  appearanceMirrorRead,
  initTheme,
  announce,
  prefersReducedMotion,
} from "./ui.js";
import { applyAccent } from "./core.js";
import { idbGet, idbPut, idbDel, idbKeys, migrateLegacy } from "./idb.js";

const CHUNK = 60;
const MAX_NOTE_CHARS = 4000;
/** 同步接口的 base64 上限（≈300KB 二进制，与 worker 的 MAX_IMAGE_BASE64 对齐） */
const MAX_IMAGE_B64_CHARS = 400_000;
const DRAW_KEY_LIMIT = 1_200_000;

const state = {
  chapter: 1,
  /** @type {any[]} */
  words: [],
  /** @type {Record<number, any>} */
  byId: new Map(),
  /** @type {Record<string, string>} wordId → note */
  notes: {},
  /** @type {Record<string, number>} wordId → 备注的客户端时间戳（按条 LWW） */
  noteStamps: {},
  /** @type {Set<number>} 云端标记有配图的词 */
  cloudImages: new Set(),
  /** @type {Set<number>} 本机 localStorage 里有配图缓存的词（键名索引，避免逐卡读大字符串） */
  localImages: new Set(),
  /** @type {Map<number, string>} wordId → dataURL（已取回的配图） */
  images: new Map(),
  filter: "all",
  query: "",
  shown: 0,
  loading: false,
  error: /** @type {string|null} */ (null),
  starred: /** @type {Set<number>} */ (new Set()),
  /** 讲义卡片外观：样式（card 卡牌 / book 书籍）与背景色（none/mint/sky/sand）；init 时从 localStorage 恢复 */
  cardStyle: "card",
  cardBg: "none",
  slideDir: "next",
  noteTimers: /** @type {Map<number, number>} */ (new Map()),
  userKey: "guest",
  dom: /** @type {Record<string, any>} */ ({}),
};

/** 章节加载与详情切换的并发守卫（旧请求的结果不许覆盖新状态） */
let chapterEpoch = 0;
let stepTimer = 0;

/* ============ 本地存储 ============ */

const noteKey = (chapter, word) => `lecture-note-${chapter}-${word}`;
const stampKey = (chapter) => `lecture-note-stamps-${chapter}`;
const imgKey = (chapter, word) => `lecture-img-${chapter}-${word}`;
const drawKey = (chapter, word) => `lecture-draw-${chapter}-${word}`;
const brushKey = (chapter) => `lecture-brush-${chapter}`;
const starsKey = () => `vocab:stars:${state.userKey}`;

function safeSet(key, value) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function safeGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function loadStars() {
  try {
    const parsed = JSON.parse(safeGet(starsKey()) || "{}");
    return new Set<number>(Array.isArray(parsed) ? parsed : []);
  } catch {
    return new Set();
  }
}

function saveStars() {
  safeSet(starsKey(), JSON.stringify([...state.starred]));
}

/* ============ 语音 ============ */

let voices = /** @type {SpeechSynthesisVoice[]} */ ([]);

async function speak(word) {
  if (!window.speechSynthesis || !word) {
    toast("当前浏览器不支持朗读", { type: "bad" });
    return;
  }
  if (!voices.length) {
    voices = window.speechSynthesis.getVoices();
    if (!voices.length) {
      // 具名回调 + 超时对称清理：超时路径也会摘掉 voiceschanged 监听，不在单例上残留
      await new Promise((done) => {
        let timer = 0;
        const finish = () => {
          window.clearTimeout(timer);
          window.speechSynthesis.removeEventListener("voiceschanged", finish);
          done(null);
        };
        window.speechSynthesis.addEventListener("voiceschanged", finish, { once: true });
        timer = window.setTimeout(finish, 1200);
      });
      voices = window.speechSynthesis.getVoices();
    }
  }
  window.speechSynthesis.cancel();
  const utter = new SpeechSynthesisUtterance(word);
  utter.lang = "en-US";
  utter.rate = 0.9;
  const preferred = voices.find((v) => v.lang === "en-US") || voices.find((v) => v.lang?.startsWith("en")) || null;
  if (preferred) utter.voice = preferred;
  window.speechSynthesis.speak(utter);
}

/* ============ 章节加载 ============ */

async function loadChapter(chapterId) {
  const epoch = ++chapterEpoch;
  state.loading = true;
  state.error = null;
  render();
  try {
    const res = await fetch(`data-${Number(chapterId)}.json`, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`词库加载失败（HTTP ${res.status}）`);
    const list = await res.json();
    if (!Array.isArray(list) || !list.length) throw new Error("词库为空");
    if (epoch !== chapterEpoch) return; // 期间又切了章：旧请求作废
    state.chapter = Number(chapterId);
    state.words = list;
    state.byId = new Map(list.map((w) => [Number(w.id), w]));
    state.images.clear();
    state.cloudImages.clear();
    state.loading = false;
    state.shown = 0;
    loadLocalNotes();
    await refreshLocalImages(); // 配图存在性索引（IDB 键名，不读大值）
    if (epoch !== chapterEpoch) return;
    render();
    history.replaceState(null, "", `?chapter=${state.chapter}`);
    safeSet("vocab:last-chapter", String(state.chapter));
    void syncNotesFromCloud();
    restoreBrush();
  } catch (err) {
    if (epoch !== chapterEpoch) return;
    state.loading = false;
    state.error = err instanceof Error ? err.message : "词库加载失败";
    render();
  }
}

function loadLocalNotes() {
  state.notes = {};
  state.noteStamps = {};
  state.localImages = new Set();
  try {
    state.noteStamps = JSON.parse(safeGet(stampKey(state.chapter)) || "{}");
    if (!state.noteStamps || typeof state.noteStamps !== "object") state.noteStamps = {};
  } catch {
    state.noteStamps = {};
  }
  const notePrefix = `lecture-note-${state.chapter}-`;
  // 一次遍历拿齐备注（配图存在性改为 IndexedDB 键名索引，见 refreshLocalImages）
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(notePrefix)) continue;
      const note = safeGet(key);
      if (note) state.notes[key.slice(notePrefix.length)] = note;
    }
  } catch {
    /* 枚举失败走下面的按词兜底 */
  }
  // 兜底：localStorage 枚举失败或个别键没扫到时按词补一遍备注
  for (const word of state.words) {
    if (state.notes[String(word.id)]) continue;
    const note = safeGet(noteKey(state.chapter, word.id));
    if (note) state.notes[String(word.id)] = note;
  }
}

/**
 * 配图存在性索引：来自 IndexedDB 键名（图片 dataURL 本体已迁到 IDB，
 * 不再在渲染路径读几百 KB 的字符串；legacy localStorage 键也一并计入）。
 */
async function refreshLocalImages() {
  const prefix = `lecture-img-${state.chapter}-`;
  const keys = await idbKeys(prefix);
  const set = new Set(keys.map((k) => Number(k.slice(prefix.length))).filter(Number.isInteger));
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(prefix)) set.add(Number(key.slice(prefix.length)));
    }
  } catch {
    /* ignore */
  }
  state.localImages = set;
}

/**
 * 云端备注/配图拉取 + 本机/云端按 updatedAt 的按条 LWW 合并 + 存量笔记上行。
 * 关键点：
 *  · 入口捕获 chapter，await 之后先校验章节未变，杜绝"A 章数据写进 B 章键"
 *  · 本机空串 = 删除标记（tombstone）：不再被云端旧值复活，且会把删除推上云
 *  · 有时间戳就按时间戳裁决；没有时间戳的旧数据以"本地为准"平滑过渡
 */
async function syncNotesFromCloud() {
  if (!Auth.isLoggedIn()) return;
  const chapter = state.chapter;
  const data = await Auth.getNotes(chapter);
  if (!data) return;
  if (chapter !== state.chapter) return; // 等待期间已切章：本次结果作废（新章节有自己的 sync）
  const stamps = /** @type {Record<string, number>} */ (data.stamps || {});
  const cloudNotes = data.notes || {};
  let changed = false;

  for (const [wordId, cloudNote] of Object.entries(cloudNotes)) {
    const local = safeGet(noteKey(chapter, wordId));
    const cloudStamp = Number(stamps[wordId]) || 0;
    const localStamp = Number(state.noteStamps[wordId]) || 0;
    if (local === null) {
      // 本机没有 → 采用云端
      state.notes[wordId] = cloudNote;
      state.noteStamps[wordId] = cloudStamp;
      safeSet(noteKey(chapter, wordId), cloudNote);
      changed = true;
    } else if (local === "") {
      // 本机删除标记 → 把删除推上云（客户端时间戳=删除时刻，服务端 LWW 裁决）
      void Auth.putNote(chapter, Number(wordId), "", Date.now());
    } else if (cloudStamp > localStamp && cloudNote !== local) {
      // 云端更新（另一台设备改过）→ 采用云端
      state.notes[wordId] = cloudNote;
      state.noteStamps[wordId] = cloudStamp;
      safeSet(noteKey(chapter, wordId), cloudNote);
      changed = true;
    }
  }
  const prevCloudImages = state.cloudImages.size;
  state.cloudImages = new Set((data.images || []).map((id) => Number(id)));

  // 本机已有但云端没有（或比云端新）的备注 → 上行（老用户数据不丢、本机编辑不被压死）
  for (const word of state.words) {
    const idStr = String(word.id);
    const local = safeGet(noteKey(chapter, word.id));
    if (local) {
      const cloudHas = Object.prototype.hasOwnProperty.call(cloudNotes, idStr);
      const cloudStamp = Number(stamps[idStr]) || 0;
      const localStamp = Number(state.noteStamps[idStr]) || 0;
      if (!cloudHas || localStamp > cloudStamp) {
        void Auth.putNote(chapter, Number(word.id), local, localStamp || Date.now());
      }
    }
    const localImageKey = imgKey(chapter, word.id);
    const localImage = (await idbGet(localImageKey)) ?? safeGet(localImageKey);
    if (localImage && !state.cloudImages.has(Number(word.id))) {
      const parts = localImage.split(",");
      const mime = parts[0]?.match(/data:([^;]+)/)?.[1] || "image/jpeg";
      if (parts[1] && parts[1].length <= MAX_IMAGE_B64_CHARS) {
        void Auth.putNoteImage(chapter, Number(word.id), mime, parts[1]);
      }
    }
  }
  if (changed || prevCloudImages !== state.cloudImages.size) render();
}

/* ============ 渲染 ============ */

function filteredWords() {
  const query = state.query.trim().toLowerCase();
  return state.words.filter((word) => {
    if (state.filter === "star" && !state.starred.has(Number(word.id))) return false;
    if (state.filter === "note" && !state.notes[String(word.id)] && !state.cloudImages.has(Number(word.id))) return false;
    if (["核心", "高频", "低频", "识记"].includes(state.filter) && word.tag !== state.filter) return false;
    if (!query) return true;
    return (
      String(word.word).toLowerCase().includes(query) ||
      String(word.meaningCN).toLowerCase().includes(query) ||
      String(word.root || "").toLowerCase().includes(query)
    );
  });
}

function render() {
  const dom = state.dom;
  const chapter = CHAPTER_BY_ID.get(state.chapter);
  dom.title.textContent = `${chapterTitle(state.chapter)} · 核心词汇`;
  document.title = `${chapter?.title || "讲义"} · 核心词汇`;
  const list = filteredWords();
  dom.sub.textContent = state.loading
    ? "正在加载…"
    : `${state.words.length} 词 · ${list.length} 条符合当前筛选`;

  dom.loading.hidden = !state.loading;
  dom.error.hidden = !state.error;
  dom.errorText.textContent = state.error || "";
  dom.grid.hidden = Boolean(state.loading || state.error);

  // 刷词页深链：带上当前章节（点一下就直接练这一章）
  dom.practiceLink?.setAttribute("href", `index.html?chapter=${state.chapter}`);
  dom.chapterBtn.replaceChildren(icon("book-open"), document.createTextNode(` ${chapterTitle(state.chapter)}`));

  if (!state.loading && !state.error) renderGrid(list);
}

/**
 * 渲染/增量加载词卡网格。
 * @param {any[]} [list] 调用方已算好的筛选结果（render 传入，避免全表过滤跑两遍）
 */
function renderGrid(list = filteredWords()) {
  const grid = state.dom.grid;
  if (state.shown > list.length || grid.dataset.chapter !== String(state.chapter) || grid.dataset.filter !== `${state.filter}|${state.query}`) {
    state.shown = 0;
    grid.replaceChildren();
    grid.dataset.chapter = String(state.chapter);
    grid.dataset.filter = `${state.filter}|${state.query}`;
  }
  const next = list.slice(state.shown, state.shown + CHUNK);
  const fragment = document.createDocumentFragment();
  next.forEach((word, index) => {
    const card = buildCard(word, state.shown + index < 40);
    fragment.append(card);
  });
  grid.append(fragment);
  state.shown += next.length;

  const existing = $("#sentinel");
  if (existing) {
    observer?.unobserve(existing); // 旧哨兵必须 unobserve，否则被移除的节点仍被 observer 强引用（内存泄漏）
    existing.remove();
  }
  if (state.shown < list.length) {
    const sentinel = el("div", { class: "sentinel", id: "sentinel", text: `已显示 ${state.shown}/${list.length}，继续下滑加载更多` });
    grid.append(sentinel);
    observer?.observe(sentinel);
  } else if (list.length === 0) {
    grid.append(el("div", { class: "sentinel", text: "没有匹配的词，试试换个筛选或关键词" }));
  }
}

/**
 * 就地刷新已渲染卡片的生词/标记状态（不追加新批次、不整表重建）。
 * 原先星标/配图变化走 render() → renderGrid 只 append 不更新，表现为"点了没反应"，
 * 且列表未加载完时每点一次星标就多冒出 60 张卡。
 */
function refreshCards() {
  const grid = state.dom.grid;
  // 筛选条件本身依赖星标/备注时，列表成员会变 → 必须整表重建
  if (state.filter === "star" || state.filter === "note") {
    state.shown = 0;
    grid.replaceChildren();
    render();
    return;
  }
  for (const card of $$("[data-id]", grid)) {
    const id = Number(card.dataset.id);
    if (!Number.isInteger(id)) continue;
    updateCardMarkers(card, id);
  }
}

/** 更新单张卡片的星标与标记（renderMarkers 的超集） */
function updateCardMarkers(card, id) {
  const hasNote = Boolean(state.notes[String(id)]);
  const hasImage = Boolean(state.images.get(id) || state.cloudImages.has(id) || state.localImages.has(id));
  const starred = state.starred.has(id);
  const markers = $(".markers", card);
  if (!markers) return;
  const starToggle = $(".star-toggle", markers);
  if (starToggle) {
    starToggle.classList.toggle("on", starred);
    starToggle.textContent = starred ? "★" : "☆";
    starToggle.setAttribute("title", starred ? "取消生词" : "标为生词");
    starToggle.setAttribute("aria-pressed", String(starred));
  }
  upsertMarker(markers, "marker-note", hasNote, () => icon("pencil"), "有备注");
  upsertMarker(markers, "marker-image", hasImage, () => icon("image"), "有配图");
  upsertMarker(markers, "marker-star", starred, () => document.createTextNode("★"), "生词");
}

/**
 * 不存在则插入标记、存在则移除（按语义 class 定位，不依赖文本内容）
 * @param {Element} markers
 * @param {string} cls
 * @param {boolean} show
 * @param {() => Node} content 图标工厂（SVG 图标，不再用 emoji）
 * @param {string} title
 */
function upsertMarker(markers, cls, show, content, title) {
  const found = $(`.${cls}`, markers);
  if (show && !found) {
    const span = el("span", { class: `marker ${cls}`, title });
    span.append(content());
    markers.append(span);
  } else if (!show && found) {
    found.remove();
  } else if (show && found && found.childNodes.length === 0) {
    found.append(content());
  }
}

/** @type {IntersectionObserver | null} */
let observer = null;

/** @param {any} word @param {boolean} animate */
function buildCard(word, animate) {
  const id = Number(word.id);
  const note = state.notes[String(id)];
  const hasImage = Boolean(state.images.get(id) || state.cloudImages.has(id) || state.localImages.has(id));
  const starred = state.starred.has(id);
  // 结构：div.word-card + 两个语义兄弟按钮（整卡查看 / 星标）。
  // 原先是 button 里嵌 role=button 的 span——嵌套交互语义非法且键盘不可达。
  const card = el(
    "div",
    {
      class: `word-card${animate ? " enter" : ""}`,
      dataset: { id: String(id) },
    },
    [
      el("button", {
        class: "card-open",
        type: "button",
        "aria-label": `查看 ${word.word} 的讲义详情`,
        onclick: () => openDetail(id),
      }),
      el("div", { class: "markers" }, [
        el("button", {
          class: `marker star-toggle${starred ? " on" : ""}`,
          type: "button",
          "aria-label": starred ? "取消生词" : "标为生词",
          "aria-pressed": String(starred),
          title: starred ? "取消生词" : "标为生词",
          text: starred ? "★" : "☆",
          onclick: (e) => {
            e.stopPropagation();
            toggleStarCard(id);
          },
        }),
        note ? el("span", { class: "marker marker-note", title: "有备注" }, [icon("pencil")]) : null,
        hasImage ? el("span", { class: "marker marker-image", title: "有配图" }, [icon("image")]) : null,
        starred ? el("span", { class: "marker marker-star", title: "生词", text: "★" }) : null,
      ]),
      el("span", { class: "w", text: word.word }),
      el("span", { class: "ph", text: word.phonetic || "" }),
      el("span", { class: "mean", text: word.meaningCN }),
      el("span", { class: "card-tags" }, [
        el("span", { class: `tag tag-${tagClass(word.tag)}`, text: word.tag || "" }),
        word.pos ? el("span", { class: "marker", text: word.pos }) : null,
      ]),
    ]
  );
  return card;
}

/** @param {string} tag */
function tagClass(tag) {
  if (tag === "核心") return "core";
  if (tag === "高频") return "high";
  if (tag === "低频") return "low";
  return "recog";
}

/* ============ 单词详情 ============ */

let currentDetail = /** @type {number|null} */ (null);
/** @type {{ close: () => void } | null} */
let currentSheet = null;
/** 当前详情的标星动作（openDetail 注入；键盘「s」与按钮共用，保证两处表现一致） */
let detailKeyStar = /** @type {null | (() => void)} */ (null);

/**
 * 打开词条详情：优先走 View Transitions API 的"词头共享元素"过渡
 * （列表词头 → 详情标题飞入）；不支持或用户开了减少动效时自动回退普通打开。
 * @param {number} wordId
 */
function openDetail(wordId) {
  const supports =
    typeof document !== "undefined" &&
    typeof document.startViewTransition === "function" &&
    !prefersReducedMotion();
  const cardW = supports ? $(`[data-id="${wordId}"] .w`) : null;
  if (cardW instanceof HTMLElement) cardW.style.viewTransitionName = "word-hero";
  const cleanup = () => {
    if (cardW instanceof HTMLElement) cardW.style.viewTransitionName = "";
  };
  if (!supports) {
    openDetailNow(wordId);
    cleanup();
    return;
  }
  const t = document.startViewTransition(() => openDetailNow(wordId));
  void t.finished.then(cleanup, cleanup);
}

/** @param {number} wordId */
function openDetailNow(wordId) {
  const word = state.byId.get(Number(wordId));
  if (!word) return;
  // 详情里所有异步/防抖回调都用这份捕获的章节，切章后不会把数据写错键
  const chapter = state.chapter;
  window.clearTimeout(stepTimer);
  currentDetail = Number(wordId);
  const sheet = openSheet({
    title: word.word,
    onClose: () => {
      cleanupDraw();
      currentDetail = null;
      currentSheet = null;
      detailKeyStar = null;
    },
  });
  currentSheet = sheet;
  const box = sheet.box;
  box.classList.add("word-detail");
  // View Transition 的落点：详情标题与列表词头同名，浏览器负责字形飞入
  const titleEl = $(".sheet-head h2", box);
  if (titleEl instanceof HTMLElement && typeof document.startViewTransition === "function") {
    titleEl.style.viewTransitionName = "word-hero";
  }

  const drawCanvas = el("canvas", { class: "draw-canvas", id: "detailCanvas" });
  box.prepend(drawCanvas);

  // 标题由弹层头部提供（单词本身），这里只放音标/词性/朗读
  const head = el("div", { class: "detail-head" }, [
    el("span", { class: "phonetic", text: word.phonetic || "" }),
    el("span", { class: `tag tag-${tagClass(word.tag)}`, text: word.tag || "" }),
    el("button", { class: "btn btn-sm", type: "button", onclick: () => void speak(word.word) }, [icon("volume"), " 朗读"]),
  ]);
  const meaning = el("div", { class: "detail-meaning", text: word.meaningCN });
  const example = word.exampleEN
    ? el("div", { class: "detail-block" }, [
        el("span", { text: `“${word.exampleEN}”` }),
        el("span", { class: "cn", text: word.exampleCN || "" }),
      ])
    : null;
  const root = word.root ? el("div", { class: "detail-block" }, [el("span", { text: `词根/词源：${word.root}` })]) : null;
  const extra = word.extra ? el("div", { class: "detail-block" }, [el("span", { text: word.extra })]) : null;
  // 配图区块默认隐藏：没有配图时不再渲染一个空的边框块（线上审查反馈"没有任何内容的区块不好看"）
  const imageWrap = el("div", { class: "detail-block detail-image", id: "detailImage", hidden: true });
  const noteStatus = el("div", { class: "note-status" });
  const textarea = /** @type {HTMLTextAreaElement} */ (
    el("textarea", { class: "textarea", id: "detailNote", placeholder: "写点备注：易混词、词根、老师讲的点…" })
  );
  textarea.value = state.notes[String(wordId)] || "";

  const addImageBtn = el("button", { class: "btn", type: "button", onclick: () => pickImage(Number(wordId)) }, [icon("image"), " 添加配图"]);
  const removeImageBtn = el("button", {
    class: "btn btn-danger",
    type: "button",
    text: "删除配图",
    onclick: () => removeImage(Number(wordId)),
  });
  const drawBtn = el("button", { class: "btn", type: "button" }, [icon("brush"), " 批注"]);
  const starBtn = el("button", { class: "btn", type: "button", text: state.starred.has(Number(wordId)) ? "★ 生词" : "☆ 生词" });

  const actions = el("div", { class: "detail-actions" }, [
    el("a", { class: "btn btn-primary", href: `index.html?chapter=${state.chapter}&word=${wordId}` }, [icon("pencil"), " 练这个词"]),
    starBtn,
    addImageBtn,
    removeImageBtn,
    drawBtn,
    el("button", { class: "btn", type: "button", onclick: () => step(-1) }, [icon("chevron-left"), " 上一个"]),
    el("button", { class: "btn", type: "button", onclick: () => step(1) }, [icon("chevron-right"), " 下一个"]),
  ]);

  const noteArea = el("div", { class: "note-area" }, [
    el("label", { class: "small muted", for: "detailNote", text: "备注（自动保存，登录后云端同步）" }),
    textarea,
    noteStatus,
  ]);

  // 卡片化：包一层 detail-card 承载样式（卡牌/书籍）与动效
  const cardClass = [
    "detail-card",
    `style-${state.cardStyle === "book" ? "book" : "card"}`,
    `slide-in-${state.slideDir === "prev" ? "prev" : "next"}`,
    state.starred.has(Number(wordId)) ? "starred" : "",
    `bg-${state.cardBg}`,
  ]
    .filter(Boolean)
    .join(" ");
  const card = el("div", { class: cardClass }, [
    head, meaning, example, root, extra, imageWrap, actions, noteArea,
  ]);
  sheet.body.append(card);

  // 键盘/鼠标共用同一条标星路径（原键盘分支不改 detail-card 的 starred 描边，两处表现不一致）
  const toggleStar = () => {
    const id = Number(wordId);
    if (state.starred.has(id)) state.starred.delete(id);
    else state.starred.add(id);
    saveStars();
    starBtn.textContent = state.starred.has(id) ? "★ 生词" : "☆ 生词";
    card.classList.toggle("starred", state.starred.has(id));
    const flashEl = document.querySelector(".detail-card");
    if (flashEl) {
      // 注意：classList.add 不接受带空格的多 token 字符串（会抛 InvalidCharacterError），
      // 必须逐个 add——原写法 add("star-flash on") 自第五期起每次都抛错，
      // 把后面的 refreshCards() 整个打断（详情里标星后网格永不刷新的根因）
      flashEl.classList.remove("star-flash", "on");
      void flashEl.offsetWidth;
      flashEl.classList.add("star-flash");
      if (state.starred.has(id)) flashEl.classList.add("on");
    }
    refreshCards();
  };
  starBtn.addEventListener("click", toggleStar);
  detailKeyStar = toggleStar;

  // 备注：本地立即保存（含时间戳），云端防抖 800ms；回调用捕获的 chapter，切章不串键
  textarea.addEventListener("input", () => {
    const value = textarea.value.slice(0, MAX_NOTE_CHARS);
    const at = Date.now();
    state.notes[String(wordId)] = value;
    state.noteStamps[String(wordId)] = at;
    const saved = safeSet(noteKey(chapter, wordId), value);
    safeSet(stampKey(chapter), JSON.stringify(state.noteStamps));
    noteStatus.textContent = saved ? "已保存到本机" : "本机存储空间不足，未能保存";
    window.clearTimeout(state.noteTimers.get(Number(wordId)));
    const timer = window.setTimeout(async () => {
      if (!Auth.isLoggedIn()) {
        noteStatus.textContent = "未登录：仅保存在本机";
        return;
      }
      const res = await Auth.putNote(chapter, Number(wordId), value, at);
      if (currentDetail === Number(wordId)) {
        noteStatus.textContent = res.ok ? "已同步到云端" : `同步失败：${res.msg || "网络异常"}`;
      }
      if (res.ok && !value) {
        // 删除已同步：清掉本机 tombstone 与时间戳，回到"和云端一致"的状态
        delete state.noteStamps[String(wordId)];
        safeSet(stampKey(chapter), JSON.stringify(state.noteStamps));
      }
    }, 800);
    state.noteTimers.set(Number(wordId), timer);
    renderMarkers(wordId);
  });

  if (Auth.isLoggedIn()) noteStatus.textContent = "登录后自动同步";

  // 配图：本机内存 → IndexedDB 本地缓存（异步，配图已迁 IDB，localStorage 只剩遗留回退）→ 云端
  const detailId = Number(wordId);
  removeImageBtn.hidden = !(state.images.get(detailId) || state.cloudImages.has(detailId) || state.localImages.has(detailId));
  const memImg = state.images.get(detailId);
  if (memImg) {
    showImage(memImg, removeImageBtn);
  } else if (state.localImages.has(detailId) || safeGet(imgKey(chapter, wordId))) {
    void idbGet(imgKey(chapter, wordId)).then((url) => {
      if (url && currentDetail === detailId) {
        state.images.set(detailId, url);
        showImage(url, removeImageBtn);
      }
    });
  } else if (state.cloudImages.has(detailId)) {
    void fetchCloudImage(detailId);
  }

  // 批注画布
  setupDrawCanvas(drawCanvas, drawBtn, wordId, box);

  announce(`单词 ${word.word}，${word.meaningCN}`);
}

/** 总览卡片上的快捷生词切换（与详情里的 ★ / 刷词页生词本同一份存储） */
function toggleStarCard(id) {
  const num = Number(id);
  if (state.starred.has(num)) state.starred.delete(num);
  else state.starred.add(num);
  saveStars();
  refreshCards();
}

function step(delta) {
  const list = filteredWords();
  const index = list.findIndex((w) => Number(w.id) === Number(currentDetail));
  if (index < 0) return;
  const next = list[(index + delta + list.length) % list.length];
  if (!next) return;
  // 滑动方向特效：记录方向，openDetail 渲染时给卡片加 slide-in 动画
  state.slideDir = delta > 0 ? "next" : "prev";
  // 走正常的 close()，保证 keydown 监听与焦点还原都被清理
  currentSheet?.close();
  window.clearTimeout(stepTimer);
  stepTimer = window.setTimeout(() => openDetail(Number(next.id)), 10);
}

function renderMarkers(wordId) {
  const grid = state.dom.grid;
  const card = $(`[data-id="${wordId}"]`, grid);
  if (!card) return;
  updateCardMarkers(card, Number(wordId));
}

/* ---------- 配图 ---------- */

/**
 * @param {string} dataUrl
 * @param {HTMLElement} [removeBtn]
 */
function showImage(dataUrl, removeBtn) {
  const wrap = $("#detailImage");
  if (!wrap) return;
  wrap.hidden = false; // 有图才现身（无图时整块隐藏）
  wrap.replaceChildren(el("img", { src: dataUrl, alt: "单词配图" }));
  if (removeBtn) removeBtn.hidden = false;
}

async function fetchCloudImage(wordId) {
  const chapter = state.chapter;
  const data = await Auth.getNoteImage(chapter, wordId);
  if (!data?.data) return;
  if (chapter !== state.chapter) return; // 切章后不往当前视图写旧章数据（缓存键本身按章节隔离，但本回合直接放弃）
  const dataUrl = `data:${data.mime};base64,${data.data}`;
  state.images.set(wordId, dataUrl);
  if (currentDetail === wordId) {
    showImage(dataUrl);
    const detailRemove = $$(".detail-actions .btn-danger").pop();
    if (detailRemove) detailRemove.hidden = false;
  }
  // 本地缓存一份（离线也能看）；写入 IndexedDB，键名进存在性索引
  const cacheKey = imgKey(chapter, wordId);
  const hasLegacy = Boolean(safeGet(cacheKey));
  if (!hasLegacy && (await idbPut(cacheKey, dataUrl))) state.localImages.add(Number(wordId));
  refreshCards();
}

function pickImage(wordId) {
  const input = el("input", { type: "file", accept: "image/*", style: "display:none" });
  // 用户取消文件选择时 change 不触发：cancel 事件兜底清理，避免孤儿 input 越积越多
  input.addEventListener("cancel", () => input.remove());
  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    input.remove();
    if (!file) return;
    toast("正在压缩图片…");
    try {
      const { dataUrl, mime, base64, bytes } = await compressImage(file);
      if (base64.length > MAX_IMAGE_B64_CHARS) throw new Error("图片过大，压缩后仍超出云端上限");
      state.images.set(wordId, dataUrl);
      const imgKeyNow = imgKey(state.chapter, wordId);
      try {
        localStorage.removeItem(imgKeyNow); // 清掉可能存在的旧 localStorage 副本
      } catch {
        /* ignore */
      }
      const localOk = await idbPut(imgKeyNow, dataUrl);
      if (localOk) state.localImages.add(Number(wordId));
      showImage(dataUrl);
      toast(`图片已更新（${Math.round(bytes / 1024)}KB${localOk ? "" : "，本机缓存空间不足"}）`, { type: "ok" });
      if (Auth.isLoggedIn()) {
        const res = await Auth.putNoteImage(state.chapter, wordId, mime, base64);
        if (!res.ok) toast(`云端保存失败：${res.msg || "网络异常"}`, { type: "bad" });
        else state.cloudImages.add(Number(wordId));
      } else {
        toast("未登录：配图只保存在本机", { type: "bad" });
      }
      refreshCards();
    } catch (err) {
      toast(err instanceof Error ? err.message : "图片处理失败", { type: "bad" });
    }
  });
  document.body.append(input);
  input.click();
}

async function removeImage(wordId) {
  const ok = await confirmDialog({ title: "删除这张配图？", confirmText: "删除", danger: true });
  if (!ok) return;
  const imgKeyNow = imgKey(state.chapter, wordId);
  try {
    localStorage.removeItem(imgKeyNow);
  } catch {
    /* ignore */
  }
  await idbDel(imgKeyNow);
  state.localImages.delete(Number(wordId));
  state.images.delete(wordId);
  state.cloudImages.delete(wordId);
  const wrap = $("#detailImage");
  wrap?.replaceChildren();
  if (wrap) wrap.hidden = true; // 删完回到"无配图"态：区块整体消失，不留空壳
  if (Auth.isLoggedIn()) await Auth.deleteNoteImage(state.chapter, wordId);
  toast("配图已删除", { type: "ok" });
  refreshCards();
}

/**
 * 压缩：长边 ≤1280，JPEG 质量 0.8；持续降质直到 ≤300KB，压不到就明确报错（单一口径，不再有 1.4 倍例外）
 * @param {File} file
 */
async function compressImage(file) {
  // imageOrientation:"from-image" 让手机竖拍的 EXIF 方向被应用（不支持时退回默认行为）
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    bitmap = await createImageBitmap(file);
  }
  let maxSide = 1280;
  let quality = 0.8;
  let result = "";
  for (let attempt = 0; attempt < 5; attempt++) {
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("浏览器不支持图片处理");
    // 先铺白底：透明 PNG/WebP 直接转 JPEG 会变黑底
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(bitmap, 0, 0, width, height);
    result = await encodeCanvas(canvas, quality);
    const base64 = result.split(",")[1] || "";
    if (base64.length <= MAX_IMAGE_B64_CHARS) {
      bitmap.close?.();
      return { dataUrl: result, mime: "image/jpeg", base64, bytes: base64.length * 0.75 };
    }
    quality = Math.max(0.5, quality - 0.12);
    maxSide = Math.round(maxSide * 0.85);
  }
  bitmap.close?.();
  throw new Error("图片过大，请先裁剪或换一张更小的图");
}

/** canvas → dataURL（toBlob 异步编码，避免大图同步编码时的主线程卡顿） */
function encodeCanvas(canvas, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error("图片编码失败"));
          return;
        }
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error("图片编码失败"));
        reader.readAsDataURL(blob);
      },
      "image/jpeg",
      quality
    );
  });
}

/* ---------- 单词级批注 ---------- */

const drawState = {
  enabled: false,
  canvas: /** @type {HTMLCanvasElement|null} */ (null),
  ctx: /** @type {CanvasRenderingContext2D|null} */ (null),
  box: /** @type {HTMLElement|null} */ (null),
  painting: false,
  lastX: 0,
  lastY: 0,
  wordId: 0,
  /** 批注所属章节（打开弹层时捕获，防切章串键） */
  chapter: 0,
  timer: 0,
  resizeHandler: /** @type {null | (() => void)} */ (null),
};

/** 弹层关闭时调用，避免 resize 监听与保存定时器堆积 */
function cleanupDraw() {
  if (drawState.resizeHandler) window.removeEventListener("resize", drawState.resizeHandler);
  window.clearTimeout(drawState.timer);
  drawState.resizeHandler = null;
  drawState.canvas = null;
  drawState.ctx = null;
  drawState.box = null;
  drawState.enabled = false;
  drawState.painting = false;
  drawState.wordId = 0;
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {HTMLElement} button
 * @param {number} wordId
 * @param {HTMLElement} box
 */
function setupDrawCanvas(canvas, button, wordId, box) {
  drawState.canvas = canvas;
  drawState.ctx = canvas.getContext("2d");
  drawState.box = box;
  drawState.wordId = Number(wordId);
  // 保存/恢复都用开弹层时捕获的章节：定时器 600ms 后触发时即便已切章也不写错键
  drawState.chapter = state.chapter;
  drawState.enabled = false;
  button.replaceChildren(icon("brush"), document.createTextNode(" 批注"));

  drawState.resizeHandler = () => resizeDetailCanvas(true);
  window.addEventListener("resize", drawState.resizeHandler);

  resizeDetailCanvas(false);
  restoreDetailDrawing(Number(wordId));

  button.addEventListener("click", () => {
    drawState.enabled = !drawState.enabled;
    canvas.classList.toggle("active", drawState.enabled);
    button.replaceChildren(
      ...(drawState.enabled ? [icon("x"), document.createTextNode(" 关闭批注")] : [icon("brush"), document.createTextNode(" 批注")])
    );
    // 批注期间禁止弹层滚动，让画布坐标与实际内容 1:1 对齐
    if (drawState.box) drawState.box.style.overflow = drawState.enabled ? "hidden" : "";
  });

  canvas.addEventListener("pointerdown", (e) => {
    if (!drawState.enabled || !drawState.ctx) return;
    e.preventDefault();
    drawState.painting = true;
    const rect = canvas.getBoundingClientRect();
    drawState.lastX = e.clientX - rect.left;
    drawState.lastY = e.clientY - rect.top;
    drawState.ctx.beginPath();
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!drawState.painting || !drawState.enabled || !drawState.ctx) return;
    const rect = canvas.getBoundingClientRect();
    const events = typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : [e];
    for (const point of events.length ? events : [e]) {
      const x = point.clientX - rect.left;
      const y = point.clientY - rect.top;
      drawState.ctx.strokeStyle = "#e5484d";
      drawState.ctx.lineWidth = 2.5;
      drawState.ctx.lineCap = "round";
      drawState.ctx.lineJoin = "round";
      drawState.ctx.beginPath();
      drawState.ctx.moveTo(drawState.lastX, drawState.lastY);
      drawState.ctx.lineTo(x, y);
      drawState.ctx.stroke();
      drawState.lastX = x;
      drawState.lastY = y;
    }
  });
  const stop = () => {
    if (!drawState.painting) return;
    drawState.painting = false;
    scheduleSaveDrawing();
  };
  canvas.addEventListener("pointerup", stop);
  canvas.addEventListener("pointerleave", stop);
  canvas.addEventListener("pointercancel", stop);
}

/** @param {boolean} restore */
function resizeDetailCanvas(restore) {
  const canvas = drawState.canvas;
  if (!canvas || !drawState.ctx) return;
  const parent = canvas.parentElement;
  if (!parent) return;
  const snapshot = restore ? canvas.toDataURL() : "";
  const rect = parent.getBoundingClientRect();
  canvas.width = Math.max(1, Math.round(rect.width));
  canvas.height = Math.max(1, Math.round(rect.height));
  drawState.ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (snapshot && snapshot.length < DRAW_KEY_LIMIT) {
    const image = new Image();
    image.onload = () => drawState.ctx?.drawImage(image, 0, 0, canvas.width, canvas.height);
    image.src = snapshot;
  }
}

function scheduleSaveDrawing() {
  window.clearTimeout(drawState.timer);
  drawState.timer = window.setTimeout(() => {
    const canvas = drawState.canvas;
    if (!canvas || !drawState.wordId || !drawState.chapter) return;
    try {
      const data = canvas.toDataURL();
      if (data.length > DRAW_KEY_LIMIT) {
        toast("批注内容过大，未保存到本机", { type: "bad" });
        return;
      }
      const key = drawKey(drawState.chapter, drawState.wordId);
      void idbPut(key, data).then((ok) => {
        if (!ok) {
          // IDB 不可用：回退 localStorage（会占空间，失败时明确提示）
          if (!safeSet(key, data)) toast("本机存储空间不足，批注未保存", { type: "bad" });
        }
      });
    } catch {
      /* ignore */
    }
  }, 600);
}

function restoreDetailDrawing(wordId) {
  const key = drawKey(drawState.chapter || state.chapter, wordId);
  const canvas = drawState.canvas;
  if (!canvas || !drawState.ctx) return;
  void (async () => {
    const saved = (await idbGet(key)) ?? safeGet(key);
    if (!saved || !drawState.ctx || !drawState.canvas) return;
    const image = new Image();
    image.onload = () => drawState.ctx?.drawImage(image, 0, 0, drawState.canvas.width, drawState.canvas.height);
    image.src = saved;
  })();
}

/* ============ 全局画笔（按章节持久化，resize 不再清空） ============ */

const brush = {
  canvas: /** @type {HTMLCanvasElement|null} */ (null),
  ctx: /** @type {CanvasRenderingContext2D|null} */ (null),
  painting: false,
  lastX: 0,
  lastY: 0,
  color: "#e5484d",
  timer: 0,
};

function initBrush() {
  const canvas = /** @type {HTMLCanvasElement} */ ($("#globalCanvas"));
  const bar = $("#brushBar");
  const toggle = $("#brushToggle");
  const colorPicker = /** @type {HTMLInputElement} */ ($("#brushColor"));
  const clearBtn = $("#brushClear");
  const closeBtn = $("#brushClose");
  brush.canvas = canvas;
  brush.ctx = canvas.getContext("2d");

  const resize = () => {
    const snapshot = canvas.toDataURL();
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    brush.ctx?.clearRect(0, 0, canvas.width, canvas.height);
    if (snapshot.length > 20 && snapshot.length < DRAW_KEY_LIMIT) {
      const image = new Image();
      image.onload = () => brush.ctx?.drawImage(image, 0, 0, canvas.width, canvas.height);
      image.src = snapshot;
    }
  };
  window.addEventListener("resize", resize);

  const save = () => {
    try {
      const data = canvas.toDataURL();
      if (data.length > DRAW_KEY_LIMIT) return;
      const key = brushKey(state.chapter);
      void idbPut(key, data).then((ok) => {
        if (!ok) safeSet(key, data);
      });
    } catch {
      /* ignore */
    }
  };
  const scheduleSave = () => {
    window.clearTimeout(brush.timer);
    brush.timer = window.setTimeout(save, 700);
  };

  const start = (/** @type {PointerEvent} */ e) => {
    if (!brush.ctx) return;
    brush.painting = true;
    const rect = canvas.getBoundingClientRect();
    brush.lastX = e.clientX - rect.left;
    brush.lastY = e.clientY - rect.top;
  };
  const move = (/** @type {PointerEvent} */ e) => {
    if (!brush.painting || !brush.ctx) return;
    const rect = canvas.getBoundingClientRect();
    const events = typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : [e];
    for (const point of events.length ? events : [e]) {
      const x = point.clientX - rect.left;
      const y = point.clientY - rect.top;
      brush.ctx.strokeStyle = brush.color;
      brush.ctx.lineWidth = 3;
      brush.ctx.lineCap = "round";
      brush.ctx.lineJoin = "round";
      brush.ctx.beginPath();
      brush.ctx.moveTo(brush.lastX, brush.lastY);
      brush.ctx.lineTo(x, y);
      brush.ctx.stroke();
      brush.lastX = x;
      brush.lastY = y;
    }
  };
  const stop = () => {
    if (!brush.painting) return;
    brush.painting = false;
    scheduleSave();
  };

  const enter = () => {
    canvas.style.display = "block";
    bar.classList.add("visible");
    canvas.addEventListener("pointerdown", start);
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerup", stop);
    canvas.addEventListener("pointerleave", stop);
    canvas.addEventListener("pointercancel", stop);
  };
  const exit = () => {
    save();
    canvas.style.display = "none";
    bar.classList.remove("visible");
    canvas.removeEventListener("pointerdown", start);
    canvas.removeEventListener("pointermove", move);
    canvas.removeEventListener("pointerup", stop);
    canvas.removeEventListener("pointerleave", stop);
    canvas.removeEventListener("pointercancel", stop);
  };

  toggle?.addEventListener("click", enter);
  closeBtn?.addEventListener("click", exit);
  colorPicker?.addEventListener("input", () => (brush.color = colorPicker.value));
  clearBtn?.addEventListener("click", () => {
    if (!brush.ctx || !brush.canvas) return;
    brush.ctx.clearRect(0, 0, brush.canvas.width, brush.canvas.height);
    save();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && canvas.style.display === "block") exit();
  });
}

function restoreBrush() {
  const canvas = brush.canvas;
  if (!canvas || !brush.ctx) return;
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  brush.ctx.clearRect(0, 0, canvas.width, canvas.height);
  void (async () => {
    const saved = (await idbGet(brushKey(state.chapter))) ?? safeGet(brushKey(state.chapter));
    if (!saved || !brush.ctx || !brush.canvas) return;
    const image = new Image();
    image.onload = () => brush.ctx?.drawImage(image, 0, 0, brush.canvas.width, brush.canvas.height);
    image.src = saved;
  })();
}

/* ============ 快速定位（命令面板：Ctrl/⌘ K 或斜杠唤起） ============ */

/**
 * 命令面板：当前章搜词（词头/释义）+ 章号/章名跳章。
 * Esc 由弹层基座处理；Enter 激活第一条结果。
 */
function openPalette() {
  if (document.querySelector(".scrim")) return; // 已有弹层时不叠加
  const sheet = openSheet({ title: "快速定位" });
  const input = /** @type {HTMLInputElement} */ (
    el("input", {
      class: "input",
      type: "text",
      placeholder: "搜索单词 / 释义，或输入章号（如 12）跳转…",
      autocomplete: "off",
      "data-autofocus": "true",
    })
  );
  const results = el("div", { class: "list palette-list" });

  const renderResults = () => {
    const raw = input.value.trim();
    const q = raw.toLowerCase();
    results.replaceChildren();
    /** @type {Array<{ label: string, meta: string, run: () => void }>} */
    const items = [];
    if (q) {
      for (const ch of CHAPTERS) {
        if (String(ch.id) === q || `${ch.id}${ch.title}`.toLowerCase().includes(q)) {
          items.push({
            label: `第${ch.id}章 · ${ch.title}`,
            meta: `${ch.count} 词 · 跳转`,
            run: () => void loadChapter(ch.id),
          });
        }
      }
      for (const w of state.words) {
        if (items.length >= 14) break;
        if (String(w.word).toLowerCase().includes(q) || String(w.meaningCN).includes(raw)) {
          items.push({
            label: String(w.word),
            meta: String(w.meaningCN),
            run: () => openDetail(Number(w.id)),
          });
        }
      }
    }
    if (!items.length) {
      results.append(el("p", { class: "empty", text: raw ? "没有匹配项" : "输入以搜索…" }));
      return;
    }
    for (const it of items.slice(0, 14)) {
      results.append(
        el(
          "button",
          {
            class: "list-item",
            type: "button",
            onclick: () => {
              sheet.close();
              it.run();
            },
          },
          [
            el("span", { class: "grow" }, [el("strong", { text: it.label }), el("div", { class: "muted", text: it.meta })]),
          ]
        )
      );
    }
  };

  input.addEventListener("input", renderResults);
  input.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const first = $(".list-item", results);
    if (first instanceof HTMLElement) first.click();
  });
  sheet.body.append(input, results);
  renderResults();
}

/* ============ 章节抽屉 ============ */

function openChapterSheet() {
  const sheet = openSheet({ title: "选择章节" });
  const list = el("div", { class: "list" });
  for (const chapter of CHAPTERS) {
    list.append(
      el(
        "button",
        {
          class: "list-item",
          type: "button",
          "aria-current": String(chapter.id === state.chapter),
          onclick: () => {
            sheet.close();
            void loadChapter(chapter.id);
          },
        },
        [
          el("span", { class: "ch-tile", "aria-hidden": "true", text: String(chapter.id) }),
          el("span", { class: "grow" }, [
            el("strong", { text: `第${chapter.id}章 · ${chapter.title}` }),
            el("div", { class: "muted", text: `${chapter.count} 词` }),
          ]),
          el("span", { class: "muted", text: chapter.id === state.chapter ? "当前" : "▶" }),
        ]
      )
    );
  }
  sheet.body.append(list);
}

/* ============ 设置面板 ============ */

function openSettingsSheet() {
  const sheet = openSheet({ title: "设置" });
  const wrap = el("div");

  wrap.append(
    el("div", { class: "settings-group" }, [
      el("h3", { text: "外观" }),
      el("div", { class: "setting-row" }, [
        el("div", { class: "label" }, [el("b", { text: "主题" })]),
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
    ]),
    el("div", { class: "settings-group" }, [
      el("h3", { text: "账号" }),
      el("p", {
        class: "small muted",
        text: Auth.isLoggedIn()
          ? `已登录：${Auth.email()}（备注与配图会同步到云端）`
          : "未登录：备注与配图只保存在本机，登录后会自动上传。",
      }),
      el("div", {
        class: "small muted",
        style: "margin-top:6px",
        text: "账号的登录/注册/改密码请在刷词页的「学习面板 → 设置」中操作。",
      }),
    ]),
    el("div", { class: "settings-group" }, [
      el("h3", { text: "配图与批注" }),
      el("p", {
        class: "small muted",
        text: "配图会自动压缩到长边 1280px（JPEG），单张上限约 300KB；批注按章节/单词保存在本机。",
      }),
    ])
  );

  sheet.body.append(wrap);
}

/**
 * @param {Array<[any, string]>} options
 * @param {any} value
 * @param {(value: any) => void} onChange
 */
function buildSeg(options, value, onChange) {
  const seg = el("div", { class: "seg" });
  for (const [optionValue, label] of options) {
    seg.append(
      el("button", {
        type: "button",
        text: label,
        "aria-pressed": String(String(optionValue) === String(value)),
        onclick: () => onChange(optionValue),
      })
    );
  }
  return seg;
}

/* ============ 初始化 ============ */

function cacheDom() {
  const dom = state.dom;
  dom.title = $("#lectureTitle");
  dom.sub = $("#lectureSub");
  dom.grid = $("#grid");
  dom.loading = $("#loadingCard");
  dom.error = $("#errorCard");
  dom.errorText = $("#errorText");
  dom.retry = $("#retryBtn");
  dom.chapterBtn = $("#chapterBtn");
  dom.search = $("#searchInput");
  dom.filters = $("#filters");
  dom.prevChapter = $("#prevChapter");
  dom.nextChapter = $("#nextChapter");
  dom.menuBtn = $("#menuBtn");
  dom.practiceLink = $("#practiceLink");
}

function bindUi() {
  const dom = state.dom;
  dom.chapterBtn.addEventListener("click", openChapterSheet);
  dom.menuBtn.addEventListener("click", openSettingsSheet);
  dom.retry.addEventListener("click", () => void loadChapter(state.chapter));
  dom.prevChapter.addEventListener("click", () => void loadChapter(Math.max(1, state.chapter - 1)));
  dom.nextChapter.addEventListener("click", () => void loadChapter(Math.min(CHAPTERS.length, state.chapter + 1)));

  let searchTimer = 0;
  dom.search.addEventListener("input", () => {
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
      state.query = dom.search.value;
      state.shown = 0;
      render();
    }, 160);
  });

  // 卡片外观：样式（卡牌/书籍）+ 背景色（网格容器上挂 class）
  const gridEl = dom.grid || document.querySelector("#grid, .grid");
  const applyCardLook = () => {
    if (!gridEl) return;
    gridEl.classList.toggle("style-book", state.cardStyle === "book");
    for (const bg of ["mint", "sky", "sand"]) gridEl.classList.toggle(`bg-${bg}`, state.cardBg === bg);
  };
  applyCardLook();
  const lookBar = document.querySelector(".filters, #filters");
  if (lookBar) {
    const bar = el("div", { class: "look-bar", style: "display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:0 0 10px" }, []);
    const styleSeg = el("div", { class: "seg", role: "group", "aria-label": "卡片样式" }, [
      el("button", { class: "chip-btn", type: "button", text: "卡牌", dataset: { look: "card" }, onclick: () => { state.cardStyle = "card"; safeSet("vocab:lecture-style", "card"); syncLook(); } }),
      el("button", { class: "chip-btn", type: "button", text: "书籍", dataset: { look: "book" }, onclick: () => { state.cardStyle = "book"; safeSet("vocab:lecture-style", "book"); syncLook(); } }),
    ]);
    const bgSeg = el("div", { class: "seg", role: "group", "aria-label": "卡片背景色" }, [
      el("button", { class: "chip-btn", type: "button", text: "素", dataset: { bg: "none" }, onclick: () => { state.cardBg = "none"; safeSet("vocab:lecture-bg", "none"); syncLook(); } }),
      el("button", { class: "chip-btn", type: "button", text: "薄荷", dataset: { bg: "mint" }, onclick: () => { state.cardBg = "mint"; safeSet("vocab:lecture-bg", "mint"); syncLook(); } }),
      el("button", { class: "chip-btn", type: "button", text: "天青", dataset: { bg: "sky" }, onclick: () => { state.cardBg = "sky"; safeSet("vocab:lecture-bg", "sky"); syncLook(); } }),
      el("button", { class: "chip-btn", type: "button", text: "暖沙", dataset: { bg: "sand" }, onclick: () => { state.cardBg = "sand"; safeSet("vocab:lecture-bg", "sand"); syncLook(); } }),
    ]);
    const syncLook = () => {
      for (const b of bar.querySelectorAll("[data-look]")) b.setAttribute("aria-pressed", String(b.dataset.look === state.cardStyle));
      for (const b of bar.querySelectorAll("[data-bg]")) b.setAttribute("aria-pressed", String(b.dataset.bg === state.cardBg));
      applyCardLook();
    };
    bar.append(el("span", { class: "small muted", text: "卡片：" }), styleSeg, bgSeg);
    lookBar.after(bar);
    syncLook();
  }

  for (const chip of $$("[data-filter]", dom.filters)) {
    chip.addEventListener("click", () => {
      state.filter = chip.dataset.filter;
      for (const other of $$("[data-filter]", dom.filters)) {
        other.setAttribute("aria-pressed", String(other === chip));
      }
      state.shown = 0;
      render();
    });
  }

  document.addEventListener("keydown", (e) => {
    if (!currentDetail) return;
    const target = /** @type {HTMLElement} */ (e.target);
    const tag = target?.tagName;
    if (tag === "TEXTAREA" || tag === "INPUT") return;
    // 只有"最上层弹层就是详情"时才响应快捷键：确认框等叠加弹层打开时让位（Esc 由 ui.js 处理）
    const scrims = document.querySelectorAll(".scrim");
    if (scrims[scrims.length - 1] !== currentSheet?.root) return;
    // 焦点在按钮/链接上时，空格交给浏览器激活控件，不劫持为朗读
    const onInteractive = Boolean(target?.closest?.('button, a, select, [role="button"]'));
    if (e.key === "ArrowRight") {
      e.preventDefault();
      step(1);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      step(-1);
    } else if (e.key === "s" || e.key === "S") {
      e.preventDefault();
      // 与按钮同一条路径：按钮文字 / 卡片描边 / 闪光 / 网格刷新全部一致
      if (detailKeyStar) detailKeyStar();
    } else if (e.key === " ") {
      if (onInteractive) return;
      e.preventDefault();
      const word = state.byId.get(Number(currentDetail));
      if (word) void speak(word.word);
    }
  });

  // 快速定位：Ctrl/⌘ K 或「/」（输入框聚焦时不劫持）
  document.addEventListener("keydown", (e) => {
    const t = /** @type {HTMLElement} */ (e.target);
    const typing = Boolean(t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable));
    if ((e.key === "k" || e.key === "K") && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      openPalette();
      return;
    }
    if (e.key === "/" && !typing && !e.isComposing && !document.querySelector(".scrim")) {
      e.preventDefault();
      openPalette();
    }
  });

  if ("IntersectionObserver" in window) {
    observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) renderGrid();
    }, { rootMargin: "400px" });
  }
}

async function init() {
  initTheme();
  // 卡片外观恢复（顶层读 localStorage 会让 Node 端 import 失败，所以放这里；走 safeSet 兜底）
  try {
    if (localStorage.getItem("vocab:lecture-style") === "book") state.cardStyle = "book";
    const bg = localStorage.getItem("vocab:lecture-bg");
    if (["mint", "sky", "sand", "none"].includes(bg)) state.cardBg = bg;
  } catch {}
  // 外观：读调色盘镜像（刷词页写入），storage 事件跨页实时跟随
  const applyAccentFromMirror = () => {
    const mirror = appearanceMirrorRead();
    if (mirror?.name) applyAccent(mirror.name, mirror.color || "");
  };
  applyAccentFromMirror();
  window.addEventListener("storage", (e) => {
    if (e.key === "vocab:accent") applyAccentFromMirror();
  });
  cacheDom();
  bindUi();
  initBrush();

  const params = new URLSearchParams(location.search);
  const chapter = Number(params.get("chapter")) || Number(localStorage.getItem("vocab:last-chapter")) || 1;

  // 一次性把旧 localStorage 里的配图/批注迁进 IndexedDB（幂等，失败不影响使用）
  void migrateLegacy();

  const user = await Auth.init();
  state.userKey = user ? `u${user.userId}` : "guest";
  state.starred = loadStars();

  // 监听器必须在 loadChapter 之前注册：loadChapter 抛错也不会把登录态变化的监听丢掉
  Auth.onAuthChange((current) => {
    state.userKey = current ? `u${current.userId}` : "guest";
    state.starred = loadStars();
    render();
    if (current) void syncNotesFromCloud();
  });

  await loadChapter(chapter);
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => void init());
  else void init();
}

export { init };
