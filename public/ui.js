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
    if (meta) meta.setAttribute("content", resolved === "dark" ? "#12141c" : "#f6f2ea");
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

/* ============ 弹层基座（焦点陷阱 + Esc + 焦点还原） ============ */

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
  document.body.append(scrim);

  const focusTarget = $("[data-autofocus]", box) ?? $("input,textarea,select,button", box) ?? box;
  window.setTimeout(() => /** @type {HTMLElement} */ (focusTarget).focus?.(), 30);

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
