// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
const lectureSource = await readFile(new URL("../public/lecture.js", import.meta.url), "utf8");
const idbSource = await readFile(new URL("../public/idb.js", import.meta.url), "utf8");
const authSource = await readFile(new URL("../public/vocab-auth.js", import.meta.url), "utf8");

test("frontend session guards cover the production continuation paths", () => {
  const flush = appSource.slice(appSource.indexOf("async function flush()"), appSource.indexOf("/** 把当前所有词状态标记为待上传"));
  assert.match(appSource, /cursor: 0/);
  assert.match(appSource, /const since = opts\.full \|\| !state\.sync\.pulledOnce \? 0 : Math\.max\(0, state\.sync\.cursor - 60_000\);/);
  assert.doesNotMatch(appSource, /sessionChapter/);
  assert.match(appSource, /if \(!data \|\| !Array\.isArray\(data\.words\)\)/);
  assert.match(appSource, /const settingsSnapshot = settingsDirty \? JSON\.stringify\(serializableSettings\(\)\) : "";/);
  assert.match(appSource, /const isCurrent = \(\) => currentUserEpoch\(runEpoch, runUserKey, runAuthRevision\)/);
  assert.match(appSource, /async function switchPractice\([\s\S]*const runEpoch = userEpoch;[\s\S]*const runUserKey = state\.userKey;[\s\S]*const runAuthRevision = Auth\.revision\(\);[\s\S]*const runToken = sessionGuard\.capture\(runUserKey, runAuthRevision\)/);
  assert.match(appSource, /async function switchPractice\([\s\S]*if \(value === "choice"\) await loadQuiz\(state\.chapter\);[\s\S]*if \(!isCurrent\(\)\) return;/);
  assert.match(appSource, /const runEpoch = userEpoch;[\s\S]*const runUserKey = state\.userKey;[\s\S]*const runAuthRevision = Auth\.revision\(\)/);
  assert.match(appSource, /const runToken = sessionGuard\.capture\(runUserKey, runAuthRevision\)/);
  assert.match(appSource, /const settingsChangedDuringPull = JSON\.stringify\(state\.settings\) !== localSettingsSnapshot/);
  assert.match(flush, /const settingsSnapshot = settingsDirty \? JSON\.stringify\(serializableSettings\(\)\) : "";/);
  assert.match(flush, /JSON\.stringify\(serializableSettings\(\)\) === settingsSnapshot/);
  assert.match(flush, /const token = \{ epoch: runEpoch, userKey: runUserKey, authRevision: runAuthRevision \}/);
  assert.match(flush, /finally \{[\s\S]*state\.sync\.inFlight === token/);

  const applyUser = appSource.slice(appSource.indexOf("async function applyUser"), appSource.indexOf("async function init()"));
  assert.match(applyUser, /const isCurrent = \(\) => currentUserEpoch/);
  assert.match(applyUser, /await syncPull\(\{ full: true \}\);\s*if \(!isCurrent\(\)\) return;/);
  assert.match(applyUser, /await starSync\.pull\(\);\s*if \(!isCurrent\(\)\) return;/);
  assert.match(applyUser, /await starSync\.flush\(\);\s*if \(!isCurrent\(\)\) return;/);
  assert.match(applyUser, /await loadChapter\(state\.chapter, \{ fresh: true \}\);\s*if \(!isCurrent\(\)\) return;/);
  assert.match(applyUser, /state\.settings = normalizeSettings\(scoped\?\.settings\);/);
  assert.match(applyUser, /const keyChanged = nextKey !== prevKey;/);
  assert.match(applyUser, /if \(opts\.switchChapter && keyChanged\)[\s\S]*await loadChapter\(state\.chapter, \{ fresh: true \}\);[\s\S]*if \(!isCurrent\(\)\) return;/);
  assert.match(applyUser, /if \(opts\.switchChapter && !chapterLoaded\)[\s\S]*await loadChapter\(state\.chapter, \{ fresh: true \}\);[\s\S]*if \(!isCurrent\(\)\) return;/);
});

test("lecture auth callback guards logout and async session continuations", () => {
  const callback = lectureSource.slice(lectureSource.indexOf("Auth.onAuthChange"), lectureSource.indexOf("window.setInterval"));
  assert.doesNotMatch(callback, /state\.userKey === "guest"[\s\S]{0,180}current\.userId/);
  assert.match(callback, /const runEpoch = nextEpoch/);
  assert.match(callback, /const token = sessionGuard\.begin\(\)/);
  assert.match(callback, /if \(!isCurrent\(\)\) return/);
});

test("lecture auth transition resets and hydrates the target session namespace", () => {
  const clear = lectureSource.slice(
    lectureSource.indexOf("function clearLectureSessionState"),
    lectureSource.indexOf("let voices"),
  );
  assert.match(clear, /state\.loading = false/);
  assert.match(clear, /state\.error = null/);
  assert.match(clear, /state\.query = ""/);
  assert.match(clear, /state\.filter = "all"/);
  assert.match(clear, /window\.clearTimeout\(stepTimer\)/);
  assert.match(clear, /stepTimer = 0/);
  assert.match(clear, /cleanupDraw\(\)/);
  assert.match(clear, /window\.clearTimeout\(brush\.timer\)/);
  assert.match(clear, /brush\.painting = false/);
  assert.match(clear, /drawState\.timer = 0/);

  const refresh = lectureSource.slice(
    lectureSource.indexOf("async function refreshLocalImages"),
    lectureSource.indexOf("/**\n * 云端备注/配图拉取"),
  );
  assert.match(refresh, /const runChapterEpoch = chapterEpoch/);
  assert.match(refresh, /const runUserKey = state\.userKey/);
  assert.match(refresh, /const runAuthRevision = Auth\.revision\(\)/);
  assert.match(refresh, /const keys = await idbKeys\(prefix\);\s*if \(!isCurrent\(\)\) return false;/);
  assert.match(refresh, /if \(!isCurrent\(\)\) return false;\s*state\.localImages = set;/);

  const callback = lectureSource.slice(lectureSource.indexOf("Auth.onAuthChange"), lectureSource.indexOf("window.setInterval"));
  assert.match(callback, /state\.userKey = nextKey;[\s\S]*loadLocalNotes\(\);[\s\S]*await refreshLocalImages\(\);[\s\S]*if \(!isCurrent\(\)\) return;[\s\S]*restoreBrush\(\);/);
  assert.match(lectureSource, /async function syncNotesFromCloud\(\)[\s\S]*const runUserKey = state\.userKey[\s\S]*const isCurrent =/);
  assert.match(lectureSource, /await Auth\.getNotes\(chapter\)[\s\S]*if \(!isCurrent\(\)\) return/);
  assert.match(lectureSource, /const localImageKey = imgKey\(chapter, word\.id\);[\s\S]*await idbGet\(localImageKey\)[\s\S]*if \(!isCurrent\(\)\) return/);
});

test("lecture async callbacks bind account, chapter, and detail identity", () => {
  assert.match(lectureSource, /function captureLectureContext\(/);
  assert.match(lectureSource, /const runUserKey = state\.userKey/);
  assert.match(lectureSource, /const runAuthRevision = Auth\.revision\(\)/);
  assert.match(lectureSource, /const runDetail = currentDetail/);
  assert.match(lectureSource, /const isCurrent = \(\) =>/);
  const note = lectureSource.slice(lectureSource.indexOf('textarea.addEventListener("input"'), lectureSource.indexOf("if (Auth.isLoggedIn()) noteStatus"));
  assert.match(note, /const runUserKey = state\.userKey/);
  assert.match(note, /if \(!isCurrent\(\)\) return/);
  assert.match(note, /await Auth\.putNote\(runChapter, runWord, value, at\)/);
  const pick = lectureSource.slice(lectureSource.indexOf("function pickImage"), lectureSource.indexOf("async function removeImage"));
  assert.match(pick, /const runChapter = state\.chapter/);
  assert.match(pick, /const runUserKey = state\.userKey/);
  assert.match(pick, /if \(!isCurrent\(\)\) return/);
  const remove = lectureSource.slice(lectureSource.indexOf("async function removeImage"), lectureSource.indexOf("/**\n * 压缩"));
  assert.match(remove, /const runChapter = state\.chapter/);
  assert.match(remove, /const runUserKey = state\.userKey/);
  assert.match(remove, /await idbDel\(imgKeyNow\)/);
  assert.match(remove, /if \(!isCurrent\(\)\) return/);
  assert.match(lectureSource, /const drawContext = captureLectureContext\(chapter, wordId\)/);
  assert.match(lectureSource, /const brushContext = captureLectureContext\(state\.chapter\)/);
  assert.match(lectureSource, /await migrateLegacy\(\)/);
});

test("IDB legacy migration is compare-and-set and preserves newer local values", () => {
  assert.match(idbSource, /async function migrateOneLegacyKey\(/);
  assert.match(idbSource, /if \(typeof req\.result === "string"\)/);
  assert.match(idbSource, /const put = store\.put\(value, key\)/);
  assert.match(idbSource, /localStorage\.getItem\(key\) === value/);
  assert.match(idbSource, /store\.put\(legacy, key\)/);
});

test("auth logout clears legacy fallback even when canonical storage is absent", () => {
  assert.match(authSource, /if \(!expectedToken \|\| stored === expectedToken \|\| !stored\)/);
});
