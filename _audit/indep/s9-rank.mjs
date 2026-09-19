// s9-rank.mjs —— 分章质量排名（综合模板句、错位、歧义、万能项、长度）
// 缺陷分 = 2*模板 + 3*错位hard + 3*歧义并集 + 万能项实例(text章内出现≥5次的实例数) + 0.5*长度不合格
// 排名值 = 缺陷分 / 章内干扰项数 × 100（每百条干扰项的加权缺陷分）
import { loadAll, writeOut, buildTokenIndex, resolveWhy, minOverlap, normalize, senseCover, jaccard, matchTemplate, WHY_BLACKLIST, pct } from "./lib.mjs";

const { chapters, data, quiz } = await loadAll();
const idx = buildTokenIndex(data);

const rows = [];
for (const c of chapters) {
  const byId = new Map(data.get(c).map((w) => [Number(w.id), w]));
  const st = { c, items: 0, dist: 0, template: 0, misalignHard: 0, ambig: 0, lenFail: 0, univInst: 0 };
  const textCnt = new Map();
  const all = [];
  for (const [id, item] of Object.entries(quiz.get(c).items || {})) {
    const w = byId.get(Number(id));
    if (!w) continue;
    st.items++;
    const answer = String(w.meaningCN ?? "");
    const na = normalize(answer);
    for (const d of item.distractors || []) {
      st.dist++;
      const text = String(d?.text ?? ""), why = String(d?.why ?? "");
      const nt = normalize(text);
      textCnt.set(nt, (textCnt.get(nt) || 0) + 1);
      all.push({ text, why, nt, na, answer });
    }
  }
  for (const { text, why, nt, na, answer } of all) {
    if (matchTemplate(why)) st.template++;
    const r = resolveWhy(why, idx);
    if (r.tokens.length && r.allResolved && minOverlap(why, text) === 0) {
      const matchesOption = [...r.named].some((n) => n.word === nt || minOverlap(n.meaningCN, text) > 0);
      if (!matchesOption) {
        const matchesAnswer = [...r.named].some((n) => minOverlap(n.meaningCN, answer) > 0);
        if (!matchesAnswer) st.misalignHard++;
      }
    }
    let amb = false;
    if (nt && na && (nt === na || nt.includes(na) || na.includes(nt))) amb = true;
    if (!amb && senseCover(text, answer) === "covered") amb = true;
    if (!amb && jaccard(text, answer) >= 0.6) amb = true;
    if (amb) st.ambig++;
    const ratio = nt.length / Math.max(1, na.length);
    if (ratio < 0.5 || ratio > 2.0) st.lenFail++;
  }
  for (const n of textCnt.values()) if (n >= 5) st.univInst += n;
  st.defectScore = 2 * st.template + 3 * st.misalignHard + 3 * st.ambig + st.univInst + 0.5 * st.lenFail;
  st.per100 = +(st.defectScore / Math.max(1, st.dist) * 100).toFixed(1);
  rows.push(st);
}

rows.sort((a, b) => b.per100 - a.per100);
const worst = rows.slice(0, 5), best = rows.slice(-5).reverse();
await writeOut("s9-rank.json", JSON.stringify({ all: rows, worst5: worst, best5: best }, null, 1));
console.log("WORST5:");
for (const r of worst) console.log(`  ch${r.c}: per100=${r.per100} tpl=${r.template} mis=${r.misalignHard} amb=${r.ambig} univ=${r.univInst} len=${r.lenFail} dist=${r.dist}`);
console.log("BEST5:");
for (const r of best) console.log(`  ch${r.c}: per100=${r.per100} tpl=${r.template} mis=${r.misalignHard} amb=${r.ambig} univ=${r.univInst} len=${r.lenFail} dist=${r.dist}`);
