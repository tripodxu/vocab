import { readFile } from "node:fs/promises";
const d = JSON.parse(await readFile("public/data-22.json", "utf8"));
console.log("data-22 keys:", Object.keys(d).slice(0, 10));
console.log("sample:", JSON.stringify(Array.isArray(d) ? d.slice(0, 3) : d, null, 1).slice(0, 1000));
const q = JSON.parse(await readFile("public/quiz-22.json", "utf8"));
console.log("quiz-22 top keys:", Object.keys(q));
console.log("item count:", Object.keys(q.items || {}).length);
console.log(JSON.stringify(Object.entries(q.items || {}).slice(0, 2), null, 1));
