// @ts-check
// PWA：Service Worker（与刷词页共用；注册失败静默）
if ("serviceWorker" in navigator && (location.protocol === "https:" || ["localhost", "127.0.0.1"].includes(location.hostname))) {
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
  toast,
  confirmDialog,
  openSheet,
  theme,
  appearanceMirrorRead,
  initTheme,
  announce,
} from "./ui.js";
import { applyAccent } from "./core.js";

const CHUNK = 60;
const MAX_NOTE_CHARS = 4000;
const MAX_IMAGE_BYTES = 300 * 1024;
const DRAW_KEY_LIMIT = 1_200_000;

const state = {
  chapter: 1,
  /** @type {any[]} */
  words: [],
  /** @type {Record<number, any>} */
  byId: new Map(),
  /** @type {Record<string, string>} wordId → note */
  notes: {},
  /** @type {Set<number>} 云端标记有配图的词 */
  cloudImages: new Set(),
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

/* ============ 本地存储 ============ */

const noteKey = (chapter, word) => `lecture-note-${chapter}-${word}`;
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
      await new Promise((resolve) => {
        window.speechSynthesis.addEventListener("voiceschanged", () => resolve(null), { once: true });
        window.setTimeout(resolve, 1200);
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
  state.loading = true;
  state.error = null;
  render();
  try {
    const res = await fetch(`data-${Number(chapterId)}.json`, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`词库加载失败（HTTP ${res.status}）`);
    const list = await res.json();
    if (!Array.isArray(list) || !list.length) throw new Error("词库为空");
    state.chapter = Number(chapterId);
    state.words = list;
    state.byId = new Map(list.map((w) => [Number(w.id), w]));
    state.images.clear();
    state.cloudImages.clear();
    state.loading = false;
    state.shown = 0;
    loadLocalNotes();
    render();
    history.replaceState(null, "", `?chapter=${state.chapter}`);
    void syncNotesFromCloud();
    restoreBrush();
  } catch (err) {
    state.loading = false;
    state.error = err instanceof Error ? err.message : "词库加载失败";
    render();
  }
}

function loadLocalNotes() {
  state.notes = {};
  for (const word of state.words) {
    const note = safeGet(noteKey(state.chapter, word.id));
    if (note) state.notes[String(word.id)] = note;
  }
}

/** 云端备注/配图拉取 + 本地存量笔记的一次性上行 */
async function syncNotesFromCloud() {
  if (!Auth.isLoggedIn()) return;
  const data = await Auth.getNotes(state.chapter);
  if (!data) return;
  let changed = false;
  for (const [wordId, note] of Object.entries(data.notes || {})) {
    if (!state.notes[wordId]) {
      state.notes[wordId] = note;
      safeSet(noteKey(state.chapter, wordId), note);
      changed = true;
    }
  }
  state.cloudImages = new Set((data.images || []).map((id) => Number(id)));

  // 本机已有但云端没有的笔记/配图 → 上行一次（老用户数据不丢）
  for (const word of state.words) {
    const local = safeGet(noteKey(state.chapter, word.id));
    if (local && !(data.notes || {})[String(word.id)]) {
      void Auth.putNote(state.chapter, Number(word.id), local);
    }
    const localImage = safeGet(imgKey(state.chapter, word.id));
    if (localImage && !state.cloudImages.has(Number(word.id))) {
      const parts = localImage.split(",");
      const mime = parts[0]?.match(/data:([^;]+)/)?.[1] || "image/jpeg";
      if (parts[1] && parts[1].length <= 400_000) {
        void Auth.putNoteImage(state.chapter, Number(word.id), mime, parts[1]);
      }
    }
  }
  if (changed) render();
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
  dom.title.textContent = `${chapter?.emoji || "📘"} ${chapterTitle(state.chapter)} · 核心词汇`;
  document.title = `${chapter?.title || "讲义"} · 核心词汇`;
  dom.sub.textContent = state.loading
    ? "正在加载…"
    : `${state.words.length} 词 · ${filteredWords().length} 条符合当前筛选`;

  dom.loading.hidden = !state.loading;
  dom.error.hidden = !state.error;
  dom.errorText.textContent = state.error || "";
  dom.grid.hidden = Boolean(state.loading || state.error);

  // 刷词页深链：带上当前章节（点一下就直接练这一章）
  dom.practiceLink?.setAttribute("href", `index.html?chapter=${state.chapter}`);
  dom.chapterBtn.textContent = `📚 ${chapterTitle(state.chapter)}`;

  if (!state.loading && !state.error) renderGrid();
}

function renderGrid() {
  const grid = state.dom.grid;
  const list = filteredWords();
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
  existing?.remove();
  if (state.shown < list.length) {
    const sentinel = el("div", { class: "sentinel", id: "sentinel", text: `已显示 ${state.shown}/${list.length}，继续下滑加载更多` });
    grid.append(sentinel);
    observer?.observe(sentinel);
  } else if (list.length === 0) {
    grid.append(el("div", { class: "sentinel", text: "没有匹配的词，试试换个筛选或关键词" }));
  }
}

/** @type {IntersectionObserver | null} */
let observer = null;

/** @param {any} word @param {boolean} animate */
function buildCard(word, animate) {
  const id = Number(word.id);
  const note = state.notes[String(id)];
  const hasImage = Boolean(state.images.get(id) || state.cloudImages.has(id) || safeGet(imgKey(state.chapter, id)));
  const card = el(
    "button",
    {
      class: `word-card${animate ? " enter" : ""}`,
      type: "button",
      dataset: { id: String(id) },
      onclick: () => openDetail(id),
    },
    [
      el("div", { class: "markers" }, [
        el("span", {
          class: `marker star-toggle${state.starred.has(id) ? " on" : ""}`,
          role: "button",
          title: state.starred.has(id) ? "取消生词" : "标为生词",
          text: state.starred.has(id) ? "★" : "☆",
          onclick: (e) => {
            e.stopPropagation();
            toggleStarCard(id);
          },
        }),
        note ? el("span", { class: "marker", title: "有备注", text: "📝" }) : null,
        hasImage ? el("span", { class: "marker", title: "有配图", text: "🖼️" }) : null,
        state.starred.has(id) ? el("span", { class: "marker", title: "生词", text: "★" }) : null,
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

/** @param {number} wordId */
function openDetail(wordId) {
  const word = state.byId.get(Number(wordId));
  if (!word) return;
  currentDetail = Number(wordId);
  const sheet = openSheet({
    title: word.word,
    onClose: () => {
      cleanupDraw();
      currentDetail = null;
      currentSheet = null;
    },
  });
  currentSheet = sheet;
  const box = sheet.box;
  box.classList.add("word-detail");

  const drawCanvas = el("canvas", { class: "draw-canvas", id: "detailCanvas" });
  box.prepend(drawCanvas);

  // 标题由弹层头部提供（单词本身），这里只放音标/词性/朗读
  const head = el("div", { class: "detail-head" }, [
    el("span", { class: "phonetic", text: word.phonetic || "" }),
    el("span", { class: `tag tag-${tagClass(word.tag)}`, text: word.tag || "" }),
    el("button", { class: "btn btn-sm", type: "button", text: "🔊 朗读", onclick: () => void speak(word.word) }),
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
  const imageWrap = el("div", { class: "detail-block detail-image", id: "detailImage" });
  const noteStatus = el("div", { class: "note-status" });
  const textarea = /** @type {HTMLTextAreaElement} */ (
    el("textarea", { class: "textarea", id: "detailNote", placeholder: "写点备注：易混词、词根、老师讲的点…" })
  );
  textarea.value = state.notes[String(wordId)] || "";

  const addImageBtn = el("button", { class: "btn", type: "button", text: "🖼️ 添加配图", onclick: () => pickImage(Number(wordId)) });
  const removeImageBtn = el("button", {
    class: "btn btn-danger",
    type: "button",
    text: "删除配图",
    onclick: () => removeImage(Number(wordId)),
  });
  const drawBtn = el("button", { class: "btn", type: "button", text: "🖌️ 批注" });
  const starBtn = el("button", { class: "btn", type: "button", text: state.starred.has(Number(wordId)) ? "★ 生词" : "☆ 生词" });

  const actions = el("div", { class: "detail-actions" }, [
    el("a", { class: "btn btn-primary", href: `index.html?chapter=${state.chapter}&word=${wordId}`, text: "✏️ 练这个词" }),
    starBtn,
    addImageBtn,
    removeImageBtn,
    drawBtn,
    el("button", { class: "btn", type: "button", text: "← 上一个", onclick: () => step(-1) }),
    el("button", { class: "btn", type: "button", text: "下一个 →", onclick: () => step(1) }),
  ]);

  const noteArea = el("div", { class: "note-area" }, [
    el("label", { class: "small muted", text: "备注（自动保存，登录后云端同步）" }),
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

  starBtn.addEventListener("click", () => {
    const id = Number(wordId);
    if (state.starred.has(id)) state.starred.delete(id);
    else state.starred.add(id);
    saveStars();
    starBtn.textContent = state.starred.has(id) ? "★ 生词" : "☆ 生词";
    render();
  });

  // 备注：本地立即保存，云端防抖 800ms
  textarea.addEventListener("input", () => {
    const value = textarea.value.slice(0, MAX_NOTE_CHARS);
    state.notes[String(wordId)] = value;
    safeSet(noteKey(state.chapter, wordId), value);
    noteStatus.textContent = "已保存到本机";
    window.clearTimeout(state.noteTimers.get(Number(wordId)));
    const timer = window.setTimeout(async () => {
      if (!Auth.isLoggedIn()) {
        noteStatus.textContent = "未登录：仅保存在本机";
        return;
      }
      const res = await Auth.putNote(state.chapter, Number(wordId), value);
      noteStatus.textContent = res.ok ? "已同步到云端" : `同步失败：${res.msg || "网络异常"}`;
    }, 800);
    state.noteTimers.set(Number(wordId), timer);
    renderMarkers(wordId);
  });

  if (Auth.isLoggedIn()) noteStatus.textContent = "登录后自动同步";

  // 配图
  const cached = state.images.get(Number(wordId)) || safeGet(imgKey(state.chapter, wordId));
  if (cached) showImage(cached, removeImageBtn);
  else if (state.cloudImages.has(Number(wordId))) void fetchCloudImage(Number(wordId));
  removeImageBtn.hidden = !(cached || state.cloudImages.has(Number(wordId)));

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
  render();
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
  window.setTimeout(() => openDetail(Number(next.id)), 10);
}

function renderMarkers(wordId) {
  // 简单更新：重绘网格以便卡片上的 📝 标记同步
  const grid = state.dom.grid;
  const card = $(`[data-id="${wordId}"]`, grid);
  if (!card) return;
  const hasNote = Boolean(state.notes[String(wordId)]);
  const markers = $(".markers", card);
  if (!markers) return;
  const existing = $$(".marker", markers).find((m) => m.textContent === "📝");
  if (hasNote && !existing) markers.prepend(el("span", { class: "marker", title: "有备注", text: "📝" }));
  if (!hasNote && existing) existing.remove();
}

/* ---------- 配图 ---------- */

/**
 * @param {string} dataUrl
 * @param {HTMLElement} [removeBtn]
 */
function showImage(dataUrl, removeBtn) {
  const wrap = $("#detailImage");
  if (!wrap) return;
  wrap.replaceChildren(el("img", { src: dataUrl, alt: "单词配图" }));
  if (removeBtn) removeBtn.hidden = false;
}

async function fetchCloudImage(wordId) {
  const data = await Auth.getNoteImage(state.chapter, wordId);
  if (!data?.data) return;
  const dataUrl = `data:${data.mime};base64,${data.data}`;
  state.images.set(wordId, dataUrl);
  if (currentDetail === wordId) {
    showImage(dataUrl);
    const detailRemove = $$(".detail-actions .btn-danger").pop();
    if (detailRemove) detailRemove.hidden = false;
  }
  // 本地缓存一份（离线也能看）
  if (!safeGet(imgKey(state.chapter, wordId))) safeSet(imgKey(state.chapter, wordId), dataUrl);
}

function pickImage(wordId) {
  const input = el("input", { type: "file", accept: "image/*", style: "display:none" });
  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    input.remove();
    if (!file) return;
    toast("正在压缩图片…");
    try {
      const { dataUrl, mime, base64, bytes } = await compressImage(file);
      state.images.set(wordId, dataUrl);
      const localOk = safeSet(imgKey(state.chapter, wordId), dataUrl);
      showImage(dataUrl);
      toast(`图片已更新（${Math.round(bytes / 1024)}KB${localOk ? "" : "，本机缓存空间不足"}）`, { type: "ok" });
      if (Auth.isLoggedIn()) {
        const res = await Auth.putNoteImage(state.chapter, wordId, mime, base64);
        if (!res.ok) toast(`云端保存失败：${res.msg || "网络异常"}`, { type: "bad" });
      } else {
        toast("未登录：配图只保存在本机", { type: "bad" });
      }
      render();
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
  try {
    localStorage.removeItem(imgKey(state.chapter, wordId));
  } catch {
    /* ignore */
  }
  state.images.delete(wordId);
  state.cloudImages.delete(wordId);
  const wrap = $("#detailImage");
  wrap?.replaceChildren();
  if (Auth.isLoggedIn()) await Auth.deleteNoteImage(state.chapter, wordId);
  toast("配图已删除", { type: "ok" });
  render();
}

/**
 * 压缩：长边 ≤1280，JPEG 质量 0.8；仍超 300KB 就继续降质量/尺寸
 * @param {File} file
 */
async function compressImage(file) {
  const bitmap = await createImageBitmap(file);
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
    ctx.drawImage(bitmap, 0, 0, width, height);
    result = canvas.toDataURL("image/jpeg", quality);
    const base64 = result.split(",")[1] || "";
    if (base64.length * 0.75 <= MAX_IMAGE_BYTES) {
      bitmap.close?.();
      return { dataUrl: result, mime: "image/jpeg", base64, bytes: base64.length * 0.75 };
    }
    quality = Math.max(0.5, quality - 0.12);
    maxSide = Math.round(maxSide * 0.85);
  }
  bitmap.close?.();
  const base64 = result.split(",")[1] || "";
  if (base64.length * 0.75 > MAX_IMAGE_BYTES * 1.4) {
    throw new Error("图片过大，请先裁剪或换一张更小的图");
  }
  return { dataUrl: result, mime: "image/jpeg", base64, bytes: base64.length * 0.75 };
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
  timer: 0,
  resizeHandler: /** @type {null | (() => void)} */ (null),
};

/** 弹层关闭时调用，避免 resize 监听堆积 */
function cleanupDraw() {
  if (drawState.resizeHandler) window.removeEventListener("resize", drawState.resizeHandler);
  drawState.resizeHandler = null;
  drawState.canvas = null;
  drawState.ctx = null;
  drawState.box = null;
  drawState.enabled = false;
  drawState.painting = false;
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
  drawState.enabled = false;
  button.textContent = "🖌️ 批注";

  drawState.resizeHandler = () => resizeDetailCanvas(true);
  window.addEventListener("resize", drawState.resizeHandler);

  resizeDetailCanvas(false);
  restoreDetailDrawing(Number(wordId));

  button.addEventListener("click", () => {
    drawState.enabled = !drawState.enabled;
    canvas.classList.toggle("active", drawState.enabled);
    button.textContent = drawState.enabled ? "✕ 关闭批注" : "🖌️ 批注";
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
    if (!canvas || !drawState.wordId) return;
    try {
      const data = canvas.toDataURL();
      if (data.length > DRAW_KEY_LIMIT) {
        toast("批注内容过大，未保存到本机", { type: "bad" });
        return;
      }
      safeSet(drawKey(state.chapter, drawState.wordId), data);
    } catch {
      /* ignore */
    }
  }, 600);
}

function restoreDetailDrawing(wordId) {
  const saved = safeGet(drawKey(state.chapter, wordId));
  const canvas = drawState.canvas;
  if (!saved || !canvas || !drawState.ctx) return;
  const image = new Image();
  image.onload = () => drawState.ctx?.drawImage(image, 0, 0, canvas.width, canvas.height);
  image.src = saved;
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
      safeSet(brushKey(state.chapter), data);
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
  const saved = safeGet(brushKey(state.chapter));
  if (!saved) return;
  const image = new Image();
  image.onload = () => brush.ctx?.drawImage(image, 0, 0, canvas.width, canvas.height);
  image.src = saved;
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
          el("span", { class: "grow" }, [
            el("strong", { text: `${chapter.emoji} 第${chapter.id}章 · ${chapter.title}` }),
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
      el("button", { class: "chip-btn", type: "button", text: "🃏 卡牌", dataset: { look: "card" }, onclick: () => { state.cardStyle = "card"; localStorage.setItem("vocab:lecture-style", "card"); syncLook(); } }),
      el("button", { class: "chip-btn", type: "button", text: "📖 书籍", dataset: { look: "book" }, onclick: () => { state.cardStyle = "book"; localStorage.setItem("vocab:lecture-style", "book"); syncLook(); } }),
    ]);
    const bgSeg = el("div", { class: "seg", role: "group", "aria-label": "卡片背景色" }, [
      el("button", { class: "chip-btn", type: "button", text: "素", dataset: { bg: "none" }, onclick: () => { state.cardBg = "none"; localStorage.setItem("vocab:lecture-bg", "none"); syncLook(); } }),
      el("button", { class: "chip-btn", type: "button", text: "薄荷", dataset: { bg: "mint" }, onclick: () => { state.cardBg = "mint"; localStorage.setItem("vocab:lecture-bg", "mint"); syncLook(); } }),
      el("button", { class: "chip-btn", type: "button", text: "天青", dataset: { bg: "sky" }, onclick: () => { state.cardBg = "sky"; localStorage.setItem("vocab:lecture-bg", "sky"); syncLook(); } }),
      el("button", { class: "chip-btn", type: "button", text: "暖沙", dataset: { bg: "sand" }, onclick: () => { state.cardBg = "sand"; localStorage.setItem("vocab:lecture-bg", "sand"); syncLook(); } }),
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
    const tag = /** @type {HTMLElement} */ (e.target).tagName;
    if (tag === "TEXTAREA" || tag === "INPUT") return;
    if (e.key === "ArrowRight") {
      e.preventDefault();
      step(1);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      step(-1);
    } else if (e.key === "s" || e.key === "S") {
      e.preventDefault();
      const id = Number(currentDetail);
      if (state.starred.has(id)) state.starred.delete(id);
      else state.starred.add(id);
      saveStars();
      const btn = [...document.querySelectorAll(".detail-actions .btn")].find((b) => b.textContent.includes("生词"));
      if (btn) btn.textContent = state.starred.has(id) ? "★ 生词" : "☆ 生词";
      const flashEl = document.querySelector(".detail-card");
      if (flashEl) {
        flashEl.classList.remove("star-flash");
        void flashEl.offsetWidth;
        flashEl.classList.add(state.starred.has(id) ? "star-flash on" : "star-flash");
      }
      render();
    } else if (e.key === " ") {
      e.preventDefault();
      const word = state.byId.get(Number(currentDetail));
      if (word) void speak(word.word);
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
  // 卡片外观恢复（顶层读 localStorage 会让 Node 端 import 失败，所以放这里）
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

  const user = await Auth.init();
  state.userKey = user ? `u${user.userId}` : "guest";
  state.starred = loadStars();

  await loadChapter(chapter);
  localStorage.setItem("vocab:last-chapter", String(state.chapter));

  Auth.onAuthChange((current) => {
    state.userKey = current ? `u${current.userId}` : "guest";
    state.starred = loadStars();
    render();
    if (current) void syncNotesFromCloud();
  });
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => void init());
  else void init();
}

export { init };
