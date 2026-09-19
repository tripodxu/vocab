import { readFile, readdir } from "node:fs/promises";
const chapters = (await readdir("public")).filter((f) => /^data-\d+\.json$/.test(f)).map((f) => Number(f.match(/\d+/)[0])).sort((a, b) => a - b);
const normalize = (t) => String(t ?? "").replace(/[\s\u3000]+/g, "")
  .replace(/[，,；;、。.．··:：!！?？"'“”‘’()（）[\]【】<>《》/\\|-]/g, "").toLowerCase();
let needRead = 0, withNote = 0, items = 0, noNote = [];
const uniPerChapter = {}, usage = new Map();
for (const c of chapters) {
  const data = JSON.parse(await readFile(`public/data-${c}.json`, "utf8"));
  const q = JSON.parse(await readFile(`public/quiz-${c}.json`, "utf8"));
  const local = new Map();
  for (const [id, it] of Object.entries(q.items)) {
    items++;
    if (it.need === "read") needRead++;
    if (it.note) withNote++; else noNote.push(`ch${c} #${id}`);
    for (const d of it.distractors || []) {
      const k = normalize(d.text);
      local.set(k, (local.get(k) || 0) + 1);
      usage.set(k, (usage.get(k) || 0) + 1);
    }
  }
  const top = [...local.entries()].filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]).slice(0, 3);
  if (top.length) uniPerChapter[c] = top;
}
console.log(`条目 ${items}；need:"read" ${needRead}；有 note ${withNote}（无 note ${items - withNote}）`);
console.log("\n章内重复使用的干扰项（≥3 次，前 3）:");
for (const [c, top] of Object.entries(uniPerChapter)) console.log(`  ch${c}: ` + top.map(([t, n]) => `${n}×「${t.slice(0, 14)}」`).join("  "));
console.log("\n全库跨章使用 ≥8 次的释义（万能干扰项）:");
const g = [...usage.entries()].filter(([, n]) => n >= 8).sort((a, b) => b[1] - a[1]).slice(0, 15);
for (const [t, n] of g) console.log(`  ${n}× ${t.slice(0, 24)}`);
console.log(`\n无 note 的条目样例: ${noNote.slice(0, 8).join(", ")} ...`);
