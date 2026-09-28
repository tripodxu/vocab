// _audit/indep/lib.mjs —— 独立审计共享库（只读项目文件，输出仅写 _audit/indep/out/）
//
// ⚠️ 2026-09-28 重构：共用工具（loadAll / buildTokenIndex / resolveWhy / 相似度 / 模板匹配…）
//    已上移到生产侧的 `scripts/quiz-data.mjs`，本文件只做**转发** + 保留审计专用的输出函数。
//    原因：此前 4 个生产脚本反向 import 了 `_audit/`（一个被标注"禁止运行"的目录），依赖方向是错的。
//    现在方向固定为：scripts/**（生产） ← _audit/**（审计/证据），生产脚本不再依赖本文件。
//
// 归一化口径与 docs/选择题资料生成规范.md 附录 B、scripts/quiz-lib.mjs 保持一致（单一实现，不复制）。
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export {
  normalize,
  senseCover,
  WHY_BLACKLIST,
  bigrams,
  jaccard,
  minOverlap,
  senses,
  loadAll,
  rootTokens,
  buildTokenIndex,
  resolveWhy,
  iterDistractors,
  TEMPLATES,
  matchTemplate,
} from "../../scripts/quiz-data.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const OUT = path.join(ROOT, "_audit", "indep", "out");
export const TODAY = new Date().toISOString().slice(0, 10);

export async function ensureOut() {
  await mkdir(OUT, { recursive: true });
}

export async function writeOut(name, content) {
  await mkdir(OUT, { recursive: true });
  const p = path.join(OUT, name);
  await (await import("node:fs/promises")).writeFile(p, content, "utf8");
  return p;
}

export const pct = (n, d) => (d ? ((n / d) * 100).toFixed(1) : "0.0");
