// @ts-check
/**
 * vocab Worker —— 认证 / 按词学习状态 / 讲义备注与配图 / 静态资源
 *
 * 设计说明：
 *  - 全部数据访问都经过 env.DB（D1）。本文件不依赖任何 Cloudflare 专有全局，
 *    只用 Request/Response/Headers/crypto，因此可以直接被 node --test import 做单元测试。
 *  - 学习状态按 (user, chapter, word) 存储，写入用 seen_at 做 LWW，
 *    多端交替作答不会互相覆盖（这是旧版整章 blob 存储做不到的）。
 */

/** @typedef {{ DB: D1Database, ASSETS: Fetcher }} Env */

const encoder = new TextEncoder();
const SESSION_DAYS = 30;
const PBKDF2_ITERATIONS = 100_000;
const MAX_JSON_BYTES = 8 * 1024;
const MAX_WORDS_BODY = 256 * 1024;
const MAX_CHANGES = 800;
const MAX_NOTE_CHARS = 4000;
const MAX_IMAGE_BASE64 = 400_000; // ≈300KB 二进制
const IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/webp"]);
const WORD_STATUS = new Set(["learning", "wrong", "mastered"]);
const THROTTLE_WINDOW_MS = 15 * 60 * 1000;
const THROTTLE_MAX_FAILURES = 8;
const THROTTLE_BLOCK_MS = 10 * 60 * 1000;

// ============ 基础工具 ============

/** 安全响应头（同源应用，不需要 CORS） */
const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "same-origin",
  "x-frame-options": "DENY",
  // 说明：Cloudflare 的 Web Analytics 会往 HTML 注入 beacon.min.js，
  // 如果严格只允许 'self'，每次加载都会在控制台留下一条 CSP 报错，所以显式放行它。
  "content-security-policy":
    "default-src 'self'; script-src 'self' https://static.cloudflareinsights.com; " +
    "style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self'; " +
    "connect-src 'self' https://cloudflareinsights.com; object-src 'none'; base-uri 'none'; " +
    "form-action 'none'; frame-ancestors 'none'",
};

/**
 * @param {unknown} data
 * @param {number} [status]
 * @param {Record<string,string>} [extra]
 */
function json(data, status = 200, extra) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...SECURITY_HEADERS,
      ...extra,
    },
  });
}

/** @param {number} bytes */
const tooLarge = (bytes) => json({ error: "payload_too_large", msg: "提交的数据过大" }, 413);

/**
 * 解析并校验 JSON body，返回 null 表示不合法（调用方负责响应）
 * @param {Request} request
 * @param {number} maxBytes
 */
async function readJson(request, maxBytes = MAX_JSON_BYTES) {
  const raw = await request.text();
  if (encoder.encode(raw).byteLength > maxBytes) return { error: "payload_too_large" };
  try {
    return { data: JSON.parse(raw) };
  } catch {
    return { error: "invalid_json" };
  }
}

/** @param {ArrayBuffer | Uint8Array} buf */
function toHex(buf) {
  const view = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let out = "";
  for (let i = 0; i < view.length; i++) out += view[i].toString(16).padStart(2, "0");
  return out;
}

/** base64 → Uint8Array（Worker 与 Node 都可用） */
function fromBase64(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// ============ 密码 ============

/** @param {string} pw */
async function hashPassword(pw) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", encoder.encode(pw), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: PBKDF2_ITERATIONS },
    key,
    256
  );
  return `pbkdf2$${PBKDF2_ITERATIONS}$${toHex(salt)}$${toHex(bits)}`;
}

/**
 * @param {string} pw
 * @param {string} stored
 */
async function verifyPassword(pw, stored) {
  if (typeof stored !== "string" || !stored.startsWith("pbkdf2$")) return false;
  const [, iter, saltHex, hashHex] = stored.split("$");
  if (!iter || !saltHex || !hashHex) return false;
  const salt = Uint8Array.from({ length: saltHex.length / 2 }, (_, i) =>
    parseInt(saltHex.slice(i * 2, i * 2 + 2), 16)
  );
  const key = await crypto.subtle.importKey("raw", encoder.encode(pw), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: Number(iter) },
    key,
    256
  );
  const computed = toHex(bits);
  if (computed.length !== hashHex.length) return false;
  let diff = 0;
  for (let i = 0; i < computed.length; i++) diff |= computed.charCodeAt(i) ^ hashHex.charCodeAt(i);
  return diff === 0;
}

function genToken() {
  return toHex(crypto.getRandomValues(new Uint8Array(32)));
}

/** @param {string} e */
const isValidEmail = (e) => typeof e === "string" && e.length <= 160 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

// ============ 会话 ============

/**
 * @param {D1Database} db
 * @param {number} userId
 */
async function createSession(db, userId) {
  const token = genToken();
  const expires = new Date(Date.now() + SESSION_DAYS * 86400_000).toISOString();
  await db
    .prepare("INSERT INTO user_sessions (token, user_id, expires_at) VALUES (?, ?, ?)")
    .bind(token, userId, expires)
    .run();
  return token;
}

/**
 * @param {Request} request
 * @param {D1Database} db
 * @returns {Promise<{ id: number, email: string, token: string } | null>}
 */
async function getUser(request, db) {
  const auth = request.headers.get("authorization");
  const token = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token || token.length < 32) return null;
  const row = await db
    .prepare(
      "SELECT u.id AS id, u.email AS email, s.token AS token FROM user_sessions s " +
        "JOIN user_accounts u ON s.user_id = u.id WHERE s.token = ? AND s.expires_at > datetime('now')"
    )
    .bind(token)
    .first();
  if (!row) return null;
  return { id: Number(row.id), email: String(row.email), token };
}

/** @param {Request} request */
const clientIp = (request) => request.headers.get("cf-connecting-ip") || "local";

/**
 * @param {D1Database} db
 * @param {string} key
 */
async function throttleState(db, key) {
  const row = await db
    .prepare("SELECT failures, window_start, blocked_until FROM auth_throttle WHERE key = ?")
    .bind(key)
    .first();
  const now = Date.now();
  if (!row) return { failures: 0, windowStart: now, blockedUntil: 0 };
  const windowStart = Number(row.window_start) || 0;
  const stale = now - windowStart > THROTTLE_WINDOW_MS;
  return {
    failures: stale ? 0 : Number(row.failures) || 0,
    windowStart: stale ? now : windowStart,
    blockedUntil: Number(row.blocked_until) || 0,
  };
}

/**
 * @param {D1Database} db
 * @param {string} key
 */
async function throttleRecordFailure(db, key) {
  const now = Date.now();
  const state = await throttleState(db, key);
  const failures = state.failures + 1;
  const blockedUntil = failures >= THROTTLE_MAX_FAILURES ? now + THROTTLE_BLOCK_MS : 0;
  await db
    .prepare(
      "INSERT INTO auth_throttle (key, failures, window_start, blocked_until) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT(key) DO UPDATE SET failures = excluded.failures, window_start = excluded.window_start, blocked_until = excluded.blocked_until"
    )
    .bind(key, failures, state.windowStart, blockedUntil)
    .run();
  return { failures, blockedUntil };
}

/**
 * @param {D1Database} db
 * @param {string} key
 */
const throttleClear = (db, key) => db.prepare("DELETE FROM auth_throttle WHERE key = ?").bind(key).run();

// ============ 学习状态 ============

/** 旧版整章 blob → 按词状态的一次性迁移（只在该用户还没有按词数据时执行） */
async function migrateLegacyProgress(db, userId) {
  const existing = await db
    .prepare("SELECT COUNT(*) AS n FROM user_word_state WHERE user_id = ?")
    .bind(userId)
    .first();
  if (Number(existing?.n) > 0) return 0;
  const rows = await db.prepare("SELECT chapter_id, data FROM vocab_progress WHERE user_id = ?").bind(userId).all();
  const list = rows.results ?? [];
  if (!list.length) return 0;
  const now = Date.now();
  const stmts = [];
  for (const raw of list) {
    const row = /** @type {{chapter_id:number, data:string}} */ (raw);
    let parsed;
    try {
      parsed = JSON.parse(row.data);
    } catch {
      continue;
    }
    const chapterId = Number(row.chapter_id);
    const seen = new Set();
    const push = (/** @type {number} */ wordId, /** @type {string} */ status) => {
      if (!wordId || seen.has(wordId)) return;
      seen.add(wordId);
      const wrongCount = status === "wrong" ? 1 : 0;
      stmts.push(
        db
          .prepare(
            "INSERT INTO user_word_state (user_id, chapter_id, word_id, status, streak, wrong_count, seen_at, due_at) " +
              "VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(user_id, chapter_id, word_id) DO NOTHING"
          )
          .bind(userId, chapterId, wordId, status, 0, wrongCount, now - 1000, 0)
      );
    };
    for (const id of parsed?.wrongBookIds ?? []) push(Number(id), "wrong");
    for (const id of parsed?.newWordBookIds ?? []) push(Number(id), "learning");
  }
  if (!stmts.length) return 0;
  for (let i = 0; i < stmts.length; i += 50) await db.batch(stmts.slice(i, i + 50));
  return stmts.length;
}

/** 客户端上传的单条状态 → 规范化的行 */
function normalizeWordChange(input) {
  if (!input || typeof input !== "object") return null;
  const c = Number(input.c);
  const w = Number(input.w);
  if (!Number.isInteger(c) || c < 1 || c > 999) return null;
  if (!Number.isInteger(w) || w < 1 || w > 100000) return null;
  const s = WORD_STATUS.has(input.s) ? input.s : "learning";
  const cs = Math.max(0, Math.min(9999, Number(input.cs) || 0));
  const wc = Math.max(0, Math.min(9999, Number(input.wc) || 0));
  // seen 缺失/非法时回落到服务器时间：否则会被写成 0，
  // 而查询用的是 seen_at > since，这条记录将永远同步不回来。
  const rawSeen = Number(input.seen);
  const seen =
    Number.isFinite(rawSeen) && rawSeen > 0 ? Math.min(rawSeen, Number.MAX_SAFE_INTEGER) : Date.now();
  const due = Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Number(input.due) || 0));
  return { c, w, s, cs, wc, seen, due };
}

/** 客户端上传的一条状态 → SQL 语句（LWW：只有更新的 seen_at 才覆盖） */
function wordStateUpsert(db, userId, ch) {
  return db
    .prepare(
      "INSERT INTO user_word_state (user_id, chapter_id, word_id, status, streak, wrong_count, seen_at, due_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(user_id, chapter_id, word_id) DO UPDATE SET " +
        "status = excluded.status, streak = excluded.streak, wrong_count = excluded.wrong_count, " +
        "seen_at = excluded.seen_at, due_at = excluded.due_at, " +
        "updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') " +
        "WHERE excluded.seen_at >= user_word_state.seen_at"
    )
    .bind(userId, ch.c, ch.w, ch.s, ch.cs, ch.wc, ch.seen, ch.due);
}

/** @param {*} row */
const rowToWord = (row) => ({
  c: Number(row.chapter_id),
  w: Number(row.word_id),
  s: String(row.status),
  cs: Number(row.streak) || 0,
  wc: Number(row.wrong_count) || 0,
  seen: Number(row.seen_at) || 0,
  due: Number(row.due_at) || 0,
});

// ============ 路由处理 ============

/** @param {Request} request @param {Env} env */
async function handleRegister(request, env) {
  const { data, error } = await readJson(request);
  if (error) return json({ error, msg: "请求格式错误" }, 400);
  const body = /** @type {any} */ (data) ?? {};
  const email = String(body.email ?? "").trim().toLowerCase();
  const pw = String(body.password ?? "");
  const nick = String(body.nickname ?? "").trim().slice(0, 40) || email.split("@")[0] || "";
  if (!isValidEmail(email)) return json({ error: "invalid_email", msg: "邮箱格式不正确" }, 400);
  if (pw.length < 8 || pw.length > 128) return json({ error: "invalid_password", msg: "密码至少 8 位" }, 400);

  const key = `register:${clientIp(request)}`;
  const throttled = await throttleState(env.DB, key);
  if (throttled.blockedUntil > Date.now()) {
    return json({ error: "rate_limited", msg: "尝试过于频繁，请稍后再试" }, 429);
  }

  const exists = await env.DB.prepare("SELECT id FROM user_accounts WHERE email = ?").bind(email).first();
  if (exists) return json({ error: "email_taken", msg: "该邮箱已注册" }, 409);

  const hash = await hashPassword(pw);
  const result = await env.DB.prepare(
    "INSERT INTO user_accounts (email, password_hash, nickname) VALUES (?, ?, ?)"
  )
    .bind(email, hash, nick)
    .run();
  const userId = Number(result.meta.last_row_id);
  const token = await createSession(env.DB, userId);
  return json({ token, userId, email, nickname: nick });
}

/** @param {Request} request @param {Env} env */
async function handleLogin(request, env) {
  const { data, error } = await readJson(request);
  if (error) return json({ error, msg: "请求格式错误" }, 400);
  const body = /** @type {any} */ (data) ?? {};
  const email = String(body.email ?? "").trim().toLowerCase();
  const pw = String(body.password ?? "");
  if (!isValidEmail(email) || !pw || pw.length > 128) {
    return json({ error: "invalid_input", msg: "请填写邮箱和密码" }, 400);
  }

  const key = `login:${clientIp(request)}:${email}`;
  const throttled = await throttleState(env.DB, key);
  if (throttled.blockedUntil > Date.now()) {
    const seconds = Math.ceil((throttled.blockedUntil - Date.now()) / 1000);
    return json({ error: "rate_limited", msg: `尝试过于频繁，请 ${seconds} 秒后再试` }, 429);
  }

  const account = await env.DB.prepare(
    "SELECT id, password_hash, nickname FROM user_accounts WHERE email = ?"
  )
    .bind(email)
    .first();
  const ok = account ? await verifyPassword(pw, String(account.password_hash)) : false;
  if (!ok) {
    await throttleRecordFailure(env.DB, key);
    return json({ error: "invalid_credentials", msg: "邮箱或密码错误" }, 401);
  }
  if (throttled.failures > 0) await throttleClear(env.DB, key);

  const userId = Number(account.id);
  const token = await createSession(env.DB, userId);
  return json({ token, userId, email, nickname: String(account.nickname ?? "") || email.split("@")[0] });
}

/** @param {Request} request @param {Env} env @param {{id:number, token:string}} user */
async function handleLogout(request, env, user) {
  const url = new URL(request.url);
  if (url.searchParams.get("all") === "1") {
    await env.DB.prepare("DELETE FROM user_sessions WHERE user_id = ?").bind(user.id).run();
  } else {
    await env.DB.prepare("DELETE FROM user_sessions WHERE token = ?").bind(user.token).run();
  }
  return json({ ok: true });
}

/** @param {Request} request @param {Env} env @param {{id:number, email:string}} user */
async function handleProfile(request, env, user) {
  if (request.method === "GET") {
    const account = await env.DB.prepare("SELECT nickname FROM user_accounts WHERE id = ?")
      .bind(user.id)
      .first();
    return json({ userId: user.id, email: user.email, nickname: String(account?.nickname ?? "") || user.email.split("@")[0] });
  }
  // PUT：改昵称
  const { data, error } = await readJson(request);
  if (error) return json({ error, msg: "请求格式错误" }, 400);
  const nick = String(/** @type {any} */ (data)?.nickname ?? "").trim().slice(0, 40);
  if (!nick) return json({ error: "invalid_nickname", msg: "昵称不能为空" }, 400);
  await env.DB.prepare("UPDATE user_accounts SET nickname = ? WHERE id = ?").bind(nick, user.id).run();
  return json({ ok: true, nickname: nick });
}

/** @param {Request} request @param {Env} env @param {{id:number, token:string}} user */
async function handlePassword(request, env, user) {
  const { data, error } = await readJson(request);
  if (error) return json({ error, msg: "请求格式错误" }, 400);
  const body = /** @type {any} */ (data) ?? {};
  const current = String(body.currentPassword ?? "");
  const next = String(body.newPassword ?? "");
  if (next.length < 8 || next.length > 128) return json({ error: "invalid_password", msg: "新密码至少 8 位" }, 400);
  const account = await env.DB.prepare("SELECT password_hash FROM user_accounts WHERE id = ?").bind(user.id).first();
  if (!account || !(await verifyPassword(current, String(account.password_hash)))) {
    return json({ error: "invalid_credentials", msg: "当前密码不正确" }, 401);
  }
  const hash = await hashPassword(next);
  await env.DB.prepare("UPDATE user_accounts SET password_hash = ? WHERE id = ?").bind(hash, user.id).run();
  // 改密后吊销其它设备上的会话，保留当前会话
  await env.DB.prepare("DELETE FROM user_sessions WHERE user_id = ? AND token != ?").bind(user.id, user.token).run();
  return json({ ok: true });
}

/** @param {Request} request @param {Env} env @param {{id:number}} user */
async function handleSettings(request, env, user) {
  if (request.method === "GET") {
    const row = await env.DB.prepare("SELECT settings FROM user_settings WHERE user_id = ?").bind(user.id).first();
    let settings = null;
    if (row) {
      try {
        settings = JSON.parse(String(row.settings));
      } catch {
        settings = null;
      }
    }
    return json({ settings });
  }
  const raw = await request.text();
  if (encoder.encode(raw).byteLength > MAX_JSON_BYTES) return tooLarge(encoder.encode(raw).byteLength);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return json({ error: "invalid_json", msg: "设置格式错误" }, 400);
  }
  await env.DB.prepare(
    "INSERT INTO user_settings (user_id, settings) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET " +
      "settings = excluded.settings, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"
  )
    .bind(user.id, JSON.stringify(parsed))
    .run();
  return json({ ok: true });
}

/** @param {Request} request @param {Env} env @param {{id:number}} user */
async function handleWords(request, env, user) {
  if (request.method === "GET") {
    const url = new URL(request.url);
    const since = Math.max(0, Number(url.searchParams.get("since")) || 0);
    const migrated = since === 0 ? await migrateLegacyProgress(env.DB, user.id) : 0;
    const chapter = Number(url.searchParams.get("chapter")) || 0;
    const rows = chapter
      ? await env.DB.prepare(
          "SELECT chapter_id, word_id, status, streak, wrong_count, seen_at, due_at FROM user_word_state " +
            "WHERE user_id = ? AND chapter_id = ? AND seen_at > ? ORDER BY word_id"
        )
          .bind(user.id, chapter, since)
          .all()
      : await env.DB.prepare(
          "SELECT chapter_id, word_id, status, streak, wrong_count, seen_at, due_at FROM user_word_state " +
            "WHERE user_id = ? AND seen_at > ? ORDER BY chapter_id, word_id"
        )
          .bind(user.id, since)
          .all();
    return json({ words: (rows.results ?? []).map(rowToWord), serverTime: Date.now(), migrated });
  }

  const raw = await request.text();
  if (encoder.encode(raw).byteLength > MAX_WORDS_BODY) return tooLarge(encoder.encode(raw).byteLength);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return json({ error: "invalid_json", msg: "数据格式错误" }, 400);
  }
  const input = Array.isArray(parsed?.changes) ? parsed.changes : [];
  if (input.length > MAX_CHANGES) return json({ error: "too_many_changes", msg: "单次提交过多" }, 413);
  const changes = input.map(normalizeWordChange).filter(Boolean);
  if (!changes.length) return json({ ok: true, applied: 0, serverTime: Date.now() });

  const stmts = changes.map((ch) => wordStateUpsert(env.DB, user.id, ch));
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  return json({ ok: true, applied: changes.length, serverTime: Date.now() });
}

/** @param {Request} request @param {Env} env @param {{id:number}} user */
async function handleWordReset(request, env, user) {
  const { data, error } = await readJson(request, MAX_WORDS_BODY);
  if (error) return json({ error, msg: "请求格式错误" }, 400);
  const chapter = Number(/** @type {any} */ (data)?.chapter);
  if (!Number.isInteger(chapter) || chapter < 1) return json({ error: "invalid_chapter" }, 400);
  await env.DB.prepare("DELETE FROM user_word_state WHERE user_id = ? AND chapter_id = ?")
    .bind(user.id, chapter)
    .run();
  return json({ ok: true, serverTime: Date.now() });
}

/** @param {Request} request @param {Env} env @param {{id:number}} user */
async function handleNotes(request, env, user) {
  if (request.method === "GET") {
    const url = new URL(request.url);
    const chapter = Number(url.searchParams.get("chapter")) || 0;
    const rows = chapter
      ? await env.DB.prepare(
          "SELECT word_id, note, has_image, updated_at FROM user_notes WHERE user_id = ? AND chapter_id = ?"
        )
          .bind(user.id, chapter)
          .all()
      : await env.DB.prepare("SELECT chapter_id, word_id, note, has_image, updated_at FROM user_notes WHERE user_id = ?")
          .bind(user.id)
          .all();
    /** @type {Record<string,string>} */
    const notes = {};
    /** @type {string[]} */
    const images = [];
    let updatedAt = 0;
    for (const raw of rows.results ?? []) {
      const row = /** @type {any} */ (raw);
      const key = chapter ? String(row.word_id) : `${row.chapter_id}:${row.word_id}`;
      if (row.note) notes[key] = String(row.note);
      if (Number(row.has_image)) images.push(key);
      updatedAt = Math.max(updatedAt, Number(row.updated_at) || 0);
    }
    return json({ notes, images, updatedAt });
  }

  const { data, error } = await readJson(request, 32 * 1024);
  if (error) return json({ error, msg: "请求格式错误" }, 400);
  const body = /** @type {any} */ (data) ?? {};
  const chapter = Number(body.chapter);
  const word = Number(body.word);
  if (!Number.isInteger(chapter) || chapter < 1 || !Number.isInteger(word) || word < 1) {
    return json({ error: "invalid_target" }, 400);
  }
  const note = String(body.note ?? "").slice(0, MAX_NOTE_CHARS);
  const updatedAt = Math.max(0, Number(body.updatedAt) || Date.now());

  const existing = await env.DB.prepare(
    "SELECT has_image FROM user_notes WHERE user_id = ? AND chapter_id = ? AND word_id = ?"
  )
    .bind(user.id, chapter, word)
    .first();
  const hasImage = Number(existing?.has_image) ? 1 : 0;

  if (!note && !hasImage) {
    // 备注清空且没有配图 → 直接删行，不留空记录
    await env.DB.prepare("DELETE FROM user_notes WHERE user_id = ? AND chapter_id = ? AND word_id = ?")
      .bind(user.id, chapter, word)
      .run();
  } else {
    await env.DB.prepare(
      "INSERT INTO user_notes (user_id, chapter_id, word_id, note, has_image, updated_at) VALUES (?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(user_id, chapter_id, word_id) DO UPDATE SET note = excluded.note, updated_at = excluded.updated_at"
    )
      .bind(user.id, chapter, word, note, hasImage, updatedAt)
      .run();
  }
  return json({ ok: true, updatedAt });
}

/** @param {Request} request @param {Env} env @param {{id:number}} user */
async function handleNoteImage(request, env, user) {
  const url = new URL(request.url);
  if (request.method === "GET") {
    const chapter = Number(url.searchParams.get("chapter"));
    const word = Number(url.searchParams.get("word"));
    if (!Number.isInteger(chapter) || !Number.isInteger(word)) return json({ error: "invalid_target" }, 400);
    const row = await env.DB.prepare(
      "SELECT mime, data FROM user_note_images WHERE user_id = ? AND chapter_id = ? AND word_id = ?"
    )
      .bind(user.id, chapter, word)
      .first();
    if (!row) return json({ error: "not_found" }, 404);
    return json({ mime: String(row.mime), data: String(row.data) });
  }

  if (request.method === "DELETE") {
    const { data, error } = await readJson(request, 4096);
    if (error) return json({ error, msg: "请求格式错误" }, 400);
    const chapter = Number(/** @type {any} */ (data)?.chapter);
    const word = Number(/** @type {any} */ (data)?.word);
    if (!Number.isInteger(chapter) || !Number.isInteger(word)) return json({ error: "invalid_target" }, 400);
    await env.DB.prepare("DELETE FROM user_note_images WHERE user_id = ? AND chapter_id = ? AND word_id = ?")
      .bind(user.id, chapter, word)
      .run();
    const existing = await env.DB.prepare(
      "SELECT note FROM user_notes WHERE user_id = ? AND chapter_id = ? AND word_id = ?"
    )
      .bind(user.id, chapter, word)
      .first();
    if (existing && String(existing.note ?? "")) {
      await env.DB.prepare(
        "UPDATE user_notes SET has_image = 0, updated_at = ? WHERE user_id = ? AND chapter_id = ? AND word_id = ?"
      )
        .bind(Date.now(), user.id, chapter, word)
        .run();
    } else {
      await env.DB.prepare("DELETE FROM user_notes WHERE user_id = ? AND chapter_id = ? AND word_id = ?")
        .bind(user.id, chapter, word)
        .run();
    }
    return json({ ok: true });
  }

  // POST：上传（客户端已压缩，≤300KB）
  const { data, error } = await readJson(request, MAX_IMAGE_BASE64 + 4096);
  if (error) {
    if (error === "payload_too_large") return json({ error, msg: "图片过大，请重新选择" }, 413);
    return json({ error, msg: "请求格式错误" }, 400);
  }
  const body = /** @type {any} */ (data) ?? {};
  const chapter = Number(body.chapter);
  const word = Number(body.word);
  const mime = String(body.mime ?? "");
  const b64 = String(body.data ?? "");
  if (!Number.isInteger(chapter) || !Number.isInteger(word)) return json({ error: "invalid_target" }, 400);
  if (!IMAGE_MIMES.has(mime)) return json({ error: "invalid_mime", msg: "只支持 JPEG/PNG/WebP" }, 400);
  if (!b64 || b64.length > MAX_IMAGE_BASE64) return json({ error: "image_too_large", msg: "图片过大（上限约 300KB）" }, 413);
  try {
    const bytes = fromBase64(b64);
    if (bytes.length > 300 * 1024) return json({ error: "image_too_large", msg: "图片过大（上限约 300KB）" }, 413);
  } catch {
    return json({ error: "invalid_base64" }, 400);
  }
  const updatedAt = Date.now();
  await env.DB.prepare(
    "INSERT INTO user_note_images (user_id, chapter_id, word_id, mime, data, updated_at) VALUES (?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT(user_id, chapter_id, word_id) DO UPDATE SET mime = excluded.mime, data = excluded.data, updated_at = excluded.updated_at"
  )
    .bind(user.id, chapter, word, mime, b64, updatedAt)
    .run();
  await env.DB.prepare(
    "INSERT INTO user_notes (user_id, chapter_id, word_id, note, has_image, updated_at) VALUES (?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT(user_id, chapter_id, word_id) DO UPDATE SET has_image = 1, updated_at = excluded.updated_at"
  )
    .bind(user.id, chapter, word, "", 1, updatedAt)
    .run();
  return json({ ok: true, updatedAt });
}

/** @param {Request} request @param {Env} env @param {{id:number}} user */
async function handleExport(request, env, user) {
  const url = new URL(request.url);
  const withImages = url.searchParams.get("images") === "1";
  const [settingsRow, wordRows, noteRows, imageRows] = await Promise.all([
    env.DB.prepare("SELECT settings FROM user_settings WHERE user_id = ?").bind(user.id).first(),
    env.DB.prepare(
      "SELECT chapter_id, word_id, status, streak, wrong_count, seen_at, due_at FROM user_word_state WHERE user_id = ?"
    )
      .bind(user.id)
      .all(),
    env.DB.prepare("SELECT chapter_id, word_id, note, has_image FROM user_notes WHERE user_id = ?").bind(user.id).all(),
    withImages
      ? env.DB.prepare("SELECT chapter_id, word_id, mime, data FROM user_note_images WHERE user_id = ?").bind(user.id).all()
      : Promise.resolve({ results: [] }),
  ]);
  let settings = null;
  if (settingsRow) {
    try {
      settings = JSON.parse(String(settingsRow.settings));
    } catch {
      settings = null;
    }
  }
  return json({
    version: 1,
    exportedAt: new Date().toISOString(),
    email: user.email,
    settings,
    words: (wordRows.results ?? []).map(rowToWord),
    notes: (noteRows.results ?? []).map((raw) => {
      const row = /** @type {any} */ (raw);
      return { c: Number(row.chapter_id), w: Number(row.word_id), note: String(row.note ?? ""), hasImage: Number(row.has_image) ? 1 : 0 };
    }),
    images: (imageRows.results ?? []).map((raw) => {
      const row = /** @type {any} */ (raw);
      return { c: Number(row.chapter_id), w: Number(row.word_id), mime: String(row.mime), data: String(row.data) };
    }),
  });
}

/** @param {Request} request @param {Env} env @param {{id:number}} user */
async function handleImport(request, env, user) {
  const raw = await request.text();
  if (encoder.encode(raw).byteLength > 4 * 1024 * 1024) return tooLarge(encoder.encode(raw).byteLength);
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return json({ error: "invalid_json", msg: "备份文件格式错误" }, 400);
  }
  const changes = (Array.isArray(payload?.words) ? payload.words : []).map(normalizeWordChange).filter(Boolean);
  const stmts = changes.map((ch) => wordStateUpsert(env.DB, user.id, ch));
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));

  let noteCount = 0;
  for (const item of Array.isArray(payload?.notes) ? payload.notes : []) {
    const chapter = Number(item?.c);
    const word = Number(item?.w);
    if (!Number.isInteger(chapter) || !Number.isInteger(word)) continue;
    const note = String(item?.note ?? "").slice(0, MAX_NOTE_CHARS);
    await env.DB.prepare(
      "INSERT INTO user_notes (user_id, chapter_id, word_id, note, has_image, updated_at) VALUES (?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(user_id, chapter_id, word_id) DO UPDATE SET note = excluded.note, updated_at = excluded.updated_at"
    )
      .bind(user.id, chapter, word, note, Number(item?.hasImage) ? 1 : 0, Date.now())
      .run();
    noteCount++;
  }

  let imageCount = 0;
  for (const item of Array.isArray(payload?.images) ? payload.images : []) {
    const chapter = Number(item?.c);
    const word = Number(item?.w);
    const mime = String(item?.mime ?? "");
    const data = String(item?.data ?? "");
    if (!Number.isInteger(chapter) || !Number.isInteger(word)) continue;
    if (!IMAGE_MIMES.has(mime) || !data || data.length > MAX_IMAGE_BASE64) continue;
    await env.DB.prepare(
      "INSERT INTO user_note_images (user_id, chapter_id, word_id, mime, data, updated_at) VALUES (?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(user_id, chapter_id, word_id) DO UPDATE SET mime = excluded.mime, data = excluded.data, updated_at = excluded.updated_at"
    )
      .bind(user.id, chapter, word, mime, data, Date.now())
      .run();
    imageCount++;
  }

  if (payload?.settings && typeof payload.settings === "object") {
    await env.DB.prepare(
      "INSERT INTO user_settings (user_id, settings) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET settings = excluded.settings"
    )
      .bind(user.id, JSON.stringify(payload.settings))
      .run();
  }
  return json({ ok: true, words: changes.length, notes: noteCount, images: imageCount });
}

// ============ 静态资源 ============

/** @param {Response} res @param {string} pathname */
function withCachePolicy(res, pathname) {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);
  if (/\.(?:html?)$/i.test(pathname) || pathname === "/") {
    headers.set("cache-control", "no-store");
  } else if (/\.(?:js|css)$/i.test(pathname)) {
    // 必须回源校验（配合 ETag 走 304），保证改完立刻生效
    headers.set("cache-control", "no-cache");
  } else if (/\.json$/i.test(pathname)) {
    headers.set("cache-control", "public, max-age=3600");
  } else {
    headers.set("cache-control", "public, max-age=86400");
  }
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

// ============ 入口 ============

export default {
  /**
   * @param {Request} request
   * @param {Env} env
   */
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;

    if (pathname.startsWith("/api/")) {
      if (method === "OPTIONS") {
        // 同源应用不需要 CORS，仅对预检给出最小响应
        return new Response(null, { status: 204, headers: SECURITY_HEADERS });
      }
      try {
        if (pathname === "/api/auth/register" && method === "POST") return await handleRegister(request, env);
        if (pathname === "/api/auth/login" && method === "POST") return await handleLogin(request, env);

        if (pathname === "/api/auth/logout" && method === "POST") {
          const user = await getUser(request, env.DB);
          if (!user) return json({ error: "authentication_required", msg: "请先登录" }, 401);
          return await handleLogout(request, env, user);
        }
        if (pathname === "/api/account/profile" && (method === "GET" || method === "PUT")) {
          const user = await getUser(request, env.DB);
          if (!user) return json({ error: "authentication_required", msg: "请先登录" }, 401);
          return await handleProfile(request, env, user);
        }
        if (pathname === "/api/account/password" && method === "POST") {
          const user = await getUser(request, env.DB);
          if (!user) return json({ error: "authentication_required", msg: "请先登录" }, 401);
          return await handlePassword(request, env, user);
        }
        if (pathname === "/api/vocab/settings" && (method === "GET" || method === "PUT")) {
          const user = await getUser(request, env.DB);
          if (!user) return json({ error: "authentication_required", msg: "请先登录" }, 401);
          return await handleSettings(request, env, user);
        }
        if (pathname === "/api/vocab/words") {
          const user = await getUser(request, env.DB);
          if (!user) return json({ error: "authentication_required", msg: "请先登录" }, 401);
          if (method === "GET" || method === "PUT") return await handleWords(request, env, user);
          if (method === "DELETE") return await handleWordReset(request, env, user);
        }
        if (pathname === "/api/vocab/notes" && (method === "GET" || method === "PUT")) {
          const user = await getUser(request, env.DB);
          if (!user) return json({ error: "authentication_required", msg: "请先登录" }, 401);
          return await handleNotes(request, env, user);
        }
        if (pathname === "/api/vocab/notes/image") {
          const user = await getUser(request, env.DB);
          if (!user) return json({ error: "authentication_required", msg: "请先登录" }, 401);
          if (method === "GET" || method === "POST" || method === "DELETE") {
            return await handleNoteImage(request, env, user);
          }
        }
        if (pathname === "/api/vocab/export" && method === "GET") {
          const user = await getUser(request, env.DB);
          if (!user) return json({ error: "authentication_required", msg: "请先登录" }, 401);
          return await handleExport(request, env, user);
        }
        if (pathname === "/api/vocab/import" && method === "POST") {
          const user = await getUser(request, env.DB);
          if (!user) return json({ error: "authentication_required", msg: "请先登录" }, 401);
          return await handleImport(request, env, user);
        }
        return json({ error: "not_found", msg: "接口不存在" }, 404);
      } catch (err) {
        console.error("api error", pathname, err && err.stack ? err.stack : err);
        return json({ error: "internal_error", msg: "服务异常，请稍后重试" }, 500);
      }
    }

    const res = await env.ASSETS.fetch(request);
    return withCachePolicy(res, pathname);
  },

  /**
   * 每日清理：过期会话 + 陈旧限流记录
   * @param {ScheduledEvent} _event
   * @param {Env} env
   */
  async scheduled(_event, env) {
    await env.DB.prepare("DELETE FROM user_sessions WHERE expires_at < datetime('now')").run();
    const cutoff = Date.now() - 86400_000;
    await env.DB.prepare("DELETE FROM auth_throttle WHERE window_start < ? AND blocked_until < ?")
      .bind(cutoff, cutoff)
      .run();
  },
};
