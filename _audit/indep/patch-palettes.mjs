// 一次性补丁：向 tokens.css 追加六调色盘 data-accent 块（用后即删）
import { readFileSync, writeFileSync } from "node:fs";

const file = "public/tokens.css";
let s = readFileSync(file, "utf8");
const nl = s.includes("\r\n") ? "\r\n" : "\n";
const j = (a) => a.join(nl);

const anchor = j(["/* 减少动效：同时清掉 delay，避免\"元素一直不可见\" */"]);
if (!s.includes(anchor)) {
  console.error("anchor missing");
  process.exit(1);
}

const palette = (name, cn, L, D) =>
  j([
    `/* ---------- ${name} ${cn} ---------- */`,
    `[data-accent="${name}"] {`,
    `  --accent: ${L.accent};`,
    `  --accent-strong: ${L.strong};`,
    `  --accent-ink: ${L.ink};`,
    `  --accent-soft: ${L.soft};`,
    `  --accent-faint: ${L.faint};`,
    `  --accent-grad: ${L.grad};`,
    `  --bg-glow-1: ${L.glow1};`,
    `  --bg-glow-2: ${L.glow2};`,
    `  --glow: ${L.shadow};`,
    `}`,
    ``,
    `[data-accent="${name}"][data-theme="dark"] {`,
    `  --accent: ${D.accent};`,
    `  --accent-strong: ${D.strong};`,
    `  --accent-ink: ${D.ink};`,
    `  --accent-soft: ${D.soft};`,
    `  --accent-faint: ${D.faint};`,
    `  --accent-grad: ${D.grad};`,
    `  --bg-glow-1: ${D.glow1};`,
    `  --bg-glow-2: ${D.glow2};`,
    `  --glow: ${D.shadow};`,
    `}`,
    ``,
  ]);

const sky = palette(
  "sky",
  "天蓝（默认盘，显式声明以便切回）",
  {
    accent: "#0284c7",
    strong: "#0369a1",
    ink: "#ffffff",
    soft: "rgba(2, 132, 199, 0.14)",
    faint: "rgba(2, 132, 199, 0.06)",
    grad: "linear-gradient(135deg, #0ea5e9 0%, #0284c7 55%, #1d4ed8 100%)",
    glow1: "rgba(14, 165, 233, 0.18)",
    glow2: "rgba(34, 211, 238, 0.10)",
    shadow: "0 6px 20px rgba(14, 165, 233, 0.32)",
  },
  {
    accent: "#38bdf8",
    strong: "#7dd3fc",
    ink: "#062033",
    soft: "rgba(56, 189, 248, 0.20)",
    faint: "rgba(56, 189, 248, 0.09)",
    grad: "linear-gradient(135deg, #7dd3fc 0%, #38bdf8 55%, #0ea5e9 100%)",
    glow1: "rgba(56, 189, 248, 0.22)",
    glow2: "rgba(34, 211, 238, 0.10)",
    shadow: "0 6px 20px rgba(56, 189, 248, 0.45)",
  }
);

const violet = palette(
  "violet",
  "紫罗兰（经典）",
  {
    accent: "#7c5cfc",
    strong: "#6a48e8",
    ink: "#ffffff",
    soft: "rgba(124, 92, 252, 0.14)",
    faint: "rgba(124, 92, 252, 0.06)",
    grad: "linear-gradient(135deg, #8b5cf6 0%, #7c5cfc 55%, #d946ef 100%)",
    glow1: "rgba(124, 92, 252, 0.18)",
    glow2: "rgba(232, 121, 249, 0.10)",
    shadow: "0 6px 20px rgba(124, 92, 252, 0.32)",
  },
  {
    accent: "#9b85ff",
    strong: "#b3a2ff",
    ink: "#120c2b",
    soft: "rgba(155, 133, 255, 0.20)",
    faint: "rgba(155, 133, 255, 0.09)",
    grad: "linear-gradient(135deg, #b3a2ff 0%, #9b85ff 55%, #c084fc 100%)",
    glow1: "rgba(155, 133, 255, 0.22)",
    glow2: "rgba(232, 121, 249, 0.10)",
    shadow: "0 6px 20px rgba(155, 133, 255, 0.45)",
  }
);

const emerald = palette(
  "emerald",
  "翡翠",
  {
    accent: "#059669",
    strong: "#047857",
    ink: "#ffffff",
    soft: "rgba(5, 150, 105, 0.14)",
    faint: "rgba(5, 150, 105, 0.06)",
    grad: "linear-gradient(135deg, #10b981 0%, #059669 55%, #0d9488 100%)",
    glow1: "rgba(16, 185, 129, 0.16)",
    glow2: "rgba(45, 212, 191, 0.10)",
    shadow: "0 6px 20px rgba(16, 185, 129, 0.30)",
  },
  {
    accent: "#34d399",
    strong: "#6ee7b7",
    ink: "#022c22",
    soft: "rgba(52, 211, 153, 0.20)",
    faint: "rgba(52, 211, 153, 0.09)",
    grad: "linear-gradient(135deg, #6ee7b7 0%, #34d399 55%, #14b8a6 100%)",
    glow1: "rgba(52, 211, 153, 0.20)",
    glow2: "rgba(45, 212, 191, 0.10)",
    shadow: "0 6px 20px rgba(52, 211, 153, 0.40)",
  }
);

const rose = palette(
  "rose",
  "玫瑰",
  {
    accent: "#e11d48",
    strong: "#be123c",
    ink: "#ffffff",
    soft: "rgba(225, 29, 72, 0.14)",
    faint: "rgba(225, 29, 72, 0.06)",
    grad: "linear-gradient(135deg, #fb7185 0%, #e11d48 55%, #be185d 100%)",
    glow1: "rgba(244, 63, 94, 0.14)",
    glow2: "rgba(251, 113, 133, 0.08)",
    shadow: "0 6px 20px rgba(244, 63, 94, 0.30)",
  },
  {
    accent: "#fb7185",
    strong: "#fda4af",
    ink: "#2b0a12",
    soft: "rgba(251, 113, 133, 0.20)",
    faint: "rgba(251, 113, 133, 0.09)",
    grad: "linear-gradient(135deg, #fda4af 0%, #fb7185 55%, #f43f5e 100%)",
    glow1: "rgba(251, 113, 133, 0.18)",
    glow2: "rgba(251, 113, 133, 0.08)",
    shadow: "0 6px 20px rgba(251, 113, 133, 0.40)",
  }
);

const amber = palette(
  "amber",
  "琥珀",
  {
    accent: "#d97706",
    strong: "#b45309",
    ink: "#ffffff",
    soft: "rgba(217, 119, 6, 0.14)",
    faint: "rgba(217, 119, 6, 0.06)",
    grad: "linear-gradient(135deg, #f59e0b 0%, #d97706 55%, #ea580c 100%)",
    glow1: "rgba(245, 158, 11, 0.16)",
    glow2: "rgba(251, 191, 36, 0.10)",
    shadow: "0 6px 20px rgba(245, 158, 11, 0.30)",
  },
  {
    accent: "#fbbf24",
    strong: "#fcd34d",
    ink: "#291500",
    soft: "rgba(251, 191, 36, 0.20)",
    faint: "rgba(251, 191, 36, 0.09)",
    grad: "linear-gradient(135deg, #fcd34d 0%, #fbbf24 55%, #f59e0b 100%)",
    glow1: "rgba(251, 191, 36, 0.18)",
    glow2: "rgba(251, 191, 36, 0.10)",
    shadow: "0 6px 20px rgba(251, 191, 36, 0.38)",
  }
);

const slate = palette(
  "slate",
  "石板（极简）",
  {
    accent: "#475569",
    strong: "#334155",
    ink: "#ffffff",
    soft: "rgba(71, 85, 105, 0.14)",
    faint: "rgba(71, 85, 105, 0.06)",
    grad: "linear-gradient(135deg, #64748b 0%, #475569 55%, #334155 100%)",
    glow1: "rgba(100, 116, 139, 0.14)",
    glow2: "rgba(148, 163, 184, 0.08)",
    shadow: "0 6px 20px rgba(71, 85, 105, 0.28)",
  },
  {
    accent: "#94a3b8",
    strong: "#cbd5e1",
    ink: "#0f172a",
    soft: "rgba(148, 163, 184, 0.20)",
    faint: "rgba(148, 163, 184, 0.09)",
    grad: "linear-gradient(135deg, #cbd5e1 0%, #94a3b8 55%, #64748b 100%)",
    glow1: "rgba(148, 163, 184, 0.16)",
    glow2: "rgba(148, 163, 184, 0.08)",
    shadow: "0 6px 20px rgba(148, 163, 184, 0.35)",
  }
);

const header = j([
  "/* ============================================================",
  "   调色盘：data-accent 属性选择（第四期）。",
  "   每盘两主题各 9 个变量；未设属性时回落到上面的 sky 默认值。",
  "   色值与 docs/主题调色盘与界面优化计划.md §2.2 一致，对比度由 npm run check 把关。",
  "   ============================================================ */",
  "",
]);

s = s.replace(anchor, header + sky + nl + violet + nl + emerald + nl + rose + nl + amber + nl + slate + nl + anchor);
writeFileSync(file, s);

const open = (s.match(/{/g) || []).length;
const close = (s.match(/}/g) || []).length;
console.log(`palette blocks added, braces ${open}/${close} ${open === close ? "OK" : "MISMATCH"}`);
