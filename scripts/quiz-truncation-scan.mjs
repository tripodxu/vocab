/**
 * 截断扫描：找出题源里被硬截断的辨析/记忆，区分「真截断」与「词库释义自带省略号」。
 *
 * 背景：v1.2 起规范禁止用 slice + … 硬截断（WHY_MAX/NOTE_MAX = 120）。
 * 但校验器（quiz-lib.mjs）不判这一项——极少数词库释义本身带省略号（如「百分之……」），
 * 机器一刀切会误杀。本脚本做嫌疑扫描，人工/模型看清单决定要不要修。
 *
 * 三个维度（历史题源被 40 字上限砍过，三种损伤形式都要查）：
 *   A. 句末带省略号 —— 残句是词库释义的**前缀**而非原文 → FLAGGED
 *   B. 句末无省略号 —— 纯 slice 砍断（如「frame 指（画」「mourn 指…哀」），更隐蔽 → SILENT_CUT
 *   C. 开头缺词名   —— 生成时 other 为空，把「<other> 指X」拼成「指X」 → HEADLESS
 *
 * 判定口径（**严格版**，2026-09-28 修）：
 *   ALLOWED    —— 人工确认过的修辞性省略号（白名单）
 *   EXEMPT     —— 残句去掉尾部省略号后，**正好等于**某条词库释义去掉尾部省略号（= 词库自带，未截断）
 *   FLAGGED    —— 维度 A：残句只是词库释义的前缀，后面还有实质内容（= 半句话，应修）
 *   SILENT_CUT —— 维度 B：末段「<word> 指<X>」的 X 不是词库该词的完整第一义项（= 被砍，应修）
 *   HEADLESS   —— 维度 C：why 以「指/同章词，指」开头（= 词名被吞，应修）
 *   UNKNOWN    —— 词库里找不到出处，需人工看一眼
 *
 * ⚠️ 旧版只查维度 A，且用"残句能在词库释义里前缀匹配到"就判 EXEMPT —— 而截断残句恰恰就是从释义
 *    砍下来的，必然命中，导致真截断被判成"词库自带"（26 条漏网 + FLAGGED 假绿）。
 *    判定必须是**相等**而非前缀；且必须覆盖无省略号的静默截断（那才是大头，884 条）。
 *
 * 用法：node scripts/quiz-truncation-scan.mjs            # 全部章节，打印清单
 *       node scripts/quiz-truncation-scan.mjs --only 1,5
 *       node scripts/quiz-truncation-scan.mjs --json     # 输出 JSON（供脚本消费）
 * 退出码：0 = 扫完（不阻断门禁；本脚本是诊断工具，不是门禁）
 */

import { loadAll } from "./quiz-data.mjs";

const argv = process.argv.slice(2);
const only = (() => {
  const i = argv.indexOf("--only");
  if (i < 0) return null;
  return new Set(String(argv[i + 1] || "").split(",").map(Number).filter(Boolean));
})();
const asJson = argv.includes("--json");

const { chapters, data, quiz } = await loadAll();

/** 词库里所有释义片段（用于判断"省略号来自词库"） */
const glossSet = new Set();
for (const c of chapters) {
  for (const w of data.get(c) || []) {
    const m = String(w?.meaningCN || "");
    if (!m) continue;
    // 整句 + 按分隔符切开的前几段，都能作为"来源证据"
    glossSet.add(m);
    for (const seg of m.split(/[，,；;、（）()]/)) {
      const s = seg.trim();
      if (s.length >= 2) glossSet.add(s);
    }
  }
}

/** 人工确认过的「修辞性省略号」（句子读得通，不是被砍断），登记在此即不再报警 */
const RHETORICAL_ALLOW = new Set([
  // ch13 #132：situs（安放）→ 被安放在…… —— 语义完整，省略号是修辞而非截断
  "13:132:note:源自拉丁语 situs（安放）→ 被安放在……",
]);

const ELLIPSIS = /(?:…|\.{2,})\s*$/;
const stripEll = (s) => String(s || "").replace(ELLIPSIS, "").trim();

/* ---- 维度 B/C 用的词库索引（干扰项可跨章取，因此按词全局查） ---- */
const wordIndex = new Map();
for (const c of chapters) {
  for (const w of data.get(c) || []) {
    if (w?.word) wordIndex.set(String(w.word).toLowerCase(), w);
  }
}
const firstSense = (e) =>
  String(e?.meaningCN || "")
    .split(/[，,；;、]/)[0]
    .trim();
const HEADLESS = /^(同章词，)?指/;

/** 维度 B：末段「<word> 指<X>」的 X 是否只是词库第一义项的前缀（被砍断） */
function silentCut(text) {
  const m = String(text).match(/([A-Za-z][A-Za-z'’-]*)\s*指([^，,；;]*)$/);
  if (!m) return null;
  const entry = wordIndex.get(m[1].trim().toLowerCase());
  if (!entry) return null;
  const full = firstSense(entry);
  const tail = m[2].trim();
  if (!full || tail === full || !full.startsWith(tail)) return null;
  return { word: m[1], tail, full };
}

/** 残句的全部候选：整句，以及"指/是/为/＝/（"之后的尾巴（例：「per cent 指百分之...」→「百分之」） */
function tailCandidates(text) {
  const body = stripEll(text);
  if (!body) return [];
  const tailMatch = body.match(/[指是＝=:：（(为]([^，,；;。]*)$/);
  return [body, tailMatch ? tailMatch[1].trim() : ""].filter((s) => s.length >= 2);
}

/** 词库自带省略号：去掉尾部省略号后**正好等于**某条词库释义（去掉尾部省略号） */
function fromGlossary(text) {
  for (const cand of tailCandidates(text)) {
    for (const g of glossSet) {
      if (stripEll(g) === cand) return true;
    }
  }
  return false;
}

/** 真截断：残句只是词库释义的前缀，后面还有非省略号的实质内容 */
function cutFromGlossary(text) {
  for (const cand of tailCandidates(text)) {
    for (const g of glossSet) {
      if (g.startsWith(cand) && /[^\s.…]/.test(g.slice(cand.length))) return true;
    }
  }
  return false;
}

const rows = [];
for (const c of chapters) {
  if (only && !only.has(c)) continue;
  const items = quiz.get(c)?.items || {};
  for (const [id, item] of Object.entries(items)) {
    const seen = [
      ...(item.distractors || []).map((d, i) => ({ where: `distractors[${i}]`, text: d.why, kind: d.kind })),
      ...((item.rev?.distractors) || []).map((d, i) => ({ where: `rev.distractors[${i}]`, text: d.why, kind: d.kind })),
      { where: "note", text: item.note },
      { where: "rev.note", text: item.rev?.note },
    ];
    for (const row of seen) {
      if (typeof row.text !== "string" || !row.text.trim()) continue;
      const allowKey = `${c}:${id}:${row.where}:${row.text}`;
      const base = { chapter: c, id, where: row.where, kind: row.kind || "", text: row.text };
      const isWhy = row.where.startsWith("distractors") || row.where.startsWith("rev.distractors");

      // 维度 C：开头缺词名（「指X，W 指Y」丢了 other）
      if (isWhy && HEADLESS.test(row.text)) {
        rows.push({ ...base, verdict: "HEADLESS" });
        continue;
      }
      // 维度 B：无省略号的静默截断（末段不是完整第一义项）
      const sc = isWhy ? silentCut(row.text) : null;
      if (sc) {
        rows.push({ ...base, verdict: "SILENT_CUT", suggest: sc.full });
        continue;
      }
      // 维度 A：句末带省略号
      if (!ELLIPSIS.test(row.text)) continue;
      rows.push({
        ...base,
        verdict: RHETORICAL_ALLOW.has(allowKey)
          ? "ALLOWED"
          : fromGlossary(row.text)
            ? "EXEMPT"
            : cutFromGlossary(row.text)
              ? "FLAGGED"
              : "UNKNOWN",
      });
    }
  }
}

const by = (v) => rows.filter((r) => r.verdict === v);
const flagged = by("FLAGGED");
const silent = by("SILENT_CUT");
const headless = by("HEADLESS");
const unknown = by("UNKNOWN");
const exempt = rows.filter((r) => r.verdict === "EXEMPT" || r.verdict === "ALLOWED");
const broken = flagged.length + silent.length + headless.length;

if (asJson) {
  console.log(JSON.stringify({ total: rows.length, flagged, silent, headless, unknown, exempt }, null, 2));
} else {
  console.log(`扫描章节：${chapters.filter((c) => !only || only.has(c)).join(",")}`);
  console.log(
    `疑似损伤共 ${broken} 条：` +
      `末段截断（无省略号）${silent.length} / 开头缺词名 ${headless.length} / ` +
      `句末省略号截断 ${flagged.length} / 待人工 ${unknown.length}；免修 ${exempt.length}\n`
  );
  const show = (title, list, extra) => {
    if (!list.length) return;
    console.log(`== ${title}（${list.length} 条）==`);
    for (const r of list.slice(0, 20)) {
      const tail = r.suggest ? `\n           → 应为「${r.suggest}」` : "";
      console.log(`ch${r.chapter} #${r.id} ${r.where}${r.kind ? `(${r.kind})` : ""}  ${r.text}${tail}`);
    }
    if (list.length > 20) console.log(`…另有 ${list.length - 20} 条（--json 看全部）`);
    console.log(extra ? extra + "\n" : "");
  };
  show("SILENT_CUT：末段被 slice 砍断（无省略号，最隐蔽）", silent);
  show("HEADLESS：开头丢了词名（other 拼成了空）", headless);
  show("FLAGGED：句末省略号，残句只是词库释义的前缀", flagged);
  show("UNKNOWN：词库里找不到出处，需人工看一眼", unknown);
  if (exempt.length) {
    console.log("== 免修：省略号来自词库释义本身（残句＝释义原文），或已人工确认是修辞 ==");
    for (const r of exempt.slice(0, 20)) console.log(`ch${r.chapter} #${r.id} ${r.where}  ${r.text}`);
    if (exempt.length > 20) console.log(`…另有 ${exempt.length - 20} 条（--json 看全部）`);
  }
  console.log(
    "\n修复参考：scripts/fix-truncated-why.mjs（Pass 2 补全末段、Pass 3 补回开头词名；" +
      "均做前缀/唯一性校验，宁缺毋滥）"
  );
}
