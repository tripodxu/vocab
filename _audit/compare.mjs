import { readFile } from "node:fs/promises";
// 对比 content/quiz 原始分片 与 public/quiz-N.json（合并+修复后）
const ch = Number(process.argv[2] || 1);
const shard = process.argv[3] || `${ch}.json`;
const ids = (process.argv[4] || "1,2,3").split(",");
const orig = JSON.parse(await readFile(`content/quiz/${shard}`, "utf8"));
const pub = JSON.parse(await readFile(`public/quiz-${ch}.json`, "utf8"));
const data = JSON.parse(await readFile(`public/data-${ch}.json`, "utf8"));
const byId = new Map(data.map((w) => [String(w.id), w]));
for (const id of ids) {
  const w = byId.get(id);
  console.log(`\n########## #${id} ${w?.word}  正确释义「${w?.meaningCN}」`);
  const a = orig.items?.[id], b = pub.items?.[id];
  if (!a) console.log("  (原始分片无此 id)");
  else {
    console.log("  --- 原始分片 ---");
    for (const d of a.distractors || []) console.log(`   [${d.kind}] ${d.text}  ||why: ${d.why}`);
  }
  console.log("  --- 已发布 ---");
  for (const d of b?.distractors || []) console.log(`   [${d.kind}] ${d.text}  ||why: ${d.why}`);
}
