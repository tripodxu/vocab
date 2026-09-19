/**
 * quiz.mjs —— 认词题源（选择题资料）的工具链
 *
 *   node scripts/quiz.mjs prompt <章号> [--offset N] [--limit N] [--out 文件]
 *       生成"喂给模型"的完整提示词（规范 + 本批词表），可直接贴给任意模型
 *   node scripts/quiz.mjs check [--chapter N] [--json]
 *       校验 public/quiz-N.json，并重建 public/quiz-index.json
 *   node scripts/quiz.mjs merge <文件...> [--chapter N] [--dry-run]
 *       把模型产出的分片合并进 public/quiz-N.json（先校验，再写入）
 *   node scripts/quiz.mjs index
 *       只重建 public/quiz-index.json
 *
 * 设计原则：**题源缺失/出错都不能让练习功能不可用** ——
 * 校验失败只会把这一章从清单里剔除（前端于是退回"同章自动生成干扰项"），
 * 而不是让页面报错。
 */
import { readFile, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  QUIZ_SPEC_VERSION,
  DISTRACTOR_COUNT,
  QUIZ_KINDS,
  QUIZ_KIND_LABEL,
  buildQuizIndex,
  emptyQuizDoc,
  extractModelPrompt,
  PROMPT_MARKERS,
  PROMPT_REV_MARKERS,
  mergeQuizDocs,
  normalizeQuizDoc,
  parseJsonLoose,
  quizIndexPath,
  quizPath,
  validateQuizDoc,
} from "./quiz-lib.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const publicDir = path.join(root, "public");
const SPEC_DOC = path.join(root, "docs", "选择题资料生成规范.md");

const args = process.argv.slice(2);
const command = args[0] || "check";
const flag = (name, fallback = null) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? (args[at + 1] && !args[at + 1].startsWith("--") ? args[at + 1] : true) : fallback;
};
const has = (name) => args.includes(`--${name}`);
/** 需要跟一个值的开关（解析位置参数时要跳过它们的值） */
const VALUE_FLAGS = new Set(["offset", "limit", "out", "chapter"]);
const positional = [];
for (let i = 1; i < args.length; i++) {
  const arg = args[i];
  if (arg.startsWith("--")) {
    if (VALUE_FLAGS.has(arg.slice(2)) && args[i + 1] && !args[i + 1].startsWith("--")) i++;
    continue;
  }
  positional.push(arg);
}

const num = (value, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
const readJson = async (file) => parseJsonLoose(await readFile(file, "utf8"));

/** 所有章节号（以 data-N.json 为准） */
async function chapterIds() {
  const files = await readdir(publicDir);
  return files
    .filter((f) => /^data-\d+\.json$/.test(f))
    .map((f) => Number(f.match(/\d+/)[0]))
    .sort((a, b) => a - b);
}

async function loadWords(chapter) {
  return readJson(path.join(publicDir, `data-${chapter}.json`));
}

/* ============ prompt ============ */

async function cmdPrompt() {
  const chapter = num(positional[0], 0);
  if (!chapter) {
    console.error("用法：node scripts/quiz.mjs prompt <章号> [--offset N] [--limit N] [--out 文件]");
    process.exit(2);
  }
  if (!existsSync(SPEC_DOC)) {
    console.error(`缺少生成规范：${path.relative(root, SPEC_DOC)}`);
    process.exit(2);
  }
  const rev = args.includes("--rev");
  const spec = await readFile(SPEC_DOC, "utf8");
  const task = extractModelPrompt(spec, rev ? PROMPT_REV_MARKERS : PROMPT_MARKERS);
  if (!task) {
    console.error(rev ? "生成规范里找不到 MODEL-PROMPT-REV 区段" : "生成规范里找不到 MODEL-PROMPT 区段（<!-- MODEL-PROMPT:START --> ... END）");
    process.exit(2);
  }
  const words = await loadWords(chapter);
  const offset = Math.max(0, num(flag("offset"), 0));
  const limit = Math.max(0, num(flag("limit"), 0));
  const slice = limit ? words.slice(offset, offset + limit) : words.slice(offset);
  const rows = slice.map((w) => ({
    id: Number(w.id),
    word: w.word,
    pos: w.pos,
    meaningCN: w.meaningCN,
    root: w.root || "",
  }));

  const out = `${task}

---

## 本批词表（第 ${chapter} 章，共 ${slice.length} 个词${limit ? `，第 ${offset + 1}~${offset + slice.length} 条` : ""}）

**只处理下面这些 id**；输出文件名建议 \`quiz-${chapter}-${offset + 1}-${offset + slice.length}.json\`。

\`\`\`json
${JSON.stringify(rows, null, 1)}
\`\`\`

---

## 交付前自查（逐条打勾，别跳）

1. 每个 id 都出现在输出里，且 id 与词表完全一致（不要自己编号、不要漏）。
2. 每个词恰好 ${DISTRACTOR_COUNT} 个干扰项；每个干扰项都有 text / kind / why。
3. 每题至少有 1 个 ${QUIZ_KINDS.filter((k) => k !== "topic" && k !== "pos").join(" / ")} 类干扰项；topic 最多 2 个。
4. 没有任何干扰项的释义与正确释义重复、包含或"也说得通"。
5. 每条 why 都点名了区分点（词根/词性/搭配/程度），不是"意思不同""另一个词"这种废话。
6. 输出是**纯 JSON**（可以和上面的骨架不同，但必须能被 JSON.parse）。
7. 改完跑：\`node scripts/quiz.mjs merge <你的文件> --chapter ${chapter}\`，校验通过才算完成。

输出骨架（字段含义见规范第 3 节）：

\`\`\`json
{
  "spec": "${QUIZ_SPEC_VERSION}",
  "chapter": ${chapter},
  "source": "model",
  "generator": "你的模型名",
  "items": {
    "1": {
      "need": "spell",
      "note": "词根/记忆点，≤60 字，可省略",
      "distractors": [
        { "text": "干扰释义（与词库里的释义不同，也别说成同义）", "kind": "root", "why": "差在哪，≤40 字" },
        { "text": "...", "kind": "form", "why": "..." },
        { "text": "...", "kind": "topic", "why": "..." }
      ]
    }
  }
}
\`\`\`
`;

  const outFile = flag("out");
  if (typeof outFile === "string") {
    await writeFile(path.resolve(root, outFile), out, "utf8");
    console.log(`已生成提示词：${outFile}（${slice.length} 个词，${out.length} 字节）`);
  } else {
    process.stdout.write(out);
  }
}

/* ============ check / index ============ */

/** 校验所有题源文件，返回每章结果 */
async function checkAll(only = 0) {
  const chapters = only ? [only] : await chapterIds();
  const results = [];
  for (const chapter of chapters) {
    const file = path.join(root, quizPath(chapter));
    const words = await loadWords(chapter);
    if (!existsSync(file)) {
      results.push({ chapter, file: null, exists: false, errors: [], warnings: [], covered: 0, total: words.length, stats: null });
      continue;
    }
    let doc = null;
    try {
      doc = await readJson(file);
    } catch (err) {
      results.push({
        chapter,
        file,
        exists: true,
        errors: [`JSON 解析失败：${err.message}`],
        warnings: [],
        covered: 0,
        total: words.length,
        stats: null,
      });
      continue;
    }
    const { errors, warnings, stats } = validateQuizDoc(doc, { chapter, words });
    results.push({ chapter, file, exists: true, errors, warnings, stats, covered: stats.covered, total: words.length, doc });
  }
  return results;
}

async function writeIndex(results) {
  const usable = results.filter((r) => r.exists && !r.errors.length);
  const index = buildQuizIndex(
    usable.map((r) => ({ chapter: r.chapter, covered: r.covered, total: r.total, revCovered: r.stats?.revCovered || 0 }))
  );
  index.updatedAt = new Date().toISOString();
  await writeFile(path.join(root, quizIndexPath), `${JSON.stringify(index, null, 2)}\n`, "utf8");
  return { index, usable };
}

function printResult(r) {
  const tag = !r.exists ? "·" : r.errors.length ? "✖" : "✔";
  const head = r.exists
    ? `${String(r.covered).padStart(4)}/${String(r.total).padEnd(4)} 词  ${String(Math.round((r.stats?.coverage || 0) * 100)).padStart(3)}%  辨析均值 ${
        r.stats?.avgWhy ?? 0
      } 字`
    : "未生成题源（该章会用自动生成的干扰项）";
  console.log(`  ${tag} 第 ${String(r.chapter).padStart(2)} 章  ${head}`);
  for (const e of r.errors) console.log(`      ✖ ${e}`);
  for (const w of r.warnings) console.log(`      ! ${w}`);
  if (r.stats && r.stats.revCovered) {
    console.log(`      反向题源（rev）：${r.stats.revCovered}/${r.total} 词`);
  }
  if (r.stats && r.covered) {
    const kinds = Object.entries(r.stats.kinds)
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${QUIZ_KIND_LABEL[k] || k} ${n}`)
      .join(" / ");
    console.log(`      干扰项类型：${kinds || "（无）"}`);
  }
}

async function cmdCheck() {
  const only = num(flag("chapter"), 0);
  const results = await checkAll(only);
  const files = results.filter((r) => r.exists);
  console.log(`\n认词题源校验（规范 v${QUIZ_SPEC_VERSION}）`);
  if (!files.length) {
    console.log("  · 目前还没有任何 quiz-N.json —— 认词模式会用同章词自动生成干扰项，功能正常。");
    console.log("    生成第一批：node scripts/quiz.mjs prompt 1 --limit 40");
  } else {
    for (const r of results) printResult(r);
  }
  const { index, usable } = await writeIndex(results);
  const covered = usable.reduce((sum, r) => sum + r.covered, 0);
  const total = usable.reduce((sum, r) => sum + r.total, 0);
  console.log(
    `\n  → 清单 public/quiz-index.json：${index.chapters.length} 章可用${
      index.chapters.length ? `（第 ${index.chapters.join(", ")} 章）` : ""
    }，已精编 ${covered}/${total} 词`
  );
  const failed = results.filter((r) => r.exists && r.errors.length);
  if (failed.length) {
    console.log(`  → ${failed.length} 章校验未通过，已从清单中剔除（前端会退回自动生成干扰项）`);
  }
  console.log(failed.length ? "\n✖ 题源校验未通过\n" : "\n✔ 题源校验通过\n");
  process.exit(failed.length ? 1 : 0);
}

/* ============ sample ============ */

/**
 * 抽样打印"用户实际会看到的那道题"。
 * 用的是前端 public/quiz.js 的同一套算法与同一个随机种子，
 * 所以这里看到什么，页面上就是什么 —— 语义质量只能人工抽查，这个命令就是抽查工具。
 */
async function cmdSample() {
  const { buildChoiceQuestion, optionLabel, questionKey, seededRng } = await import("../public/quiz.js");
  const chapter = num(flag("chapter"), 0) || num(positional[0], 0);
  if (!chapter) {
    console.error("用法：node scripts/quiz.mjs sample --chapter 1 [--count 5]");
    process.exit(2);
  }
  const count = Math.max(1, num(flag("count"), 5));
  const words = await loadWords(chapter);
  const file = path.join(root, quizPath(chapter));
  const items = existsSync(file) ? normalizeQuizDoc(await readJson(file)).items : {};
  const pool = Object.keys(items).length ? words.filter((w) => items[String(w.id)]) : words;
  // 固定种子抽样：同一章每次抽到的样本一样，方便复查同一批题
  const rng = seededRng(`sample:${chapter}`);
  const picked = [];
  const bag = pool.slice();
  while (picked.length < Math.min(count, pool.length)) {
    picked.push(bag.splice(Math.floor(rng() * bag.length), 1)[0]);
  }

  const rev = args.includes("--rev");
  console.log(`\n第 ${chapter} 章样题（${picked.length} 题${rev ? "，反向：看中文选英文" : ""}${Object.keys(items).length ? `，本章已精编 ${Object.keys(items).length} 词` : "，本章暂无精编题源"}）\n`);
  for (const entry of picked) {
    const question = buildChoiceQuestion({
      chapter,
      entry,
      pool: words,
      rng: seededRng(questionKey(chapter, entry.id, rev ? "zh" : "en")),
      curated: items[String(entry.id)] || null,
      promptKind: rev ? "zh" : "en",
    });
    console.log(`【#${entry.id} ${entry.word} ${entry.phonetic || ""} ${entry.pos || ""}】${rev ? "题面（中文）" : "正确释义"}：${rev ? entry.meaningCN : question.answer}`);
    question.options.forEach((option, index) => {
      const mark = option.correct ? "  ← 正确" : "";
      console.log(`   ${optionLabel(index)}. ${option.text}${mark}`);
      if (!option.correct && option.why) console.log(`        [${option.kind}] ${option.why}`);
    });
    console.log(`   来源：${question.hasCurated ? (rev ? "精编 rev 题源" : "精编题源") : "自动生成"}${question.note ? ` · 记忆点：${question.note}` : ""}\n`);
  }
}

/* ============ merge ============ */

async function cmdMerge() {
  const files = positional.slice(0);
  if (!files.length) {
    console.error("用法：node scripts/quiz.mjs merge <分片文件...> --chapter N [--dry-run]");
    process.exit(2);
  }
  const explicit = num(flag("chapter"), 0);
  /** @type {Map<number, any[]>} */
  const byChapter = new Map();
  for (const file of files) {
    const full = path.resolve(root, file);
    if (!existsSync(full)) {
      console.error(`找不到文件：${file}`);
      process.exit(2);
    }
    const raw = await readJson(full);
    const { chapter } = normalizeQuizDoc(raw);
    const target = Number(raw?.chapter) || explicit || chapter;
    if (!target) {
      console.error(`${file} 里没有 chapter 字段，请加 --chapter N`);
      process.exit(2);
    }
    if (!byChapter.has(target)) byChapter.set(target, []);
    byChapter.get(target).push(raw);
  }

  let ok = true;
  for (const [chapter, patches] of byChapter) {
    const target = path.join(root, quizPath(chapter));
    const words = await loadWords(chapter);
    let doc = existsSync(target) ? await readJson(target) : emptyQuizDoc(chapter);
    for (const patch of patches) doc = mergeQuizDocs(doc, patch);
    doc.spec = QUIZ_SPEC_VERSION;
    doc.chapter = chapter;
    doc.updatedAt = new Date().toISOString().slice(0, 10);

    const { errors, warnings, stats } = validateQuizDoc(doc, { chapter, words });
    const before = existsSync(target) ? normalizeQuizDoc(await readJson(target)).items : {};
    console.log(`\n第 ${chapter} 章：合并 ${patches.length} 个分片 → ${Object.keys(doc.items).length} 个词条（原有 ${Object.keys(before).length}）`);
    console.log(`  覆盖 ${stats.covered}/${stats.total}（${Math.round(stats.coverage * 100)}%），辨析均值 ${stats.avgWhy} 字`);
    for (const w of warnings) console.log(`  ! ${w}`);
    for (const e of errors) console.log(`  ✖ ${e}`);
    if (errors.length) {
      ok = false;
      console.log("  → 有错误，不写入（修好再合并）");
      continue;
    }
    if (has("dry-run")) {
      console.log("  → --dry-run：校验通过，不写入");
      continue;
    }
    await writeFile(target, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
    console.log(`  → 已写入 ${quizPath(chapter)}`);
  }

  if (!has("dry-run")) {
    const results = await checkAll();
    const { index } = await writeIndex(results);
    console.log(`  → 已更新 public/quiz-index.json（${index.chapters.length} 章可用）`);
  }
  process.exit(ok ? 0 : 1);
}

/* ============ index ============ */

async function cmdIndex() {
  const results = await checkAll();
  const { index, usable } = await writeIndex(results);
  console.log(`已重建 ${quizIndexPath}：${usable.length} 章可用（第 ${index.chapters.join(", ") || "无"} 章）`);
}

/* ============ main ============ */

switch (command) {
  case "prompt":
    await cmdPrompt();
    break;
  case "check":
    await cmdCheck();
    break;
  case "sample":
    await cmdSample();
    break;
  case "merge":
    await cmdMerge();
    break;
  case "index":
    await cmdIndex();
    break;
  default:
    console.log(`未知命令：${command}

用法：
  node scripts/quiz.mjs prompt <章号> [--offset N] [--limit N] [--out 文件]
  node scripts/quiz.mjs check [--chapter N]
  node scripts/quiz.mjs sample [--chapter N] [--count N]
  node scripts/quiz.mjs merge <文件...> [--chapter N] [--dry-run]
  node scripts/quiz.mjs index
`);
    process.exit(2);
}
