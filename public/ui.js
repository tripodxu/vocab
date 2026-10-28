// @ts-check
/**
 * ui.js —— 共用交互组件：主题、toast、确认框、输入框对话框、抽屉/弹窗（含焦点陷阱）
 * 不依赖任何框架；所有 DOM 访问都在函数内部，因此本文件可以在 Node 里被 import 做语法检查。
 */

/* ============ DOM 小工具 ============ */

/** @param {string} sel @param {ParentNode} [root] */
export const $ = (sel, root = document) => /** @type {HTMLElement|null} */ (root.querySelector(sel));
/** @param {string} sel @param {ParentNode} [root] */
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/** @param {string} value */
export function escapeHTML(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * 内联 SVG 图标（sprite 定义在各页 <body> 顶部的 #sprite 块里）。
 * 结构性控件一律用图标，不再用 emoji（emoji 依赖字体、跨平台不可控、不可主题化）。
 * @param {string} name sprite 里的符号名（不带 i- 前缀）
 * @param {string} [cls] 额外 class
 */
export function icon(name, cls = "") {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", cls ? `icon ${cls}` : "icon");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const use = document.createElementNS(SVG_NS, "use");
  use.setAttribute("href", `#i-${name}`);
  svg.append(use);
  return svg;
}

/**
 * 字符串版图标（只允许拼接静态符号名；文本部分必须先过 escapeHTML）。
 * @param {string} name @param {string} [cls]
 */
export function iconHTML(name, cls = "") {
  const klass = cls ? `icon ${cls}` : "icon";
  return `<svg class="${klass}" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><use href="#i-${name}"></use></svg>`;
}

/* ============ 图标 sprite（四页统一下发，替代各页 HTML 内联的同一份 28 符号块） ============
   原先四页 <body> 顶部各内联一份逐字相同的 <svg id="sprite">（约 28 行 × 4 = 112 行重复），
   改一个图标要改四个 HTML、漏一页就出现"这一页图标是旧的"。
   现在唯一定义在这里：模块求值时同步注入（早于各页 init 与首帧绘制，
   静态 <use href="#i-*"> 随即解析）；Node 环境（check.mjs 的 import 检查）自动跳过。 */
const SPRITE_HTML = `<svg id="sprite" xmlns="http://www.w3.org/2000/svg" style="display: none" aria-hidden="true"><symbol id="i-menu" viewBox="0 0 24 24"><path d="M4 7h16M4 12h16M4 17h16"/></symbol><symbol id="i-sliders" viewBox="0 0 24 24"><path d="M4 8h8M16 8h4M4 16h4M12 16h8"/><circle cx="14" cy="8" r="2"/><circle cx="10" cy="16" r="2"/></symbol><symbol id="i-user" viewBox="0 0 24 24"><circle cx="12" cy="8" r="3.5"/><path d="M5 20c1.3-3.5 4-5.2 7-5.2s5.7 1.7 7 5.2"/></symbol><symbol id="i-refresh" viewBox="0 0 24 24"><path d="M19.9 12a7.9 7.9 0 1 1-2.3-5.6"/><path d="M20.5 4.2V8h-3.8"/></symbol><symbol id="i-check-circle" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M8.2 12.4l2.7 2.7 5-5.6"/></symbol><symbol id="i-x-circle" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M9.2 9.2l5.6 5.6M14.8 9.2l-5.6 5.6"/></symbol><symbol id="i-alert" viewBox="0 0 24 24"><path d="M12 4.2L2.8 19.8h18.4z"/><path d="M12 10v4"/><path d="M12 17.2h.01"/></symbol><symbol id="i-x" viewBox="0 0 24 24"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/></symbol><symbol id="i-chart" viewBox="0 0 24 24"><path d="M5 20v-8M12 20V5M19 20v-5"/></symbol><symbol id="i-book-open" viewBox="0 0 24 24"><path d="M12 7.2c-1.8-1.5-4.2-2.2-7-2v12c2.8 0 5.2.5 7 2 1.8-1.5 4.2-2 7-2v-12c-2.8 0-5.2.5-7 2z"/><path d="M12 7.2v12"/></symbol><symbol id="i-pencil" viewBox="0 0 24 24"><path d="M4.5 19.5l4.3-1L20 7.3a1.9 1.9 0 0 0 0-2.7l-.6-.6a1.9 1.9 0 0 0-2.7 0L5.5 15.2z"/><path d="M14.5 5.5l4 4"/></symbol><symbol id="i-volume" viewBox="0 0 24 24"><path d="M4 9.5v5h3.5L12 19V5L7.5 9.5z"/><path d="M15.5 9.2a4 4 0 0 1 0 5.6"/><path d="M18.2 6.5a8 8 0 0 1 0 11"/></symbol><symbol id="i-lightbulb" viewBox="0 0 24 24"><path d="M9.5 18.5h5M10.2 21.2h3.6"/><path d="M12 3a6 6 0 0 0-3.6 10.8c.7.5 1.1 1.3 1.1 2.2h5c0-.9.4-1.7 1.1-2.2A6 6 0 0 0 12 3z"/></symbol><symbol id="i-timer" viewBox="0 0 24 24"><circle cx="12" cy="13.5" r="7.3"/><path d="M12 13.5V9.6M9.6 2.8h4.8M18.4 6.4l1.4-1.4"/></symbol><symbol id="i-reset" viewBox="0 0 24 24"><path d="M4.5 5.5v5h5"/><path d="M5.4 13.5a7.5 7.5 0 1 0 1.5-6.4"/></symbol><symbol id="i-flag" viewBox="0 0 24 24"><path d="M6 21V4"/><path d="M6 4.5h11l-2.6 4.2L17 13H6"/></symbol><symbol id="i-image" viewBox="0 0 24 24"><rect x="3.5" y="5" width="17" height="14" rx="2.2"/><circle cx="9" cy="10" r="1.6"/><path d="M4.5 17.5l4.8-4.2 3.7 3.2 3-2.6 3.5 3.6"/></symbol><symbol id="i-trash" viewBox="0 0 24 24"><path d="M4.5 7h15M9.5 7V5.6A1.6 1.6 0 0 1 11.1 4h1.8a1.6 1.6 0 0 1 1.6 1.6V7M7 7l.9 12.1A2 2 0 0 0 9.9 21h4.2a2 2 0 0 0 2-1.9L17 7"/><path d="M10.4 11v6M13.6 11v6"/></symbol><symbol id="i-search" viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5"/><path d="M15.8 15.8l4.7 4.7"/></symbol><symbol id="i-chevron-left" viewBox="0 0 24 24"><path d="M14.5 6l-6 6 6 6"/></symbol><symbol id="i-chevron-right" viewBox="0 0 24 24"><path d="M9.5 6l6 6-6 6"/></symbol><symbol id="i-more" viewBox="0 0 24 24"><circle cx="6" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="18" cy="12" r="1.4"/></symbol><symbol id="i-nib" viewBox="0 0 24 24"><path d="M12 3l5.5 8.5L12 21 6.5 11.5z"/><circle cx="12" cy="11.5" r="1.7"/></symbol><symbol id="i-brush" viewBox="0 0 24 24"><path d="M15.5 4.5l4 4L9.5 18.5H5.5v-4z"/><path d="M13.5 6.5l4 4"/></symbol></svg>`;

/** 幂等注入图标 sprite（已存在则跳过）；Node 环境下为 no-op */
export function ensureSprite() {
  if (typeof document === "undefined") return;
  if (document.getElementById("sprite")) return;
  const host = document.createElement("div");
  host.innerHTML = SPRITE_HTML;
  const svg = host.firstElementChild;
  if (svg) document.body.prepend(svg);
}

// 模块求值时即注入：这是浏览器端最早的时机（早于各页 init 与首帧），
// 保证 HTML 里静态的 <use href="#i-*"> 不会出现"图标晚一帧才出现"。
if (typeof document !== "undefined") ensureSprite();

/**
 * @param {string} tag
 * @param {Record<string, any>} [props]
 * @param {(string | Node)[]} [children]
 */
export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = String(value);
    else if (key === "html") node.innerHTML = String(value);
    else if (key === "text") node.textContent = String(value);
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === "value" && node instanceof HTMLInputElement) node.value = String(value);
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children) {
    if (child === null || child === undefined) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

/** 屏幕阅读器播报（题目变化/判分结果） */
export function announce(message) {
  let live = $("#aria-live");
  if (!live) {
    live = el("div", { id: "aria-live", class: "sr-only", "aria-live": "polite", "aria-atomic": "true" });
    document.body.append(live);
  }
  live.textContent = "";
  // 清空再写入，确保重复内容也会被播报
  window.setTimeout(() => {
    if (live) live.textContent = String(message ?? "");
  }, 30);
}

/* ============ 主题 ============ */

const THEME_KEY = "vocab:theme";
/** @typedef {"system" | "light" | "dark"} ThemeMode */

export const theme = {
  /** @returns {ThemeMode} */
  stored() {
    const raw = localStorage.getItem(THEME_KEY);
    return raw === "light" || raw === "dark" ? raw : "system";
  },
  /** @returns {"light" | "dark"} */
  resolved() {
    const mode = theme.stored();
    if (mode !== "system") return mode;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  },
  /** 应用到 <html>，同时更新浏览器地址栏配色 */
  apply() {
    const resolved = theme.resolved();
    document.documentElement.dataset.theme = resolved;
    const meta = $('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", resolved === "dark" ? "#101218" : "#f7f5f1");
    window.dispatchEvent(new CustomEvent("themechange", { detail: resolved }));
  },
  /** @param {ThemeMode} mode */
  set(mode) {
    if (mode === "system") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, mode);
    theme.apply();
  },
  /** 跟随系统变化 */
  watchSystem() {
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
      if (theme.stored() === "system") theme.apply();
    });
  },
};

/** 页面启动时调用：应用主题并监听系统切换 */
export function initTheme() {
  theme.apply();
  theme.watchSystem();
  // 另一个标签页改了主题：storage 事件实时跟随，无需刷新（同值写入过滤掉）。
  // 注意 theme.set("system") 是 removeItem：newValue=null 同样是真实变化，要应用。
  window.addEventListener("storage", (event) => {
    if (event.key === THEME_KEY && event.newValue !== event.oldValue) theme.apply();
  });
}

/**
 * 用户在设置里切主题：走一次 View Transitions 根快照交叉淡入。
 * 只对"可见视口"做一次快照，比给每个 surface 挂 color transition 便宜得多
 * （后者要逐个组件维护，且在低端机上每帧重绘背景）；首屏主题脚本只写初值、
 * 从不走这里，因此不会与"防闪白"逻辑打架。
 * 不支持 View Transitions 或用户要求减少动效时，退回瞬时切换（行为与旧版一致）。
 * @param {"system" | "light" | "dark"} mode
 */
export function setThemeAnimated(mode) {
  const apply = () => theme.set(mode);
  if (typeof document.startViewTransition !== "function" || prefersReducedMotion()) {
    apply();
    return;
  }
  try {
    // 快速连点会中断上一次过渡：finished 会 reject，静默即可（主题已按最后一次写入）
    document.startViewTransition(apply).finished.catch(() => {});
  } catch {
    apply();
  }
}

/* ============ 调色盘镜像（刷词页写，讲义页读；与 vocab:theme 同级的轻量通道） ============ */

const ACCENT_MIRROR_KEY = "vocab:accent";

export function appearanceMirrorRead() {
  try {
    const raw = localStorage.getItem(ACCENT_MIRROR_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed.name === "string" ? parsed : null;
  } catch {
    return null;
  }
}

export function appearanceMirrorWrite(state) {
  try {
    localStorage.setItem(ACCENT_MIRROR_KEY, JSON.stringify(state || null));
  } catch {}
}

/* ============ Toast ============ */

/** @type {HTMLElement | null} */
let toastHost = null;

function ensureToastHost() {
  if (!toastHost) {
    toastHost = el("div", { class: "toasts", role: "status", "aria-live": "polite" });
    document.body.append(toastHost);
  }
  return toastHost;
}

/**
 * @param {string} message
 * @param {{ type?: "ok" | "bad" | "info", action?: { label: string, onClick: () => void }, duration?: number }} [opts]
 */
export function toast(message, opts = {}) {
  const host = ensureToastHost();
  const node = el("div", { class: `toast ${opts.type === "ok" ? "ok" : opts.type === "bad" ? "bad" : ""}` }, []);
  node.append(el("span", { class: "grow", text: message }));
  let timer = 0;

  const remove = () => {
    window.clearTimeout(timer);
    node.classList.add("out");
    window.setTimeout(() => node.remove(), 200);
  };

  if (opts.action) {
    node.append(
      el("button", {
        type: "button",
        text: opts.action.label,
        onclick: () => {
          opts.action?.onClick();
          remove();
        },
      })
    );
  }
  host.append(node);
  timer = window.setTimeout(remove, opts.duration ?? (opts.action ? 6000 : 2600));
  return remove;
}

/* ============ 弹层基座（焦点陷阱 + Esc + 焦点还原 + 背景滚动锁定） ============ */

/** 同时只允许一个浮层锁背景：嵌套浮层（设置里打开登录）用计数防误提前解锁 */
let layerLockCount = 0;
/** 加锁前的 body 内联 padding（解锁时原样还回去） */
let lockedPadding = "";

function lockBodyScroll() {
  if (layerLockCount++ !== 0) return;
  // 桌面经典滚动条：overflow:hidden 会让滚动条消失、整页内容右移 ~15px。
  // 用等宽 padding-right 补回来（overlay 滚动条下 gap=0，天然无副作用）。
  const gap = window.innerWidth - document.documentElement.clientWidth;
  if (gap > 0) {
    lockedPadding = document.body.style.paddingRight;
    document.body.style.paddingRight = `${gap}px`;
  }
  document.body.style.overflow = "hidden";
}

function unlockBodyScroll() {
  if (--layerLockCount > 0) return;
  layerLockCount = 0;
  document.body.style.overflow = "";
  document.body.style.paddingRight = lockedPadding;
  lockedPadding = "";
}

/**
 * @param {{ mode?: "dialog" | "sheet", labelledBy?: string, onClose?: () => void }} opts
 */
function openLayer(opts) {
  const previous = /** @type {HTMLElement|null} */ (document.activeElement);
  const scrim = el("div", { class: `scrim${opts.mode === "sheet" ? " sheet-mode" : ""}` });
  const box = el("div", {
    class: opts.mode === "sheet" ? "sheet" : "dialog",
    role: "dialog",
    "aria-modal": "true",
    tabindex: "-1",
  });
  if (opts.labelledBy) box.setAttribute("aria-labelledby", opts.labelledBy);
  scrim.append(box);

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    document.removeEventListener("keydown", onKey, true);
    scrim.remove();
    unlockBodyScroll();
    if (previous && typeof previous.focus === "function" && document.contains(previous)) previous.focus();
    opts.onClose?.();
  };

  /** @param {KeyboardEvent} e */
  function onKey(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    if (e.key !== "Tab") return;
    const focusables = /** @type {HTMLElement[]} */ (
      $$('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])', box)
    ).filter((node) => node.offsetParent !== null || node === box);
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  scrim.addEventListener("click", (e) => {
    if (e.target === scrim) close();
  });
  document.addEventListener("keydown", onKey, true);
  lockBodyScroll();
  document.body.append(scrim);

  // 延迟到触发时刻再解析聚焦目标：openSheet/openConfirm 都是先建层、后往 box 里塞内容，
  // 若在调用瞬间解析，拿到的是空盒——data-autofocus 因此从未生效过（第六期线上审查抓出）
  window.setTimeout(() => {
    if (closed) return;
    const focusTarget = $("[data-autofocus]", box) ?? $("input,textarea,select,button", box) ?? box;
    focusTarget.focus?.();
  }, 30);

  return { root: scrim, box, close };
}

/**
 * 打开一个抽屉/弹窗，body 由调用方填充
 * @param {{ title?: string, mode?: "dialog" | "sheet", onClose?: () => void }} [opts]
 */
export function openSheet(opts = {}) {
  const mode = opts.mode ?? "sheet";
  const layer = openLayer({ mode, onClose: opts.onClose });
  if (opts.title) {
    const head = el("div", { class: "sheet-head" }, [
      el("h2", { id: "sheet-title", text: opts.title }),
      el("button", {
        class: "btn btn-icon btn-ghost",
        type: "button",
        "aria-label": "关闭",
        title: "关闭",
        text: "✕",
        onclick: () => layer.close(),
      }),
    ]);
    layer.box.setAttribute("aria-labelledby", "sheet-title");
    layer.box.append(head);
  }
  const body = el("div", { class: "sheet-body" });
  layer.box.append(body);
  return { root: layer.root, box: layer.box, body, close: layer.close };
}

/* ============ 确认框 ============ */

/**
 * @param {{ title: string, message?: string, confirmText?: string, cancelText?: string, danger?: boolean }} opts
 * @returns {Promise<boolean>}
 */
export function confirmDialog(opts) {
  return new Promise((resolve) => {
    let settled = false;
    const layer = openLayer({
      mode: "dialog",
      onClose: () => {
        if (!settled) {
          settled = true;
          resolve(false);
        }
      },
    });
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
      layer.close();
    };
    layer.box.append(
      el("h2", { id: "confirm-title", text: opts.title }),
      opts.message ? el("p", { text: opts.message }) : el("span"),
      el("div", { class: "dialog-actions" }, [
        el("button", {
          class: "btn",
          type: "button",
          text: opts.cancelText ?? "取消",
          onclick: () => finish(false),
        }),
        el("button", {
          class: `btn ${opts.danger ? "btn-danger" : "btn-primary"}`,
          type: "button",
          "data-autofocus": "true",
          text: opts.confirmText ?? "确定",
          onclick: () => finish(true),
        }),
      ])
    );
    layer.box.setAttribute("aria-labelledby", "confirm-title");
  });
}

/**
 * 带输入框的对话框（替代 window.prompt）
 * @param {{ title: string, label?: string, value?: string, type?: string, min?: number, max?: number, hint?: string, placeholder?: string }} opts
 * @returns {Promise<string | null>}
 */
export function promptDialog(opts) {
  return new Promise((resolve) => {
    let settled = false;
    const layer = openLayer({
      mode: "dialog",
      onClose: () => {
        if (!settled) {
          settled = true;
          resolve(null);
        }
      },
    });
    const input = el("input", {
      class: "input",
      type: opts.type ?? "text",
      value: opts.value ?? "",
      placeholder: opts.placeholder ?? "",
      min: opts.min,
      max: opts.max,
      "data-autofocus": "true",
    });
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
      layer.close();
    };
    const submit = () => finish(input.value);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        submit();
      }
    });
    layer.box.append(
      el("h2", { id: "prompt-title", text: opts.title }),
      el("div", { class: "field" }, [
        opts.label ? el("label", { for: "prompt-input", text: opts.label }) : el("span"),
        input,
        opts.hint ? el("span", { class: "hint", text: opts.hint }) : el("span"),
      ]),
      el("div", { class: "dialog-actions" }, [
        el("button", { class: "btn", type: "button", text: "取消", onclick: () => finish(null) }),
        el("button", { class: "btn btn-primary", type: "button", text: "确定", onclick: submit }),
      ])
    );
    input.id = "prompt-input";
    layer.box.setAttribute("aria-labelledby", "prompt-title");
  });
}

/* ============ 其他 ============ */

export const prefersReducedMotion = () =>
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** 短暂高亮某个元素（用于"跳到这个词"） */
export function flash(node, className = "flash") {
  if (!node) return;
  node.classList.add(className);
  window.setTimeout(() => node.classList.remove(className), 900);
}

/** 把秒数格式化成 mm:ss */
export function formatClock(seconds) {
  const s = Math.max(0, Math.ceil(seconds));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/* ============ 账号（两页共享：刷词页学习面板 / 讲义页设置抽屉） ============ */

/**
 * 登录 / 注册抽屉。两页共用一份表单；提交后以 Auth.revision() 做会话守卫，
 * 账号在请求期间切换则静默放弃本次结果。
 * @param {{ Auth: any, mode?: "login" | "register" }} opts
 */
export function openAuthSheet({ Auth, mode = "login" }) {
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
    // 不设 novalidate：required / minlength / type=email 的原生校验生效（此前写成
    // novalidate:"false"，布尔属性只要存在就生效，等于把原生校验全关了）。
    const form = el("form", { class: "stack-3" });
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
    const revisionAtSubmit = Auth.revision();
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
      // 登录/注册成功本身会推进 Auth.revision——这不是"会话被别人换掉"，
      // 弹层必须照常关闭；只有请求期间账号被其它标签页换掉（moved 且失败/无结果）才静默收场。
      const moved = Auth.revision() !== revisionAtSubmit;
      if (!moved) {
        submitBtn.disabled = false;
        submitBtn.textContent = which === "login" ? "登录" : "注册并登录";
        if (!res.ok) {
          error.textContent = res.msg || "操作失败";
          return;
        }
      }
      sheet.close();
      if (!moved && res.ok) toast("登录成功，正在合并云端进度…", { type: "ok" });
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

/** 修改密码抽屉（两页共用）。 @param {{ Auth: any }} opts */
export function openPasswordSheet({ Auth }) {
  const sheet = openSheet({ title: "修改密码" });
  const current = el("input", { class: "input", type: "password", autocomplete: "current-password" });
  const next = el("input", { class: "input", type: "password", autocomplete: "new-password", minlength: "8" });
  const error = el("p", { class: "small", style: "color:var(--bad);min-height:1.2em" });
  const form = el("form", { class: "stack-3" });
  const revisionAtSubmit = Auth.revision();
  form.append(
    el("div", { class: "field" }, [el("label", { text: "当前密码" }), current]),
    el("div", { class: "field" }, [el("label", { text: "新密码" }), next, el("span", { class: "hint", text: "至少 8 位；修改后其它设备需重新登录" })]),
    error,
    el("button", { class: "btn btn-primary btn-block", type: "submit", text: "确认修改" })
  );
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const res = await Auth.changePassword(current.value, next.value);
    const moved = Auth.revision() !== revisionAtSubmit;
    if (!moved) {
      if (!res.ok) {
        error.textContent = res.msg || "修改失败";
        return;
      }
      sheet.close();
      toast("密码已修改，其它设备的登录已失效", { type: "ok" });
    } else {
      // 改密码成功会吊销会话并推进 revision：弹层照样关，不显示成功提示
      sheet.close();
    }
  });
  sheet.body.append(form);
}

/**
 * 「账号与同步」设置区块（两页共用）。
 * @param {{ Auth: any, onAction?: (type: "auth" | "password" | "refresh" | "changed") => void }} opts
 *   onAction: auth=请求打开登录/注册抽屉；password=请求打开改密码抽屉；
 *             refresh=昵称已更新（调用方重建面板）；changed=登录态已变化（调用方收尾）。
 */
export function buildAccountSection({ Auth, onAction = () => {} }) {
  const emit = (type) => {
    try {
      onAction(type);
    } catch {
      /* 调用方回调异常不影响账号操作本身 */
    }
  };
  const group = el("div", { class: "settings-group" }, [el("h3", { text: "账号与同步" })]);
  if (Auth.isLoggedIn()) {
    group.append(
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
              const revisionAtSubmit = Auth.revision();
              const res = await Auth.updateNickname(value.trim());
              if (Auth.revision() !== revisionAtSubmit) return;
              toast(res.ok ? "昵称已更新" : res.msg || "修改失败", { type: res.ok ? "ok" : "bad" });
              if (res.ok) emit("refresh");
            },
          }),
          el("button", { class: "btn btn-sm", type: "button", text: "改密码", onclick: () => emit("password") }),
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
              const result = await Auth.logout();
              if (result?.error === "auth_changed") {
                toast("登录状态已变化，未执行退出", { type: "info" });
                return;
              }
              emit("changed");
              toast("已退出登录", { type: "ok" });
            },
          }),
        ]),
      ]),
    );
  } else {
    group.append(
      el("p", { class: "small muted", text: "登录后进度、错题本、讲义备注与配图会在多台设备间自动同步。" }),
      el("div", { class: "dialog-actions", style: "justify-content:flex-start" }, [
        el("button", { class: "btn btn-primary", type: "button", text: "登录 / 注册", onclick: () => emit("auth") }),
      ])
    );
  }
  return group;
}
