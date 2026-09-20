// 一次性补丁：重写 check.mjs 的 pick 函数为纯字符串扫描（用后即删）
import { readFileSync, writeFileSync } from "node:fs";

const file = "scripts/check.mjs";
let s = readFileSync(file, "utf8");
const nl = s.includes("\r\n") ? "\r\n" : "\n";

const start = s.indexOf("  const pick = (selector, prop) => {");
if (start < 0) {
  console.error("pick start missing");
  process.exit(1);
}
// pick 块的结束：起始后第一个 "  };" 行
const endMarker = "  };";
const end = s.indexOf(endMarker, start);
if (end < 0) {
  console.error("pick end missing");
  process.exit(1);
}

const clean = [
  "  const pick = (selector, prop) => {",
  "    const idx = tokens.indexOf(selector);",
  "    if (idx < 0) return null;",
  "    const block = tokens.slice(idx, tokens.indexOf(\"}\", idx));",
  "    const line = block.split(/\\r?\\n/).find((l) => l.includes(prop + \":\"));",
  "    return line ? line.split(\":\").slice(1).join(\":\").trim().replace(/;$/, \"\") : null;",
  "  };",
].join(nl);

s = s.slice(0, start) + clean + s.slice(end + endMarker.length + nl.length);
writeFileSync(file, s);
console.log("pick rewritten");
