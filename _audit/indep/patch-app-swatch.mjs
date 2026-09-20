// 一次性补丁：app.js 接入调色盘（导入/色卡组件/外观组/应用逻辑/动态 favicon）（用后即删）
import { readFileSync, writeFileSync } from "node:fs";

const file = "public/app.js";
let s = readFileSync(file, "utf8");
const nl = s.includes("\r\n") ? "\r\n" : "\n";
const j = (a) => a.join(nl);

/* 1) 导入 */
const coreImportAnchor = j(["  normalizeSettings,", "  shuffle,"]);
if (!s.includes(coreImportAnchor)) {
  console.error("core import anchor missing");
  process.exit(1);
}
s = s.replace(
  coreImportAnchor,
  j(["  normalizeSettings,", "  ACCENTS,", "  ACCENT_HEX,", "  applyAccent,", "  shuffle,"])
);
const uiImportAnchor = j(["  flash,", "  formatClock,", "} from \"./ui.js\";"]);
if (!s.includes(uiImportAnchor)) {
  console.error("ui import anchor missing");
  process.exit(1);
}
s = s.replace(
  uiImportAnchor,
  j(["  flash,", "  formatClock,", "  appearanceMirrorWrite,", "} from \"./ui.js\";"])
);

/* 2) 应用逻辑 + 色卡组件（插在 buildSeg 之前） */
const segAnchor = j(["function buildSeg(options, value, onChange, name) {"]);
if (!s.includes(segAnchor)) {
  console.error("buildSeg anchor missing");
  process.exit(1);
}
const swatchBlock = j([
  "/* ============ 主题调色盘 ============ */",
  "",
  "const SWATCH_NAMES = { sky: \"天蓝\", violet: \"紫罗兰\", emerald: \"翡翠\", rose: \"玫瑰\", amber: \"琥珀\", slate: \"石板\", custom: \"自定义\" };",
  "",
  "let lastAccentKey = \"\";",
  "",
  "/** 把当前 settings 的主题色落到 <html> + 镜像 + 动态 favicon（同状态幂等） */",
  "function applyAccentSettings() {",
  "  const name = String(state.settings.accent || \"sky\");",
  "  const color = String(state.settings.accentCustom || \"\");",
  "  const key = `${name}|${color}`;",
  "  if (key === lastAccentKey) return;",
  "  lastAccentKey = key;",
  "  applyAccent(name, color);",
  "  appearanceMirrorWrite({ name, color: name === \"custom\" ? color : \"\" });",
  "  applyFavicon(name === \"custom\" ? color : ACCENT_HEX[name] || \"#0ea5e9\");",
  "}",
  "",
  "/** 动态 favicon：用当前主题色画一枚渐变 L 标（浏览器标签页跟着换色） */",
  "function applyFavicon(hex) {",
  "  try {",
  "    const canvas = document.createElement(\"canvas\");",
  "    canvas.width = 64;",
  "    canvas.height = 64;",
  "    const ctx = canvas.getContext(\"2d\");",
  "    if (!ctx) return;",
  "    const grad = ctx.createLinearGradient(0, 0, 64, 64);",
  "    grad.addColorStop(0, mixToward(hex, [255, 255, 255], 0.25));",
  "    grad.addColorStop(1, mixToward(hex, [0, 0, 0], 0.3));",
  "    ctx.fillStyle = grad;",
  "    if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(0, 0, 64, 64, 16); ctx.fill(); }",
  "    else ctx.fillRect(0, 0, 64, 64);",
  "    ctx.strokeStyle = \"#fff\";",
  "    ctx.lineWidth = 7;",
  "    ctx.lineCap = \"round\";",
  "    ctx.beginPath();",
  "    ctx.moveTo(22, 16);",
  "    ctx.lineTo(22, 46);",
  "    ctx.lineTo(44, 46);",
  "    ctx.stroke();",
  "    let link = document.querySelector('link[rel=\"icon\"]');",
  "    if (!link) {",
  "      link = document.createElement(\"link\");",
  "      link.rel = \"icon\";",
  "      document.head.append(link);",
  "    }",
  "    link.href = canvas.toDataURL(\"image/png\");",
  "  } catch {}",
  "  function mixToward(h, target, t) {",
  "    const n = parseInt(String(h || \"#0ea5e9\").slice(1), 16);",
  "    const r = Math.round((((n >> 16) & 255) + (target[0] - ((n >> 16) & 255)) * t));",
  "    const g = Math.round((((n >> 8) & 255) + (target[1] - ((n >> 8) & 255)) * t));",
  "    const b = Math.round(((n & 255) + (target[2] - (n & 255)) * t));",
  "    const to2 = (x) => x.toString(16).padStart(2, \"0\");",
  "    return `#${to2(r)}${to2(g)}${to2(b)}`;",
  "  }",
  "}",
  "",
  "/**",
  " * 主题色色卡（六预设 + 自定义取色）。",
  " * @param {string} value 当前盘名",
  " * @param {string} customHex 自定义色（value === \"custom\" 时有效）",
  " * @param {(name: string, color: string) => void} onChange",
  " */",
  "function buildSwatches(value, customHex, onChange) {",
  "  const host = el(\"div\", { class: \"swatches\", role: \"radiogroup\", \"aria-label\": \"主题色\" });",
  "  const repaint = () => {",
  "    for (const btn of host.querySelectorAll(\".swatch\")) {",
  "      const isCustom = btn.dataset.palette === \"custom\";",
  "      btn.setAttribute(\"aria-pressed\", String(state.settings.accent === btn.dataset.palette || (state.settings.accent === \"custom\" && isCustom)));",
  "    }",
  "  };",
  "  for (const name of ACCENTS) {",
  "    if (name === \"custom\") continue;",
  "    host.append(",
  "      el(\"button\", {",
  "        class: \"swatch\",",
  "        type: \"button\",",
  "        role: \"radio\",",
  "        \"aria-pressed\": String(value === name),",
  "        \"aria-label\": SWATCH_NAMES[name],",
  "        title: SWATCH_NAMES[name],",
  "        dataset: { palette: name },",
  "        onclick: () => {",
  "          state.settings.accent = name;",
  "          state.settings.accentCustom = \"\";",
  "          markSettingsDirty();",
  "          applyAccentSettings();",
  "          repaint();",
  "        },",
  "      })",
  "    );",
  "  }",
  "  const colorInput = el(\"input\", { type: \"color\", value: /^#[0-9a-fA-F]{6}$/.test(customHex || \"\") ? customHex : \"#0ea5e9\", \"aria-label\": \"自定义主题色\" });",
  "  colorInput.addEventListener(\"input\", () => {",
  "    state.settings.accent = \"custom\";",
  "    state.settings.accentCustom = colorInput.value;",
  "    markSettingsDirty();",
  "    applyAccentSettings();",
  "    repaint();",
  "  });",
  "  host.append(",
  "    el(\"label\", {",
  "      class: \"swatch swatch-custom\",",
  "      role: \"radio\",",
  "      \"aria-pressed\": String(value === \"custom\"),",
  "      \"aria-label\": \"自定义主题色\",",
  "      title: \"自定义色（点右侧圆点取色）\",",
  "      dataset: { palette: \"custom\" },",
  "    }, [colorInput])",
  "  );",
  "  return host;",
  "}",
  "",
  segAnchor,
]);

s = s.replace(segAnchor, swatchBlock);

/* 3) 外观组插入主题色行 */
const appearanceAnchor = j([
  "  /* 外观 */",
  "  const themeGroup = el(\"div\", { class: \"settings-group\" }, [",
  "    el(\"h3\", { text: \"外观\" }),",
  "    el(\"div\", { class: \"setting-row\" }, [",
  "      el(\"div\", { class: \"label\" }, [el(\"b\", { text: \"主题\" }), el(\"small\", { text: \"跟随系统 / 浅色 / 深色\" })]),",
  "      buildSeg(",
  "        [",
  "          [\"system\", \"跟随系统\"],",
  "          [\"light\", \"浅色\"],",
  "          [\"dark\", \"深色\"],",
  "        ],",
  "        theme.stored(),",
  "        (value) => theme.set(/** @type {any} */ (value))",
  "      ),",
  "    ]),",
  "  ]);",
]);
if (!s.includes(appearanceAnchor)) {
  console.error("appearance anchor missing");
  process.exit(1);
}
s = s.replace(
  appearanceAnchor,
  j([
    "  /* 外观 */",
    "  const themeGroup = el(\"div\", { class: \"settings-group\" }, [",
    "    el(\"h3\", { text: \"外观\" }),",
    "    el(\"div\", { class: \"setting-row\" }, [",
    "      el(\"div\", { class: \"label\" }, [el(\"b\", { text: \"主题色\" }), el(\"small\", { text: \"六款精选渐变，或自定义取色\" })]),",
    "      buildSwatches(state.settings.accent, state.settings.accentCustom, (name, color) => {",
    "        state.settings.accent = /** @type {any} */ (name);",
    "        state.settings.accentCustom = color;",
    "        markSettingsDirty();",
    "        applyAccentSettings();",
    "      }),",
    "    ]),",
    "    el(\"div\", { class: \"setting-row\" }, [",
    "      el(\"div\", { class: \"label\" }, [el(\"b\", { text: \"主题\" }), el(\"small\", { text: \"跟随系统 / 浅色 / 深色\" })]),",
    "      buildSeg(",
    "        [",
    "          [\"system\", \"跟随系统\"],",
    "          [\"light\", \"浅色\"],",
    "          [\"dark\", \"深色\"],",
    "        ],",
    "        theme.stored(),",
    "        (value) => theme.set(/** @type {any} */ (value))",
    "      ),",
    "    ]),",
    "  ]);",
  ])
);

/* 4) render() 顶部调用（云端拉取/本地加载后都会走 render） */
const renderAnchor = j(["  // 练习方式 + 出题方式分段控件", "  const practice = practiceMode();", "  syncPracticeSeg();"]);
if (!s.includes(renderAnchor)) {
  console.error("render anchor missing");
  process.exit(1);
}
s = s.replace(renderAnchor, j(["  // 主题调色盘（幂等：状态未变时是空操作）", "  applyAccentSettings();", "", renderAnchor]));

writeFileSync(file, s);
console.log("app.js palette wiring done");
