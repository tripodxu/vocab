// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeActiveStars,
  normalizeStarRecords,
  activeFromRecords,
  mergeStarRecords,
  recordsForPush,
  mergeActiveMaps,
  replaceActiveStars,
  setStar,
  activeStarsKey,
  starRecordsKey,
} from "../public/star-store.js";
import { createStarSync } from "../public/star-sync.js";

test("local storage setItem returning false is reported as a failed write", () => {
  const storage = { getItem: () => null, setItem: () => false, removeItem: () => {} };
  const result = setStar("u1", 1, 7, true, storage, 100);
  assert.equal(result.stored, false);
});

test("public star maps reject prototype keys and remain ordinary objects", () => {
  const active = normalizeActiveStars(JSON.parse('{"__proto__":[1]}'));
  assert.deepEqual(active, {});
  assert.equal(Object.getPrototypeOf(active), Object.prototype);
  const records = normalizeStarRecords(JSON.parse('{"__proto__":{"starred":true,"updatedAt":1}}'));
  assert.deepEqual(records, {});
  assert.equal(Object.getPrototypeOf(records), Object.prototype);
  assert.equal({}.polluted, undefined);
});

test("normalizeActiveStars: 兼容旧数组和章节对象，丢弃非法 id", () => {
  assert.deepEqual(normalizeActiveStars([3, 3, "4", 0, -1, 2.5]), { "1": [3, 4] });
  assert.deepEqual(normalizeActiveStars({ "1": [2, 2, 5], "x": [9], 2: [1] }), { "1": [2, 5], "2": [1] });
});

test("normalizeStarRecords: 只接受合法章节/单词/时间戳和布尔状态", () => {
  assert.deepEqual(
    normalizeStarRecords({
      "1:2": { starred: true, updatedAt: 10 },
      "0:3": { starred: true, updatedAt: 10 },
      "1:0": { starred: true, updatedAt: 10 },
      "1:4": { starred: "yes", updatedAt: 10 },
      "1:5": { starred: false, updatedAt: -1 },
    }),
    { "1:2": { starred: true, updatedAt: 10 } }
  );
});

test("activeFromRecords: 删除 tombstone 不出现在生词列表中", () => {
  assert.deepEqual(activeFromRecords({
    "1:2": { starred: true, updatedAt: 20 },
    "1:3": { starred: false, updatedAt: 30 },
  }), { "1": [2] });
});

test("mergeStarRecords: 按 updatedAt LWW，删除也能覆盖旧的加星", () => {
  const local = {
    "1:2": { starred: true, updatedAt: 20 },
    "1:3": { starred: true, updatedAt: 40 },
  };
  const merged = mergeStarRecords(local, [
    { c: 1, w: 2, starred: false, updatedAt: 30 },
    { c: 1, w: 3, starred: false, updatedAt: 10 },
    { c: 1, w: 4, starred: true, updatedAt: 50 },
  ]);
  assert.deepEqual(merged, {
    "1:2": { starred: false, updatedAt: 30 },
    "1:3": { starred: true, updatedAt: 40 },
    "1:4": { starred: true, updatedAt: 50 },
  });
});

test("mergeStarRecords: 相同时间戳删除优先，避免加星复活", () => {
  const merged = mergeStarRecords(
    { "1:2": { starred: true, updatedAt: 10 } },
    [{ c: 1, w: 2, starred: false, updatedAt: 10 }]
  );
  assert.equal(merged["1:2"].starred, false);
});

test("recordsForPush: 时间戳为 0 的旧数据会补成可同步时间戳", () => {
  const changes = recordsForPush({ "1:2": { starred: true, updatedAt: 0 } }, 1234);
  assert.deepEqual(changes, [{ c: 1, w: 2, starred: true, updatedAt: 1234 }]);
});

test("mergeActiveMaps: guest 合并到账号时取并集且去重", () => {
  assert.deepEqual(mergeActiveMaps({ "1": [2, 3], "2": [8] }, { "1": [3, 4], "3": [9] }), {
    "1": [2, 3, 4],
    "2": [8],
    "3": [9],
  });
});

test("replaceActiveStars: 清空/撤销使用单调时间戳，即使活动缓存丢失也能处理记录表", () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  setStar("u1", 1, 7, true, storage, 5000);
  // 模拟 records 写成功、active 写失败后的不一致状态。
  values.set(activeStarsKey("u1"), JSON.stringify({}));
  const cleared = replaceActiveStars("u1", {}, storage, 5000);
  assert.deepEqual(cleared.records["1:7"], { starred: false, updatedAt: 5001 });
  const restored = replaceActiveStars("u1", { "1": [7] }, storage, 5000);
  assert.deepEqual(restored.records["1:7"], { starred: true, updatedAt: 5002 });
});

test("normalizeStarRecords: 拒绝带额外字段的别名键", () => {
  assert.deepEqual(normalizeStarRecords({ "1:2:3": { starred: true, updatedAt: 10 } }), {});
});

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
    key: (index) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  };
}

test("star-sync: stale pull failure cannot surface in the next account", async () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  let userKey = "u1";
  let resolvePull;
  const pending = new Promise((resolve) => { resolvePull = resolve; });
  const auth = {
    isLoggedIn: () => true,
    pullStars: async () => { await pending; return null; },
    pushStars: async () => ({ ok: true }),
  };
  const sync = createStarSync({ getUserKey: () => userKey, auth, storage });
  const oldPull = sync.pull();
  userKey = "u2";
  sync.reset();
  resolvePull();
  await oldPull;
  assert.equal(sync.lastError(), null);
});

test("star-sync: failed removal keeps the memory overlay available", async () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: () => { throw new Error("read only"); },
  };
  const auth = { isLoggedIn: () => false, pullStars: async () => null, pushStars: async () => null };
  const sync = createStarSync({ getUserKey: () => "u1", auth, storage });
  sync.set(1, 7, true);
  // The failed write is overlaid in memory; reset must not make active() lose it.
  sync.reset();
  assert.deepEqual(sync.active(), { "1": [7] });
});

test("star-sync: reset() 清除上一账号的错误状态", async () => {
  const auth = { isLoggedIn: () => true, pullStars: async () => null, pushStars: async () => null };
  const sync = createStarSync({ getUserKey: () => "u1", auth, storage: memoryStorage() });
  assert.equal(await sync.pull(), false);
  assert.match(sync.lastError(), /失败|网络|拉取/);
  sync.reset();
  assert.equal(sync.lastError(), null);
});

test("star-sync: active() 可直接读取 guest 命名空间", () => {
  const storage = memoryStorage({ [activeStarsKey("guest")]: JSON.stringify({ "1": [7] }) });
  const sync = createStarSync({ getUserKey: () => "guest", storage });
  assert.deepEqual(sync.active(), { "1": [7] });
  sync.reset();
});

test("star-sync: 另一标签页关闭前写入的本地胜出记录仍会被 pull 排队并上传", async () => {
  const storage = memoryStorage();
  const pushed = [];
  const auth = {
    isLoggedIn: () => true,
    pullStars: async () => ({ stars: { "1:7": { starred: false, updatedAt: 1 } } }),
    pushStars: async (changes) => { pushed.push(...changes); return { ok: true, applied: changes.length }; },
  };
  const writer = createStarSync({ getUserKey: () => "u1", auth, storage });
  writer.set(1, 7, true);
  writer.reset(); // 模拟写标签页在 800ms 防抖前关闭
  const reader = createStarSync({ getUserKey: () => "u1", auth, storage });
  assert.equal(await reader.pull(), true);
  assert.equal(await reader.flush(), true);
  assert.equal(pushed.some((change) => change.c === 1 && change.w === 7 && change.starred === true), true);
  reader.reset();
});

test("star-sync: localStorage 写入失败时保留内存中的变更并仍可上传", async () => {
  const storage = {
    getItem: () => null,
    setItem: () => { throw new Error("quota"); },
    removeItem: () => {},
  };
  const pushed = [];
  const auth = {
    isLoggedIn: () => true,
    pullStars: async () => ({ stars: {} }),
    pushStars: async (changes) => { pushed.push(...changes); return { ok: true, applied: changes.length }; },
  };
  const sync = createStarSync({ getUserKey: () => "u1", auth, storage });
  sync.set(1, 7, true);
  assert.equal(await sync.flush(), true);
  assert.equal(pushed.length, 1);
  assert.equal(pushed[0].starred, true);
  sync.reset();
});

test("star-sync: 拉取失败会暴露可重试错误", async () => {
  const auth = { isLoggedIn: () => true, pullStars: async () => null, pushStars: async () => null };
  const sync = createStarSync({ getUserKey: () => "u1", auth, storage: memoryStorage() });
  assert.equal(await sync.pull(), false);
  assert.match(sync.lastError(), /失败|网络|拉取/);
  sync.reset();
});

test("star-sync: 未完成 canonical pull 时不把旧的无时间戳活动列表上传", async () => {
  const storage = memoryStorage();
  const pushed = [];
  const auth = {
    isLoggedIn: () => true,
    pullStars: async () => null,
    pushStars: async (changes) => { pushed.push(...changes); return { ok: true, applied: changes.length }; },
  };
  const sync = createStarSync({ getUserKey: () => "u1", auth, storage });
  sync.mergeActive({ "1": [7] });
  assert.equal(await sync.flush(), false);
  assert.equal(pushed.length, 0);
  sync.reset();
});
