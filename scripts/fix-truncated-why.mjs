/**
 * 修复：把历史题源里被截断的 why/note 按原生成模板 / 词库补全。
 *
 * ⚠️ 状态：**已跑完**（2026-09-28），按 `docs/项目规范.md` §6 的例外条款
 *    **保留在 `scripts/` 作同类修复的模板**——不是一次性脚本，不要归档。
 *    适用条件：题源里再出现"可反推 + 残句/词名能校验"的损伤时才重跑；
 *    无校验的批量替换一律禁止（见项目规范 §5）。
 *
 * 三个 Pass 对应三种损伤形式（历史题源被 40 字上限 slice 过，损伤不止一种）：
 *   Pass 1  按生成模板反推整句（genWhyOld/genNoteOld），覆盖带「…」的残句 —— 1561 条
 *   Pass 2  按词库补全末段「<word> 指<残句>」→ 完整第一义项 —— 942 条
 *           ⚠️ 不要求句末有省略号：纯 slice 砍断的（「frame 指（画」）才是大头，更隐蔽
 *   Pass 3  补回开头被吞掉的词名「指X，W 指Y」→「<other> 指X，W 指Y」 —— 373 条
 *           反查口径：同章第一义项 == sense，**唯一命中才补**；多义/查不到的留给人工
 *
 * 已知边界（2026-09-28 收尾时仍未自动修的 91 条，用 `npm run quiz:scan:truncation -- --json` 导出）：
 *   · 同章多义词无法定夺（「潮湿的」同时对应 moist/damp/humid）
 *   · 同名不在本章（「摇滚乐」对应词可能在别的章，跨章反查会引入误判，故不跨章）
 *   这两类必须人工判定，脚本不猜。
 *
 * 背景：quiz-optimize.mjs / quiz-rev-generate.mjs 曾对生成的 why/note 做
 * `> 40 字则 slice(0,39) + "…"` 的硬截断，导致 1500+ 条辨析在半句话处被砍断。
 * 生成模板是确定性的（词形/词根/释义拼接），因此可以从词库（public/data-N.json）
 * 反推出完整句子，并与截断残句做前缀校验，只有确认匹配才替换，避免误改人工精编内容。
 *
 * 用法：node scripts/fix-truncated-why.mjs [--dry]
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { WHY_MAX } from "./quiz-lib.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dry = process.argv.includes("--dry");

/**
 * 句末省略号：不只是 U+2026「…」。
 * 词库释义本身就大量使用 6 个英文句点（如 `tax = 税 v. 对......征税`），
 * 于是旧生成器 slice(0,8/9) 砍出来的残句以 `...` / `....` 结尾——只认「…」会整批漏掉。
 */
const ELLIPSIS = /(?:…|\.{2,})\s*$/;

/* 与旧版 quiz-optimize.mjs / quiz-rev-generate.mjs 完全一致的 shortOf（历史数据按此口径生成） */
const shortOfOpt = (text, n = 8) => {
  const s = String(text || "").split(/[，,；;、]/)[0].trim();
  return s.length > n ? s.slice(0, n) : s;
};
const shortOfRev = (text, n = 9) => {
  const s = String(text || "").split(/[，,；;、]/)[0].trim();
  return s.length > n ? s.slice(0, n) : s;
};

function rootPairs(entry) {
  const out = [];
  for (const m of String(entry?.root || "").matchAll(/([A-Za-z][A-Za-z-]*)\s*[（(]([^）)]*)[）)]/g)) {
    const tok = m[1].replace(/-+$/, "");
    const gloss = m[2].trim();
    if (tok.length >= 2 && gloss) out.push({ tok, gloss });
  }
  return out;
}
const sharedTokOf = (a, b) => {
  for (const p of rootPairs(a)) {
    for (const q of rootPairs(b)) {
      if (p.tok.toLowerCase() === q.tok.toLowerCase()) return p.tok;
    }
  }
  return "";
};

/* ---------- 正向 why 模板（旧 quiz-optimize.mjs genWhy，old shortOf=8） ---------- */
function genWhyOld(base, other, kind) {
  const bw = String(base?.word || "");
  const ow = String(other?.word || "");
  const bm = shortOfOpt(base?.meaningCN);
  const om = shortOfOpt(other?.meaningCN);
  if (kind === "root") {
    const shared = rootPairs(base).find((p) => rootPairs(other).some((q) => q.tok.toLowerCase() === p.tok.toLowerCase()));
    if (shared) return `${shared.tok}- 是「${shared.gloss}」，${ow} 指${om}`;
    return `${ow} 与 ${bw} 同根，${ow} 指${om}`;
  }
  if (kind === "form") return `${ow} 与 ${bw} 拼写相近，${ow} 指${om}`;
  if (kind === "sense") return `${ow} 指${om}，${bw} 指${bm}`;
  if (kind === "pos") {
    const bp = String(base?.pos || "").replace(/\.$/, "");
    const op = String(other?.pos || "").replace(/\.$/, "");
    return `${ow} 是${op}，此处要的是${bp || "其他词性"}`;
  }
  return `${ow} 指${om}，${bw} 指${bm}`;
}

/* ---------- 反向 why 模板（旧 quiz-rev-generate.mjs genRevWhy，old shortOf=9） ---------- */
function genRevWhyOld(base, other, kind) {
  const om = shortOfRev(other?.meaningCN);
  const ow = String(other?.word || "");
  const sharedTok = sharedTokOf(base, other);
  if (kind === "root" && sharedTok) return `${sharedTok}- 同根，${ow} 指${om}`;
  if (kind === "root") return `${ow} 与 ${base?.word} 同根，${ow} 指${om}`;
  if (kind === "form") return `${ow} 与 ${base?.word} 拼写相近，${ow} 指${om}`;
  return `${ow} 指${om}`;
}

/* ---------- note 模板（旧 quiz-optimize.mjs genNote） ---------- */
function genNoteOld(entry) {
  const pairs = rootPairs(entry);
  const m = shortOfOpt(entry?.meaningCN, 14);
  if (pairs.length >= 2) return `${pairs[0].tok}（${pairs[0].gloss}）+ ${pairs[1].tok}（${pairs[1].gloss}）→ ${m}`;
  if (pairs.length === 1) return `${pairs[0].tok}（${pairs[0].gloss}）→ ${m}`;
  return "";
}

const prefixOf = (s) => String(s || "").replace(ELLIPSIS, "");
/** 残句是否可以被 full 补全（full 以残句（去掉尾部省略号）为前缀，且确实更长） */
const completes = (full, truncated) => {
  const pre = prefixOf(truncated);
  return typeof full === "string" && full.startsWith(pre) && full.length > pre.length;
};
/** 会被写进文件才计数：补全结果与残句相同（例如词库释义本身就是「百分之......」）时不算修复 */
const actuallyChanged = (full, cur) => typeof full === "string" && full !== cur;
/**
 * 多个候选都能补全时消歧：同章候选优先 → 残句里点名了 other.word 的优先 → 章序靠前优先。
 * 仍然唯一才替换，否则宁缺毋滥（保留残句，不误改人工内容）。
 */
function chooseHit(hits, pre, chapterId) {
  if (!hits.length) return null;
  const uniq = [...new Map(hits.map((h) => [h.full, h])).values()];
  if (uniq.length === 1) return uniq[0].full;
  const scored = uniq.map((h) => {
    let score = 0;
    if (h.other._ch === chapterId) score += 2;
    if (pre.includes(String(h.other.word || ""))) score += 1;
    return { ...h, score };
  });
  scored.sort((a, b) => b.score - a.score || a.other._ch - b.other._ch);
  return scored[0].full;
}

/* ---------- 主流程 ---------- */
const chapters = [];
for (let c = 1; c <= 99; c++) {
  try {
    const words = JSON.parse(readFileSync(join(root, "public", `data-${c}.json`), "utf8"));
    const quiz = JSON.parse(readFileSync(join(root, "public", `quiz-${c}.json`), "utf8"));
    chapters.push({ id: c, words, quiz });
  } catch {
    break; // 章节号连续，读到不存在即停
  }
}

let fixedWhy = 0;
let fixedRevWhy = 0;
let fixedNote = 0;
let missed = 0;
const misses = [];

/* 全词库候选池：optimize 的 root/form/sense 干扰项可跨章选取，反查也必须全局 */
const globalPool = [];
const globalByWord = new Map();
for (const ch of chapters) {
  for (const w of ch.words || []) {
    globalPool.push({ ...w, _ch: ch.id });
    globalByWord.set(String(w.word || "").toLowerCase(), w);
  }
}

for (const ch of chapters) {
  const byId = new Map((ch.words || []).map((w) => [Number(w.id), w]));
  const byWord = globalByWord;
  const pool = globalPool;
  const items = ch.quiz?.items && typeof ch.quiz.items === "object" ? ch.quiz.items : {};
  let dirty = false;

  for (const [key, item] of Object.entries(items)) {
    const base = byId.get(Number(key));
    if (!base) continue;

    // note / rev.note（同一段 base 记忆点模板）
    const notes = [
      ["note", () => genNoteOld(base)],
      ["rev.note", () => genNoteOld(base)],
    ];
    for (const [path, build] of notes) {
      const cur = path === "note" ? item.note : item.rev?.note;
      if (typeof cur === "string" && ELLIPSIS.test(cur)) {
        const full = build();
        if (completes(full, cur) && actuallyChanged(full, cur)) {
          if (path === "note") item.note = full;
          else item.rev.note = full;
          fixedNote += 1;
          dirty = true;
        } else {
          missed += 1;
          misses.push([ch.id, key, path, cur]);
        }
      }
    }

    // 正向干扰项：text 是释义，需要反查"是哪个词"
    const fwd = Array.isArray(item.distractors) ? item.distractors : [];
    for (const d of fwd) {
      if (typeof d.why !== "string" || !ELLIPSIS.test(d.why)) continue;
      const pre = prefixOf(d.why);
      const hits = [];
      for (const other of pool) {
        if (other.id === base.id && other._ch === ch.id) continue;
        const full = genWhyOld(base, other, d.kind);
        if (full.startsWith(pre) && full.length > pre.length) hits.push({ full, other });
      }
      const pick = chooseHit(hits, pre, ch.id);
      if (pick && actuallyChanged(pick, d.why)) {
        d.why = pick;
        fixedWhy += 1;
        dirty = true;
      } else {
        missed += 1;
        misses.push([ch.id, key, `fwd:${d.text}`, d.why]);
      }
    }

    // 反向干扰项：text 就是英文词
    const rev = Array.isArray(item.rev?.distractors) ? item.rev.distractors : [];
    for (const d of rev) {
      if (typeof d.why !== "string" || !ELLIPSIS.test(d.why)) continue;
      const other = byWord.get(String(d.text || "").toLowerCase());
      if (!other) {
        missed += 1;
        misses.push([ch.id, key, `rev:${d.text}`, d.why]);
        continue;
      }
      const full = genRevWhyOld(base, other, d.kind);
      if (completes(full, d.why) && actuallyChanged(full, d.why)) {
        d.why = full;
        fixedRevWhy += 1;
        dirty = true;
      } else {
        missed += 1;
        misses.push([ch.id, key, `rev:${d.text}`, d.why]);
      }
    }
  }

  if (dirty && !dry) {
    const out = join(root, "public", `quiz-${ch.id}.json`);
    writeFileSync(out, JSON.stringify(ch.quiz, null, 2) + "\n", "utf8");
  }
}

/* ---------- Pass 2：按词库补全「<word> 指<残句>」的末段 ----------
 *
 * 历史题源被 40 字上限 slice 过，why 末尾的释义常被砍成半句话。两类都要管：
 *   带省略号：「tax 指税 v. 对...」        （Pass 1 的模板反推已覆盖部分，这里是兜底）
 *   不带省略号：「frame 指（画」「mourn 指…哀」（纯 slice，更隐蔽，占绝大多数）
 * 因此**不要求**句末有省略号，只看末尾「<英文词> 指<X>」里的 X 是不是词库第一义项的真前缀。
 *
 * 补全到**完整义项段**（不再套 shortOf 的 8/9 字截断）——shortOf 本就是截断的源头，
 * 套它反推出来的仍是同一个残句。
 */
const firstSense = (entry) =>
  String(entry?.meaningCN || "")
    .split(/[，,；;、]/)[0]
    .trim();

let fixedTail = 0;
let skippedLong = 0;
for (const ch of chapters) {
  const items = ch.quiz?.items && typeof ch.quiz.items === "object" ? ch.quiz.items : {};
  let dirty = false;
  for (const [, item] of Object.entries(items)) {
    const distractors = [
      ...(Array.isArray(item.distractors) ? item.distractors : []),
      ...(Array.isArray(item.rev?.distractors) ? item.rev.distractors : []),
    ];
    for (const d of distractors) {
      if (typeof d.why !== "string" || !d.why) continue;
      const m = d.why.match(/([A-Za-z][A-Za-z' -]*)\s*指([^，,；;]*)$/);
      if (!m) continue;
      const tail = m[2];
      const entry = globalByWord.get(m[1].trim().toLowerCase());
      if (!entry) continue;
      const full = firstSense(entry);
      const pre = prefixOf(tail);
      // 前缀校验：补全结果必须能从残句长出来，且确实更长（宁缺毋滥）
      if (!pre || !full.startsWith(pre) || full.length <= pre.length) continue;
      const next = d.why.slice(0, d.why.length - tail.length) + full;
      if (next === d.why) continue;
      // 不得突破题源规范的 why 上限（WHY_MAX）；超限的留给人工，不自动补
      if (next.length > WHY_MAX) {
        skippedLong += 1;
        continue;
      }
      d.why = next;
      fixedTail += 1;
      dirty = true;
    }
  }
  if (dirty && !dry) {
    writeFileSync(join(root, "public", `quiz-${ch.id}.json`), JSON.stringify(ch.quiz, null, 2) + "\n", "utf8");
  }
}

/* ---------- Pass 3：补回开头被吞掉的词名 ----------
 *
 * 典型：「指摇滚乐，lithosphere 指岩石圈」「同章词，指山腰，El Nino 指厄尔尼诺现象」
 * —— 生成时 other 变量为空，把「<other> 指<sense>」拼成了「指<sense>」，词名凭空消失。
 * 这与 40 字 slice 无关（原句远没到上限），是拼接缺陷，所以 Pass 1/2 都覆盖不到。
 *
 * 反查口径：同章内「第一义项 == sense」的词。**必须唯一命中才补**（宁缺毋滥），
 * 多义（如「潮湿的」同时对应 moist/damp/humid）与查不到的留给人工。
 */
const HEADLESS = /^(同章词，)?指/;

let fixedHead = 0;
let headAmbiguous = 0;
let headNoHit = 0;
const headPending = [];

for (const ch of chapters) {
  // 同章「第一义项 → 词」索引
  const senseIndex = new Map();
  for (const w of ch.words || []) {
    const s = firstSense(w);
    if (!s || !w?.word) continue;
    if (!senseIndex.has(s)) senseIndex.set(s, []);
    senseIndex.get(s).push(String(w.word));
  }

  const items = ch.quiz?.items && typeof ch.quiz.items === "object" ? ch.quiz.items : {};
  let dirty = false;
  for (const [id, item] of Object.entries(items)) {
    // 本题词：other 不会是它自己，反查时排除
    const baseW = (ch.words || []).find((w) => Number(w.id) === Number(id));
    const selfWord = String(baseW?.word || "").toLowerCase();

    const distractors = [
      ...(Array.isArray(item.distractors) ? item.distractors.map((d) => ["why", d]) : []),
      ...(Array.isArray(item.rev?.distractors) ? item.rev.distractors.map((d) => ["rev.why", d]) : []),
    ];
    for (const [where, d] of distractors) {
      if (typeof d.why !== "string" || !HEADLESS.test(d.why)) continue;
      const m = d.why.match(/^(同章词，)?指([^，,；;]*)/);
      if (!m) continue;
      const rawSense = m[2].trim();
      let word = null;
      let sense = rawSense;

      // ① 精确反查：同章第一义项 == sense，唯一命中
      const cands = (senseIndex.get(rawSense) || []).filter(
        (w) => w.toLowerCase() !== selfWord
      );
      if (cands.length === 1) {
        word = cands[0];
      } else {
        // ② sense 自己也被 shortOf 砍过（如「（尤指某一地区的」「肢」）——先补 sense 再反查
        const pref = [];
        for (const w of ch.words || []) {
          const fs = firstSense(w);
          if (!fs || !rawSense || String(w.word || "").toLowerCase() === selfWord) continue;
          if (fs.startsWith(rawSense) && fs.length > rawSense.length) pref.push({ word: String(w.word), fs });
        }
        if (pref.length === 1) {
          word = pref[0].word;
          sense = pref[0].fs;
        }
      }

      if (!word) {
        if (cands.length > 1) headAmbiguous += 1;
        else headNoHit += 1;
        if (headPending.length < 20) headPending.push(`ch${ch.id} #${id} ${where}  ${d.why}`);
        continue;
      }
      const next = `${m[1] || ""}${word} 指${sense}${d.why.slice(m[0].length)}`;
      if (next.length > WHY_MAX) continue;
      d.why = next;
      fixedHead += 1;
      dirty = true;
    }
  }
  if (dirty && !dry) {
    writeFileSync(join(root, "public", `quiz-${ch.id}.json`), JSON.stringify(ch.quiz, null, 2) + "\n", "utf8");
  }
}

console.log(
  `正向 why 修复 ${fixedWhy} 条；反向 why 修复 ${fixedRevWhy} 条；note 修复 ${fixedNote} 条；` +
    `末段兜底补全 ${fixedTail} 条；开头词名补全 ${fixedHead} 条` +
    `（多义待定 ${headAmbiguous} / 查不到 ${headNoHit}）；未能确定 ${missed} 条${dry ? "（dry-run 未写入）" : ""}`
);
if (skippedLong) console.log(`注意：${skippedLong} 条因补全后超过 ${WHY_MAX} 字被跳过（需人工精简）`);
if (headPending.length) {
  console.log("—— 开头词名待人工（前 20）——");
  for (const p of headPending) console.log("  " + p);
}
if (misses.length) {
  console.log("—— 未修复样例（前 20）——");
  for (const m of misses.slice(0, 20)) console.log(JSON.stringify(m));
}
