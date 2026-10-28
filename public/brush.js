// @ts-check
/**
 * brush.js —— 讲义页「整页画笔」：全屏 canvas 的绘制、按章节持久化与恢复
 *
 * 从 lecture.js 抽出（拆分第 3 步）。这一块自成一体：状态都在 brush 对象里，
 * 存储走 lecture-store 的 persistLectureValue（IDB 优先、localStorage 兜底），
 * 与刷词逻辑、词卡渲染没有交集。
 *
 * 与页面的唯一接口是 initBrush(getContext)：会话上下文（章节/账号/authRevision）
 * 由 lecture.js 提供——brush.js 不需要知道账号模型，也就不可能反向依赖页面。
 */
import { $, toast } from "./ui.js";
import { idbGet } from "./idb.js";
import { persistLectureValue, brushKey, DRAW_KEY_LIMIT, safeGet } from "./lecture-store.js";

/* ============ 全局画笔（按章节持久化，resize 不再清空） ============ */

export const brush = {
  canvas: /** @type {HTMLCanvasElement|null} */ (null),
  ctx: /** @type {CanvasRenderingContext2D|null} */ (null),
  painting: false,
  lastX: 0,
  lastY: 0,
  color: "#e5484d",
  timer: 0,
  generation: 0,
  revision: 0,
  dirty: false,
  attached: false,
  context: /** @type {null | { chapter: number, userKey: string, authRevision?: number }} */ (null),
  bar: /** @type {HTMLElement|null} */ (null),
  detach: /** @type {null | (() => void)} */ (null),
};

/** 页面注入的"上下文是否仍属当前会话"判断：brush.js 不认识 lecture 的世代/详情模型 */
let isContextCurrent = () => false;

/**
 * @param {{ chapter: number, userKey: string, authRevision?: number } | null} context
 * @param {HTMLCanvasElement} canvas
 * @param {number} generation
 */
export function isBrushInstanceActive(context, canvas, generation) {
  return (
    brush.generation === generation &&
    brush.canvas === canvas &&
    brush.context === context &&
    isContextCurrent(context, { checkDetail: false })
  );
}

export function markBrushDirty() {
  brush.dirty = true;
  brush.revision++;
}

export function saveBrushSnapshot(context, canvas, generation, revision) {
  if (!context || !canvas) return;
  let data = "";
  try {
    data = canvas.toDataURL();
  } catch {
    return;
  }
  if (data.length > DRAW_KEY_LIMIT) {
    if (isBrushInstanceActive(context, canvas, generation)) toast("全局画笔内容过大，未保存到本机", { type: "bad" });
    return;
  }
  const key = brushKey(context.chapter, context.userKey);
  void persistLectureValue(key, data).then((ok) => {
    if (!ok && isBrushInstanceActive(context, canvas, generation)) toast("本机存储空间不足，全局画笔未保存", { type: "bad" });
    if (ok && brush.context === context && brush.generation === generation && brush.revision === revision) brush.dirty = false;
  });
}

export function flushBrush() {
  window.clearTimeout(brush.timer);
  brush.timer = 0;
  if (brush.dirty && brush.context && brush.canvas) saveBrushSnapshot(brush.context, brush.canvas, brush.generation, brush.revision);
}

export function detachBrush({ flush = true } = {}) {
  if (!brush.attached && !brush.canvas) return;
  if (flush) flushBrush();
  const detach = brush.detach;
  brush.detach = null;
  if (detach) detach();
  brush.generation++;
  brush.painting = false;
  brush.dirty = false;
  brush.revision = 0;
  brush.canvas = null;
  brush.ctx = null;
  brush.context = null;
  brush.bar = null;
  brush.attached = false;
}

export function resizeBrush(
  restore,
  context = brush.context,
  canvas = brush.canvas,
  ctx = brush.ctx,
  generation = brush.generation
) {
  if (!context || !canvas || !ctx || !isBrushInstanceActive(context, canvas, generation)) return;
  let snapshot = "";
  if (restore) {
    try {
      snapshot = canvas.toDataURL();
    } catch {
      snapshot = "";
    }
  }
  const width = Math.max(1, window.innerWidth);
  const height = Math.max(1, window.innerHeight);
  canvas.width = width;
  canvas.height = height;
  ctx.clearRect(0, 0, width, height);
  const revision = brush.revision;
  if (snapshot.length > 20 && snapshot.length < DRAW_KEY_LIMIT) {
    const image = new Image();
    image.onload = () => {
      if (isBrushInstanceActive(context, canvas, generation) && brush.revision === revision) ctx.drawImage(image, 0, 0, width, height);
    };
    image.src = snapshot;
  }
}

/**
 * 挂载全局画笔。上下文与"是否仍属当前会话"都由调用方注入：
 * brush.js 不认识 lecture 的章节/详情/会话世代模型，也就不可能反向依赖页面。
 * @param {{
 *   getContext: () => { chapter: number, userKey: string, authRevision?: number },
 *   isCurrent: (context: any, opts?: { checkChapter?: boolean, checkDetail?: boolean }) => boolean
 * }} deps
 */
export function initBrush({ getContext, isCurrent }) {
  isContextCurrent = isCurrent;
  if (brush.attached) return;
  const canvas = /** @type {HTMLCanvasElement|null} */ ($("#globalCanvas"));
  const bar = /** @type {HTMLElement|null} */ ($("#brushBar"));
  if (!canvas || !bar) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const context = getContext();
  const generation = ++brush.generation;
  brush.canvas = canvas;
  brush.ctx = ctx;
  brush.bar = bar;
  brush.context = context;
  brush.revision = 0;
  brush.dirty = false;
  brush.attached = true;
  canvas.style.display = "none";
  bar.classList.remove("visible");

  const toggle = /** @type {HTMLButtonElement|null} */ ($("#brushToggle"));
  const colorPicker = /** @type {HTMLInputElement|null} */ ($("#brushColor"));
  const clearBtn = /** @type {HTMLButtonElement|null} */ ($("#brushClear"));
  const closeBtn = /** @type {HTMLButtonElement|null} */ ($("#brushClose"));
  const isActive = () => isBrushInstanceActive(context, canvas, generation);
  const resize = () => resizeBrush(true, context, canvas, ctx, generation);
  const scheduleSave = () => {
    window.clearTimeout(brush.timer);
    brush.timer = window.setTimeout(() => {
      brush.timer = 0;
      if (isActive()) saveBrushSnapshot(context, canvas, generation, brush.revision);
    }, 700);
  };
  const start = (/** @type {PointerEvent} */ e) => {
    if (!isActive()) return;
    e.preventDefault();
    brush.painting = true;
    const rect = canvas.getBoundingClientRect();
    brush.lastX = e.clientX - rect.left;
    brush.lastY = e.clientY - rect.top;
  };
  const move = (/** @type {PointerEvent} */ e) => {
    if (!isActive() || !brush.painting) return;
    const rect = canvas.getBoundingClientRect();
    const events = typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : [e];
    for (const point of events.length ? events : [e]) {
      const x = point.clientX - rect.left;
      const y = point.clientY - rect.top;
      ctx.strokeStyle = brush.color;
      ctx.lineWidth = 3;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      ctx.moveTo(brush.lastX, brush.lastY);
      ctx.lineTo(x, y);
      ctx.stroke();
      brush.lastX = x;
      brush.lastY = y;
    }
    markBrushDirty();
  };
  const stop = () => {
    if (!isActive() || !brush.painting) return;
    brush.painting = false;
    scheduleSave();
  };
  const enter = () => {
    if (!isActive()) return;
    canvas.style.display = "block";
    bar.classList.add("visible");
  };
  const exit = () => {
    if (!isActive()) return;
    brush.painting = false;
    flushBrush();
    canvas.style.display = "none";
    bar.classList.remove("visible");
  };
  const clear = () => {
    if (!isActive()) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    markBrushDirty();
    saveBrushSnapshot(context, canvas, generation, brush.revision);
  };
  const onColor = () => {
    if (isActive() && colorPicker) brush.color = colorPicker.value;
  };
  const onKey = (/** @type {KeyboardEvent} */ e) => {
    if (e.key === "Escape" && isActive() && canvas.style.display === "block") exit();
  };
  canvas.addEventListener("pointerdown", start);
  canvas.addEventListener("pointermove", move);
  canvas.addEventListener("pointerup", stop);
  canvas.addEventListener("pointerleave", stop);
  canvas.addEventListener("pointercancel", stop);
  toggle?.addEventListener("click", enter);
  closeBtn?.addEventListener("click", exit);
  colorPicker?.addEventListener("input", onColor);
  clearBtn?.addEventListener("click", clear);
  document.addEventListener("keydown", onKey);
  window.addEventListener("resize", resize);
  brush.detach = () => {
    canvas.removeEventListener("pointerdown", start);
    canvas.removeEventListener("pointermove", move);
    canvas.removeEventListener("pointerup", stop);
    canvas.removeEventListener("pointerleave", stop);
    canvas.removeEventListener("pointercancel", stop);
    toggle?.removeEventListener("click", enter);
    closeBtn?.removeEventListener("click", exit);
    colorPicker?.removeEventListener("input", onColor);
    clearBtn?.removeEventListener("click", clear);
    document.removeEventListener("keydown", onKey);
    window.removeEventListener("resize", resize);
    bar.classList.remove("visible");
    canvas.style.display = "none";
  };
  resizeBrush(false, context, canvas, ctx, generation);
}

export function restoreBrush(
  context = brush.context,
  canvas = brush.canvas,
  ctx = brush.ctx,
  generation = brush.generation
) {
  if (!context || !canvas || !ctx || !isBrushInstanceActive(context, canvas, generation)) return;
  canvas.width = Math.max(1, window.innerWidth);
  canvas.height = Math.max(1, window.innerHeight);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const revision = brush.revision;
  const key = brushKey(context.chapter, context.userKey);
  void (async () => {
    const saved = (await idbGet(key)) ?? safeGet(key);
    if (!saved || !isBrushInstanceActive(context, canvas, generation) || brush.revision !== revision) return;
    const image = new Image();
    image.onload = () => {
      if (isBrushInstanceActive(context, canvas, generation) && brush.revision === revision) {
        ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      }
    };
    image.src = saved;
  })();
}
