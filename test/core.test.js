import { test } from "node:test";
import assert from "node:assert/strict";
import {
  STATUS,
  MASTER_STREAK,
  WRONG_DUE_MS,
  analyzeWord,
  judgeAnswer,
  mergeWordStates,
  stateKey,
  dueReviewIds,
  insertAhead,
  chapterProgress,
  computeStats,
  sessionFinished,
  localDateKey,
  previousDateKey,
  rollDaily,
  recordDaily,
  resetDaily,
  mergeDailySync,
  mergeDailyBackup,
  currentStreak,
  buildDeck,
  normalizeSettings,
  pickNewer,
  formatRelative,
  cloudSettingsPayload,
  ACCENTS,
  ACCENT_HEX,
  deriveAccentVars,
  accentInkFor,
  applyAccent,
  applyResult,
  applyWeightResult,
  weightInsertCount,
  normalizeWeights,
  WEIGHT_MIN,
  WEIGHT_MAX,
  WEIGHT_INIT,
  canMergeGuestInto,
  PRACTICE,
  normalizePractice,
  normalizeModeLedger,
  mergeModeLedgers,
  recordModeResult,
  modeStats,
  masteredForPractice,
  chapterPracticeStats,
} from "../public/core.js";

// ============ 分词与判分 ============

test("analyzeWord：空格与连字符自动占位，不计入字母数", () => {
  const a = analyzeWord("high-tech");
  assert.equal(a.slots.length, 9);
  assert.equal(a.letters, 8);
  assert.equal(a.slots[4].sep, true);
  assert.equal(a.slots[4].ch, "-");

  const b = analyzeWord("El nino");
  assert.equal(b.letters, 6);
  assert.equal(b.slots[2].sep, true);
});

test("judgeAnswer：忽略空格与连字符差异（El nino / elnino 判对）", () => {
  const slots = analyzeWord("El nino").slots;
  // 用户只输入字母：e l n i n o，空格位留空
  const input = ["e", "l", "", "n", "i", "n", "o"];
  assert.equal(judgeAnswer(slots, input, "El nino"), true);

  const slots2 = analyzeWord("high-tech").slots;
  const input2 = ["h", "i", "g", "h", "", "t", "e", "c", "h"];
  assert.equal(judgeAnswer(slots2, input2, "high-tech"), true);
  assert.equal(judgeAnswer(slots2, ["h", "i", "g", "h", "", "t", "e", "c", "k"], "high-tech"), false);
});

test("judgeAnswer：空输入不算对", () => {
  const slots = analyzeWord("cat").slots;
  assert.equal(judgeAnswer(slots, ["", "", ""], "cat"), false);
});

// ============ 掌握判定 ============

test("applyResult：答错进入错题本并安排次日复现", () => {
  const now = 1_700_000_000_000;
  const st = applyResult(undefined, false, now);
  assert.equal(st.s, STATUS.wrong);
  assert.equal(st.cs, 0);
  assert.equal(st.wc, 1);
  assert.equal(st.seen, now);
  assert.equal(st.due, now + WRONG_DUE_MS);
});

test("applyResult：错词答对 1 次离开错题本，连续 2 次判定掌握", () => {
  const now = 1_700_000_000_000;
  const wrong = applyResult(undefined, false, now);
  const first = applyResult(wrong, true, now + 1000);
  assert.equal(first.s, STATUS.learning, "第一次答对 → 学习中（移出错题本）");
  assert.equal(first.cs, 1);
  assert.equal(first.wc, 1, "错误次数保留为历史统计");
  assert.equal(first.due, 0);

  const second = applyResult(first, true, now + 2000);
  assert.equal(second.s, STATUS.mastered);
  assert.equal(second.cs, MASTER_STREAK);
});

test("applyResult：掌握后答错立刻打回错题本", () => {
  const now = 1_700_000_000_000;
  const mastered = { s: STATUS.mastered, cs: 2, wc: 0, seen: now, due: 0 };
  const back = applyResult(mastered, false, now + 10);
  assert.equal(back.s, STATUS.wrong);
  assert.equal(back.cs, 0);
  assert.equal(back.wc, 1);
});

// ============ 多端合并 ============

test("mergeWordStates：LWW，seen 大者胜；旧数据不覆盖新数据", () => {
  const map = {};
  const older = [{ c: 1, w: 5, s: "wrong", cs: 0, wc: 1, seen: 100, due: 200 }];
  const newer = [{ c: 1, w: 5, s: "mastered", cs: 2, wc: 1, seen: 300, due: 0 }];
  assert.equal(mergeWordStates(map, newer), 1);
  assert.equal(map[stateKey(1, 5)].s, "mastered");
  assert.equal(mergeWordStates(map, older), 0, "更旧的 seen 不应覆盖");
  assert.equal(map[stateKey(1, 5)].s, "mastered");
});

test("mergeWordStates：seen 相同时以更靠后的状态为准", () => {
  const map = { [stateKey(2, 1)]: { c: 2, w: 1, s: "wrong", cs: 0, wc: 1, seen: 500, due: 0 } };
  mergeWordStates(map, [{ c: 2, w: 1, s: "mastered", cs: 2, wc: 1, seen: 500, due: 0 }]);
  assert.equal(map[stateKey(2, 1)].s, "mastered");
  assert.equal(pickNewer({ s: "mastered", seen: 9 }, { s: "wrong", seen: 9 }), false);
});

test("mergeWordStates：忽略脏数据", () => {
  const map = {};
  assert.equal(mergeWordStates(map, [{ c: NaN, w: 1 }, null, undefined]), 0);
});

// ============ 错词复现 ============

test("dueReviewIds：只取到期错词，按到期时间升序，受 limit 限制", () => {
  const now = 10_000;
  const map = {
    [stateKey(1, 1)]: { c: 1, w: 1, s: "wrong", due: 9000 },
    [stateKey(1, 2)]: { c: 1, w: 2, s: "wrong", due: 5000 },
    [stateKey(1, 3)]: { c: 1, w: 3, s: "wrong", due: 99000 },
    [stateKey(1, 4)]: { c: 1, w: 4, s: "learning", due: 0 },
    [stateKey(2, 1)]: { c: 2, w: 1, s: "wrong", due: 1000 },
  };
  assert.deepEqual(dueReviewIds(map, 1, now), [2, 1]);
  assert.deepEqual(dueReviewIds(map, 1, now, 1), [2]);
});

test("insertAhead：错词回插到本轮后面第 gap 位，且不重复", () => {
  const deck = [1, 2, 3, 4, 5, 6, 7, 8];
  const next = insertAhead(deck, 0, 9, 5);
  assert.equal(next[6], 9);
  assert.deepEqual(deck, [1, 2, 3, 4, 5, 6, 7, 8], "不修改原数组");
  const dup = insertAhead([1, 9, 3], 0, 9, 5);
  assert.deepEqual(dup, [1, 9, 3], "本轮后面已存在则不重复插入");
});

// ============ 统计口径 ============

test("computeStats：正确率永远 ≤100%，不受跨轮累计影响", () => {
  assert.deepEqual(computeStats({ attempts: 10, correct: 7 }), {
    attempts: 10,
    correct: 7,
    wrong: 3,
    accuracy: 70,
  });
  const second = computeStats({ attempts: 20, correct: 20 });
  assert.equal(second.accuracy, 100);
  const dirty = computeStats({ attempts: 5, correct: 99 });
  assert.equal(dirty.correct, 5, "correct 不会超过 attempts");
});

test("sessionFinished：本轮全部答对才结束", () => {
  assert.equal(sessionFinished({ attempts: 3, correct: 3 }, 3), true);
  assert.equal(sessionFinished({ attempts: 3, correct: 2 }, 3), false);
  assert.equal(sessionFinished({ attempts: 4, correct: 4 }, 3), true);
  assert.equal(sessionFinished({ attempts: 0, correct: 0 }, 0), false);
});

test("chapterProgress：以掌握数为主口径", () => {
  const map = {
    [stateKey(3, 1)]: { c: 3, w: 1, s: "mastered" },
    [stateKey(3, 2)]: { c: 3, w: 2, s: "wrong" },
    [stateKey(3, 3)]: { c: 3, w: 3, s: "learning" },
    [stateKey(4, 1)]: { c: 4, w: 1, s: "mastered" },
  };
  const p = chapterProgress(map, 3, 10);
  assert.equal(p.mastered, 1);
  assert.equal(p.wrong, 1);
  assert.equal(p.learning, 1);
  assert.equal(p.seen, 3);
  assert.equal(p.percent, 10);
  assert.equal(chapterProgress(map, 9, 0).percent, 0);
});

// ============ 每日目标 ============

test("localDateKey：使用本地日期而不是 UTC（UTC+ 时区凌晨不会算成昨天）", () => {
  const d = new Date(2026, 0, 2, 1, 30, 0); // 本地 2026-01-02 01:30
  assert.equal(localDateKey(d), "2026-01-02");
  const offsetMinutes = -d.getTimezoneOffset();
  if (offsetMinutes > 0) {
    assert.notEqual(
      localDateKey(d),
      d.toISOString().slice(0, 10),
      "东时区下本地日期必须与 UTC 日期不同（旧实现用的是 toISOString）"
    );
  }
  assert.equal(previousDateKey(d), "2026-01-01");
});

test("rollDaily：同一天保留计数；跨天清零但保留连续打卡历史", () => {
  const today = "2026-01-02";
  const same = rollDaily({ date: today, count: 3, target: 50, streak: 2, achieved: false }, today);
  assert.equal(same.count, 3);

  const nextDay = rollDaily(
    { date: "2026-01-01", count: 50, target: 50, achieved: true, streak: 2, lastAchieved: "2026-01-01" },
    today
  );
  assert.equal(nextDay.count, 0);
  assert.equal(nextDay.achieved, false);
  assert.equal(nextDay.streak, 2, "换天不清空历史 streak，是否仍连续由 currentStreak 判断");
  assert.equal(currentStreak(nextDay, today), 2, "昨天达成过 → 连续仍然有效");

  const stale = { streak: 5, lastAchieved: "2025-12-30" };
  assert.equal(currentStreak(stale, today), 0, "断了两天以上 → 连续天数显示为 0");
});

test("recordDaily：达成后不清零、只奖励一次、连续天数按昨天是否达成累加", () => {
  const today = "2026-01-02";
  const nowRef = new Date(2026, 0, 2, 20, 0, 0);
  let daily = { date: today, count: 48, target: 50, achieved: false, streak: 2, best: 2, total: 48, lastAchieved: "2026-01-01" };
  const r1 = recordDaily(daily, today, nowRef);
  daily = r1.daily;
  assert.equal(daily.count, 49);
  assert.equal(r1.achievedNow, false);

  const r2 = recordDaily(daily, today, nowRef);
  daily = r2.daily;
  assert.equal(daily.count, 50);
  assert.equal(r2.achievedNow, true, "刚好达标 → 触发奖励");
  assert.equal(daily.streak, 3, "昨天达成 → 连续 +1");
  assert.equal(daily.lastAchieved, today);

  const r3 = recordDaily(daily, today, nowRef);
  daily = r3.daily;
  assert.equal(daily.count, 51, "达标后计数继续累加，不再清零");
  assert.equal(r3.achievedNow, false, "同一天不会再重复奖励");
  assert.equal(daily.achieved, true);

  // 昨天没达成 → 连续重新从 1 开始
  const restart = recordDaily(
    { date: today, count: 49, target: 50, achieved: false, streak: 7, lastAchieved: "2025-12-29" },
    today,
    nowRef
  );
  assert.equal(restart.daily.streak, 1);
});

// ============ 牌堆与设置 ============

test("buildDeck：到期错词优先，已掌握沉底", () => {
  const deck = buildDeck([1, 2, 3, 4, 5, 6], [5, 6], [1, 2], () => 0);
  assert.deepEqual(deck.slice(0, 2).sort(), [5, 6], "到期错词排在最前");
  assert.deepEqual(deck.slice(4).sort(), [1, 2], "已掌握排在最后");
  assert.equal(deck.length, 6);
});

test("normalizeSettings：非法值回落到默认值", () => {
  const s = normalizeSettings({ mode: "hack", hint: 9, timerSeconds: 999, rate: 5, daily: { target: -3 } });
  assert.equal(s.mode, "random");
  assert.equal(s.hint, 0);
  assert.equal(s.timerSeconds, 60);
  assert.equal(s.rate, 1.3);
  assert.equal(s.daily.target, 1);
  assert.equal(s.sfx, true);
  assert.equal(s.speech, true);
  const t = normalizeSettings({ mode: "audio", hint: 2, timerEnabled: true, sfx: false });
  assert.equal(t.mode, "audio");
  assert.equal(t.hint, 2);
  assert.equal(t.timerEnabled, true);
  assert.equal(t.sfx, false);
});

test("formatRelative：相对时间文案", () => {
  const now = 1_700_000_000_000;
  assert.equal(formatRelative(now - 5_000, now), "刚刚");
  assert.equal(formatRelative(now - 120_000, now), "2 分钟前");
  assert.equal(formatRelative(now - 7200_000, now), "2 小时前");
  assert.equal(formatRelative(now - 3 * 86400_000, now), "3 天前");
});

// ============ 云端设置体积 / 跨账号合并 ============

test("cloudSettingsPayload：超过上限时先丢牌堆顺序，再丢 resume，绝不整包失败", () => {
  const small = {
    mode: "audio",
    hint: 1,
    timerEnabled: true,
    timerSeconds: 10,
    sfx: true,
    speech: true,
    rate: 0.9,
    daily: { target: 50, count: 1 },
    resume: { chapter: 3, index: 12, deck: [1, 2, 3], attempts: 12, correct: 9 },
  };
  const packed = cloudSettingsPayload(small);
  assert.deepEqual(packed.resume.deck, [1, 2, 3], "体积不大时保持原样");

  const heavy = { ...small, resume: { chapter: 5, index: 400, deck: Array.from({ length: 2500 }, (_, i) => 10000 + i), at: 1 } };
  assert.ok(JSON.stringify(heavy).length > 7200, "构造的样例确实超限");
  const trimmed = cloudSettingsPayload(heavy);
  assert.deepEqual(trimmed.resume.deck, [], "先丢掉牌堆顺序");
  assert.equal(trimmed.resume.chapter, 5, "章节与位置仍保留，断点续做不受影响");
  assert.ok(JSON.stringify(trimmed).length <= 7200);

  const huge = {
    ...small,
    daily: { target: 50, blob: "x".repeat(9000) },
    resume: { chapter: 5, deck: Array.from({ length: 2500 }, (_, i) => 10000 + i) },
  };
  const dropped = cloudSettingsPayload(huge);
  assert.equal(dropped.resume, null, "再不行就丢掉 resume");
  assert.ok(JSON.stringify(dropped).length <= 7200, "兜底后仍然不超限，保证同步不会整包失败");
  assert.equal(dropped.mode, "audio", "最关键的偏好设置不丢");
});

test("canMergeGuestInto：未登录期间的进度只并入一个账号（防共用电脑串号）", () => {
  assert.equal(canMergeGuestInto(null, 7), true, "从未并入过 → 允许");
  assert.equal(canMergeGuestInto("7", 7), true, "同一账号再次登录 → 允许");
  assert.equal(canMergeGuestInto("7", 8), false, "换账号 → 拒绝，避免把上一个账号的数据并进去");
  assert.equal(canMergeGuestInto("7", Number("7")), true);
});

// ============ 两种答法：拼写 / 认词 ============

test("normalizeSettings：练习方式默认拼写，认词相关的字段有默认值", () => {
  const defaults = normalizeSettings(null);
  assert.equal(defaults.answer, "spell");
  assert.equal(defaults.quizPrompt, "en");
  assert.equal(defaults.autoNext, false, "认词默认不自动跳题（用户自己看完解析再进下一题）");

  const choice = normalizeSettings({ answer: "choice", quizPrompt: "audio", autoNext: false });
  assert.equal(choice.answer, "choice");
  assert.equal(choice.quizPrompt, "audio");
  assert.equal(choice.autoNext, false);

  const bad = normalizeSettings({ answer: "选择题", quizPrompt: "hack", autoNext: 1 });
  assert.equal(bad.answer, "spell", "非法练习方式回落");
  assert.equal(bad.quizPrompt, "en", "非法题干回落");
  assert.equal(bad.autoNext, true, "显式给定值按布尔强制转换（1 → true）");
});

test("cloudSettingsPayload：认词设置也要上云（否则换设备就丢了）", () => {
  const payload = cloudSettingsPayload(normalizeSettings({ answer: "choice", quizPrompt: "audio", autoNext: false }));
  assert.equal(payload.answer, "choice");
  assert.equal(payload.quizPrompt, "audio");
  assert.equal(payload.autoNext, false);
});

test("normalizePractice：非法值一律当拼写", () => {
  assert.equal(normalizePractice("choice"), "choice");
  assert.equal(normalizePractice("spell"), "spell");
  assert.equal(normalizePractice(undefined), "spell");
  assert.equal(normalizePractice("认词"), "spell");
});

test("recordModeResult / modeStats：分模式计数互不干扰", () => {
  let ledger = recordModeResult(undefined, "choice", true);
  ledger = recordModeResult(ledger, "choice", true);
  ledger = recordModeResult(ledger, "choice", false);
  ledger = recordModeResult(ledger, "spell", false);

  assert.deepEqual(modeStats(ledger, "choice"), { c: 2, w: 1, total: 3, accuracy: 67 });
  assert.deepEqual(modeStats(ledger, "spell"), { c: 0, w: 1, total: 1, accuracy: 0 });
  assert.deepEqual(modeStats(undefined, "choice"), { c: 0, w: 0, total: 0, accuracy: 0 });
});

test("masteredForPractice：只做过选择题的词，在拼写模式里不算掌握", () => {
  const mastered = { s: STATUS.mastered };
  const byChoice = recordModeResult(undefined, "choice", true);
  const bySpell = recordModeResult(undefined, "spell", true);

  assert.equal(masteredForPractice(mastered, byChoice, "choice"), true);
  assert.equal(masteredForPractice(mastered, byChoice, "spell"), false, "没拼对过 → 拼写模式仍要练");
  assert.equal(masteredForPractice(mastered, bySpell, "spell"), true);
  assert.equal(masteredForPractice({ s: STATUS.wrong }, bySpell, "choice"), false);
  assert.equal(masteredForPractice(undefined, undefined, "choice"), false);
});

test("mergeModeLedgers：跨命名空间合并取较大值，不重复计数", () => {
  const a = recordModeResult(recordModeResult(undefined, "choice", true), "spell", true);
  const b = recordModeResult(recordModeResult(recordModeResult(undefined, "choice", true), "choice", true), "spell", false);
  const merged = mergeModeLedgers({ "1:1": a }, { "1:1": b, "2:3": b });
  assert.deepEqual(modeStats(merged["1:1"], "choice"), { c: 2, w: 0, total: 2, accuracy: 100 }, "取较大值而不是相加");
  assert.deepEqual(modeStats(merged["1:1"], "spell"), { c: 1, w: 1, total: 2, accuracy: 50 });
  assert.deepEqual(modeStats(merged["2:3"], "choice"), { c: 2, w: 0, total: 2, accuracy: 100 });
  assert.deepEqual(mergeModeLedgers(null, null), {});
});

test("normalizeModeLedger：脏数据不会污染台账", () => {
  const ledger = normalizeModeLedger({ "1:1": { spell: { c: -5, w: "x" }, choice: { c: 2 } }, bad: null });
  assert.deepEqual(ledger["1:1"].spell, { c: 0, w: 0 });
  assert.deepEqual(ledger["1:1"].choice, { c: 2, w: 0 });
  assert.deepEqual(ledger.bad, { spell: { c: 0, w: 0 }, choice: { c: 0, w: 0 } });
});

test("chapterPracticeStats：只统计本章，两种答法分开算", () => {
  const entry = recordModeResult(recordModeResult(undefined, "choice", true), "spell", true);
  const other = recordModeResult(undefined, "choice", false);
  const stats = chapterPracticeStats({ "3:1": entry, "3:2": other, "4:1": other }, 3);
  assert.deepEqual(stats.choice, { c: 1, w: 1, total: 2, accuracy: 50 });
  assert.deepEqual(stats.spell, { c: 1, w: 0, total: 1, accuracy: 100 });
  assert.deepEqual(chapterPracticeStats({}, 3).choice, { c: 0, w: 0, total: 0, accuracy: 0 });
});

// ============ 整轮练习集成（牌堆 / 掌握 / 回插 / 每日目标 / 多端合并） ============

test("集成：一整轮练习的状态流转自洽", () => {
  const CHAPTER = 4;
  const ids = Array.from({ length: 12 }, (_, i) => 100 + i);
  const today = localDateKey();
  const base = 1_700_000_000_000;

  /** @type {Record<string, any>} */
  const words = {};
  let deck = buildDeck(ids, [], [], () => 0.5);
  let index = 0;
  let session = { attempts: 0, correct: 0 };
  let daily = { date: today, count: 0, target: 10, achieved: false, streak: 0, best: 0, total: 0, lastAchieved: "" };
  let rewards = 0;
  let clock = 0;

  /**
   * 回答一个词（模拟真实流程：答错的本轮回插 + 每日目标 + 本轮统计）
   * @param {number} wordId
   * @param {boolean} correct
   */
  const answerWord = (wordId, correct) => {
    const key = stateKey(CHAPTER, wordId);
    const next = applyResult(words[key], correct, base + (clock += 1000));
    words[key] = { c: CHAPTER, w: wordId, ...next };
    session.attempts++;
    if (correct) session.correct++;
    else deck = insertAhead(deck, index, wordId);
    const result = recordDaily(daily, today, new Date(base + clock));
    daily = result.daily;
    if (result.achievedNow) rewards++;
    return words[key];
  };

  assert.equal(deck.length, 12, "初始牌堆包含本章全部词");

  // 同一个词跨轮连续答对两次 = 掌握
  const first = deck[index++];
  assert.equal(answerWord(first, true).s, STATUS.learning, "第一次答对仍是学习中");
  assert.equal(answerWord(first, true).s, STATUS.mastered, "第二次答对 → 掌握");
  assert.equal(answerWord(first, false).s, STATUS.wrong, "掌握后答错立刻打回错题本");
  assert.equal(answerWord(first, true).s, STATUS.learning, "再答对一次移出错题本");

  // 答错 → 进错题本 + 本轮后面再遇一次
  const wrongId = deck[index];
  const wrongState = answerWord(wrongId, false);
  assert.equal(wrongState.s, STATUS.wrong);
  assert.equal(wrongState.wc, 1);
  const distance = deck.indexOf(wrongId, index + 1);
  assert.ok(distance > index && distance - index <= 6, `错词应在后面第 ≤6 个位置再出现（实际 ${distance - index}）`);
  index += 1; // 答完这一题继续往下

  // 到期复现：当天不再重复复现，次日起进入队列
  assert.equal(dueReviewIds(words, CHAPTER, base).length, 0, "刚答错的词当天不再判为到期");
  assert.ok(dueReviewIds(words, CHAPTER, base + 25 * 3600 * 1000).length >= 1, "次日应进入到期复现队列");

  // 统计口径：正确率永远不会超过 100%
  let stats = computeStats(session);
  assert.ok(stats.accuracy <= 100);
  assert.equal(stats.wrong, stats.attempts - stats.correct);

  // 章节进度自洽
  const progress = chapterProgress(words, CHAPTER, ids.length);
  assert.equal(progress.mastered + progress.learning + progress.wrong, progress.seen);
  assert.ok(progress.seen <= ids.length);

  // 打完一轮：每日目标只奖励一次，达标后计数不清零
  while (index < deck.length) {
    answerWord(deck[index++], true);
  }
  stats = computeStats(session);
  assert.ok(session.attempts >= 10, `本轮至少尝试了 10 次（实际 ${session.attempts}）`);
  assert.equal(rewards, 1, "一整轮里每日目标只触发一次奖励");
  assert.equal(daily.count, session.attempts, "计数继续累加，不会因为达标被清零");
  assert.equal(daily.achieved, true);
  assert.equal(stats.correct <= stats.attempts, true);

  // 多端合并：更旧的 seen 不覆盖本地，更新的 seen 覆盖
  const key = stateKey(CHAPTER, first);
  const localSeen = words[key].seen;
  const beforeMerge = words[key].s;
  mergeWordStates(words, [{ c: CHAPTER, w: first, s: "wrong", cs: 0, wc: 3, seen: localSeen - 5000, due: 0 }]);
  assert.equal(words[key].s, beforeMerge, "更旧的记录不会覆盖本地");
  mergeWordStates(words, [{ c: CHAPTER, w: first, s: "wrong", cs: 0, wc: 3, seen: localSeen + 5000, due: 0 }]);
  assert.equal(words[key].s, STATUS.wrong, "更新的记录会覆盖本地");
});

/* ============ 第四期：主题调色盘 ============ */

test("normalizeSettings：accent 白名单与非法回落", () => {
  assert.equal(normalizeSettings({ accent: "emerald" }).accent, "emerald");
  assert.equal(normalizeSettings({ accent: "nope" }).accent, "sky");
  assert.equal(normalizeSettings({}).accent, "sky");
  assert.equal(normalizeSettings({ accent: "custom", accentCustom: "#E11D48" }).accentCustom, "#e11d48");
  assert.equal(normalizeSettings({ accent: "custom", accentCustom: "red" }).accentCustom, "");
});

test("ACCENTS：七项（六预设 + custom），预设色表齐全", () => {
  assert.deepEqual(ACCENTS, ["sky", "violet", "emerald", "rose", "amber", "slate", "custom"]);
  for (const name of ["sky", "violet", "emerald", "rose", "amber", "slate"]) {
    assert.match(ACCENT_HEX[name], /^#[0-9a-f]{6}$/);
  }
});

test("deriveAccentVars：自定义色派生全套变量，墨色按亮度自适应", () => {
  const vars = deriveAccentVars("#e11d48");
  assert.equal(vars["--accent"], "#e11d48");
  assert.match(vars["--accent-grad"], /^linear-gradient\(135deg, #[0-9a-f]{6} 0%, #e11d48 55%, #[0-9a-f]{6} 100%\)$/);
  assert.equal(vars["--accent-ink"], "#ffffff"); // 深红底配白墨
  assert.match(vars["--accent-soft"], /^rgba\(225, 29, 72, 0\.16\)$/);
  // 亮色（如浅天蓝）配深墨
  assert.equal(accentInkFor("#7dd3fc"), "#062033");
});

test("applyAccent：预设盘设 data-accent 且清内联变量；custom 写内联变量（假 root 可测）", () => {
  const fake = { dataset: {}, style: { props: {}, setProperty(k, v) { this.props[k] = v; }, removeProperty(k) { delete this.props[k]; } } };
  applyAccent("custom", "#e11d48", fake);
  assert.equal(fake.dataset.accent, "custom");
  assert.ok(Object.keys(fake.style.props).length >= 7);
  applyAccent("emerald", "", fake);
  assert.equal(fake.dataset.accent, "emerald");
  assert.equal(Object.keys(fake.style.props).length, 0);
  applyAccent("nope", "", fake);
  assert.equal(fake.dataset.accent, "sky"); // 非法回落
  applyAccent(null, "", fake);
  assert.equal(fake.dataset.accent, "sky");
});

test("cloudSettingsPayload：携带 accent 与 accentCustom", () => {
  const payload = cloudSettingsPayload({ ...normalizeSettings({ accent: "rose", accentCustom: "" }) });
  assert.equal(payload.accent, "rose");
  assert.equal("accentCustom" in payload, true);
});

/* ============ 第五期：掌握规则与易错权重 ============ */

test("applyResult：认词 streakStep=2 答对一次即掌握；拼写保持连对 2 次", () => {
  const choiceOnce = applyResult(null, true, 1000, { streakStep: 2 });
  assert.equal(choiceOnce.s, STATUS.mastered, "认词答对一次即掌握（认识即掌握）");
  const spellOnce = applyResult(null, true, 1000);
  assert.equal(spellOnce.s, STATUS.learning, "拼写答对一次仍是学习中");
  assert.equal(applyResult(spellOnce, true, 2000).s, STATUS.mastered, "拼写连对 2 次掌握");
  // 认词答错仍然清零 streak 并进错题
  const wrongThenRight = applyResult(applyResult(null, false, 1000), true, 2000, { streakStep: 2 });
  assert.equal(wrongThenRight.s, STATUS.mastered, "错过一次后认词答对一次也算掌握");
});

test("易错权重：首错初始化、答错升级有上限、答对衰减有下限（永不为 0）", () => {
  const first = applyWeightResult(undefined, false, 1);
  assert.equal(first.w, WEIGHT_INIT);
  assert.equal(first.bad, 1);
  let w = first;
  for (let i = 0; i < 10; i++) w = applyWeightResult(w, false, i + 2);
  assert.equal(w.w, WEIGHT_MAX, "连错有上限 3.0");
  let w2 = applyWeightResult(first, true, 2);
  assert.ok(w2.w < first.w && w2.w >= WEIGHT_MIN, "答对权重下降但不低于下限");
  for (let i = 0; i < 20; i++) w2 = applyWeightResult(w2, true, i + 10);
  assert.equal(w2.w, WEIGHT_MIN, "连对衰减到 0.1 下限，永不归零");
  assert.ok(w2.ok >= 20 && w2.bad === 1, "计数保留");
});

test("weightInsertCount：权重决定牌堆复现次数（1~3），无记录为 0", () => {
  assert.equal(weightInsertCount(undefined), 0);
  assert.equal(weightInsertCount({ w: 0.1 }), 1);
  assert.equal(weightInsertCount({ w: 1 }), 1);
  assert.equal(weightInsertCount({ w: 1.6 }), 2);
  assert.equal(weightInsertCount({ w: 3 }), 3);
});

test("normalizeWeights：丢弃非法条目并夹紧边界", () => {
  const out = normalizeWeights({ "1:1": { w: 99 }, "1:2": { w: -3 }, "1:3": { w: "x" }, "1:4": { w: 1.5, ok: 2, bad: 1 } });
  assert.equal(out["1:1"].w, WEIGHT_MAX);
  assert.equal(out["1:2"], undefined);
  assert.equal(out["1:3"], undefined);
  assert.equal(out["1:4"].w, 1.5);
});

// ============ 今日目标重置（resetAt 同步语义） ============

test("resetDaily：清零 count/achieved，写入 resetAt，保留 streak/best/total", () => {
  const daily = {
    date: "2026-09-25",
    count: 30,
    target: 50,
    achieved: true,
    streak: 4,
    best: 9,
    total: 1200,
    lastAchieved: "2026-09-25",
  };
  const out = resetDaily(daily, "2026-09-25", 1790000000000);
  assert.equal(out.count, 0);
  assert.equal(out.achieved, false);
  assert.equal(out.resetAt, 1790000000000);
  assert.equal(out.streak, 4, "连续天数不随重置撤销");
  assert.equal(out.best, 9);
  assert.equal(out.total, 1200);
  assert.equal(out.date, "2026-09-25");
});

test("resetDaily：resetAt 单调不回退", () => {
  const daily = { date: "2026-09-25", count: 5, resetAt: 1790000000000 };
  const again = resetDaily(daily, "2026-09-25", 1000);
  assert.equal(again.resetAt, 1790000000000);
});

test("mergeDailySync：resetAt 较新的重置胜过更大的旧计数", () => {
  const cloud = { date: "2026-09-25", count: 20, achieved: true, resetAt: 0 };
  const local = { date: "2026-09-25", count: 0, achieved: false, resetAt: 1790000000000 };
  const merged = mergeDailySync(cloud, local, "2026-09-25");
  assert.equal(merged.count, 0, "本地刚重置过，云端旧计数不能复活");
  assert.equal(merged.achieved, false);
  assert.equal(merged.resetAt, 1790000000000);
});

test("mergeDailySync：云端 resetAt 更新时同样以重置侧为准", () => {
  const cloud = { date: "2026-09-25", count: 0, achieved: false, resetAt: 1790000000000 };
  const local = { date: "2026-09-25", count: 8, achieved: false, resetAt: 0 };
  const merged = mergeDailySync(cloud, local, "2026-09-25");
  assert.equal(merged.count, 0);
});

test("mergeDailySync：resetAt 打平沿用 max(count) 旧语义", () => {
  const tie = mergeDailySync(
    { date: "2026-09-25", count: 12, resetAt: 0 },
    { date: "2026-09-25", count: 5, resetAt: 0 },
    "2026-09-25"
  );
  assert.equal(tie.count, 12);
});

test("mergeDailySync：跨天 rollDaily 归一，新的一天从 0 开始且云端台账保留", () => {
  const crossDay = mergeDailySync(
    { date: "2026-09-24", count: 30, target: 50, streak: 4, best: 9, total: 100, lastAchieved: "2026-09-24" },
    { date: "2026-09-25", count: 3 },
    "2026-09-25"
  );
  assert.equal(crossDay.date, "2026-09-25");
  assert.equal(crossDay.count, 0, "昨天的计数不应显示成今天的进度");
  assert.equal(crossDay.target, 50);
  assert.equal(crossDay.streak, 4);
  assert.equal(crossDay.total, 100);
});

test("mergeDailyBackup：更近的一天胜出；同一天 resetAt 新者胜；打平取更大计数", () => {
  assert.equal(mergeDailyBackup({ date: "2026-09-24", count: 9 }, { date: "2026-09-25", count: 1 }).date, "2026-09-25");
  assert.equal(
    mergeDailyBackup({ date: "2026-09-25", count: 9, resetAt: 0 }, { date: "2026-09-25", count: 0, resetAt: 5 }).count,
    0
  );
  assert.equal(
    mergeDailyBackup({ date: "2026-09-25", count: 9, resetAt: 5 }, { date: "2026-09-25", count: 2, resetAt: 5 }).count,
    9
  );
});
