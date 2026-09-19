import { readFile } from "node:fs/promises";
const r = JSON.parse(await readFile("_audit/audit-report.json", "utf8"));
const type = process.argv[2];
const n = Number(process.argv[3] || 12);
const want = r.flags.filter((f) => f.type === type);
console.log(`type=${type} 共 ${want.length} 条\n`);
for (const f of want.slice(0, n)) console.log(JSON.stringify(f, null, 1));
