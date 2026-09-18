import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_OPTION_COUNT,
  buildChoiceQuestion,
  classifyDistractor,
  commonPrefix,
  commonSuffix,
  explainChoice,
  gradeChoice,
  hashSeed,
  isNearMiss,
  isUsableDistractor,
  meaningOverlap,
  meaningsConflict,
  normalizeMeaning,
  optionLabel,
  pickDistractors,
  questionKey,
  rootTokens,
  seededRng,
  sharedRoots,
  shuffleWith,
} from "../public/quiz.js";
import {
  DISTRACTOR_COUNT,
  PROMPT_MARKERS,
  buildQuizIndex,
  emptyQuizDoc,
  extractModelPrompt,
  mergeQuizDocs,
  normalizeQuizDoc,
  validateQuizDoc,
} from "../scripts/quiz-lib.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

/* ============ 词库（真实数据） ============ */

const chapter1 = JSON.parse(readFileSync(path.join(root, "public", "data-1.json"), "utf8"));
const chapter20 = JSON.parse(readFileSync(path.join(root, "public", "data-20.json"), "utf8"));
const byWord = (list, word) => list.find((w) => w.word === word);

const build = (entry, pool = chapter1, curated = null) =>
  buildChoiceQuestion({
    chapter: 1,
    entry,
    pool,
    rng: seededRng(questionKey(1, entry.id)),
    curated,
  });

/* ============ 文本工具 ============ */

test("normalizeMeaning：忽略空白与所有标点", () => {
  assert.equal(normalizeMeaning("大气层，大气圈；气氛"), "大气层大气圈气氛");
  assert.equal(normalizeMeaning("  a-b c  "), "abc");
  assert.equal(normalizeMeaning(null), "");
});

test("meaningsConflict：重复/包含都算冲突（两个选项都说得通）", () => {
  assert.equal(meaningsConflict("大气层，大气圈；气氛", "气氛"), true);
  assert.equal(meaningsConflict("岩石圈", "岩石圈"), true);
  assert.equal(meaningsConflict("岩石圈", "水圈；大气中的水汽"), false);
  assert.equal(meaningsConflict("", "岩石圈"), true);
});

test("commonPrefix / commonSuffix / isNearMiss：拼写相近的三种信号", () => {
  assert.equal(commonPrefix("adapt", "adopt"), 2);
  assert.equal(commonSuffix("hydrosphere", "lithosphere"), 7); // "osphere"
  assert.equal(commonSuffix("Act", "act"), 3);
  // 只差一个字母（等长）——比"前缀相同"更值得出题
  assert.equal(isNearMiss("adapt", "adopt"), true);
  assert.equal(isNearMiss("affect", "effect"), true);
  assert.equal(isNearMiss("adapt", "adept"), true);
  assert.equal(isNearMiss("act", "apt"), false); // 太短，容易误判
  assert.equal(isNearMiss("atmosphere", "lithosphere"), false);
  assert.equal(isNearMiss("cat", "cats"), false); // 长度不同
});

test("rootTokens / sharedRoots：从 root 字段里认出拉丁词根", () => {
  const atmo = byWord(chapter1, "atmosphere");
  const hydro = byWord(chapter1, "hydrosphere");
  const litho = byWord(chapter1, "lithosphere");
  assert.deepEqual([...rootTokens(atmo)].sort(), ["atmo", "sphere"]);
  assert.deepEqual(sharedRoots(atmo, hydro), ["sphere"]);
  assert.deepEqual(sharedRoots(atmo, litho), ["sphere"]);
  // 少于 3 个字母的碎片（非 ASCII 被截断产生）不算词根
  assert.equal([...rootTokens({ root: "源自 dǣd（行为）→ 行为" })].includes("d"), false);
});

test("meaningOverlap：释义用词重合度", () => {
  assert.ok(meaningOverlap("水圈；大气中的水汽", "水圈") > 0.5);
  assert.equal(meaningOverlap("岩石圈", "寒冷的"), 0);
});

/* ============ 随机与洗牌 ============ */

test("seededRng：同一颗种子结果一致，不同种子结果不同", () => {
  const a = seededRng("1:1");
  const b = seededRng("1:1");
  const c = seededRng("1:2");
  const seqA = [a(), a(), a()];
  assert.deepEqual(seqA, [b(), b(), b()]);
  assert.notDeepEqual(seqA, [c(), c(), c()]);
  assert.equal(hashSeed("1:1") === hashSeed("1:2"), false);
});

test("shuffleWith：不改原数组，同样 rng 得到同样结果", () => {
  const input = [1, 2, 3, 4, 5];
  const out = shuffleWith(input, seededRng("x"));
  assert.deepEqual(input, [1, 2, 3, 4, 5]);
  assert.deepEqual(out, shuffleWith(input, seededRng("x")));
  assert.deepEqual([...out].sort(), input);
});

test("optionLabel：A/B/C/D", () => {
  assert.equal(optionLabel(0), "A");
  assert.equal(optionLabel(3), "D");
});

/* ============ 干扰项挑选 ============ */

test("classifyDistractor：同词根最常见，也最容易混", () => {
  const base = byWord(chapter1, "atmosphere");
  const info = classifyDistractor(base, byWord(chapter1, "hydrosphere"));
  assert.equal(info.kind, "root");
  assert.ok(info.why.includes("sphere"));
});

test("classifyDistractor：词性不同会给词性提示", () => {
  const base = byWord(chapter20, "act"); // v./n.
  const info = classifyDistractor(base, { id: 999, word: "temporary", pos: "adj.", meaningCN: "临时的" });
  assert.equal(info.kind, "pos");
  assert.ok(info.why.includes("adj."));
});

test("isUsableDistractor：排除同一个词、释义冲突、同词形", () => {
  const base = byWord(chapter1, "atmosphere");
  assert.equal(isUsableDistractor(base, base), false);
  assert.equal(isUsableDistractor(base, { id: 2, word: "atmospheres", meaningCN: "别的东西" }), false);
  assert.equal(isUsableDistractor(base, { id: 3, word: "mood", meaningCN: "气氛" }), false);
  assert.equal(isUsableDistractor(base, { id: 4, word: "lithosphere", meaningCN: "岩石圈" }), true);
  // 与"已占用的释义"冲突的候选也要排除
  assert.equal(isUsableDistractor(base, { id: 5, word: "hemisphere", meaningCN: "半球" }, ["半球"]), false);
  assert.equal(isUsableDistractor(base, { id: 6, word: "hemisphere", meaningCN: "半球" }, []), true);
});

test("pickDistractors：数量正确、不重复、不与正确释义冲突", () => {
  const base = byWord(chapter1, "atmosphere");
  const picked = pickDistractors(base, chapter1, 3, seededRng("pick"));
  assert.equal(picked.length, 3);
  const texts = picked.map((d) => d.text);
  assert.equal(new Set(texts).size, 3);
  for (const text of texts) {
    assert.equal(meaningsConflict(base.meaningCN, text), false, `${text} 与正确释义冲突`);
    assert.ok(picked.every((d) => d.why && d.kind && d.source === "generated"));
  }
});

test("pickDistractors：同词根优先（-sphere 家族会被优先选中）", () => {
  const base = byWord(chapter1, "atmosphere");
  const picked = pickDistractors(base, chapter1, 3, seededRng("root-first"));
  assert.ok(picked.filter((d) => d.kind === "root").length >= 2, JSON.stringify(picked.map((d) => d.kind)));
});

test("pickDistractors：词池太小时不报错，返回能拿到的数量", () => {
  const base = { id: 1, word: "alpha", meaningCN: "第一个", pos: "n." };
  const tiny = [base, { id: 2, word: "beta", meaningCN: "第二个", pos: "n." }];
  const picked = pickDistractors(base, tiny, 3, seededRng("tiny"));
  assert.equal(picked.length, 1);
  assert.equal(picked[0].text, "第二个");
  assert.deepEqual(pickDistractors(base, [base], 3, seededRng("only")), []);
});

test("pickDistractors：有可辨析候选时，topic 型最多 2 个", () => {
  const base = { id: 1, word: "sphere", meaningCN: "球体", pos: "n.", root: "sphere（球体）" };
  const pool = [base, { id: 2, word: "atmo", meaningCN: "水汽", pos: "n.", root: "atmo（水汽）+ sphere（球体）" }];
  // 一堆"同主题但毫无关系"的候选
  for (let i = 3; i <= 10; i++) {
    pool.push({ id: i, word: `zq${i}x`, meaningCN: `无关概念${i}`, pos: "n.", root: "" });
  }
  const picked = pickDistractors(base, pool, 3, seededRng("topic-cap"));
  assert.equal(picked.length, 3);
  assert.equal(picked.filter((d) => d.kind === "topic").length, 2);
  assert.equal(picked[0].kind, "root");
});

test("pickDistractors：词池里只有同主题候选时，仍然补满选项（题目不能缺项）", () => {
  const base = { id: 1, word: "alpha", meaningCN: "第一个", pos: "n." };
  const pool = [base];
  for (let i = 2; i <= 12; i++) pool.push({ id: i, word: `zq${i}x`, meaningCN: `无关概念${i}`, pos: "n." });
  const picked = pickDistractors(base, pool, 3, seededRng("topic"));
  assert.equal(picked.length, 3);
  assert.ok(picked.every((d) => d.kind === "topic"));
});

/* ============ 出题 ============ */

test("buildChoiceQuestion：4 个选项、恰好 1 个正确、correctIndex 指向它", () => {
  for (const word of ["atmosphere", "hydrosphere", "cliff", "carbon dioxide"]) {
    const entry = byWord(chapter1, word);
    const question = build(entry);
    assert.equal(question.options.length, DEFAULT_OPTION_COUNT, word);
    assert.equal(question.options.filter((o) => o.correct).length, 1, word);
    assert.equal(question.options[question.correctIndex].correct, true, word);
    assert.equal(question.options[question.correctIndex].text, entry.meaningCN, word);
    assert.equal(question.answer, entry.meaningCN);
    assert.equal(question.word, entry.word);
  }
});

test("buildChoiceQuestion：选项之间不会出现两个都说得通", () => {
  for (const entry of chapter1.slice(0, 60)) {
    const question = build(entry);
    const texts = question.options.map((o) => o.text);
    for (let i = 0; i < texts.length; i++) {
      for (let j = i + 1; j < texts.length; j++) {
        assert.equal(meaningsConflict(texts[i], texts[j]), false, `${entry.word}: ${texts[i]} vs ${texts[j]}`);
      }
    }
  }
});

test("buildChoiceQuestion：正确答案不会永远在 A（位置随词变化）", () => {
  const positions = new Set();
  for (const entry of chapter1.slice(0, 40)) positions.add(build(entry).correctIndex);
  assert.ok(positions.size >= 3, `只出现了 ${[...positions].join(",")}`);
  assert.ok(positions.has(0) && positions.has(1));
});

test("buildChoiceQuestion：同一题重复构建，选项顺序完全一致（不会跳位）", () => {
  const entry = byWord(chapter1, "atmosphere");
  const a = build(entry);
  const b = build(entry);
  assert.deepEqual(a.options.map((o) => o.text), b.options.map((o) => o.text));
  assert.equal(a.correctIndex, b.correctIndex);
});

test("buildChoiceQuestion：精编题源优先，自动生成只补差额", () => {
  const entry = byWord(chapter1, "atmosphere");
  const curated = {
    note: "atmo（气体）+ sphere（球）→ 包住地球的气体层",
    distractors: [
      { text: "水圈；大气中的水汽", kind: "root", why: "hydro- 是水" },
      { text: "岩石圈", kind: "root", why: "litho- 是石" },
    ],
  };
  const question = build(entry, chapter1, curated);
  assert.equal(question.options.length, 4);
  assert.equal(question.hasCurated, true);
  assert.equal(question.generatedCount, 1);
  assert.equal(question.note, curated.note);
  const texts = question.options.map((o) => o.text);
  assert.ok(texts.includes("水圈；大气中的水汽") && texts.includes("岩石圈"));
  assert.equal(question.options[question.correctIndex].why, curated.note);
});

test("buildChoiceQuestion：精编干扰项非法时被丢弃（不会污染选项）", () => {
  const entry = byWord(chapter1, "atmosphere");
  const curated = {
    distractors: [
      { text: "气氛", kind: "sense", why: "空话" }, // 与正确释义包含 → 丢弃
      { text: "水圈；大气中的水汽", kind: "root", why: "hydro- 是水" },
      { text: "水圈；大气中的水汽", kind: "root", why: "重复" }, // 重复 → 丢弃
    ],
  };
  const question = build(entry, chapter1, curated);
  const texts = question.options.map((o) => o.text);
  assert.equal(texts.filter((t) => t === "水圈；大气中的水汽").length, 1);
  assert.equal(texts.includes("气氛"), false);
  assert.equal(question.options.length, 4);
});

test("buildChoiceQuestion：真实的 22 章词库都能出题（不抛错、选项合法）", async () => {
  for (let chapter = 1; chapter <= 22; chapter++) {
    const words = JSON.parse(readFileSync(path.join(root, "public", `data-${chapter}.json`), "utf8"));
    for (const entry of words.slice(0, 25)) {
      const question = buildChoiceQuestion({
        chapter,
        entry,
        pool: words,
        rng: seededRng(questionKey(chapter, entry.id)),
      });
      assert.equal(question.options.length, 4, `第${chapter}章 ${entry.word}`);
      assert.equal(question.options[question.correctIndex].text, entry.meaningCN);
      const texts = question.options.map((o) => o.text);
      assert.equal(new Set(texts).size, 4, `第${chapter}章 ${entry.word} 选项重复`);
      assert.ok(texts.every((t) => t && t.trim()), `第${chapter}章 ${entry.word} 有空选项`);
    }
  }
});

/* ============ 判分与讲解 ============ */

test("gradeChoice：按下标判分", () => {
  const question = build(byWord(chapter1, "atmosphere"));
  assert.equal(gradeChoice(question, question.correctIndex).correct, true);
  const wrong = (question.correctIndex + 1) % question.options.length;
  assert.equal(gradeChoice(question, wrong).correct, false);
  assert.equal(gradeChoice(question, wrong).correctIndex, question.correctIndex);
});

test("explainChoice：说清「你选的是什么」+ 正确释义", () => {
  const question = build(byWord(chapter1, "atmosphere"));
  const wrong = (question.correctIndex + 1) % question.options.length;
  const text = explainChoice(question, wrong);
  assert.ok(text.includes(question.options[wrong].text));
  assert.ok(text.includes(question.answer));
});

/* ============ 题源校验器 ============ */

const words = chapter1.slice(0, 3);

/** 一份合法的最小题源 */
const goodDoc = () => ({
  spec: "1.0",
  chapter: 1,
  source: "model",
  items: {
    [words[0].id]: {
      need: "spell",
      note: "atmo（气体）+ sphere（球）",
      distractors: [
        { text: "水圈；大气中的水汽", kind: "root", why: "hydro- 是“水”，指水体总和" },
        { text: "岩石圈", kind: "root", why: "litho- 是“石”，指岩石部分" },
        { text: "半球", kind: "form", why: "hemi- 才是“一半”" },
      ],
    },
  },
});

test("validateQuizDoc：合法题源零错误", () => {
  const { errors, warnings, stats } = validateQuizDoc(goodDoc(), { chapter: 1, words });
  assert.deepEqual(errors, []);
  assert.equal(stats.covered, 1);
  assert.equal(stats.total, 3);
  assert.equal(stats.kinds.root, 2);
  // 覆盖率 1/3 < 50% 会给警告
  assert.ok(warnings.some((w) => w.includes("覆盖")));
});

test("validateQuizDoc：id 必须以词库为准", () => {
  const doc = goodDoc();
  doc.items["99999"] = doc.items[String(words[0].id)];
  const { errors } = validateQuizDoc(doc, { chapter: 1, words });
  assert.ok(errors.some((e) => e.includes("99999") && e.includes("词库里没有")));
});

test("validateQuizDoc：chapter 与文件名必须一致", () => {
  const doc = goodDoc();
  doc.chapter = 2;
  const { errors } = validateQuizDoc(doc, { chapter: 1, words });
  assert.ok(errors.some((e) => e.includes("chapter")));
});

test("validateQuizDoc：干扰项数量与字段校验", () => {
  const doc = goodDoc();
  const id = String(words[0].id);
  doc.items[id].distractors = doc.items[id].distractors.slice(0, 2);
  let result = validateQuizDoc(doc, { chapter: 1, words });
  assert.ok(result.errors.some((e) => e.includes(`必须是 3 条`)));

  const doc2 = goodDoc();
  doc2.items[id].distractors[0].kind = "whatever";
  doc2.items[id].distractors[1].why = "";
  result = validateQuizDoc(doc2, { chapter: 1, words });
  assert.ok(result.errors.some((e) => e.includes("kind 必须是")));
  assert.ok(result.errors.some((e) => e.includes("缺少 why")));
});

test("validateQuizDoc：与正确释义冲突的干扰项必须判错", () => {
  const doc = goodDoc();
  const id = String(words[0].id);
  doc.items[id].distractors[2] = { text: "气氛", kind: "sense", why: "属于正确释义的一部分" };
  const { errors } = validateQuizDoc(doc, { chapter: 1, words });
  assert.ok(errors.some((e) => e.includes("与正确释义冲突")));
});

test("validateQuizDoc：全是 topic 会被判错（没有辨析价值）", () => {
  const doc = goodDoc();
  const id = String(words[0].id);
  doc.items[id].distractors = [
    { text: "水圈；大气中的水汽", kind: "topic", why: "同主题" },
    { text: "岩石圈", kind: "topic", why: "同主题" },
    { text: "半球", kind: "topic", why: "同主题" },
  ];
  const { errors } = validateQuizDoc(doc, { chapter: 1, words });
  assert.ok(errors.some((e) => e.includes("有辨析价值")));
  assert.ok(errors.some((e) => e.includes("最多 2 个")));
});

test("validateQuizDoc：why 超长、note 超长、need 非法都会判错", () => {
  const doc = goodDoc();
  const id = String(words[0].id);
  doc.items[id].distractors[0].why = "啊".repeat(41);
  doc.items[id].note = "记".repeat(61);
  doc.items[id].need = "readonly";
  const { errors } = validateQuizDoc(doc, { chapter: 1, words });
  assert.ok(errors.some((e) => e.includes("why 超过")));
  assert.ok(errors.some((e) => e.includes("note 超过")));
  assert.ok(errors.some((e) => e.includes("need 只能是")));
});

test("validateQuizDoc：need=read 会被统计（用于'只认不拼'）", () => {
  const doc = goodDoc();
  doc.items[String(words[0].id)].need = "read";
  const { stats } = validateQuizDoc(doc, { chapter: 1, words });
  assert.equal(stats.needs.read, 1);
  assert.equal(stats.needs.spell, 0);
});

test("normalizeQuizDoc：三种常见形状都能归一", () => {
  const a = normalizeQuizDoc({ chapter: 3, items: { 5: { distractors: [] } } });
  assert.deepEqual(Object.keys(a.items), ["5"]);
  assert.equal(a.chapter, 3);

  const b = normalizeQuizDoc({ chapter: 3, items: [{ id: 7, distractors: [] }] });
  assert.deepEqual(Object.keys(b.items), ["7"]);

  const c = normalizeQuizDoc([{ id: 8 }, { id: 9 }]);
  assert.deepEqual(Object.keys(c.items).sort(), ["8", "9"]);
});

test("mergeQuizDocs：后写覆盖先写，保留原有词条", () => {
  const target = { chapter: 1, items: { 1: { distractors: [{ text: "旧" }] }, 2: { distractors: [] } } };
  const merged = mergeQuizDocs(target, { chapter: 1, items: { 1: { distractors: [{ text: "新" }] }, 3: { distractors: [] } } });
  assert.equal(merged.items["1"].distractors[0].text, "新");
  assert.ok(merged.items["2"] && merged.items["3"]);
});

test("buildQuizIndex：只列有内容的章节，并按章号排序", () => {
  const index = buildQuizIndex([
    { chapter: 3, covered: 0, total: 10 },
    { chapter: 2, covered: 5, total: 10 },
    { chapter: 1, covered: 2, total: 10 },
  ]);
  assert.deepEqual(index.chapters, [1, 2]);
  assert.equal(index.coverage["2"].covered, 5);
});

test("emptyQuizDoc：骨架字段齐全", () => {
  const doc = emptyQuizDoc(4);
  assert.equal(doc.chapter, 4);
  assert.deepEqual(doc.items, {});
});

/* ============ 规范文档与工具的约定 ============ */

test("生成规范里必须有 MODEL-PROMPT 区段（quiz.mjs prompt 依赖它）", () => {
  const spec = readFileSync(path.join(root, "docs", "选择题资料生成规范.md"), "utf8");
  assert.ok(spec.includes(PROMPT_MARKERS[0]) && spec.includes(PROMPT_MARKERS[1]));
  const prompt = extractModelPrompt(spec);
  assert.ok(prompt.length > 500, `提示词太短：${prompt.length}`);
  for (const keyword of ["kind", "distractors", "why", "root", "topic", "JSON"]) {
    assert.ok(prompt.includes(keyword), `提示词缺少关键词 ${keyword}`);
  }
});

test("规范文档写明的 kind 清单与校验器一致", () => {
  const spec = readFileSync(path.join(root, "docs", "选择题资料生成规范.md"), "utf8");
  for (const kind of ["root", "form", "pos", "sense", "topic", "antonym"]) {
    assert.ok(spec.includes(`\`${kind}\``), `规范里没有提到 ${kind}`);
  }
  assert.equal(DISTRACTOR_COUNT, 3);
});
