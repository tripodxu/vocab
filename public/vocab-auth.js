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
  /** @type {Array<(user: { userId: number, email: string, nickname: string } | null) => void>} */
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
      listener(payload);
    } catch {
      /* ignore */
    }
  }
}

/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 统一请求封装
 * @param {string} path
 * @param {{ method?: string, body?: any, timeout?: number, retries?: number }} [opts]
 * @returns {Promise<{ ok: boolean, status: number, data: any, error?: string, msg?: string }>}
 */
async function api(path, opts = {}) {
  const method = opts.method ?? "GET";
  const timeout = opts.timeout ?? 15000;
  const retries = opts.retries ?? 0;
  let lastError = { ok: false, status: 0, data: null, error: "network", msg: "网络连接失败" };

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      /** @type {Record<string,string>} */
      const headers = { "content-type": "application/json" };
      if (state.token) headers.authorization = `Bearer ${state.token}`;
      const res = await fetch(state.apiBase + path, {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: controller.signal,
      });
      clearTimeout(timer);
      const text = await res.text();
      let data = null;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = null;
        }
      }
      if (res.status === 401) {
        // 会话已失效：清掉本地登录态，让界面立刻反映真实情况
        clearSession();
        emitAuth();
        return { ok: false, status: 401, data, error: "authentication_required", msg: data?.msg || "登录已过期，请重新登录" };
      }
      if (!res.ok) {
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
      const aborted = err instanceof DOMException && err.name === "AbortError";
      lastError = {
        ok: false,
        status: 0,
        data: null,
        error: aborted ? "timeout" : "network",
        msg: aborted ? "请求超时" : "网络连接失败",
      };
      if (attempt < retries) await sleep(400 * (attempt + 1));
    }
  }
  return lastError;
}

function clearSession() {
  state.token = "";
  state.userId = 0;
  state.email = "";
  state.nickname = "";
  localStorage.removeItem(TOKEN_KEY);
}

function saveSession(/** @type {{token:string, userId:number, email:string, nickname?:string}} */ payload) {
  state.token = payload.token;
  state.userId = Number(payload.userId) || 0;
  state.email = payload.email;
  state.nickname = payload.nickname || payload.email.split("@")[0];
  localStorage.setItem(TOKEN_KEY, state.token);
}

/** 从 localStorage 读 token（兼容旧 key） */
function loadToken() {
  const stored = localStorage.getItem(TOKEN_KEY);
  if (stored) return stored;
  for (const legacy of LEGACY_TOKEN_KEYS) {
    const value = localStorage.getItem(legacy);
    if (value) {
      localStorage.setItem(TOKEN_KEY, value);
      localStorage.removeItem(legacy);
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
    state.token = loadToken();
    if (!state.token) {
      state.ready = true;
      emitAuth();
      return null;
    }
    const res = await api("/api/account/profile", { timeout: 8000 });
    if (res.ok && res.data?.email) {
      state.userId = Number(res.data.userId) || 0;
      state.email = res.data.email;
      state.nickname = res.data.nickname || res.data.email.split("@")[0];
      state.ready = true;
      emitAuth();
      return { userId: state.userId, email: state.email, nickname: state.nickname };
    }
    state.ready = true;
    emitAuth();
    return null;
  },

  isLoggedIn: () => Boolean(state.token && state.userId),
  userId: () => state.userId,
  email: () => state.email,
  nickname: () => state.nickname,
  syncState: () => state.sync,

  /** @param {(user: { userId: number, email: string, nickname: string } | null) => void} cb */
  onAuthChange(cb) {
    state.authListeners.push(cb);
    if (state.ready) {
      cb(state.userId ? { userId: state.userId, email: state.email, nickname: state.nickname } : null);
    }
  },

  /** @param {(s: SyncState) => void} cb */
  onSync(cb) {
    state.syncListeners.push(cb);
    cb(state.sync);
  },

  /** @param {string} email @param {string} password */
  async login(email, password) {
    const res = await api("/api/auth/login", { method: "POST", body: { email, password } });
    if (!res.ok) return res;
    saveSession(res.data);
    emitAuth();
    return res;
  },

  /** @param {string} email @param {string} password @param {string} [nickname] */
  async register(email, password, nickname) {
    const res = await api("/api/auth/register", { method: "POST", body: { email, password, nickname } });
    if (!res.ok) return res;
    saveSession(res.data);
    emitAuth();
    return res;
  },

  async logout() {
    if (state.token) await api("/api/auth/logout", { method: "POST", timeout: 8000 });
    clearSession();
    emitAuth();
    emitSync({ state: "idle" });
    return { ok: true, status: 200, data: {} };
  },

  /** @param {string} nickname */
  updateNickname(nickname) {
    return api("/api/account/profile", { method: "PUT", body: { nickname } }).then((res) => {
      if (res.ok) {
        state.nickname = res.data?.nickname || nickname;
        emitAuth();
      }
      return res;
    });
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
      emitSync(res.ok ? { state: "ok" } : { state: "error", message: res.msg });
      return res;
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
   */
  putNote(chapter, word, note) {
    if (!state.token) return Promise.resolve({ ok: true, status: 200, data: {} });
    return api("/api/vocab/notes", { method: "PUT", body: { chapter, word, note, updatedAt: Date.now() } });
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
   */
  putNoteImage(chapter, word, mime, data) {
    if (!state.token) return Promise.resolve({ ok: false, status: 401, data: null, error: "auth", msg: "请先登录" });
    return api("/api/vocab/notes/image", { method: "POST", body: { chapter, word, mime, data }, timeout: 30000 });
  },

  /** @param {number} chapter @param {number} word */
  deleteNoteImage(chapter, word) {
    if (!state.token) return Promise.resolve({ ok: true, status: 200, data: {} });
    return api("/api/vocab/notes/image", { method: "DELETE", body: { chapter, word } });
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
