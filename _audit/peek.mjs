import { readFile } from "node:fs/promises";
const ch = Number(process.argv[2] || 1);
const ids = (process.argv[3] || "1,3").split(",");
const q = JSON.parse(await readFile(`public/quiz-${ch}.json`, "utf8"));
const d = JSON.parse(await readFile(`public/data-${ch}.json`, "utf8"));
const byId = new Map(d.map((w) => [String(w.id), w]));
for (const id of ids) {
  const w = byId.get(id);
  console.log(`\n===== ch${ch} #${id} ${w?.word} =====`);
  console.log(`  正确释义: ${w?.meaningCN}   (root: ${w?.root})`);
  const it = q.items[id];
  console.log(`  note: ${it?.note}`);
  for (const [i, dd] of (it?.distractors || []).entries()) {
    console.log(`  [${i + 1}] kind=${dd.kind}  text=「${dd.text}」`);
    console.log(`      why=「${dd.why}」`);
  }
}
