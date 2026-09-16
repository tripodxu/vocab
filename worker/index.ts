export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
}

const encoder = new TextEncoder();
const json = (data: unknown, status = 200, extra?: Record<string, string>) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra },
  });

// ===== 密码哈希 (PBKDF2-SHA256) =====
const ITERATIONS = 100_000;
function toHex(buf: ArrayBuffer | Uint8Array): string {
  return Array.from(buf instanceof Uint8Array ? buf : new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}
async function hashPassword(pw: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", encoder.encode(pw), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: ITERATIONS }, key, 256);
  return `pbkdf2$${ITERATIONS}$${toHex(salt)}$${toHex(bits)}`;
}
async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  if (!stored.startsWith("pbkdf2$")) return false;
  const [, iter, saltHex, hashHex] = stored.split("$");
  const salt = Uint8Array.from({ length: saltHex.length / 2 }, (_, i) => parseInt(saltHex.slice(i * 2, i * 2 + 2), 16));
  const key = await crypto.subtle.importKey("raw", encoder.encode(pw), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: Number(iter) }, key, 256);
  const computed = toHex(bits);
  if (computed.length !== hashHex.length) return false;
  let diff = 0;
  for (let i = 0; i < computed.length; i++) diff |= computed.charCodeAt(i) ^ hashHex.charCodeAt(i);
  return diff === 0;
}
function genToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");
}

// ===== 认证 =====
async function getUser(req: Request, db: D1Database): Promise<{ id: number; email: string } | null> {
  const auth = req.headers.get("authorization");
  const token = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token || token.length < 32) return null;
  return (await db
    .prepare("SELECT u.id, u.email FROM user_sessions s JOIN user_accounts u ON s.user_id = u.id WHERE s.token = ? AND s.expires_at > datetime('now')")
    .bind(token)
    .first<{ id: number; email: string }>()) ?? null;
}

function isValidEmail(e: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

// ===== Worker 入口 =====
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
          "access-control-allow-headers": "Content-Type, Authorization",
          "access-control-max-age": "86400",
        },
      });
    }

    const corsHeaders = { "access-control-allow-origin": "*" };

    // ===== POST /api/auth/register =====
    if (url.pathname === "/api/auth/register" && request.method === "POST") {
      const body = (await request.json().catch(() => null)) as { email?: string; password?: string; nickname?: string } | null;
      const email = body?.email?.trim().toLowerCase();
      const pw = body?.password;
      const nick = body?.nickname?.trim() || email?.split("@")[0] || "";
      if (!email || !isValidEmail(email) || !pw || pw.length < 6) return json({ error: "invalid_input", msg: "邮箱或密码不合法" }, 400, corsHeaders);
      const exists = await env.DB.prepare("SELECT id FROM user_accounts WHERE email = ?").bind(email).first();
      if (exists) return json({ error: "email_taken", msg: "该邮箱已注册" }, 409, corsHeaders);
      const hash = await hashPassword(pw);
      const result = await env.DB.prepare("INSERT INTO user_accounts (email, password_hash, nickname) VALUES (?, ?, ?)").bind(email, hash, nick).run();
      const userId = result.meta.last_row_id as number;
      const token = genToken();
      const expires = new Date(Date.now() + 30 * 86400_000).toISOString();
      await env.DB.prepare("INSERT INTO user_sessions (token, user_id, expires_at) VALUES (?, ?, ?)").bind(token, userId, expires).run();
      return json({ token, email, nickname: nick }, 200, corsHeaders);
    }

    // ===== POST /api/auth/login =====
    if (url.pathname === "/api/auth/login" && request.method === "POST") {
      const body = (await request.json().catch(() => null)) as { email?: string; password?: string } | null;
      const email = body?.email?.trim().toLowerCase();
      const pw = body?.password;
      if (!email || !pw) return json({ error: "invalid_input", msg: "请填写邮箱和密码" }, 400, corsHeaders);
      const account = await env.DB.prepare("SELECT id, password_hash, nickname FROM user_accounts WHERE email = ?").bind(email).first<{ id: number; password_hash: string; nickname: string | null }>();
      if (!account || !(await verifyPassword(pw, account.password_hash))) return json({ error: "invalid_credentials", msg: "邮箱或密码错误" }, 401, corsHeaders);
      const token = genToken();
      const expires = new Date(Date.now() + 30 * 86400_000).toISOString();
      await env.DB.prepare("INSERT INTO user_sessions (token, user_id, expires_at) VALUES (?, ?, ?)").bind(token, account.id, expires).run();
      // 清理过期会话
      await env.DB.prepare("DELETE FROM user_sessions WHERE expires_at < datetime('now')").run();
      return json({ token, email, nickname: account.nickname ?? email.split("@")[0] }, 200, corsHeaders);
    }

    // ===== GET /api/account/profile =====
    if (url.pathname === "/api/account/profile" && request.method === "GET") {
      const user = await getUser(request, env.DB);
      if (!user) return json({ error: "authentication_required" }, 401, corsHeaders);
      const account = await env.DB.prepare("SELECT nickname FROM user_accounts WHERE id = ?").bind(user.id).first<{ nickname: string | null }>();
      return json({ email: user.email, nickname: account?.nickname ?? user.email.split("@")[0] }, 200, corsHeaders);
    }

    // ===== GET /api/vocab/progress =====
    if (url.pathname === "/api/vocab/progress" && request.method === "GET") {
      const user = await getUser(request, env.DB);
      if (!user) return json({ error: "authentication_required" }, 401, corsHeaders);
      const rows = await env.DB.prepare("SELECT chapter_id, data, updated_at FROM vocab_progress WHERE user_id = ?").bind(user.id).all();
      const chapters: Record<number, unknown> = {};
      for (const row of rows.results ?? []) {
        const r = row as { chapter_id: number; data: string; updated_at: string };
        try { chapters[r.chapter_id] = { ...JSON.parse(r.data), updatedAt: r.updated_at }; } catch { /* skip */ }
      }
      return json({ chapters }, 200, corsHeaders);
    }

    // ===== /api/vocab/progress/:chapterId =====
    const chMatch = url.pathname.match(/^\/api\/vocab\/progress\/(\d+)$/);
    if (chMatch) {
      const chapterId = Number(chMatch[1]);
      const user = await getUser(request, env.DB);
      if (!user) return json({ error: "authentication_required" }, 401, corsHeaders);

      if (request.method === "GET") {
        const row = await env.DB.prepare("SELECT data, updated_at FROM vocab_progress WHERE user_id = ? AND chapter_id = ?").bind(user.id, chapterId).first<{ data: string; updated_at: string }>();
        return json(row ? { data: JSON.parse(row.data), updatedAt: row.updated_at } : { data: null }, 200, corsHeaders);
      }

      if (request.method === "PUT") {
        const raw = await request.text();
        if (encoder.encode(raw).byteLength > 64 * 1024) return json({ error: "payload_too_large" }, 413, corsHeaders);
        let data: unknown;
        try { data = JSON.parse(raw); } catch { return json({ error: "invalid_json" }, 400, corsHeaders); }
        await env.DB.prepare(
          "INSERT INTO vocab_progress (user_id, chapter_id, data) VALUES (?, ?, ?) ON CONFLICT(user_id, chapter_id) DO UPDATE SET data = excluded.data, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"
        ).bind(user.id, chapterId, JSON.stringify(data)).run();
        return json({ stored: true }, 200, corsHeaders);
      }

      if (request.method === "DELETE") {
        await env.DB.prepare("DELETE FROM vocab_progress WHERE user_id = ? AND chapter_id = ?").bind(user.id, chapterId).run();
        return json({ deleted: true }, 200, corsHeaders);
      }
    }

    // ===== 静态资源 fallback（HTML/JS 禁缓存） =====
    const res = await env.ASSETS.fetch(request);
    const ct = res.headers.get("content-type") || "";
    if (ct.includes("text/html") || ct.includes("javascript")) {
      const h = new Headers(res.headers);
      h.set("cache-control", "no-store, no-cache, must-revalidate");
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
    }
    return res;
  },
};
