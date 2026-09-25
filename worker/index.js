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
const MAX_STARS_BODY = 256 * 1024;
const MAX_IMPORT_BYTES = 4 * 1024 * 1024;
const MAX_IMPORT_CHANGES = 10_000;
const MAX_CHANGES = 800;
const MAX_STAR_CHANGES = 800;
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

const tooLarge = () => json({ error: "payload_too_large", msg: "提交的数据过大" }, 413);

/** 统一的错误响应：payload_too_large 用 413，其余校验错误用 400 */
const jsonError = (/** @type {string} */ error, /** @type {string} */ msg) =>
  json({ error, msg }, error === "payload_too_large" ? 413 : 400);

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

/** 严格的标准 Base64：拒绝空白、非规范填充及非 canonical pad bits。 */
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** base64 → Uint8Array（Worker 与 Node 都可用）；拒绝 atob 会宽松接受的输入。 @param {string} b64 */
function fromBase64(b64) {
  if (typeof b64 !== "string" || !BASE64_RE.test(b64)) throw new Error("invalid_base64");
  // atob 会忽略空白、接受未填充字符串；上面的语法检查先挡住这些输入。
  // 再检查 pad bits，避免同一串字节存在多个非规范 Base64 表示。
  const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  if (pad) {
    const value = BASE64_ALPHABET.indexOf(b64.charAt(b64.length - pad - 1));
    if (value < 0 || (pad === 2 ? value & 0x0f : value & 0x03)) {
      throw new Error("invalid_base64");
    }
  }
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/**
 * 导入图片的逻辑时间戳；旧备份缺字段时退回当前时刻。
 * @param {unknown} value
 */
function normalizeImageUpdatedAt(value) {
  const updatedAt = Number(value);
  return Number.isSafeInteger(updatedAt) && updatedAt > 0 ? updatedAt : Date.now();
}

/**
 * 图片按 updatedAt 做 LWW；同刻导入允许覆盖，但 tombstone 同刻/更新时必须获胜。
 * @param {D1Database} db @param {number} userId @param {number} chapter @param {number} word
 * @param {string} mime @param {string} data @param {number} updatedAt
 * @returns {D1PreparedStatement}
 */
function imageUpsert(db, userId, chapter, word, mime, data, updatedAt) {
  return db
    .prepare(
      "INSERT INTO user_note_images (user_id, chapter_id, word_id, mime, data, updated_at) " +
        "SELECT ?, ?, ?, ?, ?, ? " +
        "WHERE ? > COALESCE((SELECT updated_at FROM user_note_image_tombstones WHERE user_id = ? AND chapter_id = ? AND word_id = ?), 0) " +
        "ON CONFLICT(user_id, chapter_id, word_id) DO UPDATE SET mime = excluded.mime, data = excluded.data, updated_at = excluded.updated_at " +
        "WHERE excluded.updated_at >= user_note_images.updated_at " +
        "AND excluded.updated_at > COALESCE((SELECT updated_at FROM user_note_image_tombstones WHERE user_id = excluded.user_id AND chapter_id = excluded.chapter_id AND word_id = excluded.word_id), 0)"
    )
    .bind(userId, chapter, word, mime, data, updatedAt, updatedAt, userId, chapter, word);
}

/**
 * 图片删除的 durable tombstone；只允许逻辑时间戳前进。
 * @param {D1Database} db @param {number} userId @param {number} chapter @param {number} word
 * @param {number} updatedAt
 * @returns {D1PreparedStatement}
 */
function imageTombstoneUpsert(db, userId, chapter, word, updatedAt) {
  return db
    .prepare(
      "INSERT INTO user_note_image_tombstones (user_id, chapter_id, word_id, updated_at) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT(user_id, chapter_id, word_id) DO UPDATE SET updated_at = MAX(user_note_image_tombstones.updated_at, excluded.updated_at)"
    )
    .bind(userId, chapter, word, updatedAt);
}

/**
 * 图片存在时同步讲义列表的 has_image 标记，不改备注正文或其 LWW 时间戳。
 * @param {D1Database} db @param {number} userId @param {number} chapter @param {number} word
 * @returns {D1PreparedStatement}
 */
function markNoteHasImage(db, userId, chapter, word) {
  return db
    .prepare(
      "INSERT INTO user_notes (user_id, chapter_id, word_id, note, has_image, updated_at) VALUES (?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(user_id, chapter_id, word_id) DO UPDATE SET has_image = 1"
    )
    .bind(userId, chapter, word, "", 1, 0);
}

/**
 * 读取仍然有效的图片；tombstone 时间戳相同或更新时视为已删除。
 * @param {D1Database} db @param {number} userId @param {number} chapter @param {number} word
 * @returns {Promise<any|null>}
 */
async function getActiveImage(db, userId, chapter, word) {
  const row = await db
    .prepare("SELECT mime, data, updated_at FROM user_note_images WHERE user_id = ? AND chapter_id = ? AND word_id = ?")
    .bind(userId, chapter, word)
    .first();
  if (!row) return null;
  const tombstone = await db
    .prepare("SELECT updated_at FROM user_note_image_tombstones WHERE user_id = ? AND chapter_id = ? AND word_id = ?")
    .bind(userId, chapter, word)
    .first();
  if (tombstone && Number(tombstone.updated_at || 0) >= Number(row.updated_at || 0)) return null;
  return row;
}

/** @param {unknown} value @returns {Record<string, number>} */
function normalizeResetMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out = Object.create(null);
  for (const [rawChapter, rawAt] of Object.entries(value)) {
    const chapter = Number(rawChapter);
    const resetAt = Number(rawAt);
    if (!Number.isSafeInteger(chapter) || chapter < 1 || chapter > 999 || !Number.isSafeInteger(resetAt) || resetAt <= 0) continue;
    out[String(chapter)] = resetAt;
  }
  return out;
}

/** @param {unknown} value @param {number} max @returns {Array<{c:number,w:number,updatedAt:number}>} */
function normalizeTombstones(value, max) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value.slice(0, max)) {
    const c = Number(item?.c);
    const w = Number(item?.w);
    const updatedAt = Number(item?.updatedAt);
    if (!Number.isSafeInteger(c) || c < 1 || c > 999 || !Number.isSafeInteger(w) || w < 1 || w > 100000 || !Number.isSafeInteger(updatedAt) || updatedAt <= 0) continue;
    out.push({ c, w, updatedAt });
  }
  return out;
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
      // expires_at 存的是 new Date().toISOString()（YYYY-MM-DDTHH:MM:SS.sssZ），
    // 这里必须用同格式做字典序比较，不能用 datetime('now')（空格分隔，格式不同）
    "SELECT u.id AS id, u.email AS email, s.token AS token FROM user_sessions s " +
        "JOIN user_accounts u ON s.user_id = u.id WHERE s.token = ? AND s.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"
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
  const marker = await db
    .prepare("SELECT migrated_at FROM user_legacy_progress_migrations WHERE user_id = ?")
    .bind(userId)
    .first();
  if (marker) return 0;
  const rows = await db.prepare("SELECT chapter_id, data FROM vocab_progress WHERE user_id = ?").bind(userId).all();
  const list = rows.results ?? [];
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
              "SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE ? > COALESCE((SELECT reset_at FROM user_chapter_resets WHERE user_id = ? AND chapter_id = ?), 0) " +
              "ON CONFLICT(user_id, chapter_id, word_id) DO NOTHING"
          )
          .bind(userId, chapterId, wordId, status, 0, wrongCount, now - 1000, 0, now - 1000, userId, chapterId)
      );
    };
    for (const id of parsed?.wrongBookIds ?? []) push(Number(id), "wrong");
    for (const id of parsed?.newWordBookIds ?? []) push(Number(id), "learning");
  }
  for (let i = 0; i < stmts.length; i += 50) await db.batch(stmts.slice(i, i + 50));
  // 即使旧 blob 为空/损坏也完成一次性迁移，避免每次 full GET 重复扫描。
  await db
    .prepare("INSERT INTO user_legacy_progress_migrations (user_id, migrated_at) VALUES (?, ?) ON CONFLICT(user_id) DO NOTHING")
    .bind(userId, Date.now())
    .run();
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
        "SELECT ?, ?, ?, ?, ?, ?, ?, ? " +
        "WHERE ? > COALESCE((SELECT reset_at FROM user_chapter_resets WHERE user_id = ? AND chapter_id = ?), 0) " +
        "ON CONFLICT(user_id, chapter_id, word_id) DO UPDATE SET " +
        "status = excluded.status, streak = excluded.streak, wrong_count = excluded.wrong_count, " +
        "seen_at = excluded.seen_at, due_at = excluded.due_at, " +
        "updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') " +
        "WHERE excluded.seen_at > COALESCE((SELECT reset_at FROM user_chapter_resets WHERE user_id = excluded.user_id AND chapter_id = excluded.chapter_id), 0) " +
        "AND (excluded.seen_at > user_word_state.seen_at " +
        "OR (excluded.seen_at = user_word_state.seen_at AND " +
        "CASE excluded.status WHEN 'mastered' THEN 2 WHEN 'wrong' THEN 1 ELSE 0 END > " +
        "CASE user_word_state.status WHEN 'mastered' THEN 2 WHEN 'wrong' THEN 1 ELSE 0 END))"
    )
    .bind(userId, ch.c, ch.w, ch.s, ch.cs, ch.wc, ch.seen, ch.due, ch.seen, userId, ch.c);
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

/** 客户端上传的一条生词记录 → 严格规范化的行；非法条目不静默丢弃。 */
function normalizeStarChange(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const c = Number(input.c);
  const w = Number(input.w);
  if (!Number.isSafeInteger(c) || c < 1 || c > 999) return null;
  if (!Number.isSafeInteger(w) || w < 1 || w > 100000) return null;
  if (typeof input.starred !== "boolean") return null;
  const updatedAt = Number(input.updatedAt);
  if (!Number.isSafeInteger(updatedAt) || updatedAt <= 0) return null;
  return { c, w, starred: input.starred, updatedAt };
}

/** 生词记录 LWW：更大的 updated_at 覆盖；同一毫秒删除优先，避免加星复活。 */
function starUpsert(db, userId, change) {
  return db
    .prepare(
      "INSERT INTO user_word_stars (user_id, chapter_id, word_id, starred, updated_at) VALUES (?, ?, ?, ?, ?) " +
        "ON CONFLICT(user_id, chapter_id, word_id) DO UPDATE SET starred = excluded.starred, updated_at = excluded.updated_at " +
        "WHERE excluded.updated_at > user_word_stars.updated_at " +
        "OR (excluded.updated_at = user_word_stars.updated_at AND excluded.starred = 0 AND user_word_stars.starred = 1)"
    )
    .bind(userId, change.c, change.w, change.starred ? 1 : 0, change.updatedAt);
}

/** @param {*} row */
const rowToStar = (row) => ({
  c: Number(row.chapter_id),
  w: Number(row.word_id),
  starred: Number(row.starred) ? true : false,
  updatedAt: Number(row.updated_at) || 0,
});

// ============ 路由处理 ============

/** @param {Request} request @param {Env} env */
async function handleRegister(request, env) {
  const { data, error } = await readJson(request);
  if (error) return jsonError(error, "请求格式错误");
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
  let userId;
  try {
    const result = await env.DB.prepare(
      "INSERT INTO user_accounts (email, password_hash, nickname) VALUES (?, ?, ?)"
    )
      .bind(email, hash, nick)
      .run();
    userId = Number(result.meta.last_row_id);
  } catch (err) {
    // 并发注册同一邮箱：先查后插之间的竞态由 UNIQUE 约束兜底，映射成 409 而不是 500
    if (String(err && err.message ? err.message : err).includes("UNIQUE")) {
      return json({ error: "email_taken", msg: "该邮箱已注册" }, 409);
    }
    throw err;
  }
  const token = await createSession(env.DB, userId);
  return json({ token, userId, email, nickname: nick });
}

/** @param {Request} request @param {Env} env */
async function handleLogin(request, env) {
  const { data, error } = await readJson(request);
  if (error) return jsonError(error, "请求格式错误");
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
  if (error) return jsonError(error, "请求格式错误");
  const nick = String(/** @type {any} */ (data)?.nickname ?? "").trim().slice(0, 40);
  if (!nick) return json({ error: "invalid_nickname", msg: "昵称不能为空" }, 400);
  await env.DB.prepare("UPDATE user_accounts SET nickname = ? WHERE id = ?").bind(nick, user.id).run();
  return json({ ok: true, nickname: nick });
}

/** @param {Request} request @param {Env} env @param {{id:number, token:string}} user */
async function handlePassword(request, env, user) {
  const { data, error } = await readJson(request);
  if (error) return jsonError(error, "请求格式错误");
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
  if (encoder.encode(raw).byteLength > MAX_JSON_BYTES) return tooLarge();
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
    const resetClause = " AND seen_at > COALESCE((SELECT reset_at FROM user_chapter_resets WHERE user_id = user_word_state.user_id AND chapter_id = user_word_state.chapter_id), 0)";
    const rows = chapter
      ? await env.DB.prepare(
          "SELECT chapter_id, word_id, status, streak, wrong_count, seen_at, due_at FROM user_word_state " +
            "WHERE user_id = ? AND chapter_id = ? AND seen_at > ?" + resetClause + " ORDER BY word_id"
        )
          .bind(user.id, chapter, since)
          .all()
      : await env.DB.prepare(
          "SELECT chapter_id, word_id, status, streak, wrong_count, seen_at, due_at FROM user_word_state " +
            "WHERE user_id = ? AND seen_at > ?" + resetClause + " ORDER BY chapter_id, word_id"
        )
          .bind(user.id, since)
          .all();
    const resetRows = await env.DB.prepare("SELECT chapter_id, reset_at FROM user_chapter_resets WHERE user_id = ?")
      .bind(user.id)
      .all();
    const resets = Object.fromEntries((resetRows.results ?? []).map((row) => [String(row.chapter_id), Number(row.reset_at) || 0]));
    const resetFiltered = (rows.results ?? []).filter((row) => {
      const resetAt = Number(resets[String(row.chapter_id)]) || 0;
      return Number(row.seen_at) > resetAt;
    });
    return json({ words: resetFiltered.map(rowToWord), resets, serverTime: Date.now(), migrated });
  }

  const raw = await request.text();
  if (encoder.encode(raw).byteLength > MAX_WORDS_BODY) return tooLarge();
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

/** 生词本云同步：GET 全量/按章节/按 updatedAt 增量，PUT 按词 LWW。 */
async function handleStars(request, env, user) {
  if (request.method === "GET") {
    const url = new URL(request.url);
    const rawSince = Number(url.searchParams.get("since"));
    const since = Number.isSafeInteger(rawSince) && rawSince > 0 ? rawSince : 0;
    const rawChapter = Number(url.searchParams.get("chapter"));
    const chapter = Number.isSafeInteger(rawChapter) && rawChapter > 0 ? rawChapter : 0;
    if (url.searchParams.has("chapter") && (!Number.isSafeInteger(rawChapter) || rawChapter < 1 || rawChapter > 999)) {
      return json({ error: "invalid_chapter", msg: "章节号不合法" }, 400);
    }
    const rows = chapter
      ? await env.DB.prepare(
          "SELECT chapter_id, word_id, starred, updated_at FROM user_word_stars " +
            "WHERE user_id = ? AND chapter_id = ? AND updated_at > ? ORDER BY word_id"
        )
          .bind(user.id, chapter, since)
          .all()
      : await env.DB.prepare(
          "SELECT chapter_id, word_id, starred, updated_at FROM user_word_stars " +
            "WHERE user_id = ? AND updated_at > ? ORDER BY chapter_id, word_id"
        )
          .bind(user.id, since)
          .all();
    const stars = {};
    for (const raw of rows.results ?? []) {
      const row = rowToStar(raw);
      stars[`${row.c}:${row.w}`] = { starred: row.starred, updatedAt: row.updatedAt };
    }
    return json({ stars, serverTime: Date.now() });
  }

  const { data, error } = await readJson(request, MAX_STARS_BODY);
  if (error) return jsonError(error, "请求格式错误");
  const body = /** @type {any} */ (data) ?? {};
  if (!Array.isArray(body.changes)) return json({ error: "invalid_star", msg: "生词条目格式错误" }, 400);
  if (body.changes.length > MAX_STAR_CHANGES) {
    return json({ error: "too_many_changes", msg: "单次提交过多生词记录" }, 413);
  }
  const changes = [];
  for (const item of body.changes) {
    const change = normalizeStarChange(item);
    if (!change) return json({ error: "invalid_star", msg: "生词条目格式错误" }, 400);
    changes.push(change);
  }
  if (!changes.length) return json({ ok: true, applied: 0, serverTime: Date.now() });
  const stmts = changes.map((change) => starUpsert(env.DB, user.id, change));
  let applied = 0;
  for (let i = 0; i < stmts.length; i += 50) {
    const results = await env.DB.batch(stmts.slice(i, i + 50));
    for (const result of results) applied += Number(result?.meta?.changes || 0);
  }
  return json({ ok: true, applied, serverTime: Date.now() });
}

/** @param {Request} request @param {Env} env @param {{id:number}} user */
async function handleWordReset(request, env, user) {
  const { data, error } = await readJson(request, MAX_WORDS_BODY);
  if (error) return jsonError(error, "请求格式错误");
  const chapter = Number(/** @type {any} */ (data)?.chapter);
  if (!Number.isInteger(chapter) || chapter < 1) return json({ error: "invalid_chapter" }, 400);
  // 只清学习状态；讲义备注/配图与易错权重不属于"本章学习记录"
  const resetAt = Date.now();
  await env.DB.prepare(
    "INSERT INTO user_chapter_resets (user_id, chapter_id, reset_at) VALUES (?, ?, ?) " +
      "ON CONFLICT(user_id, chapter_id) DO UPDATE SET reset_at = MAX(user_chapter_resets.reset_at, excluded.reset_at)"
  )
    .bind(user.id, chapter, resetAt)
    .run();
  await env.DB.prepare("DELETE FROM user_word_state WHERE user_id = ? AND chapter_id = ?")
    .bind(user.id, chapter)
    .run();
  return json({ ok: true, resetAt, serverTime: resetAt });
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
    const tombstones = chapter
      ? await env.DB.prepare(
          "SELECT word_id, updated_at FROM user_note_tombstones WHERE user_id = ? AND chapter_id = ?"
        )
          .bind(user.id, chapter)
          .all()
      : await env.DB.prepare("SELECT chapter_id, word_id, updated_at FROM user_note_tombstones WHERE user_id = ?")
          .bind(user.id)
          .all();
    /** @type {Record<string,string>} */
    const notes = {};
    /** @type {Record<string,number>} */
    const stamps = {};
    /** @type {string[]} */
    const images = [];
    const tombstoneMap = new Map();
    for (const raw of tombstones.results ?? []) {
      const row = /** @type {any} */ (raw);
      const key = chapter ? String(row.word_id) : `${row.chapter_id}:${row.word_id}`;
      tombstoneMap.set(key, Number(row.updated_at) || 0);
    }
    let updatedAt = 0;
    for (const raw of rows.results ?? []) {
      const row = /** @type {any} */ (raw);
      const key = chapter ? String(row.word_id) : `${row.chapter_id}:${row.word_id}`;
      const at = Number(row.updated_at) || 0;
      const tombstoneAt = tombstoneMap.get(key) || 0;
      // 删除与正文使用同一个 LWW 时钟；平局时删除优先，避免旧正文复活。
      if (row.note && at > tombstoneAt) {
        notes[key] = String(row.note);
        stamps[key] = at;
      } else if (tombstoneAt) {
        stamps[key] = tombstoneAt;
      }
      if (Number(row.has_image)) images.push(key);
      updatedAt = Math.max(updatedAt, at, tombstoneAt);
    }
    for (const [key, at] of tombstoneMap) {
      if (!stamps[key]) stamps[key] = at;
      updatedAt = Math.max(updatedAt, at);
    }
    return json({ notes, stamps, images, updatedAt });
  }

  const { data, error } = await readJson(request, 32 * 1024);
  if (error) return jsonError(error, "请求格式错误");
  const body = /** @type {any} */ (data) ?? {};
  const chapter = Number(body.chapter);
  const word = Number(body.word);
  if (!Number.isInteger(chapter) || chapter < 1 || !Number.isInteger(word) || word < 1) {
    return json({ error: "invalid_target" }, 400);
  }
  const note = String(body.note ?? "").slice(0, MAX_NOTE_CHARS);
  const updatedAt = Math.max(0, Number(body.updatedAt) || Date.now());

  const existing = await env.DB.prepare(
    "SELECT note, has_image, updated_at FROM user_notes WHERE user_id = ? AND chapter_id = ? AND word_id = ?"
  )
    .bind(user.id, chapter, word)
    .first();
  const tombstone = await env.DB.prepare(
    "SELECT updated_at FROM user_note_tombstones WHERE user_id = ? AND chapter_id = ? AND word_id = ?"
  )
    .bind(user.id, chapter, word)
    .first();
  const currentAt = Math.max(Number(existing?.updated_at || 0), Number(tombstone?.updated_at || 0));
  if (currentAt > updatedAt || (Number(tombstone?.updated_at || 0) >= updatedAt && note)) {
    return json({
      ok: true,
      conflict: true,
      note: String(existing?.note ?? ""),
      hasImage: Number(existing?.has_image) ? 1 : 0,
      updatedAt: currentAt,
    });
  }
  const hasImage = Number(existing?.has_image) ? 1 : 0;

  if (!note && !hasImage) {
    // 删除也必须留下持久化 tombstone；条件删除防止并发较新的 PUT 被误删。
    await env.DB.prepare(
      "INSERT INTO user_note_tombstones (user_id, chapter_id, word_id, updated_at) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT(user_id, chapter_id, word_id) DO UPDATE SET updated_at = MAX(user_note_tombstones.updated_at, excluded.updated_at)"
    )
      .bind(user.id, chapter, word, updatedAt)
      .run();
    await env.DB.prepare(
      "DELETE FROM user_notes WHERE user_id = ? AND chapter_id = ? AND word_id = ? AND updated_at <= ?"
    )
      .bind(user.id, chapter, word, updatedAt)
      .run();
  } else {
    await env.DB.prepare(
      "INSERT INTO user_notes (user_id, chapter_id, word_id, note, has_image, updated_at) VALUES (?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(user_id, chapter_id, word_id) DO UPDATE SET note = excluded.note, updated_at = excluded.updated_at " +
        "WHERE excluded.updated_at > COALESCE((SELECT updated_at FROM user_note_tombstones WHERE user_id = excluded.user_id AND chapter_id = excluded.chapter_id AND word_id = excluded.word_id), 0) " +
        "AND excluded.updated_at >= user_notes.updated_at"
    )
      .bind(user.id, chapter, word, note, hasImage, updatedAt)
      .run();
    await env.DB.prepare(
      "DELETE FROM user_note_tombstones WHERE user_id = ? AND chapter_id = ? AND word_id = ? AND updated_at <= ?"
    )
      .bind(user.id, chapter, word, updatedAt)
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
    const row = await getActiveImage(env.DB, user.id, chapter, word);
    if (!row) return json({ error: "not_found" }, 404);
    return json({ mime: String(row.mime), data: String(row.data) });
  }

  if (request.method === "DELETE") {
    const { data, error } = await readJson(request, 4096);
    if (error) return jsonError(error, "请求格式错误");
    const chapter = Number(/** @type {any} */ (data)?.chapter);
    const word = Number(/** @type {any} */ (data)?.word);
    if (!Number.isInteger(chapter) || !Number.isInteger(word)) return json({ error: "invalid_target" }, 400);
    const updatedAt = normalizeImageUpdatedAt(data?.updatedAt);
    // 先留下不可逆的 tombstone，再按同一逻辑时间戳条件删除，旧客户端不能删掉新图。
    await imageTombstoneUpsert(env.DB, user.id, chapter, word, updatedAt).run();
    await env.DB
      .prepare("DELETE FROM user_note_images WHERE user_id = ? AND chapter_id = ? AND word_id = ? AND updated_at <= ?")
      .bind(user.id, chapter, word, updatedAt)
      .run();

    const active = await getActiveImage(env.DB, user.id, chapter, word);
    const existing = await env.DB.prepare(
      "SELECT note, updated_at FROM user_notes WHERE user_id = ? AND chapter_id = ? AND word_id = ?"
    )
      .bind(user.id, chapter, word)
      .first();
    if (!active) {
      if (existing && String(existing.note ?? "")) {
        // 只清 has_image，不动备注的 updated_at（配图增删不参与备注的 LWW 仲裁）
        await env.DB.prepare(
          "UPDATE user_notes SET has_image = 0 WHERE user_id = ? AND chapter_id = ? AND word_id = ?"
        )
          .bind(user.id, chapter, word)
          .run();
      } else {
        // 物理删除备注行前先补写备注墓碑：行删掉后“正文删除时间”就只剩墓碑可依，
        // 否则旧客户端可以用更旧的时间戳把已清空的备注复活。
        if (existing) {
          await env.DB.prepare(
            "INSERT INTO user_note_tombstones (user_id, chapter_id, word_id, updated_at) VALUES (?, ?, ?, ?) " +
              "ON CONFLICT(user_id, chapter_id, word_id) DO UPDATE SET updated_at = MAX(user_note_tombstones.updated_at, excluded.updated_at)"
          )
            .bind(user.id, chapter, word, Number(existing.updated_at) || 0)
            .run();
        }
        await env.DB
          .prepare("DELETE FROM user_notes WHERE user_id = ? AND chapter_id = ? AND word_id = ? AND updated_at <= ?")
          .bind(user.id, chapter, word, updatedAt)
          .run();
      }
    }
    const tombstone = await env.DB
      .prepare("SELECT updated_at FROM user_note_image_tombstones WHERE user_id = ? AND chapter_id = ? AND word_id = ?")
      .bind(user.id, chapter, word)
      .first();
    const canonicalAt = Math.max(Number(active?.updated_at || 0), Number(tombstone?.updated_at || 0), updatedAt);
    return json({ ok: true, updatedAt: canonicalAt });
  }

  // POST：上传（客户端已压缩，≤300KB）
  const { data, error } = await readJson(request, MAX_IMAGE_BASE64 + 4096);
  if (error) return jsonError(error, error === "payload_too_large" ? "图片过大，请重新选择" : "请求格式错误");
  const body = /** @type {any} */ (data) ?? {};
  const chapter = Number(body.chapter);
  const word = Number(body.word);
  const mime = String(body.mime ?? "");
  const b64 = body.data;
  if (!Number.isInteger(chapter) || !Number.isInteger(word)) return json({ error: "invalid_target" }, 400);
  if (!IMAGE_MIMES.has(mime)) return json({ error: "invalid_mime", msg: "只支持 JPEG/PNG/WebP" }, 400);
  if (typeof b64 !== "string" || !b64) return json({ error: "invalid_base64" }, 400);
  if (b64.length > MAX_IMAGE_BASE64) return json({ error: "image_too_large", msg: "图片过大（上限约 300KB）" }, 413);
  try {
    const bytes = fromBase64(b64);
    if (bytes.length > 300 * 1024) return json({ error: "image_too_large", msg: "图片过大（上限约 300KB）" }, 413);
  } catch {
    return json({ error: "invalid_base64" }, 400);
  }
  const updatedAt = normalizeImageUpdatedAt(body.updatedAt);
  await imageUpsert(env.DB, user.id, chapter, word, mime, b64, updatedAt).run();
  const active = await getActiveImage(env.DB, user.id, chapter, word);
  if (active) {
    // 更新 has_image 标记：不触碰 note 与备注的 updated_at（配图不参与备注 LWW）
    await markNoteHasImage(env.DB, user.id, chapter, word).run();
  }
  const tombstone = await env.DB
    .prepare("SELECT updated_at FROM user_note_image_tombstones WHERE user_id = ? AND chapter_id = ? AND word_id = ?")
    .bind(user.id, chapter, word)
    .first();
  return json({ ok: true, updatedAt: Number(active?.updated_at) || Number(tombstone?.updated_at) || updatedAt });
}

/** @param {Request} request @param {Env} env @param {{id:number}} user */
/**
 * 题目报错（第五期）：认词辨析卡上的「🚩 报错」。登录用户可提交；同用户同词限 1 条/分钟级别。
 * 导出：GET /api/quiz/report/export?token=<ADMIN_TOKEN>（env 未配置即 404）。
 */
const REPORT_KINDS = new Set(["similar", "options-wrong", "meaning-wrong", "other"]);

async function handleReportCreate(request, env, user) {
  // 注意：readJson 返回 { data, error } 包装，必须解包后再取字段（修复前恒为 400）
  const { data, error } = await readJson(request, 4096);
  if (error) return jsonError(error, "请求格式错误");
  const body = /** @type {any} */ (data) ?? {};
  const chapter = Number(body.chapter);
  const wordId = Number(body.wordId);
  const kind = String(body.kind || "");
  const note = String(body.note || "").slice(0, 500);
  if (!Number.isInteger(chapter) || chapter < 1 || chapter > 99 || !Number.isInteger(wordId) || wordId < 1) {
    return json({ error: "bad_request", msg: "章节或词 id 不合法" }, 400);
  }
  if (!REPORT_KINDS.has(kind)) {
    return json({ error: "bad_request", msg: "报错类型不合法" }, 400);
  }
  // 同用户同词：15 分钟窗口内 8 次即封 10 分钟（复用 auth_throttle 的窗口语义）
  const throttleKey = `report:${user.id}:${chapter}:${wordId}`;
  const st = await throttleState(env.DB, throttleKey);
  if (st.blockedUntil > Date.now()) return json({ error: "rate_limited", msg: "提交太频繁，请稍后再试" }, 429);
  await env.DB.prepare(
    "INSERT INTO question_report (user_id, chapter, word_id, kind, note) VALUES (?, ?, ?, ?, ?)"
  ).bind(user.id, chapter, wordId, kind, note).run();
  // 计数发生在插入之后：本条受理，第 9 次起被上面的 blockedUntil 拦下（与登录限流同语义）
  await throttleRecordFailure(env.DB, throttleKey);
  return json({ ok: true, msg: "已收到反馈，感谢！" });
}

async function handleReportExport(request, env) {
  // 支持 Authorization: Bearer（推荐，不进日志）；查询串 token 兼容旧用法但会被访问日志记录
  const auth = request.headers.get("authorization");
  const token = auth?.startsWith("Bearer ")
    ? auth.slice(7)
    : new URL(request.url).searchParams.get("token") || "";
  const admin = String(env.ADMIN_TOKEN || "");
  if (!admin || token !== admin) return json({ error: "not_found", msg: "接口不存在" }, 404);
  // 词库是静态 JSON（不在 D1），导出按 chapter+word_id 记录，后台对照 public/data-N.json 即可
  const { results } = await env.DB.prepare(
    "SELECT id, user_id, chapter, word_id, kind, note, created_at FROM question_report ORDER BY created_at DESC LIMIT 5000"
  )
    .all()
    .catch(() => ({ results: [] }));
  const esc = (v) => {
    let s2 = String(v ?? "");
    // 防 CSV 公式注入：以 = + - @ 开头的单元格加前导单引号
    if (/^[=+\-@]/.test(s2)) s2 = `'${s2}`;
    return /[",\n]/.test(s2) ? '"' + s2.replace(/"/g, '""') + '"' : s2;
  };
  const rows = [
    ["id", "created_at", "user_id", "chapter", "word_id", "kind", "note"],
    ...(results || []).map((r) => [r.id, r.created_at, r.user_id, r.chapter, r.word_id, r.kind, r.note]),
  ];
  const csv = rows.map((row) => row.map(esc).join(",")).join("\n");
  return new Response("\uFEFF" + csv, {
    headers: { ...SECURITY_HEADERS, "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="question-reports.csv"' },
  });
}

// ============ 后台管理（/api/admin/*，ADMIN_TOKEN 鉴权） ============

/** 常量时间比较：先 SHA-256 归一长度再逐字节异或，Workers 与 Node 通用 */
async function adminTokenEqual(input, expected) {
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(String(input || ""))),
    crypto.subtle.digest("SHA-256", enc.encode(String(expected || ""))),
  ]);
  const va = new Uint8Array(a);
  const vb = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i];
  return diff === 0;
}

/**
 * 管理路由统一鉴权。返回 null 表示通过，否则为应直接返回的错误响应。
 * Token 只从 Bearer header 读（查询串会进访问日志，不再支持）。
 */
async function guardAdmin(request, env) {
  const admin = String(env.ADMIN_TOKEN || "");
  if (!admin) return json({ error: "admin_disabled", msg: "后台未配置 ADMIN_TOKEN" }, 503);
  const auth = request.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token || !(await adminTokenEqual(token, admin))) {
    return json({ error: "admin_unauthorized", msg: "管理令牌无效" }, 401);
  }
  return null;
}

async function handleAdminOverview(request, env) {
  const nowIso = new Date().toISOString();
  const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const one = async (sql, bind = [], fallback = 0) => {
    try {
      const row = await env.DB.prepare(sql).bind(...bind).first();
      return Number(row?.n) || fallback;
    } catch {
      return fallback;
    }
  };
  const [users, activeSessions, reports, openReports, newUsers, newReports] = await Promise.all([
    one("SELECT COUNT(*) AS n FROM user_accounts"),
    one("SELECT COUNT(*) AS n FROM user_sessions WHERE expires_at > ?", [nowIso]),
    one("SELECT COUNT(*) AS n FROM question_report"),
    one("SELECT COUNT(*) AS n FROM question_report WHERE status = 'open'"),
    one("SELECT COUNT(*) AS n FROM user_accounts WHERE created_at >= ?", [weekAgo]),
    one("SELECT COUNT(*) AS n FROM question_report WHERE created_at >= ?", [weekAgo]),
  ]);
  return json({ users, activeSessions, reports, openReports, newUsers, newReports, serverTime: Date.now() });
}

/** 报错列表：全量拉回后 JS 过滤分页（个人项目规模足够；SQL 保持固定便于测试） */
async function handleAdminReports(request, env) {
  const url = new URL(request.url);
  const kind = url.searchParams.get("kind") || "";
  const chapter = Number(url.searchParams.get("chapter")) || 0;
  const status = url.searchParams.get("status") || "";
  const q = (url.searchParams.get("q") || "").trim().toLowerCase();
  const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit")) || 100));
  const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
  const { results } = await env.DB.prepare(
    "SELECT r.id, r.user_id, r.chapter, r.word_id, r.kind, r.note, r.status, r.handled_at, r.created_at, u.email AS user_email " +
      "FROM question_report r LEFT JOIN user_accounts u ON u.id = r.user_id " +
      "ORDER BY r.created_at DESC LIMIT 5000"
  )
    .all()
    .catch(() => ({ results: [] }));
  const filtered = (results || []).filter((r) => {
    if (kind && r.kind !== kind) return false;
    if (chapter && Number(r.chapter) !== chapter) return false;
    if (status && (r.status || "open") !== status) return false;
    if (q && !String(r.note || "").toLowerCase().includes(q) && !String(r.user_email || "").toLowerCase().includes(q)) return false;
    return true;
  });
  return json({
    total: filtered.length,
    reports: filtered.slice(offset, offset + limit).map((r) => ({
      id: Number(r.id),
      userId: Number(r.user_id) || 0,
      userEmail: String(r.user_email || ""),
      chapter: Number(r.chapter),
      wordId: Number(r.word_id),
      kind: String(r.kind),
      note: String(r.note || ""),
      status: String(r.status || "open"),
      handledAt: r.handled_at ? String(r.handled_at) : null,
      createdAt: String(r.created_at || ""),
    })),
  });
}

const REPORT_STATUSES = new Set(["open", "handled"]);

async function handleAdminReportPatch(request, env, reportId) {
  const { data, error } = await readJson(request, 2048);
  if (error) return jsonError(error, "请求格式错误");
  const status = String(/** @type {any} */ (data)?.status || "");
  if (!REPORT_STATUSES.has(status)) return json({ error: "invalid_status", msg: "状态只允许 open/handled" }, 400);
  const result = await env.DB.prepare("UPDATE question_report SET status = ?, handled_at = ? WHERE id = ?")
    .bind(status, status === "handled" ? new Date().toISOString() : null, reportId)
    .run();
  if (!Number(result?.meta?.changes || 0)) return json({ error: "not_found", msg: "报错记录不存在" }, 404);
  return json({ ok: true, status });
}

async function handleAdminUsers(request, env) {
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") || "").trim().toLowerCase();
  const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit")) || 100));
  const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
  const [accountRows, seenRows, starRows, noteRows] = await Promise.all([
    env.DB.prepare("SELECT id, email, nickname, created_at FROM user_accounts ORDER BY id DESC LIMIT 2000").all().catch(() => ({ results: [] })),
    env.DB.prepare("SELECT user_id, MAX(seen_at) AS last_seen FROM user_word_state GROUP BY user_id").all().catch(() => ({ results: [] })),
    env.DB.prepare("SELECT user_id, COUNT(*) AS n FROM user_word_stars GROUP BY user_id").all().catch(() => ({ results: [] })),
    env.DB.prepare("SELECT user_id, COUNT(*) AS n FROM user_notes GROUP BY user_id").all().catch(() => ({ results: [] })),
  ]);
  const seenMap = new Map((seenRows.results ?? []).map((r) => [Number(r.user_id), Number(r.last_seen) || 0]));
  const starMap = new Map((starRows.results ?? []).map((r) => [Number(r.user_id), Number(r.n) || 0]));
  const noteMap = new Map((noteRows.results ?? []).map((r) => [Number(r.user_id), Number(r.n) || 0]));
  const users = (accountRows.results ?? [])
    .filter((r) => {
      if (!q) return true;
      return String(r.email || "").toLowerCase().includes(q) || String(r.nickname || "").toLowerCase().includes(q);
    })
    .map((r) => ({
      id: Number(r.id),
      email: String(r.email || ""),
      nickname: String(r.nickname || ""),
      createdAt: String(r.created_at || ""),
      lastSeen: seenMap.get(Number(r.id)) || 0,
      stars: starMap.get(Number(r.id)) || 0,
      notes: noteMap.get(Number(r.id)) || 0,
    }));
  return json({ total: users.length, users: users.slice(offset, offset + limit) });
}

async function handleAdminUserDetail(request, env, userId) {
  const account = await env.DB.prepare("SELECT id, email, nickname, created_at FROM user_accounts WHERE id = ?")
    .bind(userId)
    .first()
    .catch(() => null);
  if (!account) return json({ error: "not_found", msg: "用户不存在" }, 404);
  const [chapterRows, starRows, noteRows, reportRows] = await Promise.all([
    env.DB.prepare("SELECT chapter_id, status, COUNT(*) AS n FROM user_word_state WHERE user_id = ? GROUP BY chapter_id, status")
      .bind(userId)
      .all()
      .catch(() => ({ results: [] })),
    env.DB.prepare("SELECT chapter_id, COUNT(*) AS n FROM user_word_stars WHERE user_id = ? AND starred = 1 GROUP BY chapter_id")
      .bind(userId)
      .all()
      .catch(() => ({ results: [] })),
    env.DB.prepare("SELECT chapter_id, COUNT(*) AS n FROM user_notes WHERE user_id = ? GROUP BY chapter_id")
      .bind(userId)
      .all()
      .catch(() => ({ results: [] })),
    env.DB.prepare("SELECT id, chapter, word_id, kind, note, status, created_at FROM question_report WHERE user_id = ? ORDER BY created_at DESC LIMIT 100")
      .bind(userId)
      .all()
      .catch(() => ({ results: [] })),
  ]);
  /** @type {Record<string, any>} */
  const chapters = {};
  for (const row of chapterRows.results ?? []) {
    const ch = String(row.chapter_id);
    chapters[ch] ||= { mastered: 0, learning: 0, wrong: 0 };
    if (row.status === "mastered") chapters[ch].mastered += Number(row.n) || 0;
    else if (row.status === "wrong") chapters[ch].wrong += Number(row.n) || 0;
    else chapters[ch].learning += Number(row.n) || 0;
  }
  return json({
    id: Number(account.id),
    email: String(account.email || ""),
    nickname: String(account.nickname || ""),
    createdAt: String(account.created_at || ""),
    chapters,
    stars: Object.fromEntries((starRows.results ?? []).map((r) => [String(r.chapter_id), Number(r.n) || 0])),
    notes: Object.fromEntries((noteRows.results ?? []).map((r) => [String(r.chapter_id), Number(r.n) || 0])),
    reports: (reportRows.results ?? []).map((r) => ({
      id: Number(r.id),
      chapter: Number(r.chapter),
      wordId: Number(r.word_id),
      kind: String(r.kind),
      note: String(r.note || ""),
      status: String(r.status || "open"),
      createdAt: String(r.created_at || ""),
    })),
  });
}

async function handleExport(request, env, user) {
  const url = new URL(request.url);
  const withImages = url.searchParams.get("images") === "1";
  const [settingsRow, wordRows, noteRows, imageRows, starRows, resetRows, noteTombstoneRows, imageTombstoneRows] = await Promise.all([
    env.DB.prepare("SELECT settings FROM user_settings WHERE user_id = ?").bind(user.id).first(),
    env.DB.prepare(
      "SELECT chapter_id, word_id, status, streak, wrong_count, seen_at, due_at FROM user_word_state WHERE user_id = ?"
    )
      .bind(user.id)
      .all(),
    env.DB.prepare("SELECT chapter_id, word_id, note, has_image, updated_at FROM user_notes WHERE user_id = ?").bind(user.id).all(),
    withImages
      ? env.DB.prepare("SELECT chapter_id, word_id, mime, data, updated_at FROM user_note_images WHERE user_id = ?").bind(user.id).all()
      : Promise.resolve({ results: [] }),
    env.DB.prepare("SELECT chapter_id, word_id, starred, updated_at FROM user_word_stars WHERE user_id = ?")
      .bind(user.id)
      .all(),
    env.DB.prepare("SELECT chapter_id, reset_at FROM user_chapter_resets WHERE user_id = ?").bind(user.id).all(),
    env.DB.prepare("SELECT chapter_id, word_id, updated_at FROM user_note_tombstones WHERE user_id = ?").bind(user.id).all(),
    env.DB.prepare("SELECT chapter_id, word_id, updated_at FROM user_note_image_tombstones WHERE user_id = ?").bind(user.id).all(),
  ]);
  let settings = null;
  if (settingsRow) {
    try {
      settings = JSON.parse(String(settingsRow.settings));
    } catch {
      settings = null;
    }
  }
  const imageTombstoneMap = new Map(
    (imageTombstoneRows.results ?? []).map((raw) => {
      const row = /** @type {any} */ (raw);
      return [`${Number(row.chapter_id)}:${Number(row.word_id)}`, Number(row.updated_at) || 0];
    })
  );
  const imageRowsList = (imageRows.results ?? []).filter((raw) => {
    const row = /** @type {any} */ (raw);
    const key = `${Number(row.chapter_id)}:${Number(row.word_id)}`;
    return Number(row.updated_at) > (imageTombstoneMap.get(key) || 0);
  });
  const imageKeys = new Set(imageRowsList.map((row) => `${Number(row.chapter_id)}:${Number(row.word_id)}`));
  const resetMap = Object.fromEntries(
    (resetRows.results ?? []).map((row) => [String(row.chapter_id), Number(row.reset_at) || 0])
  );
  const noteTombstoneMap = new Map(
    (noteTombstoneRows.results ?? []).map((raw) => {
      const row = /** @type {any} */ (raw);
      return [`${Number(row.chapter_id)}:${Number(row.word_id)}`, Number(row.updated_at) || 0];
    })
  );
  return json({
    version: 2,
    exportedAt: new Date().toISOString(),
    email: user.email,
    settings,
    resets: resetMap,
    words: (wordRows.results ?? [])
      .filter((row) => Number(row.seen_at) > (Number(resetMap[String(row.chapter_id)]) || 0))
      .map(rowToWord),
    stars: (starRows.results ?? []).map(rowToStar),
    notes: (noteRows.results ?? []).map((raw) => {
      const row = /** @type {any} */ (raw);
      return {
        c: Number(row.chapter_id),
        w: Number(row.word_id),
        note: String(row.note ?? ""),
        hasImage: withImages && imageKeys.has(`${Number(row.chapter_id)}:${Number(row.word_id)}`) ? 1 : 0,
        updatedAt: Number(row.updated_at) || 0,
      };
    }),
    noteTombstones: [...noteTombstoneMap].map(([key, updatedAt]) => {
      const [c, w] = key.split(":").map(Number);
      return { c, w, updatedAt };
    }),
    imageTombstones: [...imageTombstoneMap].map(([key, updatedAt]) => {
      const [c, w] = key.split(":").map(Number);
      return { c, w, updatedAt };
    }),
    images: imageRowsList.map((raw) => {
      const row = /** @type {any} */ (raw);
      return {
        c: Number(row.chapter_id),
        w: Number(row.word_id),
        mime: String(row.mime),
        data: String(row.data),
        updatedAt: Number(row.updated_at) || 0,
      };
    }),
  });
}

/** @param {Request} request @param {Env} env @param {{id:number}} user */
async function handleImport(request, env, user) {
  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_IMPORT_BYTES) return tooLarge();
  const raw = await request.text();
  if (encoder.encode(raw).byteLength > MAX_IMPORT_BYTES) return tooLarge();
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return json({ error: "invalid_json", msg: "备份文件格式错误" }, 400);
  }
  const rawNotes = Array.isArray(payload?.notes) ? payload.notes : [];
  const rawImages = Array.isArray(payload?.images) ? payload.images : [];
  const rawNoteTombstones = Array.isArray(payload?.noteTombstones) ? payload.noteTombstones : [];
  const rawImageTombstones = Array.isArray(payload?.imageTombstones) ? payload.imageTombstones : [];
  const resetMap = normalizeResetMap(payload?.resets);
  const noteTombstones = normalizeTombstones(rawNoteTombstones, MAX_IMPORT_CHANGES);
  const imageTombstones = normalizeTombstones(rawImageTombstones, MAX_IMPORT_CHANGES);
  if (rawNotes.length > MAX_IMPORT_CHANGES || rawImages.length > MAX_IMPORT_CHANGES || rawNoteTombstones.length > MAX_IMPORT_CHANGES || rawImageTombstones.length > MAX_IMPORT_CHANGES) {
    return json({ error: "too_many_changes", msg: "备份里的备注或图片记录过多" }, 413);
  }
  const changes = (Array.isArray(payload?.words) ? payload.words : []).map(normalizeWordChange).filter(Boolean);
  if (changes.length > MAX_IMPORT_CHANGES) {
    return json({ error: "too_many_changes", msg: "备份里的学习记录过多" }, 413);
  }
  const starItems = Array.isArray(payload?.stars) ? payload.stars : [];
  if (starItems.length > MAX_IMPORT_CHANGES) {
    return json({ error: "too_many_changes", msg: "备份里的生词记录过多" }, 413);
  }
  const starChanges = starItems.map(normalizeStarChange).filter(Boolean);
  for (const [chapter, resetAt] of Object.entries(resetMap)) {
    await env.DB.prepare(
      "INSERT INTO user_chapter_resets (user_id, chapter_id, reset_at) VALUES (?, ?, ?) " +
        "ON CONFLICT(user_id, chapter_id) DO UPDATE SET reset_at = MAX(user_chapter_resets.reset_at, excluded.reset_at)"
    )
      .bind(user.id, Number(chapter), resetAt)
      .run();
  }
  for (const item of noteTombstones) {
    await env.DB.prepare(
      "INSERT INTO user_note_tombstones (user_id, chapter_id, word_id, updated_at) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT(user_id, chapter_id, word_id) DO UPDATE SET updated_at = MAX(user_note_tombstones.updated_at, excluded.updated_at)"
    )
      .bind(user.id, item.c, item.w, item.updatedAt)
      .run();
  }
  for (const item of imageTombstones) {
    await imageTombstoneUpsert(env.DB, user.id, item.c, item.w, item.updatedAt).run();
  }

  // 还原语义：导入数据的时间戳要越过账号当前的删除标记（章节重置 cutoff、备注/配图墓碑），
  // 否则“导出 → 重置或删除 → 再导入”会被静默拦下，用户看到导入成功但数据没有回来。
  // 只抬高到标记之后一位：真正的 LWW 语义不变，导出之后产生的新数据仍然胜出。
  const cutoffs = new Map();
  {
    const rows = await env.DB.prepare("SELECT chapter_id, reset_at FROM user_chapter_resets WHERE user_id = ?")
      .bind(user.id)
      .all();
    for (const row of rows.results ?? []) cutoffs.set(Number(row.chapter_id), Number(row.reset_at) || 0);
  }
  const noteGaps = new Map();
  {
    const rows = await env.DB
      .prepare("SELECT chapter_id, word_id, updated_at FROM user_note_tombstones WHERE user_id = ?")
      .bind(user.id)
      .all();
    for (const row of rows.results ?? []) {
      noteGaps.set(`${Number(row.chapter_id)}:${Number(row.word_id)}`, Number(row.updated_at) || 0);
    }
  }
  const imageGaps = new Map();
  {
    const rows = await env.DB
      .prepare("SELECT chapter_id, word_id, updated_at FROM user_note_image_tombstones WHERE user_id = ?")
      .bind(user.id)
      .all();
    for (const row of rows.results ?? []) {
      imageGaps.set(`${Number(row.chapter_id)}:${Number(row.word_id)}`, Number(row.updated_at) || 0);
    }
  }

  const stmts = changes.map((ch) => {
    const cutoff = cutoffs.get(ch.c) || 0;
    return wordStateUpsert(env.DB, user.id, ch.seen > cutoff ? ch : { ...ch, seen: cutoff + 1 });
  });
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));

  const starStmts = starChanges.map((change) => starUpsert(env.DB, user.id, change));
  for (let i = 0; i < starStmts.length; i += 50) await env.DB.batch(starStmts.slice(i, i + 50));

  const validImageKeys = new Set();
  for (const item of rawImages) {
    const chapter = Number(item?.c);
    const word = Number(item?.w);
    const mime = String(item?.mime ?? "");
    const data = item?.data;
    if (!Number.isInteger(chapter) || !Number.isInteger(word)) continue;
    if (!IMAGE_MIMES.has(mime) || typeof data !== "string" || !data || data.length > MAX_IMAGE_BASE64) continue;
    try {
      if (fromBase64(data).length > 300 * 1024) continue;
    } catch {
      continue;
    }
    validImageKeys.add(`${chapter}:${word}`);
  }

  let noteCount = 0;
  for (const item of rawNotes) {
    const chapter = Number(item?.c);
    const word = Number(item?.w);
    if (!Number.isInteger(chapter) || !Number.isInteger(word)) continue;
    const note = String(item?.note ?? "").slice(0, MAX_NOTE_CHARS);
    // 备份里带了导出时间戳就用它（保持 LWW 语义），否则退回导入时刻；
    // 有墓碑时重定基到墓碑之后，保证“导出后又被删除”的备注能被备份还原。
    const backupAt = Math.max(0, Number(item?.updatedAt) || 0);
    const gapAt = noteGaps.get(`${chapter}:${word}`) || 0;
    const at = backupAt > 0 ? Math.max(backupAt, gapAt + 1) : Date.now();
    await env.DB.prepare(
      "INSERT INTO user_notes (user_id, chapter_id, word_id, note, has_image, updated_at) VALUES (?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(user_id, chapter_id, word_id) DO UPDATE SET note = excluded.note, has_image = excluded.has_image, updated_at = excluded.updated_at " +
        "WHERE excluded.updated_at >= user_notes.updated_at"
    )
      .bind(user.id, chapter, word, note, validImageKeys.has(`${chapter}:${word}`) ? 1 : 0, at)
      .run();
    noteCount++;
  }

  for (const item of noteTombstones) {
    await env.DB.prepare(
      "DELETE FROM user_notes WHERE user_id = ? AND chapter_id = ? AND word_id = ? AND updated_at <= ?"
    )
      .bind(user.id, item.c, item.w, item.updatedAt)
      .run();
  }
  for (const item of imageTombstones) {
    await env.DB.prepare(
      "DELETE FROM user_note_images WHERE user_id = ? AND chapter_id = ? AND word_id = ? AND updated_at <= ?"
    )
      .bind(user.id, item.c, item.w, item.updatedAt)
      .run();
    await env.DB.prepare(
      "UPDATE user_notes SET has_image = 0 WHERE user_id = ? AND chapter_id = ? AND word_id = ?"
    )
      .bind(user.id, item.c, item.w)
      .run();
  }

  let imageCount = 0;
  for (const item of rawImages) {
    const chapter = Number(item?.c);
    const word = Number(item?.w);
    const mime = String(item?.mime ?? "");
    const data = item?.data;
    if (!Number.isInteger(chapter) || !Number.isInteger(word)) continue;
    if (!IMAGE_MIMES.has(mime) || typeof data !== "string" || !data || data.length > MAX_IMAGE_BASE64) continue;
    try {
      // 导入也走与上传相同的严格解码，避免 atob 宽松接受损坏的备份数据。
      if (fromBase64(data).length > 300 * 1024) continue;
    } catch {
      continue;
    }
    // 与备注同理：重定基越过配图墓碑，备份里仍存在的图不会被旧删除标记吞掉。
    const updatedAt = Math.max(
      normalizeImageUpdatedAt(item?.updatedAt),
      (imageGaps.get(`${chapter}:${word}`) || 0) + 1
    );
    await imageUpsert(env.DB, user.id, chapter, word, mime, data, updatedAt).run();
    // 图片表是事实来源；只有当前有效图片才补齐列表标记，且不改已有备注的 LWW 时间戳。
    const active = await getActiveImage(env.DB, user.id, chapter, word);
    if (active) {
      await markNoteHasImage(env.DB, user.id, chapter, word).run();
    }
    imageCount++;
  }

  if (payload?.settings && typeof payload.settings === "object") {
    await env.DB.prepare(
      "INSERT INTO user_settings (user_id, settings) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET settings = excluded.settings"
    )
      .bind(user.id, JSON.stringify(payload.settings))
      .run();
  }
  return json({ ok: true, words: changes.length, stars: starChanges.length, notes: noteCount, images: imageCount });
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
    // 与 js/css 同策略：走 ETag/304 回源校验，题源或词库改完立刻生效（原先 max-age=3600 会让更新滞留 1 小时）
    headers.set("cache-control", "no-cache");
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
        if (pathname === "/api/vocab/stars") {
          const user = await getUser(request, env.DB);
          if (!user) return json({ error: "authentication_required", msg: "请先登录" }, 401);
          if (method === "GET" || method === "PUT") return await handleStars(request, env, user);
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
        if (pathname === "/api/quiz/report" && method === "POST") {
          const user = await getUser(request, env.DB);
          if (!user) return json({ error: "authentication_required", msg: "请先登录" }, 401);
          return await handleReportCreate(request, env, user);
        }
        if (pathname === "/api/quiz/report/mine" && method === "GET") {
          const user = await getUser(request, env.DB);
          if (!user) return json({ error: "authentication_required", msg: "请先登录" }, 401);
          const { results } = await env.DB.prepare(
            "SELECT id, chapter, word_id, kind, note, status, handled_at, created_at FROM question_report WHERE user_id = ? ORDER BY created_at DESC LIMIT 100"
          )
            .bind(user.id)
            .all()
            .catch(() => ({ results: [] }));
          return json({
            reports: (results ?? []).map((r) => ({
              id: Number(r.id),
              chapter: Number(r.chapter),
              wordId: Number(r.word_id),
              kind: String(r.kind),
              note: String(r.note || ""),
              status: String(r.status || "open"),
              handledAt: r.handled_at ? String(r.handled_at) : null,
              createdAt: String(r.created_at || ""),
            })),
          });
        }
        if (pathname === "/api/quiz/report/export" && method === "GET") {
          return await handleReportExport(request, env);
        }
        if (pathname.startsWith("/api/admin/")) {
          const denied = await guardAdmin(request, env);
          if (denied) return denied;
          if (pathname === "/api/admin/overview" && method === "GET") return await handleAdminOverview(request, env);
          if (pathname === "/api/admin/reports" && method === "GET") return await handleAdminReports(request, env);
          if (pathname === "/api/admin/users" && method === "GET") return await handleAdminUsers(request, env);
          const userMatch = pathname.match(/^\/api\/admin\/users\/(\d+)$/);
          if (userMatch && method === "GET") return await handleAdminUserDetail(request, env, Number(userMatch[1]));
          const reportMatch = pathname.match(/^\/api\/admin\/reports\/(\d+)$/);
          if (reportMatch && method === "PATCH") return await handleAdminReportPatch(request, env, Number(reportMatch[1]));
          return json({ error: "not_found" }, 404);
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
    // 会话过期判断必须与 getUser 用同一时间格式（ISO-8601 UTC，存的就是 toISOString()）
    await env.DB.prepare("DELETE FROM user_sessions WHERE expires_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now')").run();
    const cutoff = Date.now() - 86400_000;
    await env.DB.prepare("DELETE FROM auth_throttle WHERE window_start < ? AND blocked_until < ?")
      .bind(cutoff, cutoff)
      .run();
  },
};
