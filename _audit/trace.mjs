import { readFile } from "node:fs/promises";
// 直接看某个 id 在各中间产物里的形态，判断"text 被换、why 未换"发生在哪一步
const ch = Number(process.argv[2] || 1);
const id = String(process.argv[3] || "1");
const files = process.argv.slice(4);
const data = JSON.parse(await readFile(`public/data-${ch}.json`, "utf8"));
const w = data.find((x) => String(x.id) === id);
console.log(`ch${ch} #${id} ${w?.word} 正确释义「${w?.meaningCN}」`);
for (const f of files) {
  let doc;
  try { doc = JSON.parse(await readFile(`content/quiz/${f}`, "utf8")); }
  catch { try { doc = JSON.parse(await readFile(`public/${f}`, "utf8")); } catch (e) { console.log(`  ${f}: 读不到`); continue; } }
  const it = doc.items?.[id];
  console.log(`\n--- ${f} ---`);
  if (!it) { console.log("   (无此 id)"); continue; }
  for (const d of it.distractors || []) console.log(`   [${d.kind}] 「${d.text}」\n        why: ${d.why}`);
}
