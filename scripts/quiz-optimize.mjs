/**
 * 逐题优化：按 _audit/work/N-fixlist.json 的 must 清单修复题源，输出 content/quiz/N-opt.json。
 *
 * 三种修复模式（只动有缺陷的干扰项，尽量保留好内容）：
 *   retext — why 在讲词 X 却挂在别的释义上：把 text 改成 X 的词库释义（保留 why/kind）
 *   rewhy  — text 没问题但 why 是空话/重复：按真实关系重写 why
 *   regen  — 干扰项本身不合格（歧义/长度作弊/万能项/英文夹带/配额）：换新干扰项+新 why
 * 另：noNote → 按词根字段补记忆点。
 *
 * 生成器与校验器同口径：meaningsConflict / senseCover（义项覆盖）/ 长度 0.5~2.0 /
 * kind 配额（topic≤2, pos≤1, antonym≤1）/ 至少 1 个可辨析项 / why ≤40 字且避开黑名单。
 * 万能项（章内同 text ≥3 次）在内存里迭代消除后再写出。
 *
 * 用法：node scripts/quiz-optimize.mjs [--only 1,5]
 */

import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { validateQuizDoc, normalizeMeaning, meaningsConflict, WHY_BLACKLIST, QUIZ_SPEC_VERSION } from "./quiz-lib.mjs";
import {
  loadAll,
  buildTokenIndex,
  resolveWhy,
  normalize,
  minOverlap,
  senseCover,
  matchTemplate,
} from "../_audit/indep/lib.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const only = (() => {
  const i = argv.indexOf("--only");
  if (i < 0) return null;
  return new Set(String(argv[i + 1] || "").split(",").map(Number).filter(Boolean));
})();

const { chapters, data, quiz } = await loadAll();
const tokenIndex = buildTokenIndex(data);

/** 全词库候选池（root/form/sense 可跨章；topic 限同章由 pickCandidate 保证） */
const globalPool = [];
for (const cc of chapters) for (const w of data.get(cc) || []) globalPool.push({ ...w, _ch: cc });

/* ---------- 词根字段解析：token（释义）对 ---------- */
function rootPairs(entry) {
  const out = [];
  for (const m of String(entry?.root || "").matchAll(/([A-Za-z][A-Za-z-]*)\s*[（(]([^）)]*)[）)]/g)) {
    const tok = m[1].replace(/-+$/, "");
    const gloss = m[2].trim();
    if (tok.length >= 2 && gloss) out.push({ tok, gloss });
  }
  return out;
}
const pairIndex = new Map(); // token -> [{entry, gloss}]
for (const [, words] of data)
  for (const w of words)
    for (const p of rootPairs(w)) {
      const t = p.tok.toLowerCase();
      if (!pairIndex.has(t)) pairIndex.set(t, []);
      pairIndex.get(t).push({ entry: w, gloss: p.gloss });
    }

/* ---------- 小工具 ---------- */
const shortOf = (text, n = 8) => {
  const s = String(text || "").split(/[，,；;、]/)[0].trim();
  return s.length > n ? s.slice(0, n) : s;
};
const charLen = (s) => String(s || "").length;
const whyOk = (why) => charLen(why) >= 6 && charLen(why) <= 40 && !WHY_BLACKLIST.some((re) => re.test(String(why || "")));

const KIND_VALUABLE = new Set(["root", "form", "sense", "antonym"]);

/* ---------- why 生成（按真实关系写，全部点名具体内容） ---------- */
function genWhy(base, other, kind) {
  const bw = String(base?.word || "");
  const ow = String(other?.word || "");
  const bm = shortOf(base?.meaningCN);
  const om = shortOf(other?.meaningCN);
  const bp = String(base?.pos || "").replace(/\.$/, "");
  const op = String(other?.pos || "").replace(/\.$/, "");
  let why = "";
  if (kind === "root") {
    const shared = rootPairs(base).find((p) => rootPairs(other).some((q) => q.tok.toLowerCase() === p.tok.toLowerCase()));
    if (shared) why = `${shared.tok}- 是「${shared.gloss}」，${ow} 指${om}`;
    if (!whyOk(why)) why = `${ow} 与 ${bw} 同根，${ow} 指${om}`;
  } else if (kind === "form") {
    why = `${ow} 与 ${bw} 拼写相近，${ow} 指${om}`;
  } else if (kind === "sense") {
    why = `${ow} 指${om}，${bw} 指${bm}`;
  } else if (kind === "pos") {
    why = `${ow} 是${op}，此处要的是${bp || "其他词性"}`;
  } else {
    why = `${ow} 指${om}，${bw} 指${bm}`;
  }
  if (charLen(why) > 40) why = why.slice(0, 39) + "…";
  return why;
}

/* ---------- note 生成（补缺） ---------- */
function genNote(entry) {
  const pairs = rootPairs(entry);
  const m = shortOf(entry?.meaningCN, 14);
  let note = "";
  if (pairs.length >= 2) note = `${pairs[0].tok}（${pairs[0].gloss}）+ ${pairs[1].tok}（${pairs[1].gloss}）→ ${m}`;
  else if (pairs.length === 1) note = `${pairs[0].tok}（${pairs[0].gloss}）→ ${m}`;
  if (charLen(note) > 60) note = note.slice(0, 59) + "…";
  return noteOk(note) ? note : "";
}
const noteOk = (s) => charLen(s) >= 6 && charLen(s) <= 60;

/* ---------- 形近判定 ---------- */
function formRel(a, b) {
  const x = String(a).toLowerCase(), y = String(b).toLowerCase();
  if (x === y) return false;
  let p = 0;
  while (p < x.length && p < y.length && x[p] === y[p]) p++;
  if (p >= 3) return true;
  let s = 0;
  while (s < x.length && s < y.length && x[x.length - 1 - s] === y[y.length - 1 - s]) s++;
  if (s >= 4) return true;
  if (x.length === y.length) {
    let diff = 0;
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) diff++;
    if (diff === 1) return true;
  }
  return false;
}

/* ---------- 候选挑选 ---------- */
/**
 * 从词池里为 base 选一个新的干扰项。
 * @param {{allowedKinds?: Set<string>, forceValuable?: boolean, avoidTexts: Set<string>, answerText: string, lenBand?: [number, number], preferValuable?: boolean}} opts
 * @returns {{other: any, kind: string, why: string} | null}
 */
/** 章内 text 频次表（万能项约束：≥3 的不再当候选）；每章每轮由主流程更新 */
let chapterFreq = null;

/** 按 text 找来源词：先精确（归一化相等），再模糊（minOverlap ≥0.72）——用于把 why 对齐到选项的真实含义 */
let fuzzyPool = [];
function findSourceByText(text, exactMap) {
  const key = normalizeMeaning(text);
  const hit = exactMap.get(key);
  if (hit) return hit;
  let best = null, bestOv = 0;
  for (const w of fuzzyPool) {
    const ov = minOverlap(text, w.meaningCN);
    if (ov > bestOv) { bestOv = ov; best = w; }
  }
  return bestOv >= 0.72 ? best : null;
}

/** 确定性打散：同一对 (base, other) 永远同一个抖动值，不同题之间互相错开 */
function jitter(base, other) {
  const s = `${base?.word}|${other?.word}`;
  let h = 7;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return (h % 97) / 97 * 3; // 0~3 分
}

function pickCandidate(base, pool, opts) {
  const { allowedKinds = null, forceValuable = false, avoidTexts, answerText, otherTexts = [], lenBand = [0.5, 2.0], preferValuable = true, baseChapter = 0 } = opts;
  const baseLen = Math.max(1, charLen(String(base?.meaningCN || "")));
  /** 单轮扫描：给定长度带，返回打分后的候选 */
  const scan = (band) => {
    /** @type {{other:any, kind:string, score:number, why:string}[]} */
    const scored = [];
    outer: for (const other of pool) {
      const text = String(other.meaningCN || "");
      if (!text.trim()) continue;
      const nText = normalizeMeaning(text);
      if (!nText) continue;
      if (avoidTexts.has(nText)) continue;
      if (chapterFreq && (chapterFreq.get(nText) || 0) >= 3) continue; // 万能项：高频文本不再当候选
      if (meaningsConflict(nText, answerText)) continue;
      for (const t of otherTexts) if (meaningsConflict(nText, t)) continue outer; // 与同题其它槽位互相包含也算冲突
      if (senseCover(text, answerText)) continue;
      const ratio = charLen(text) / baseLen;
      if (ratio < band[0] || ratio > band[1]) continue;
      // 关系判定（root > form > sense > pos/topic）
      const sharedTok = rootPairs(base).find((p) =>
        rootPairs(other).some((q) => q.tok.toLowerCase() === p.tok.toLowerCase())
      );
      const sameCh = Number(other?._ch || 0) === Number(baseChapter);
      let kind = null, score = 0;
      if (sharedTok) { kind = "root"; score = 30 + Math.min(10, sharedTok.gloss.length / 4); }
      else if (formRel(base?.word, other.word)) { kind = "form"; score = 24; }
      else {
        const ov = minOverlap(base?.meaningCN, text);
        if (ov >= 0.34 && ov < 0.8) { kind = "sense"; score = 16 + ov * 6; }
        else {
          const bp = String(base?.pos || ""), op = String(other?.pos || "");
          if (bp && op && bp !== op) { kind = "pos"; score = 10; }
          else { kind = "topic"; score = 4; }
        }
      }
      if (kind === "topic" && !sameCh) continue; // 别的章的词当 topic = "与本章毫无关系"，规范禁止
      if (sameCh && kind !== "topic") score += 6; // 同章优先（同层级）
      score += jitter(base, other);
      if (allowedKinds && !allowedKinds.has(kind)) continue;
      const why = genWhy(base, other, kind);
      if (!whyOk(why)) continue;
      scored.push({ other, kind, score, why });
    }
    return scored;
  };
  let scored = scan(lenBand);
  if (!scored.length) scored = scan([0.45, 2.2]);
  if (!scored.length) scored = scan([0, 2.5]); // 长度只是警告级指标：超长/超短释义好过空话 why 或缺项
  const valuable = scored.filter((c) => KIND_VALUABLE.has(c.kind));
  let order = forceValuable ? valuable : preferValuable && valuable.length ? valuable : scored;
  if (!order.length) order = scored; // 兜底：没有可辨析候选时退回全部
  if (!order.length) {
    if (process.env.QOPT_DEBUG)
      console.error(`    [dbg] pick NULL base=${base?.word} pool=${pool.length} allowed=${allowedKinds ? [...allowedKinds] : "any"} avoid=${avoidTexts.size}`);
    return null;
  }
  order.sort((a, b) => b.score - a.score || String(a.other.word).localeCompare(String(b.other.word)));
  return { other: order[0].other, kind: order[0].kind, why: order[0].why };
}

/** 按 kind 配额计算当前还允许哪些 kind（不含 antonym：永不新造反义项） */
function allowedKindsNow(distractors, skipDi) {
  const count = { topic: 0, pos: 0, antonym: 0, valuable: 0 };
  distractors.forEach((d, i) => {
    if (i === skipDi || !d?.kind) return;
    if (d.kind === "topic") count.topic++;
    else if (d.kind === "pos") count.pos++;
    else if (d.kind === "antonym") { count.antonym++; count.valuable++; }
    else count.valuable++;
  });
  const allowed = new Set(["root", "form", "sense", "topic"]);
  if (count.pos >= 1) allowed.delete("pos");
  if (count.topic >= 2) allowed.delete("topic");
  return { allowed, valuablePresent: count.valuable > 0 };
}

/* ---------- 主流程 ---------- */
const report = [];
for (const c of chapters) {
  if (only && !only.has(c)) continue;
  const words = data.get(c) || [];
  const doc = quiz.get(c);
  const fixlist = JSON.parse(await import("node:fs").then((m) => m.readFileSync(join(root, "_audit", "work", `${c}-fixlist.json`), "utf8")));
  for (const w of words) w._ch = c; // genWhy 同章措辞判断
  const byId = new Map(words.map((w) => [Number(w.id), w]));
  const exactMap = new Map();
  for (const w of words) { const k = normalizeMeaning(w.meaningCN); if (k && !exactMap.has(k)) exactMap.set(k, w); }
  fuzzyPool = globalPool;
  const overused = new Set((fixlist.overused || []).map((o) => o.text));

  const optItems = {};
  const actions = { retext: 0, rewhy: 0, regen: 0, note: 0, skipped: 0, reverted: 0 };
  const pending = []; // {id, item, entry, reason} 全量重写过的条目也要参与万能项迭代

  for (const must of fixlist.must || []) {
    const id = Number(must.id);
    const entry = byId.get(id);
    const cur = must.current || {};
    const reasons = must.reasons || {};
    const answerText = String(entry?.meaningCN || "");

    // 最终条目：从现状拷贝，逐项修
    const item = { ...(cur.distractors ? cur : {}) };
    item.distractors = (cur.distractors || []).map((d) => ({ ...d }));
    if (cur.need) item.need = cur.need;

    const changed = new Set(); // 本条目内被重写的 distractor 下标

    // 1) retext：misalign → why 点名了词 X，把 text 指向 X 的释义
    const misFlag = [...(reasons.misalign || [])];
    const baseWhyDis = new Set([...(reasons.misalign || []).map((m) => m.di)]);
    // reasons 里没有 basewhy（那是 review 类），must 内 misalign 优先 retext
    for (const m of misFlag) {
      const di = m.di;
      const d = item.distractors[di];
      if (!d) continue;
      const r = resolveWhy(d.why || "", tokenIndex);
      const named = [...r.named].filter((w) => Number(w.id) !== Number(id));
      // 优先同章、释义可用（不冲突/不覆盖/长度合适/不在滥用榜）；
      // 比较器必须是全序：原写法 (a)=> some(a)?-1:1 不满足反对称性，排序结果依实现而定
      const inThisChapter = (w) => (data.get(c) || []).some((x) => Number(x.id) === Number(w.id)) ? 0 : 1;
      let hit = null;
      for (const w of named.sort((a, b) => inThisChapter(a) - inThisChapter(b) || String(a.word).localeCompare(String(b.word)))) {
        const t = String(w.meaningCN || "");
        if (!t.trim() || overused.has(normalize(t))) continue;
        if (meaningsConflict(t, answerText)) continue;
        if (senseCover(t, answerText)) continue;
        if (item.distractors.some((x, i) => i !== di && meaningsConflict(x.text, t))) continue;
        const ratio = charLen(t) / Math.max(1, charLen(answerText));
        if (ratio < 0.5 || ratio > 2.0) continue;
        hit = w;
        break;
      }
      if (hit) {
        d.text = hit.meaningCN;
        actions.retext++;
      } else {
        changed.add(di); // retext 失败 → 稍后 regen
      }
    }

    // 2) eng：夹带英文 → regen
    for (const e of reasons.eng || []) changed.add(e.di);

    // 3) ambig：选了也算对 → regen
    for (const a of reasons.ambig || []) changed.add(a.di);

    // 4) extremeLen：长度比出界 → regen（只动出界的）
    for (const l of reasons.extremeLen || []) changed.add(l.di);

    // 5) univ：万能项（text 在滥用榜）→ regen
    (item.distractors || []).forEach((d, di) => {
      if (overused.has(normalize(d.text))) changed.add(di);
    });

    // 6) err：配额违规 → 超额的 regen；空话黑名单 → rewhy 或 regen
    if (reasons.err) {
      const kinds = item.distractors.map((d) => d.kind);
      const extra = (kind, cap) => {
        const idxs = kinds.map((k, i) => (k === kind ? i : -1)).filter((i) => i >= 0);
        return idxs.slice(cap); // 保留前面，超额的标记
      };
      for (const i of extra("antonym", 1)) changed.add(i);
      for (const i of extra("pos", 1)) changed.add(i);
      for (const i of extra("topic", 2)) changed.add(i);
      if (!kinds.some((k) => KIND_VALUABLE.has(k))) {
        // 全是 topic → 换掉最后一个
        let last = -1;
        kinds.forEach((k, i) => { if (k === "topic") last = i; });
        if (last >= 0) changed.add(last);
      }
      for (const e of reasons.err) {
        // 从校验器文案反解下标（与 quiz-lib 的 "第 N 个干扰项" 文案耦合；\d+ 兼容两位数下标）
        const m = String(e).match(/第 (\d+) 个干扰项.*空话模板/);
        if (m) changed.add(Number(m[1]) - 1);
      }
    }

    // 7) tmpl / dupwhy：why 重写（text 若没问题就保留）
    const rewhyDis = new Set();
    for (const t of reasons.tmpl || []) rewhyDis.add(t);
    for (const d of reasons.dupwhy || []) rewhyDis.add(d.di);
    for (const b of reasons.basewhy || []) rewhyDis.add(b.di ?? b);
    for (const di of rewhyDis) {
      if (changed.has(di)) continue;
      const d = item.distractors[di];
      // 找 text 的来源词（精确 → 模糊）
      const src = findSourceByText(d.text, exactMap);
      if (src) {
        const sharedTok = rootPairs(entry).find((p) => rootPairs(src).some((q) => q.tok.toLowerCase() === p.tok.toLowerCase()));
        let kind = sharedTok ? "root" : formRel(entry?.word, src.word) ? "form" : minOverlap(entry?.meaningCN, src.meaningCN) >= 0.34 ? "sense" : String(entry?.pos || "") !== String(src?.pos || "") && src.pos ? "pos" : "topic";
        // kind 接受规则：topic 需同章；pos 需配额（满了且同章降级 topic，跨章放弃）
        const srcSameCh = Number(src?._ch || 0) === c;
        if (kind === "topic" && !srcSameCh) continue;
        if (kind === "pos") {
          const posUsed = item.distractors.filter((x, i) => i !== di && x?.kind === "pos").length;
          if (posUsed >= 1) {
            if (!srcSameCh) continue;
            kind = "topic";
          }
        }
        const why = genWhy(entry, src, kind);
        if (whyOk(why)) { d.why = why; d.kind = kind; actions.rewhy++; continue; }
      }
      changed.add(di);
    }

    // 8) regen：所有 changed 的下标换新干扰项（配额按已放置结果实时计算；池=全词库）
    let reverted = false;
    if (changed.size) {
      const avoid = new Set([normalizeMeaning(answerText)]);
      item.distractors.forEach((d, i) => {
        if (!changed.has(i)) avoid.add(normalizeMeaning(d.text));
      });
      const pool = globalPool.filter((w) => !(Number(w._ch) === c && Number(w.id) === Number(id)));
      const baseChapter = c;
      const needValuable = !item.distractors.some((d, i) => !changed.has(i) && d?.kind && KIND_VALUABLE.has(d.kind));
      let forced = needValuable; // 至少一个 changed 槽位必须给可辨析项
      for (const di of [...changed].sort((a, b) => a - b)) {
        const { allowed, valuablePresent } = allowedKindsNow(item.distractors, di);
        const otherTexts = item.distractors.filter((_, i) => i !== di && !changed.has(i)).map((x) => normalizeMeaning(x.text)).concat(
          [...changed].filter((i2) => i2 !== di && item.distractors[i2]?.text).map((i2) => normalizeMeaning(item.distractors[i2].text))
        );
        const opts = { avoidTexts: avoid, answerText, baseChapter, otherTexts };
        let cand = null;
        if (forced && !valuablePresent) {
          // 这个槽位必须出可辨析项；长度带放宽到规范的警告边界
          cand = pickCandidate(entry, pool, { ...opts, allowedKinds: new Set(["root", "form", "sense"]), forceValuable: true, lenBand: [0.4, 2.5] });
          if (cand) forced = false;
        }
        if (!cand) cand = pickCandidate(entry, pool, { ...opts, allowedKinds: allowed });
        if (!cand) cand = pickCandidate(entry, pool, { ...opts, allowedKinds: allowed, lenBand: [0.45, 2.2] });
        if (cand) {
          if (process.env.QOPT_DEBUG)
            console.error(`    [dbg] #${id} di=${di} allowed=[${[...allowed]}] picked=${cand.kind} ${cand.other.word}(ch${cand.other._ch})`);
          item.distractors[di] = { text: cand.other.meaningCN, kind: cand.kind, why: cand.why };
          avoid.add(normalizeMeaning(cand.other.meaningCN));
          actions.regen++;
        } else {
          actions.skipped++;
        }
      }
      // why 黑名单清扫：保留的原 why 也要过现行正则黑名单（rewhy 失败就换新干扰项）
      for (let di = 0; di < item.distractors.length; di++) {
        if (changed.has(di)) continue;
        const d = item.distractors[di];
        if (!WHY_BLACKLIST.some((re) => re.test(String(d.why || "")))) continue;
        const src = findSourceByText(d.text, exactMap);
        if (src) {
          const sharedTok = rootPairs(entry).find((p) => rootPairs(src).some((q) => q.tok.toLowerCase() === p.tok.toLowerCase()));
          const kind = sharedTok ? "root" : formRel(entry?.word, src.word) ? "form" : minOverlap(entry?.meaningCN, src.meaningCN) >= 0.34 ? "sense" : String(entry?.pos || "") !== String(src?.pos || "") && src.pos ? "pos" : "topic";
          const why = genWhy(entry, src, kind);
          if (whyOk(why)) { d.why = why; d.kind = kind; continue; }
        }
        const { allowed: allowedSweep } = allowedKindsNow(item.distractors, di);
        const otherTextsS = item.distractors.filter((_, i) => i !== di).map((x) => normalizeMeaning(x.text));
        const candS = pickCandidate(entry, globalPool.filter((w) => !(Number(w._ch) === c && Number(w.id) === Number(id))), {
          avoidTexts: new Set([normalizeMeaning(answerText), ...otherTextsS]),
          answerText, otherTexts: otherTextsS, allowedKinds: allowedSweep, baseChapter: c,
        });
        if (candS) { item.distractors[di] = { text: candS.other.meaningCN, kind: candS.kind, why: candS.why }; actions.regen++; }
      }

      // 兜底：整题仍没有可辨析项 → 再抢一次；仍失败就整题回退（保持可 merge）
      if (!item.distractors.some((d) => KIND_VALUABLE.has(d.kind))) {
        for (const di of [...changed]) {
          const avoid2 = new Set([normalizeMeaning(answerText), ...item.distractors.filter((_, i) => i !== di).map((x) => normalizeMeaning(x.text))]);
          const otherTexts2 = item.distractors.filter((_, i) => i !== di && item.distractors[i]?.text).map((x) => normalizeMeaning(x.text));
          const cand = pickCandidate(entry, pool, {
            avoidTexts: avoid2, answerText, baseChapter: c, otherTexts: otherTexts2,
            allowedKinds: new Set(["root", "form", "sense"]), forceValuable: true, lenBand: [0.4, 2.5],
          });
          if (cand) {
            item.distractors[di] = { text: cand.other.meaningCN, kind: cand.kind, why: cand.why };
            actions.regen++;
            break;
          }
        }
      }
      if (!item.distractors.some((d) => KIND_VALUABLE.has(d.kind))) {
        item.distractors = (cur.distractors || []).map((d) => ({ ...d }));
        actions.reverted++;
        reverted = true;
      }
    }

    // 8.5) 同题 why 去重：撞车时用两段释义重写后出现的那条
    {
      const seenW = new Set();
      for (const d of item.distractors) {
        if (seenW.has(d.why)) {
          const src = findSourceByText(d.text, exactMap);
          if (src) {
            const om2 = String(src.meaningCN || "").split(/[，,；;、]/).slice(0, 2).join("，").slice(0, 14);
            const cand2 = `${String(src.word || "")} 指${om2}，${String(entry?.word || "")} 指${shortOf(entry?.meaningCN)}`;
            if (whyOk(cand2) && !seenW.has(cand2)) { d.why = cand2; }
          }
        }
        seenW.add(d.why);
      }
    }

    // 9) noNote：补记忆点
    if (reasons.noNote && !item.note) {
      const note = genNote(entry);
      if (note) { item.note = note; actions.note++; }
    }

    // 清理：恰好 3 条、字段齐（reverted 的条目不产出）
    item.distractors = item.distractors.slice(0, 3);
    if (!reverted && item.distractors.length === 3 && item.distractors.every((d) => d.text && d.kind && d.why)) {
      const clean = {};
      if (item.note) clean.note = item.note;
      if (item.need && item.need !== "spell") clean.need = item.need;
      clean.distractors = item.distractors;
      optItems[String(id)] = clean;
      pending.push({ id, entry, item: clean });
    } else {
      actions.skipped++;
    }
  }

  // 10) 万能项迭代：章内同 text ≥3 次的实例再换（扫全章所有条目，非必修条目的修复同样写入 opt 文件；与 regen 同一套配额）
  for (let round = 0; round < 4; round++) {
    const count = new Map();
    for (const [idStr, it] of Object.entries(doc.items)) {
      const fin = optItems[idStr] || it;
      for (const d of fin.distractors || []) {
        const k = normalizeMeaning(d.text);
        count.set(k, (count.get(k) || 0) + 1);
      }
    }
    chapterFreq = count;
    let moved = 0;
    // 全章收集：任何条目（含非必修）中 count≥3 的 text 实例都参与置换
    const univTargets = [];
    for (const [idStr, it] of Object.entries(doc.items)) {
      const fin = optItems[idStr] || it;
      const hit = (fin.distractors || []).some((d) => (count.get(normalizeMeaning(d.text)) || 0) >= 3);
      if (!hit) continue;
      const entryU = byId.get(Number(idStr));
      if (!entryU) continue;
      if (!optItems[idStr]) {
        const cleanU = {};
        if (it.note) cleanU.note = it.note;
        if (it.need && it.need !== "spell") cleanU.need = it.need;
        cleanU.distractors = fin.distractors;
        optItems[idStr] = cleanU;
      }
      univTargets.push({ id: Number(idStr), entry: entryU, item: optItems[idStr] });
    }
    for (const { id, entry, item } of univTargets) {
      const answerText = String(entry?.meaningCN || "");
      for (let di = 0; di < 3; di++) {
        const d = item.distractors[di];
        const k = normalizeMeaning(d.text);
        if ((count.get(k) || 0) < 3) continue;
        const avoid = new Set([
          normalizeMeaning(answerText),
          ...item.distractors.filter((_, i) => i !== di).map((x) => normalizeMeaning(x.text)),
        ]);
        const { allowed, valuablePresent } = allowedKindsNow(item.distractors, di);
        const pool = globalPool.filter((w) => !(Number(w._ch) === c && Number(w.id) === Number(id)));
        const otherTexts = item.distractors.filter((_, i) => i !== di).map((x) => normalizeMeaning(x.text));
        // 若被替换槽是本题唯一可辨析项，必须换回可辨析类
        const allowedUse = KIND_VALUABLE.has(d.kind) && !valuablePresent ? new Set(["root", "form", "sense"]) : allowed;
        let cand = pickCandidate(entry, pool, {
          allowedKinds: allowedUse,
          avoidTexts: avoid,
          answerText,
          otherTexts,
          preferValuable: false,
          baseChapter: c,
        });
        if (!cand && allowedUse === allowed) cand = pickCandidate(entry, pool, { allowedKinds: null, avoidTexts: avoid, answerText, otherTexts, preferValuable: false, baseChapter: c, lenBand: [0.45, 2.2] });
        if (cand) {
          item.distractors[di] = { text: cand.other.meaningCN, kind: cand.kind, why: cand.why };
          count.set(k, (count.get(k) || 0) - 1);
          const nk = normalizeMeaning(cand.other.meaningCN);
          count.set(nk, (count.get(nk) || 0) + 1);
          moved++;
        }
      }
    }
    if (!moved) break;
    actions.regen += moved;
  }

  // 11) 内存预校验：合并后的整章跑 validateQuizDoc，报错打印（merge 时还会再验一次）
  const mergedItems = { ...doc.items, ...optItems };
  const { errors } = validateQuizDoc({ ...doc, items: mergedItems }, { chapter: c, words });

  writeFileSync(
    join(root, "content", "quiz", `${c}-opt.json`),
    JSON.stringify(
      {
        spec: QUIZ_SPEC_VERSION,
        chapter: c,
        source: "model+human",
        generator: `quiz-optimize-${new Date().toISOString().slice(0, 10)}`,
        updatedAt: new Date().toISOString().slice(0, 10),
        items: optItems,
      },
      null,
      1
    ) + "\n"
  );
  report.push({ chapter: c, optItems: Object.keys(optItems).length, ...actions, preErrors: errors.length });
  for (const e of errors.slice(0, 8)) console.log(`  ch${c} ✖ ${e}`);
}

console.table(report);
const tot = report.reduce((a, r) => ({ opt: a.opt + r.optItems, retext: a.retext + r.retext, rewhy: a.rewhy + r.rewhy, regen: a.regen + r.regen, note: a.note + r.note, skip: a.skipped + r.skipped, err: a.err + r.preErrors }), { opt: 0, retext: 0, rewhy: 0, regen: 0, note: 0, skip: 0, err: 0 });
console.log("TOTAL", JSON.stringify(tot));
// 退出码：预校验有 error 时置 1（--strict 供门禁使用）；正常产出仍写文件，交 merge 收口再校验
if (tot.err > 0 && process.argv.includes("--strict")) {
  console.error(`strict：${tot.err} 条预校验错误`);
  process.exit(1);
}
