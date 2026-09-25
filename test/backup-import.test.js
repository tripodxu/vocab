// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const appModule = await import("../public/app.js?backup-import-guard");
const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");


test("backup import exposes strict v2 payload validation", () => {
  assert.equal(typeof appModule.validateBackupPayload, "function");
});

test("backup import accepts the exported cloud v2 schema", () => {
  const backup = {
    version: 2,
    exportedAt: "2026-01-02T03:04:05.000Z",
    email: "learner@example.com",
    settings: {
      mode: "random",
      answer: "spell",
      quizPrompt: "en",
      accent: "sky",
      accentCustom: "",
      autoNext: false,
      hint: 0,
      timerEnabled: false,
      timerSeconds: 10,
      sfx: true,
      speech: true,
      rate: 0.9,
      daily: {
        target: 50,
        count: 2,
        date: "2026-01-02",
        achieved: false,
        streak: 1,
        best: 3,
        total: 8,
        lastAchieved: "2026-01-01",
      },
      resume: null,
    },
    words: [{ c: 1, w: 2, s: "learning", cs: 1, wc: 0, seen: 100, due: 0 }],
    stars: [{ c: 1, w: 2, starred: true, updatedAt: 101 }],
    notes: [{ c: 1, w: 2, note: "remember", hasImage: 1, updatedAt: 102 }],
    images: [{ c: 1, w: 2, mime: "image/png", data: "aGVsbG8=", updatedAt: 103 }],
  };

  const validated = appModule.validateBackupPayload(backup);

  assert.deepEqual(validated, backup);
  assert.notEqual(validated, backup);
});

test("backup import accepts durable reset and note/image tombstone metadata", () => {
  const backup = {
    version: 2,
    resets: { "1": 1234 },
    words: [],
    stars: [],
    notes: [],
    images: [],
    noteTombstones: [{ c: 1, w: 2, updatedAt: 1235 }],
    imageTombstones: [{ c: 1, w: 2, updatedAt: 1236 }],
  };
  const validated = appModule.validateBackupPayload(backup);
  assert.ok(validated);
  assert.deepEqual({ ...validated.resets }, backup.resets);
  assert.deepEqual(validated.noteTombstones, backup.noteTombstones);
  assert.deepEqual(validated.imageTombstones, backup.imageTombstones);
});


test("backup import preserves edits made while the file is being uploaded", () => {
  const base = {
    "1:1": { c: 1, w: 1, s: "learning", cs: 1, wc: 0, seen: 10, due: 0 },
    "1:2": { c: 1, w: 2, s: "learning", cs: 1, wc: 0, seen: 20, due: 0 },
  };
  const current = {
    "1:1": { c: 1, w: 1, s: "mastered", cs: 2, wc: 0, seen: 30, due: 0 },
  };
  const incoming = [
    { c: 1, w: 1, s: "learning", cs: 1, wc: 0, seen: 10, due: 0 },
    { c: 1, w: 2, s: "wrong", cs: 0, wc: 1, seen: 40, due: 50 },
  ];
  const rebased = appModule.rebaseBackupWords(base, current, incoming);
  assert.equal(rebased.words["1:1"].s, "mastered");
  assert.equal(rebased.words["1:1"].seen, 30);
  assert.equal(rebased.words["1:2"], undefined);
  assert.equal(rebased.changed, 0);
});

test("backup import does not apply an older incoming record over the current LWW winner", () => {
  const base = { "2:3": { c: 2, w: 3, s: "learning", cs: 1, wc: 0, seen: 50, due: 0 } };
  const current = { "2:3": { c: 2, w: 3, s: "wrong", cs: 0, wc: 1, seen: 80, due: 90 } };
  const rebased = appModule.rebaseBackupWords(base, current, [
    { c: 2, w: 3, s: "learning", cs: 1, wc: 0, seen: 10, due: 0 },
  ]);
  assert.equal(rebased.words["2:3"].s, "wrong");
  assert.equal(rebased.words["2:3"].seen, 80);
  assert.equal(rebased.changed, 0);
});

test("backup import does not apply an older incoming record over an unchanged current state", () => {
  const base = { "2:4": { c: 2, w: 4, s: "wrong", cs: 0, wc: 1, seen: 50, due: 90 } };
  const current = { "2:4": { c: 2, w: 4, s: "wrong", cs: 0, wc: 1, seen: 50, due: 90 } };
  const rebased = appModule.rebaseBackupWords(base, current, [
    { c: 2, w: 4, s: "learning", cs: 1, wc: 0, seen: 10, due: 0 },
  ]);
  assert.equal(rebased.words["2:4"].s, "wrong");
  assert.equal(rebased.words["2:4"].seen, 50);
  assert.equal(rebased.changed, 0);
});

test("backup import accepts local v2 maps and keeps them prototype-free", () => {
  const backup = {
    version: 2,
    exportedAt: "2026-01-02T03:04:05.000Z",
    localWords: {
      "1:2": { c: 1, w: 2, s: "wrong", cs: 0, wc: 2, seen: 100, due: 200 },
    },
    localStars: { "1": [2, 3] },
    starRecords: {
      "1:2": { starred: true, updatedAt: 0 },
      "1:3": { starred: true, updatedAt: 101 },
    },
    settings: null,
  };

  const validated = appModule.validateBackupPayload(backup);

  assert.ok(validated);
  assert.equal(Object.getPrototypeOf(validated.localWords), null);
  assert.equal(Object.getPrototypeOf(validated.localStars), null);
  assert.equal(Object.getPrototypeOf(validated.starRecords), null);
  assert.deepEqual({ ...validated.localWords }, backup.localWords);
  assert.deepEqual({ ...validated.localStars }, backup.localStars);
  assert.deepEqual({ ...validated.starRecords }, backup.starRecords);
});

test("backup import caps reads, stages local state, and rechecks identity after every await", () => {
  const importSource = appSource.slice(
    appSource.indexOf("function importBackup()"),
    appSource.indexOf("/* ============ 事件绑定 ============ */")
  );

  assert.match(importSource, /file\.size > BACKUP_IMPORT_MAX_BYTES/);
  assert.ok(importSource.indexOf("file.size > BACKUP_IMPORT_MAX_BYTES") < importSource.indexOf("await file.text()"));
  assert.ok(importSource.indexOf("const runUserId = Auth.userId()") < importSource.indexOf("await file.text()"));
  assert.match(importSource, /await file\.text\(\);\s*if \(!isCurrent\(\)\) return abortImport\(\);/);
  assert.match(importSource, /const payload = validateBackupPayload\(/);
  assert.match(importSource, /const staged = stageBackupImport\(payload\)/);
  assert.match(
    importSource,
    /const res = await Auth\.importAll\(payload\);\s*if \(res\?\.error === "auth_changed" \|\| !isCurrent\(\)\) return abortImport\(\);/
  );
  assert.match(importSource, /await starSync\.pull\(\);\s*if \(!isCurrent\(\)\) return abortImport\(\);/);
  assert.match(importSource, /await starSync\.flush\(\);\s*if \(!isCurrent\(\)\) return abortImport\(\);/);
  assert.match(importSource, /res\.data\?\.words/);
  assert.doesNotMatch(importSource, /res\.data\.words/);
  assert.ok(importSource.indexOf("const staged = stageBackupImport(payload)") < importSource.indexOf("commitStagedBackup(staged)"));
  assert.doesNotMatch(importSource, /state\.words = staged\.words/);
  assert.match(appSource, /rebaseBackupWords\(staged\.baseWords, state\.words, staged\.incomingWords\)/);
  assert.match(appSource, /staged\.baseSettingsSnapshot/);
});
