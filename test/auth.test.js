// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";

function memoryStorage({ throwOnSet = false, throwOnGet = false, throwOnRemove = false } = {}) {
  const values = new Map();
  return {
    getItem(key) {
      if (throwOnGet) throw new Error("blocked");
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      if (throwOnSet) throw new Error("quota");
      values.set(key, String(value));
    },
    removeItem(key) {
      if (throwOnRemove) throw new Error("blocked");
      values.delete(key);
    },
    key(index) { return [...values.keys()][index] ?? null; },
    get length() { return values.size; },
  };
}

async function freshAuth(storage) {
  globalThis.localStorage = storage;
  globalThis.fetch = async () => new Response(JSON.stringify({
    token: "t-12345678901234567890123456789012",
    userId: 7,
    email: "user@example.com",
    nickname: "User",
  }), { status: 200, headers: { "content-type": "application/json" } });
  return (await import(`../public/vocab-auth.js?auth-test=${Math.random()}`)).default;
}

test("Auth.init survives throwing storage and keeps a transient token", async () => {
  const auth = await freshAuth(memoryStorage({ throwOnGet: true }));
  const result = await auth.init();
  assert.equal(result, null);
  assert.equal(auth.isLoggedIn(), false);
});

test("Auth.init retries a transient profile failure and restores the session", async () => {
  const storage = memoryStorage();
  storage.setItem("vocab:account-token", "t-retry-123456789012345678901234567890");
  let calls = 0;
  globalThis.localStorage = storage;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) return new Response(JSON.stringify({ error: "temporary" }), { status: 503 });
    return new Response(JSON.stringify({
      token: "t-retry-123456789012345678901234567890",
      userId: 9,
      email: "retry@example.com",
      nickname: "Retry",
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const auth = (await import(`../public/vocab-auth.js?auth-retry=${Math.random()}`)).default;
  const result = await auth.init();
  assert.equal(calls, 2);
  assert.equal(result?.userId, 9);
  assert.equal(auth.isLoggedIn(), true);
});

test("Auth.init does not accept a profile without a positive user id", async () => {
  const storage = memoryStorage();
  globalThis.localStorage = storage;
  globalThis.fetch = async () => new Response(JSON.stringify({
    token: "t-invalid-123456789012345678901234567890",
    userId: 0,
    email: "invalid@example.com",
  }), { status: 200, headers: { "content-type": "application/json" } });
  const auth = (await import(`../public/vocab-auth.js?auth-invalid=${Math.random()}`)).default;
  const result = await auth.init();
  assert.equal(result, null);
  assert.equal(auth.isLoggedIn(), false);
});

test("Auth.init keeps the request timeout active while reading the response body", async () => {
  const storage = memoryStorage();
  storage.setItem("vocab:account-token", "t-body-123456789012345678901234567890123");
  let releaseBody;
  const realSetTimeout = globalThis.setTimeout;
  globalThis.localStorage = storage;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    // Deliberately ignore AbortSignal: the client timeout must still bound body parsing.
    text: () => new Promise((resolve) => {
      releaseBody = () => resolve(JSON.stringify({
        userId: 8,
        email: "body@example.com",
      }));
    }),
  });
  const auth = (await import(`../public/vocab-auth.js?auth-body-timeout=${Math.random()}`)).default;

  // Assumption: tests may accelerate only the auth timeout; retry backoff stays real.
  globalThis.setTimeout = (callback, delay, ...args) => realSetTimeout(callback, delay === 8000 ? 0 : delay, ...args);
  const initPromise = auth.init();
  const observed = await Promise.race([
    initPromise.then(() => "settled"),
    new Promise((resolve) => realSetTimeout(() => resolve("still-reading"), 2000)),
  ]);
  globalThis.setTimeout = realSetTimeout;
  releaseBody();
  const result = await initPromise;

  assert.equal(observed, "settled");
  assert.equal(result, null);
  assert.equal(auth.isLoggedIn(), false);
});

test("Auth.login emits an in-memory session even when token persistence fails", async () => {
  const storage = memoryStorage({ throwOnSet: true });
  const auth = await freshAuth(storage);
  let emitted = null;
  auth.onAuthChange((user) => { emitted = user; });
  const result = await auth.login("user@example.com", "password123");
  assert.equal(result.ok, true);
  assert.equal(auth.isLoggedIn(), true);
  assert.equal(emitted?.userId, 7);
});

test("a 401 from a tokenless request does not clear a newer shared token", async () => {
  const storage = memoryStorage();
  let releaseResponse;
  const pending = new Promise((resolve) => { releaseResponse = resolve; });
  globalThis.localStorage = storage;
  globalThis.fetch = async () => {
    await pending;
    return new Response(JSON.stringify({ error: "expired" }), { status: 401 });
  };
  const auth = (await import(`../public/vocab-auth.js?auth-tokenless-401=${Math.random()}`)).default;
  const login = auth.login("user@example.com", "password123");
  storage.setItem("vocab:account-token", "newer-shared-token");
  releaseResponse();
  const result = await login;

  assert.equal(result.error, "auth_changed");
  assert.equal(storage.getItem("vocab:account-token"), "newer-shared-token");
});

test("a stale 401 does not remove another tab's newer token", async () => {
  const storage = memoryStorage();
  globalThis.localStorage = storage;
  const authA = (await import(`../public/vocab-auth.js?auth-tab-a=${Math.random()}`)).default;
  const authB = (await import(`../public/vocab-auth.js?auth-tab-b=${Math.random()}`)).default;
  globalThis.fetch = async () => new Response(JSON.stringify({ token: "token-a", userId: 1, email: "a@example.com" }), {
    status: 200, headers: { "content-type": "application/json" },
  });
  await authA.login("a@example.com", "password123");
  globalThis.fetch = async () => new Response(JSON.stringify({ token: "token-b", userId: 2, email: "b@example.com" }), {
    status: 200, headers: { "content-type": "application/json" },
  });
  await authB.login("b@example.com", "password123");
  globalThis.fetch = async (url) => {
    if (url.includes("/api/vocab/words")) return new Response(JSON.stringify({ msg: "expired" }), { status: 401 });
    return new Response(JSON.stringify({ userId: 2, email: "b@example.com" }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  };
  const result = await authA.pushWords([{ c: 1, w: 1, s: "learning", cs: 0, wc: 0, seen: 1, due: 0 }]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(storage.getItem("vocab:account-token"), "token-b");
  assert.equal(result.error, "auth_changed");
  assert.equal(authA.userId(), 2);
  assert.equal(authB.isLoggedIn(), true);
});

test("a late login response does not overwrite another tab's newer token", async () => {
  const storage = memoryStorage();
  globalThis.localStorage = storage;
  let resolveA;
  const pendingA = new Promise((resolve) => { resolveA = resolve; });
  let call = 0;
  globalThis.fetch = async () => {
    call++;
    if (call === 1) {
      await pendingA;
      return new Response(JSON.stringify({ token: "token-a", userId: 1, email: "a@example.com" }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ token: "token-b", userId: 2, email: "b@example.com" }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  };
  const authA = (await import(`../public/vocab-auth.js?auth-late-a=${Math.random()}`)).default;
  const authB = (await import(`../public/vocab-auth.js?auth-late-b=${Math.random()}`)).default;
  const loginA = authA.login("a@example.com", "password123");
  const loginB = authB.login("b@example.com", "password123");
  await loginB;
  resolveA();
  const resultA = await loginA;
  // Assumption: adopting the newer shared token validates its profile asynchronously.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(storage.getItem("vocab:account-token"), "token-b");
  assert.equal(resultA.error, "auth_changed");
  assert.equal(authA.isLoggedIn(), true);
  assert.equal(authA.userId(), 2);
  assert.equal(authB.isLoggedIn(), true);
});

test("a late login response does not overwrite a newer shared legacy token", async () => {
  const storage = memoryStorage();
  let resolveLogin;
  const pending = new Promise((resolve) => { resolveLogin = resolve; });
  globalThis.localStorage = storage;
  globalThis.fetch = async () => {
    await pending;
    return new Response(JSON.stringify({ token: "token-late", userId: 1, email: "late@example.com" }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  };
  const auth = (await import(`../public/vocab-auth.js?auth-late-legacy=${Math.random()}`)).default;
  const login = auth.login("late@example.com", "password123");

  // Assumption: a legacy-only write models an older tab before canonical migration.
  storage.setItem("art-rank:account-token", "token-newer-legacy");
  resolveLogin();
  const result = await login;

  assert.equal(result.error, "auth_changed");
  assert.equal(storage.getItem("vocab:account-token"), null);
  assert.equal(storage.getItem("art-rank:account-token"), "token-newer-legacy");
});

test("a successful login clears a stale legacy token after committing the canonical token", async () => {
  const storage = memoryStorage();
  storage.setItem("art-rank:account-token", "stale-legacy-token");
  globalThis.localStorage = storage;
  globalThis.fetch = async () => new Response(JSON.stringify({
    token: "new-canonical-token", userId: 10, email: "new@example.com",
  }), { status: 200, headers: { "content-type": "application/json" } });
  const auth = (await import(`../public/vocab-auth.js?auth-login-cleanup=${Math.random()}`)).default;
  const result = await auth.login("new@example.com", "password123");
  assert.equal(result.ok, true);
  assert.equal(storage.getItem("vocab:account-token"), "new-canonical-token");
  assert.equal(storage.getItem("art-rank:account-token"), null);
});

test("login rejects a malformed successful profile without committing it", async () => {
  const storage = memoryStorage();
  globalThis.localStorage = storage;
  globalThis.fetch = async () => new Response(JSON.stringify({ token: "bad", userId: 0, email: "bad@example.com" }), {
    status: 200, headers: { "content-type": "application/json" },
  });
  const auth = (await import(`../public/vocab-auth.js?auth-bad-login=${Math.random()}`)).default;
  const result = await auth.login("bad@example.com", "password123");
  assert.equal(result.ok, false);
  assert.equal(auth.isLoggedIn(), false);
  assert.equal(storage.getItem("vocab:account-token"), null);
});

test("a stale logout leaves a newer legacy-only session untouched", async () => {
  const storage = memoryStorage();
  globalThis.localStorage = storage;
  globalThis.fetch = async (url) => {
    if (url.endsWith("/api/auth/logout")) return new Response(JSON.stringify({ ok: true }), { status: 200 });
    if (url.endsWith("/api/account/profile")) {
      return new Response(JSON.stringify({ userId: 12, email: "newer@example.com" }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ token: "token-old", userId: 11, email: "old@example.com" }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  };
  const auth = (await import(`../public/vocab-auth.js?auth-stale-logout-legacy=${Math.random()}`)).default;
  await auth.login("old@example.com", "password123");
  storage.removeItem("vocab:account-token");
  storage.setItem("art-rank:account-token", "token-newer");

  const result = await auth.logout();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(result.error, "auth_changed");
  assert.equal(storage.getItem("art-rank:account-token"), "token-newer");
  assert.equal(auth.userId(), 12);
});

test("logout clears mismatched legacy storage immediately and revokes the captured token in background", async () => {
  const storage = memoryStorage();
  let releaseRevoke;
  const revokePending = new Promise((resolve) => { releaseRevoke = resolve; });
  let calls = 0;
  globalThis.localStorage = storage;
  globalThis.fetch = async (url) => {
    calls++;
    if (url.endsWith("/api/auth/logout")) {
      await revokePending;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return new Response(JSON.stringify({ token: "captured-token", userId: 4, email: "logout@example.com" }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  };
  const auth = (await import(`../public/vocab-auth.js?auth-logout-cleanup=${Math.random()}`)).default;
  await auth.login("logout@example.com", "password123");
  storage.setItem("art-rank:account-token", "stale-legacy-token");

  // Assumption: a deferred revoke models a slow network; local logout must not wait for it.
  const result = await auth.logout();
  assert.equal(result.ok, true);
  assert.equal(auth.isLoggedIn(), false);
  assert.equal(storage.getItem("vocab:account-token"), null);
  assert.equal(storage.getItem("art-rank:account-token"), null);
  assert.equal(calls, 2);
  releaseRevoke();
});

test("an invalid external profile clears the mismatched legacy fallback", async () => {
  const storage = memoryStorage();
  const listeners = new Map();
  globalThis.window = {
    addEventListener(type, callback) { listeners.set(type, callback); },
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  };
  storage.setItem("vocab:account-token", "external-invalid");
  storage.setItem("art-rank:account-token", "stale-legacy");
  globalThis.localStorage = storage;
  globalThis.fetch = async () => new Response(JSON.stringify({ userId: 0, email: "invalid@example.com" }), {
    status: 200, headers: { "content-type": "application/json" },
  });
  const auth = (await import(`../public/vocab-auth.js?auth-external-invalid=${Math.random()}`)).default;
  for (const callback of [listeners.get("storage")].flat()) {
    callback?.({ key: "vocab:account-token", newValue: "external-invalid" });
  }
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(auth.isLoggedIn(), false);
  assert.equal(storage.getItem("vocab:account-token"), null);
  assert.equal(storage.getItem("art-rank:account-token"), null);
});

test("a canonical token removal does not resurrect a stale legacy token", async () => {
  const storage = memoryStorage();
  storage.setItem("vocab:account-token", "token-current");
  const listeners = new Map();
  globalThis.window = {
    addEventListener(type, callback) { listeners.set(type, callback); },
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  };
  let profileCalls = 0;
  globalThis.localStorage = storage;
  globalThis.fetch = async () => {
    profileCalls++;
    return new Response(JSON.stringify({ userId: 3, email: "current@example.com" }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  };
  const auth = (await import(`../public/vocab-auth.js?auth-canonical=${Math.random()}`)).default;
  await auth.init();
  assert.equal(auth.userId(), 3);

  // Assumption: the browser dispatches storage events explicitly; localStorage itself does not.
  storage.setItem("art-rank:account-token", "stale-legacy-token");
  storage.removeItem("vocab:account-token");
  listeners.get("storage")?.({ key: "vocab:account-token", oldValue: "token-current", newValue: null });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(profileCalls, 1);
  assert.equal(auth.isLoggedIn(), false);
  assert.equal(auth.userId(), 0);
  assert.equal(storage.getItem("art-rank:account-token"), null);
});

test("login rejects a successful response with a malformed email", async () => {
  const storage = memoryStorage();
  globalThis.localStorage = storage;
  globalThis.fetch = async () => new Response(JSON.stringify({ token: "bad-email", userId: 4, email: "not-an-email" }), {
    status: 200, headers: { "content-type": "application/json" },
  });
  const auth = (await import(`../public/vocab-auth.js?auth-bad-email=${Math.random()}`)).default;
  const result = await auth.login("bad@example.com", "password123");
  assert.equal(result.ok, false);
  assert.equal(auth.isLoggedIn(), false);
  assert.equal(storage.getItem("vocab:account-token"), null);
});

test("register rejects an invalid email before making a request", async () => {
  const storage = memoryStorage();
  let calls = 0;
  globalThis.localStorage = storage;
  globalThis.fetch = async () => {
    calls++;
    return new Response(JSON.stringify({}), { status: 500 });
  };
  const auth = (await import(`../public/vocab-auth.js?auth-register-input=${Math.random()}`)).default;
  const result = await auth.register("not-an-email", "password123");
  assert.equal(result.ok, false);
  assert.equal(result.error, "invalid_email");
  assert.equal(calls, 0);
  assert.equal(auth.isLoggedIn(), false);
});

test("focus retries do not duplicate an in-flight external profile check", async () => {
  const storage = memoryStorage();
  const listeners = new Map();
  globalThis.window = {
    addEventListener(type, callback) { listeners.set(type, callback); },
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  };
  let releaseFirst;
  const firstPending = new Promise((resolve) => { releaseFirst = resolve; });
  let calls = 0;
  globalThis.localStorage = storage;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) {
      await firstPending;
      return new Response(JSON.stringify({ userId: 13, email: "focus@example.com" }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ userId: 14, email: "duplicate@example.com" }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  };
  const auth = (await import(`../public/vocab-auth.js?auth-focus-dedupe=${Math.random()}`)).default;
  storage.setItem("vocab:account-token", "external-focus-token");
  listeners.get("storage")?.({ key: "vocab:account-token", newValue: "external-focus-token" });
  await new Promise((resolve) => setImmediate(resolve));
  listeners.get("focus")?.();
  await new Promise((resolve) => setImmediate(resolve));

  const callsBeforeRelease = calls;
  releaseFirst();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(callsBeforeRelease, 1);
  assert.equal(auth.userId(), 13);
});

test("an external transient profile retries when the browser comes online", async () => {
  const storage = memoryStorage();
  const listeners = new Map();
  const timers = new Map();
  globalThis.window = {
    addEventListener(type, callback) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(callback);
    },
    setTimeout(callback) {
      const id = timers.size + 1;
      timers.set(id, callback);
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
  };
  let calls = 0;
  let resolveRetry;
  const retried = new Promise((resolve) => { resolveRetry = resolve; });
  globalThis.localStorage = storage;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) return new Response(JSON.stringify({ error: "temporary" }), { status: 503 });
    resolveRetry();
    return new Response(JSON.stringify({ userId: 6, email: "online@example.com" }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  };
  const auth = (await import(`../public/vocab-auth.js?auth-online-retry=${Math.random()}`)).default;
  storage.setItem("vocab:account-token", "external-online-token");
  for (const callback of listeners.get("storage") ?? []) callback({ key: "vocab:account-token", newValue: "external-online-token" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  assert.equal(auth.isLoggedIn(), false);

  // Assumption: focus/online notifications are delivered as window events.
  for (const callback of listeners.get("online") ?? []) callback();
  const retriedObserved = await Promise.race([
    retried.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 100)),
  ]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(retriedObserved, true);
  assert.equal(calls, 2);
  assert.equal(auth.isLoggedIn(), true);
  assert.equal(auth.userId(), 6);
});

test("protected requests wait for a validated profile", async () => {
  const storage = memoryStorage();
  storage.setItem("vocab:account-token", "pending-token-123456789012345678901234567890");
  let calls = 0;
  globalThis.localStorage = storage;
  globalThis.fetch = async () => {
    calls++;
    return new Response(JSON.stringify({ msg: "offline" }), { status: 503 });
  };
  const auth = (await import(`../public/vocab-auth.js?auth-pending=${Math.random()}`)).default;
  await auth.init();
  const result = await auth.pullWords();
  assert.equal(result, null);
  assert.equal(calls, 3); // profile plus its two retries; no protected request while pending
  assert.equal(auth.isLoggedIn(), false);
});
