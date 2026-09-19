// s2-template.mjs —— 机器模板 why 扫描：5 大主张模式 + 扩展脚本模板 + 附录 A 黑名单
import { loadAll, writeOut, WHY_BLACKLIST, TEMPLATES, matchTemplate, pct } from "./lib.mjs";

const { chapters, data, quiz } = await loadAll();

const perPattern = new Map(TEMPLATES.map((t) => [t.key, { n: 0, samples: [] }]));
const perChapter = new Map(chapters.map((c) => [c, 0]));
const blacklistHits = [];
let total = 0, totalDist = 0, blacklistN = 0;
// 复现报告 828 的归并口径：form-confuse 报告行 = 形近易混(56) + 但含义侧重不同(20)
let focusOnly = 0, focusVariant = 0;
const RE_FOCUS = /但含义侧重不同/;
const RE_FOCUS_VAR = /侧重.{1,12}，而.{1,12}侧重/;
const claim828Chapter = new Map(chapters.map((c) => [c, 0]));

for (const c of chapters) {
  const byId = new Map(data.get(c).map((w) => [Number(w.id), w]));
  for (const [id, item] of Object.entries(quiz.get(c).items || {})) {
    const w = byId.get(Number(id));
    for (const d of item.distractors || []) {
      totalDist++;
      const why = String(d?.why ?? "");
      const t = matchTemplate(why);
      if (t) {
        total++;
        perChapter.set(c, perChapter.get(c) + 1);
        const bucket = perPattern.get(t.key);
        bucket.n++;
        if (bucket.samples.length < 3) {
          bucket.samples.push({ c, id, word: w?.word, text: d.text, why });
        }
        // 828 口径：5 个主张模式，其中 form-confuse 行并入“但含义侧重不同”
        const isClaim5 = ["len-tag（|长度修复|避免最长项可猜）", "pos-short（X 词性不同）", "sense-diff（X 与 Y 意思有区别）", "form-confuse（“X”与“Y”形近易混，但实际含义不同）", "semantic-field（属同一语义场，但具体所指不同）"].includes(t.key);
        const isFocus = t.key.startsWith("ext:focus-diff");
        if (isClaim5 || (isFocus && RE_FOCUS.test(why))) {
          claim828Chapter.set(c, claim828Chapter.get(c) + 1);
        }
      }
      if (RE_FOCUS.test(why)) focusOnly++;
      else if (RE_FOCUS_VAR.test(why)) focusVariant++;
      if (WHY_BLACKLIST.some((re) => re.test(why))) {
        blacklistN++;
        if (blacklistHits.length < 10) blacklistHits.push({ c, id, word: w?.word, why });
      }
    }
  }
}

const byChapter = [...perChapter.entries()].sort((a, b) => b[1] - a[1]);
const claim828Total = [...claim828Chapter.values()].reduce((a, b) => a + b, 0);
const out = {
  totalTemplate: total, totalDistractors: totalDist, pct: pct(total, totalDist),
  blacklistN,
  claim828Total, claim828Chapter: [...claim828Chapter.entries()].sort((a, b) => b[1] - a[1]),
  focusOnlyButMeaningFocusDiff: focusOnly, focusVariantXerY: focusVariant,
  byPattern: [...perPattern.entries()].map(([k, v]) => ({ key: k, n: v.n, samples: v.samples })),
  byChapterTop10: byChapter.slice(0, 10),
  byChapterAll: byChapter,
  blacklistHits,
};
await writeOut("s2-template.json", JSON.stringify(out, null, 1));
console.log(`template=${total}/${totalDist} (${pct(total, totalDist)}%)  blacklist=${blacklistN}`);
console.log(`claim828-equivalent=${claim828Total}`);
for (const [c, n] of byChapter.slice(0, 10)) console.log(`  ch${c}: ${n}`);
