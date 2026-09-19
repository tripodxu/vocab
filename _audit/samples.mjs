import { readFile } from "node:fs/promises";
const r = JSON.parse(await readFile("_audit/desync2-report.json", "utf8"));
const chs = (process.argv[2] || "3,5,19,20,21").split(",").map(Number);
const per = Number(process.argv[3] || 5);
for (const c of chs) {
  const rows = r.samples.filter((x) => x.chapter === c);
  console.log(`\n########## 第 ${c} 章（不一致样例 ${rows.length} 条中取 ${per}）`);
  for (const x of rows.slice(0, per)) {
    console.log(`  #${x.id} ${x.word}「${x.answer}」  [${x.kind}]${x.replaced ? " (选项被脚本换过)" : " (原始保留)"}`);
    console.log(`     选项: 「${x.text}」${x.textSource ? ` = 词库词 ${x.textSource}` : " ← 词库里没有这个词条"}`);
    console.log(`     辨析: 「${x.why}」${x.named.length ? ` ← 点名了 ${x.named.join("/")}` : ""}`);
  }
}
