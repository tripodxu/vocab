// @ts-check
/**
 * vocab-auth.js —— 账号与云同步（无框架、同源 API）
 *
 * 与旧版的区别：
 *  · 每个请求都有超时与错误分类，失败不再被静默吞掉（调用方能看到 msg）
 *  · 提供 userId，前端据此给本地存档分账号命名空间（修掉"换账号数据串号"）
 *  · 401 会自动清理登录态并通知订阅者（不再假装还登录着）
 *  · 支持登出（服务端吊销会话）、改昵称、改密码、导入导出
 *  · 学习状态按词增量同步（pullWords/pushWords），不再整章覆盖
 *  · 无 console 调试输出
 */

const TOKEN_KEY = "vocab:account-token";
const LEGACY_TOKEN_KEYS = ["art-rank:account-token"];

/** @typedef {{ state: "idle"|"syncing"|"ok"|"error", message?: string }} SyncState */

let authRevision = 0;
let profileCheckInFlight = false;
let profileCheckToken = "";
let profileRetryTimer = 0;
const state = {
  /** @type {string} */
  apiBase: "",
  /** @type {string} */
  token: "",
  /** @type {number} */
  userId: 0,
  /** @type {string} */
  email: "",
  nickname: "",
  ready: false,
  /** @type {Array<(user: { userId: number, email: string, nickname: string } | null) => void | PromiseLike<void>>} */
  authListeners: [],
  /** @type {SyncState} */
  sync: { state: "idle" },
  /** @type {Array<(state: SyncState) => void>} */
  syncListeners: [],
};

/** @param {SyncState} next */
function emitSync(next) {
  state.sync = next;
  for (const listener of state.syncListeners) {
    try {
      listener(next);
    } catch {
      /* 监听器异常不影响同步 */
    }
  }
}

function emitAuth() {
  const payload = state.userId ? { userId: state.userId, email: state.email, nickname: state.nickname } : null;
  for (const listener of state.authListeners) {
    try {
      const result = listener(payload);
      if (result && typeof result.then === "function") result.catch(() => {});
    } catch {
      /* ignore */
    }
  }
}

function storageGet(key) {
  try {
    return typeof localStorage === "undefined" ? null : localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key, value) {
  try {
    if (typeof localStorage === "undefined") return false;
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function storageRemove(key) {
  try {
    if (typeof localStorage === "undefined") return false;
    localStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

function storedTokenForAuth() {
  const canonical = storageGet(TOKEN_KEY);
  if (canonical) return canonical;
  for (const legacy of LEGACY_TOKEN_KEYS) {
    const value = storageGet(legacy);
    if (value) return value;
  }
  return "";
}

/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const isValidEmail = (value) => typeof value === "string" && value.length <= 160 && EMAIL_PATTERN.test(value);
const normalizeEmail = (value) => typeof value === "string" ? value.trim().toLowerCase() : "";

const isValidProfile = (data) => Boolean(
  data &&
  typeof data.userId === "number" &&
  Number.isSafeInteger(data.userId) &&
  data.userId > 0 &&
  isValidEmail(data.email)
);

const isValidSession = (data) => Boolean(isValidProfile(data) && typeof data.token === "string" && data.token.trim());

/** Serialize token commits when the browser exposes Web Locks; fall back safely elsewhere. */
async function withTokenLock(run) {
  const locks = globalThis.navigator?.locks;
  if (locks && typeof locks.request === "function") return locks.request("vocab-auth-token", run);
  return run();
}

function scheduleProfileRetry() {
  if (profileRetryTimer || typeof window === "undefined" || !window.setTimeout) return;
  profileRetryTimer = window.setTimeout(() => {
    profileRetryTimer = 0;
    retryProfile();
  }, 5000);
}

function retryProfile() {
  if (!state.token || state.userId || profileCheckInFlight) return;
  if (profileRetryTimer && typeof window !== "undefined") window.clearTimeout(profileRetryTimer);
  profileRetryTimer = 0;
  void adoptExternalToken(state.token);
}

function makeAbortError() {
  const error = new Error("请求超时");
  error.name = "AbortError";
  return error;
}

async function readResponseText(res, signal) {
  let rejectOnAbort;
  const aborted = new Promise((_, reject) => {
    rejectOnAbort = () => reject(makeAbortError());
    if (signal.aborted) rejectOnAbort();
    else signal.addEventListener("abort", rejectOnAbort, { once: true });
  });
  try {
    return await Promise.race([Promise.resolve().then(() => res.text()), aborted]);
  } finally {
    signal.removeEventListener("abort", rejectOnAbort);
  }
}

/**
 * 统一请求封装
 * @param {string} path
 * @param {{ method?: string, body?: any, timeout?: number, retries?: number, token?: string }} [opts]
 * @returns {Promise<{ ok: boolean, status: number, data: any, error?: string, msg?: string }>}
 */
async function api(path, opts = {}) {
  const method = opts.method ?? "GET";
  const timeout = opts.timeout ?? 15000;
  const retries = opts.retries ?? 0;
  // 一次操作固定使用同一个 bearer token/用户身份；账号切换后旧请求不能带着新 token 重试。
  const requestToken = opts.token ?? state.token;
  const requestUserId = state.userId;
  const requestRevision = authRevision;
  const sameAuth = () =>
    state.token === requestToken && state.userId === requestUserId && authRevision === requestRevision;
  if (requestToken && requestUserId <= 0 && !["/api/account/profile", "/api/auth/login", "/api/auth/register", "/api/auth/logout"].includes(path)) {
    return { ok: false, status: 0, data: null, error: "profile_pending", msg: "登录资料正在校验" };
  }
  let lastError = { ok: false, status: 0, data: null, error: "network", msg: "网络连接失败" };

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      /** @type {Record<string,string>} */
      const headers = { "content-type": "application/json" };
      if (requestToken) headers.authorization = `Bearer ${requestToken}`;
      const res = await fetch(state.apiBase + path, {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: controller.signal,
      });
      const text = await readResponseText(res, controller.signal);
      let data = null;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = null;
        }
      }
      clearTimeout(timer);
      if (!sameAuth()) {
        return { ok: false, status: 0, data: null, error: "auth_changed", msg: "登录状态已变化" };
      }
      if (res.status === 401) {
        // 旧标签页/旧账号的响应不能清掉当前新会话。
        if (sameAuth()) {
          const cleared = clearSession(requestToken);
          if (!cleared) {
            const newer = storedTokenForAuth();
            if (newer && newer !== requestToken) void adoptExternalToken(newer);
            return { ok: false, status: 0, data: null, error: "auth_changed", msg: "登录状态已变化" };
          }
          emitAuth();
        }
        return { ok: false, status: 401, data, error: "authentication_required", msg: data?.msg || "登录已过期，请重新登录" };
      }
      if (!res.ok) {
        const transient = res.status === 408 || res.status === 429 || res.status >= 500;
        if (transient && attempt < retries) {
          await sleep(400 * (attempt + 1));
          if (!sameAuth()) return { ok: false, status: 0, data: null, error: "auth_changed", msg: "登录状态已变化" };
          continue;
        }
        return {
          ok: false,
          status: res.status,
          data,
          error: data?.error || "http_error",
          msg: data?.msg || `请求失败（${res.status}）`,
        };
      }
      return { ok: true, status: res.status, data };
    } catch (err) {
      clearTimeout(timer);
      const aborted = /** @type {any} */ (err)?.name === "AbortError";
      if (!sameAuth()) {
        lastError = { ok: false, status: 0, data: null, error: "auth_changed", msg: "登录状态已变化" };
        break;
      }
      lastError = {
        ok: false,
        status: 0,
        data: null,
        error: aborted ? "timeout" : "network",
        msg: aborted ? "请求超时" : "网络连接失败",
      };
      if (attempt < retries) {
        await sleep(400 * (attempt + 1));
        if (!sameAuth()) {
          lastError = { ok: false, status: 0, data: null, error: "auth_changed", msg: "登录状态已变化" };
          break;
        }
      }
    }
  }
  return lastError;
}

function clearLegacyTokens(expectedToken = state.token, all = false) {
  for (const legacy of LEGACY_TOKEN_KEYS) {
    const legacyValue = storageGet(legacy);
    if (all || !expectedToken || legacyValue === expectedToken) storageRemove(legacy);
  }
}

function clearSession(expectedToken = state.token, explicit = false) {
  const stored = storageGet(TOKEN_KEY);
  const legacyValues = LEGACY_TOKEN_KEYS.map(storageGet).filter(Boolean);
  // A late response from an older tab may only clear the token it observed.
  // If another tab has already installed a different canonical token, leave it
  // intact and let the storage event adopt it instead. With no canonical token,
  // a different legacy token is still a real shared session and must survive.
  const hasStoredToken = Boolean(stored || legacyValues.length);
  const conflictingLegacy = !stored && legacyValues.some((value) => value !== expectedToken);
  if (hasStoredToken && !expectedToken) return false;
  if (expectedToken && ((stored && stored !== expectedToken) || conflictingLegacy)) return false;
  if (profileRetryTimer && typeof window !== "undefined") window.clearTimeout(profileRetryTimer);
  profileRetryTimer = 0;
  authRevision++;
  state.token = "";
  state.userId = 0;
  state.email = "";
  state.nickname = "";
  if (!expectedToken || stored === expectedToken || !stored) {
    storageRemove(TOKEN_KEY);
    clearLegacyTokens(expectedToken, explicit);
  }
  return true;
}

/** 另一个标签页改了 token：先暂停本标签页的写入，再异步校验新会话。 */
async function adoptExternalToken(rawToken) {
  const nextToken = String(rawToken || "");
  if (profileCheckInFlight && profileCheckToken === nextToken) return;
  if (nextToken === state.token && state.userId > 0) return;
  profileCheckInFlight = true;
  profileCheckToken = nextToken;
  try {
    authRevision++;
    state.token = nextToken;
    state.userId = 0;
    state.email = "";
    state.nickname = "";
    emitAuth();
    if (!nextToken) return;
    const profileRevision = authRevision;
    const res = await api("/api/account/profile", { timeout: 8000 });
    if (state.token !== nextToken || authRevision !== profileRevision) return;
    if (res.ok && isValidProfile(res.data)) {
      authRevision++;
      state.userId = Number(res.data.userId);
      state.email = res.data.email;
      state.nickname = res.data.nickname || state.email.split("@")[0];
      state.ready = true;
      emitAuth();
    } else if (res.status === 401 || res.error === "authentication_required") {
      if (!clearSession(nextToken, true)) {
        const newer = storedTokenForAuth();
        if (newer && newer !== nextToken) void adoptExternalToken(newer);
      }
      emitAuth();
    } else if (res.ok) {
      // HTTP 200 但资料形状非法：不要把未验证身份当登录态。
      if (!clearSession(nextToken, true)) {
        const newer = storedTokenForAuth();
        if (newer && newer !== nextToken) void adoptExternalToken(newer);
      }
      emitAuth();
    } else {
      // 网络/超时/5xx 不能把另一个标签页刚写入的 token 清掉；暂停写入，等待下一次校验。
      state.ready = true;
      emitAuth();
      emitSync({ state: "error", message: res.msg || "登录状态暂时无法校验" });
      scheduleProfileRetry();
    }
  } finally {
    if (profileCheckToken === nextToken) {
      profileCheckInFlight = false;
      profileCheckToken = "";
    }
  }
}

if (typeof window !== "undefined" && window.addEventListener) {
  window.addEventListener("storage", (event) => {
    if (event.key !== TOKEN_KEY && event.key !== LEGACY_TOKEN_KEYS[0]) return;
    const canonical = storageGet(TOKEN_KEY);
    if (event.key === TOKEN_KEY && !canonical) clearLegacyTokens("", true);
    const next = canonical || (event.key === LEGACY_TOKEN_KEYS[0] ? storageGet(LEGACY_TOKEN_KEYS[0]) : "");
    void adoptExternalToken(next);
  });
  const retryOnBrowserWake = () => retryProfile();
  window.addEventListener("focus", retryOnBrowserWake);
  window.addEventListener("online", retryOnBrowserWake);
}

async function saveSession(/** @type {{token:string, userId:number, email:string, nickname?:string}} */ payload, expectedStoredToken = null) {
  if (!isValidSession(payload)) return { ok: false, error: "invalid_session" };
  return withTokenLock(() => {
    const observed = storedTokenForAuth();
    const expected = expectedStoredToken || "";
    if (observed !== expected) {
      if (observed) void adoptExternalToken(observed);
      return { ok: false, error: "auth_changed" };
    }
    authRevision++;
    state.token = payload.token;
    state.userId = Number(payload.userId);
    state.email = payload.email;
    state.nickname = payload.nickname || payload.email.split("@")[0];
    const persisted = storageSet(TOKEN_KEY, state.token);
    if (persisted) clearLegacyTokens(payload.token, true);
    return { ok: true };
  });
}

/** 从 localStorage 读 token（兼容旧 key） */
function loadToken() {
  const stored = storageGet(TOKEN_KEY);
  if (stored) return stored;
  for (const legacy of LEGACY_TOKEN_KEYS) {
    const value = storageGet(legacy);
    if (value) {
      if (storageSet(TOKEN_KEY, value)) storageRemove(legacy);
      return value;
    }
  }
  return "";
}

export const Auth = {
  /** @param {{ apiBase?: string }} opts */
  configure(opts) {
    if (opts.apiBase !== undefined) state.apiBase = opts.apiBase;
  },

  /** 页面启动时调用：恢复登录态（有 token 就验一次） */
  async init() {
    const token = loadToken();
    if (token !== state.token) {
      authRevision++;
      state.token = token;
      state.userId = 0;
      state.email = "";
      state.nickname = "";
    }
    if (!state.token) {
      state.ready = true;
      emitAuth();
      return null;
    }
    const res = await api("/api/account/profile", { timeout: 8000, retries: 2 });
    if (res.ok && isValidProfile(res.data)) {
      state.userId = Number(res.data.userId);
      state.email = res.data.email;
      state.nickname = res.data.nickname || res.data.email.split("@")[0];
      state.ready = true;
      emitAuth();
      return { userId: state.userId, email: state.email, nickname: state.nickname };
    }
    if (res.status === 401 || res.error === "authentication_required") {
      clearSession(token);
      state.ready = true;
      emitAuth();
      return null;
    }
    if (res.ok && !isValidProfile(res.data)) {
      clearSession(token);
      state.ready = true;
      emitAuth();
      return null;
    }
    // 网络/超时/5xx 保留 token 供稍后重试，但当前页面先以 guest/离线模式运行。
    state.ready = true;
    emitAuth();
    emitSync({ state: "error", message: res.msg || "登录状态暂时无法校验" });
    scheduleProfileRetry();
    return null;
  },

  isLoggedIn: () => Boolean(state.token && state.userId),
  userId: () => state.userId,
  email: () => state.email,
  nickname: () => state.nickname,
  syncState: () => state.sync,
  revision: () => authRevision,

  /** @param {(user: { userId: number, email: string, nickname: string } | null) => void | PromiseLike<void>} cb */
  onAuthChange(cb) {
    state.authListeners.push(cb);
    if (state.ready) {
      try {
        const result = cb(state.userId ? { userId: state.userId, email: state.email, nickname: state.nickname } : null);
        if (result && typeof result.then === "function") result.catch(() => {});
      } catch {
        /* ignore */
      }
    }
  },

  /** @param {(s: SyncState) => void} cb */
  onSync(cb) {
    state.syncListeners.push(cb);
    cb(state.sync);
  },

  /** @param {string} email @param {string} password */
  async login(email, password) {
    const normalizedEmail = normalizeEmail(email);
    if (!isValidEmail(normalizedEmail)) {
      return { ok: false, status: 400, data: null, error: "invalid_email", msg: "邮箱格式不正确" };
    }
    const requestRevision = authRevision;
    const expectedStoredToken = storedTokenForAuth();
    const request = api("/api/auth/login", { method: "POST", body: { email: normalizedEmail, password } });
    const res = await request;
    if (!res.ok) return res;
    if (authRevision !== requestRevision) return { ok: false, status: 0, data: null, error: "auth_changed", msg: "登录状态已变化" };
    const saved = await saveSession(res.data, expectedStoredToken);
    if (!saved.ok) {
      return { ok: false, status: 0, data: null, error: saved.error, msg: saved.error === "auth_changed" ? "登录状态已变化" : "登录响应无效" };
    }
    emitAuth();
    return res;
  },

  /** @param {string} email @param {string} password @param {string} [nickname] */
  async register(email, password, nickname) {
    const normalizedEmail = normalizeEmail(email);
    if (!isValidEmail(normalizedEmail)) {
      return { ok: false, status: 400, data: null, error: "invalid_email", msg: "邮箱格式不正确" };
    }
    const requestRevision = authRevision;
    const expectedStoredToken = storedTokenForAuth();
    const res = await api("/api/auth/register", { method: "POST", body: { email: normalizedEmail, password, nickname } });
    if (!res.ok) return res;
    if (authRevision !== requestRevision) return { ok: false, status: 0, data: null, error: "auth_changed", msg: "登录状态已变化" };
    const saved = await saveSession(res.data, expectedStoredToken);
    if (!saved.ok) {
      return { ok: false, status: 0, data: null, error: saved.error, msg: saved.error === "auth_changed" ? "登录状态已变化" : "登录响应无效" };
    }
    emitAuth();
    return res;
  },

  async logout() {
    const token = state.token;
    const userId = state.userId;
    const revision = authRevision;
    if (!token) return { ok: true, status: 200, data: {} };
    if (state.token === token && state.userId === userId && authRevision === revision) {
      if (!clearSession(token, true)) {
        const newer = storedTokenForAuth();
        if (newer) void adoptExternalToken(newer);
        return { ok: false, status: 0, data: null, error: "auth_changed", msg: "登录状态已变化" };
      }
      emitAuth();
      emitSync({ state: "idle" });
      void api("/api/auth/logout", { method: "POST", token, timeout: 8000 });
      return { ok: true, status: 200, data: {} };
    }
    return { ok: false, status: 0, data: null, error: "auth_changed", msg: "登录状态已变化" };
  },

  /** @param {string} nickname */
  async updateNickname(nickname) {
    const requestRevision = authRevision;
    const res = await api("/api/account/profile", { method: "PUT", body: { nickname } });
    if (res.ok && authRevision === requestRevision) {
      state.nickname = res.data?.nickname || nickname;
      emitAuth();
    }
    return res;
  },

  /** @param {string} currentPassword @param {string} newPassword */
  changePassword(currentPassword, newPassword) {
    return api("/api/account/password", { method: "POST", body: { currentPassword, newPassword } });
  },

  // ---------- 学习状态 ----------

  /** @param {number} [since] */
  pullWords(since = 0) {
    if (!state.token) return Promise.resolve(null);
    emitSync({ state: "syncing" });
    return api(`/api/vocab/words?since=${Math.max(0, Number(since) || 0)}`, { retries: 1 }).then((res) => {
      if (res.error === "auth_changed") return null;
      if (!res.ok) {
        emitSync({ state: "error", message: res.msg });
        return null;
      }
      emitSync({ state: "ok" });
      return res.data;
    });
  },

  /** @param {Array<{c:number,w:number,s:string,cs:number,wc:number,seen:number,due:number}>} changes */
  pushWords(changes) {
    if (!state.token || !changes.length) return Promise.resolve({ ok: true, status: 200, data: { applied: 0 } });
    emitSync({ state: "syncing" });
    return api("/api/vocab/words", { method: "PUT", body: { changes }, retries: 1 }).then((res) => {
      if (res.error !== "auth_changed") emitSync(res.ok ? { state: "ok" } : { state: "error", message: res.msg });
      return res;
    });
  },

  /**
   * 拉取生词本。服务端返回按 `chapter:word` 键控的记录 map，删除项也保留为
   * `{ starred: false, updatedAt }` tombstone，失败或未登录返回 null。
   * @param {number} [since]
   */
  pullStars(since = 0) {
    if (!state.token) return Promise.resolve(null);
    emitSync({ state: "syncing" });
    return api(`/api/vocab/stars?since=${Math.max(0, Number(since) || 0)}`, { retries: 1 }).then((res) => {
      if (res.error === "auth_changed") return null;
      if (!res.ok) {
        emitSync({ state: "error", message: res.msg });
        return null;
      }
      emitSync({ state: "ok" });
      return res.data;
    });
  },

  /**
   * 上行生词 tombstone/加星记录。成功返回 `{ok:true, applied, serverTime}`，
   * 失败或未登录返回 null；调用方可直接把 null 视为待重试。
   * @param {Array<{c:number,w:number,starred:boolean,updatedAt:number}>} changes
   */
  pushStars(changes) {
    if (!state.token) return Promise.resolve(null);
    if (!changes.length) return Promise.resolve({ ok: true, applied: 0 });
    emitSync({ state: "syncing" });
    return api("/api/vocab/stars", { method: "PUT", body: { changes }, retries: 1 }).then((res) => {
      if (res.error === "auth_changed") return null;
      if (!res.ok) {
        emitSync({ state: "error", message: res.msg });
        return null;
      }
      emitSync({ state: "ok" });
      return res.data;
    });
  },

  /** @param {number} chapter */
  resetChapter(chapter) {
    if (!state.token) return Promise.resolve({ ok: true, status: 200, data: {} });
    return api("/api/vocab/words", { method: "DELETE", body: { chapter } });
  },

  // ---------- 设置 ----------

  /** 题目报错（第五期）：未登录返回 { ok:false, auth:false } */
  reportQuestion(chapter, wordId, kind, note = "") {
    if (!state.token) return Promise.resolve({ ok: false, auth: false, msg: "请先登录后再提交" });
    return api("/api/quiz/report", { method: "POST", body: { chapter, wordId, kind, note }, timeout: 10000 });
  },

  getSettings() {
    if (!state.token) return Promise.resolve(null);
    return api("/api/vocab/settings").then((res) => (res.ok ? res.data?.settings ?? null : null));
  },

  /** @param {any} settings */
  putSettings(settings) {
    if (!state.token) return Promise.resolve({ ok: true, status: 200, data: {} });
    return api("/api/vocab/settings", { method: "PUT", body: settings });
  },

  // ---------- 讲义备注与配图 ----------

  /** @param {number} chapter */
  getNotes(chapter) {
    if (!state.token) return Promise.resolve(null);
    return api(`/api/vocab/notes?chapter=${chapter}`).then((res) => (res.ok ? res.data : null));
  },

  /**
   * @param {number} chapter @param {number} word @param {string} note
   * @param {number} [updatedAt] 备注的客户端时间戳（服务端按它做按条 LWW；缺省用当前时刻）
   */
  putNote(chapter, word, note, updatedAt) {
    if (!state.token) return Promise.resolve({ ok: true, status: 200, data: {} });
    return api("/api/vocab/notes", {
      method: "PUT",
      body: { chapter, word, note, updatedAt: Number(updatedAt) || Date.now() },
    });
  },

  /** @param {number} chapter @param {number} word */
  getNoteImage(chapter, word) {
    if (!state.token) return Promise.resolve(null);
    return api(`/api/vocab/notes/image?chapter=${chapter}&word=${word}`).then((res) =>
      res.ok ? res.data : null
    );
  },

  /**
   * @param {number} chapter @param {number} word @param {string} mime @param {string} data base64（不含前缀）
   * @param {number} [updatedAt]
   */
  putNoteImage(chapter, word, mime, data, updatedAt) {
    if (!state.token) return Promise.resolve({ ok: false, status: 401, data: null, error: "auth", msg: "请先登录" });
    return api("/api/vocab/notes/image", {
      method: "POST",
      body: { chapter, word, mime, data, updatedAt: Number(updatedAt) || Date.now() },
      timeout: 30000,
    });
  },

  /** @param {number} chapter @param {number} word @param {number} [updatedAt] */
  deleteNoteImage(chapter, word, updatedAt) {
    if (!state.token) return Promise.resolve({ ok: true, status: 200, data: {} });
    return api("/api/vocab/notes/image", {
      method: "DELETE",
      body: { chapter, word, updatedAt: Number(updatedAt) || Date.now() },
    });
  },

  // ---------- 备份 ----------

  /** @param {boolean} [withImages] */
  exportAll(withImages = false) {
    if (!state.token) return Promise.resolve(null);
    return api(`/api/vocab/export${withImages ? "?images=1" : ""}`, { timeout: 30000 }).then((res) =>
      res.ok ? res.data : null
    );
  },

  /** @param {any} payload */
  importAll(payload) {
    if (!state.token) return Promise.resolve({ ok: false, status: 401, data: null, error: "auth", msg: "请先登录" });
    return api("/api/vocab/import", { method: "POST", body: payload, timeout: 60000 });
  },
};

export default Auth;
