import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../worker/index.js";
import { FakeD1 } from "./fake-d1.js";

/** 构造测试环境：内存 D1 + 假的静态资源绑定 */
function makeEnv() {
  const DB = new FakeD1();
  const ASSETS = {
    async fetch(request) {
      const path = new URL(request.url).pathname;
      const type = path.endsWith(".html") || path === "/"
        ? "text/html; charset=utf-8"
        : path.endsWith(".js")
          ? "text/javascript"
          : path.endsWith(".css")
            ? "text/css"
            : path.endsWith(".json")
              ? "application/json"
              : "image/svg+xml";
      return new Response(`asset:${path}`, { status: 200, headers: { "content-type": type } });
    },
  };
  return { DB, ASSETS };
}

const BASE = "https://app.test";

/** @param {string} path @param {RequestInit & { token?: string, ip?: string }} [opts] */
function call(path, opts = {}) {
  const headers = new Headers(opts.headers || {});
  headers.set("content-type", "application/json");
  if (opts.token) headers.set("authorization", `Bearer ${opts.token}`);
  headers.set("cf-connecting-ip", opts.ip || "10.0.0.1");
  return new Request(`${BASE}${path}`, {
    method: opts.method || "GET",
    headers,
    body: opts.body,
  });
}

const post = (path, body, opts = {}) =>
  worker.fetch(call(path, { ...opts, method: "POST", body: JSON.stringify(body) }), opts.env);
const put = (path, body, opts = {}) =>
  worker.fetch(call(path, { ...opts, method: "PUT", body: JSON.stringify(body) }), opts.env);
const get = (path, opts = {}) => worker.fetch(call(path, opts), opts.env);

/** 注册一个账号并返回 { token, userId, env } */
async function registerUser(env, email = "a@b.com", password = "password123") {
  const res = await post("/api/auth/register", { email, password }, { env });
  const data = await res.json();
  assert.equal(res.status, 200, JSON.stringify(data));
  return { token: data.token, userId: data.userId, env };
}

// ============ 认证 ============

test("注册：成功返回 token/userId，重复邮箱 409，弱密码 400，非法邮箱 400", async () => {
  const env = makeEnv();
  const res = await post("/api/auth/register", { email: "  A@B.com ", password: "password123", nickname: "小A" }, { env });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.email, "a@b.com", "邮箱应归一化为小写并去空格");
  assert.equal(data.nickname, "小A");
  assert.ok(data.token.length >= 32);
  assert.ok(data.userId > 0);

  const dup = await post("/api/auth/register", { email: "a@b.com", password: "password123" }, { env });
  assert.equal(dup.status, 409);

  const weak = await post("/api/auth/register", { email: "c@d.com", password: "short" }, { env });
  assert.equal(weak.status, 400);
  assert.equal((await weak.json()).error, "invalid_password");

  const bad = await post("/api/auth/register", { email: "nope", password: "password123" }, { env });
  assert.equal(bad.status, 400);
});

test("登录：密码错误 401，正确返回新会话；未登录访问受保护接口 401", async () => {
  const env = makeEnv();
  await registerUser(env);

  const wrong = await post("/api/auth/login", { email: "a@b.com", password: "wrongpass1" }, { env });
  assert.equal(wrong.status, 401);

  const ok = await post("/api/auth/login", { email: "a@b.com", password: "password123" }, { env });
  assert.equal(ok.status, 200);
  const { token } = await ok.json();

  assert.equal((await get("/api/account/profile", { env })).status, 401, "无 token → 401");
  assert.equal((await get("/api/account/profile", { env, token: "x".repeat(40) })).status, 401, "伪造 token → 401");
  const profile = await get("/api/account/profile", { env, token });
  assert.equal(profile.status, 200);
  assert.equal((await profile.json()).email, "a@b.com");
});

test("限流：连续失败达阈值后返回 429", async () => {
  const env = makeEnv();
  await registerUser(env);
  let last = 0;
  for (let i = 0; i < 8; i++) {
    const res = await post("/api/auth/login", { email: "a@b.com", password: "badpassword" }, { env });
    last = res.status;
  }
  assert.equal(last, 401, "第 8 次仍然按密码错误处理");
  const blocked = await post("/api/auth/login", { email: "a@b.com", password: "password123" }, { env });
  assert.equal(blocked.status, 429, "第 9 次被限流（正确密码也拒绝）");
  assert.equal((await blocked.json()).error, "rate_limited");

  const otherIp = await post(
    "/api/auth/login",
    { email: "a@b.com", password: "password123" },
    { env, ip: "10.0.0.99" }
  );
  assert.equal(otherIp.status, 200, "限流按 IP+邮箱 维度，其它 IP 不受影响");

  const otherEmail = await post(
    "/api/auth/login",
    { email: "a@b.com", password: "password123" },
    { env, ip: "10.0.0.99" }
  );
  assert.equal(otherEmail.status, 200);
});

test("登出：会话立即失效（旧 token 不能再访问）", async () => {
  const env = makeEnv();
  const { token } = await registerUser(env);
  assert.equal((await get("/api/account/profile", { env, token })).status, 200);

  const out = await post("/api/auth/logout", {}, { env, token });
  assert.equal(out.status, 200);
  assert.equal((await get("/api/account/profile", { env, token })).status, 401, "登出后旧 token 立即失效");
});

test("改密码：校验当前密码，吊销其它会话但保留当前会话", async () => {
  const env = makeEnv();
  const { token: first } = await registerUser(env);
  const second = await (await post("/api/auth/login", { email: "a@b.com", password: "password123" }, { env })).json();

  const bad = await post("/api/account/password", { currentPassword: "nope12345", newPassword: "newpassword1" }, { env, token: second.token });
  assert.equal(bad.status, 401);

  const ok = await post("/api/account/password", { currentPassword: "password123", newPassword: "newpassword1" }, { env, token: second.token });
  assert.equal(ok.status, 200);
  assert.equal((await get("/api/account/profile", { env, token: first })).status, 401, "其它设备被吊销");
  assert.equal((await get("/api/account/profile", { env, token: second.token })).status, 200, "当前会话保留");

  const relogin = await post("/api/auth/login", { email: "a@b.com", password: "newpassword1" }, { env });
  assert.equal(relogin.status, 200, "新密码可用");
});

test("改昵称：PUT /api/account/profile", async () => {
  const env = makeEnv();
  const { token } = await registerUser(env);
  const res = await put("/api/account/profile", { nickname: "新名字" }, { env, token });
  assert.equal(res.status, 200);
  assert.equal((await (await get("/api/account/profile", { env, token })).json()).nickname, "新名字");
  assert.equal((await put("/api/account/profile", { nickname: "   " }, { env, token })).status, 400);
});

// ============ 设置同步 ============

test("设置：读写往返 + 超过 8KB 拒绝", async () => {
  const env = makeEnv();
  const { token } = await registerUser(env);
  assert.equal((await (await get("/api/vocab/settings", { env, token })).json()).settings, null);

  const settings = { mode: "audio", hint: 2, daily: { target: 80, streak: 3 } };
  assert.equal((await put("/api/vocab/settings", settings, { env, token })).status, 200);

  const back = await (await get("/api/vocab/settings", { env, token })).json();
  assert.deepEqual(back.settings, settings);

  const huge = { blob: "x".repeat(9 * 1024) };
  assert.equal((await put("/api/vocab/settings", huge, { env, token })).status, 413);
});

// ============ 学习状态（按词 + LWW） ============

test("词状态：PUT 后 GET 可读回；更旧的 seen 不会覆盖更新的记录", async () => {
  const env = makeEnv();
  const { token } = await registerUser(env);

  const now = Date.now();
  const res = await put(
    "/api/vocab/words",
    {
      changes: [
        { c: 1, w: 10, s: "wrong", cs: 0, wc: 1, seen: now, due: now + 86400000 },
        { c: 1, w: 11, s: "learning", cs: 1, wc: 0, seen: now, due: 0 },
        { c: 2, w: 5, s: "mastered", cs: 2, wc: 1, seen: now, due: 0 },
      ],
    },
    { env, token }
  );
  assert.equal(res.status, 200);
  assert.equal((await res.json()).applied, 3);

  const all = await (await get("/api/vocab/words", { env, token })).json();
  assert.equal(all.words.length, 3);

  // 用更旧的时间戳把 w=5 改回 wrong，应当被 LWW 拒绝
  await put("/api/vocab/words", { changes: [{ c: 2, w: 5, s: "wrong", cs: 0, wc: 9, seen: now - 5000, due: 0 }] }, { env, token });
  const after = await (await get("/api/vocab/words", { env, token })).json();
  const kept = after.words.find((w) => w.c === 2 && w.w === 5);
  assert.equal(kept.s, "mastered", "旧的 seen 不覆盖新状态");

  // 更新的时间戳可以正常覆盖
  await put("/api/vocab/words", { changes: [{ c: 2, w: 5, s: "wrong", cs: 0, wc: 9, seen: now + 5000, due: now + 9000 }] }, { env, token });
  const later = await (await get("/api/vocab/words", { env, token })).json();
  assert.equal(later.words.find((w) => w.c === 2 && w.w === 5).s, "wrong");

  // since 过滤只返回更新的
  const since = await (await get(`/api/vocab/words?since=${now + 1000}`, { env, token })).json();
  assert.equal(since.words.length, 1);
  assert.equal(since.words[0].w, 5);

  // 按章节过滤
  const ch1 = await (await get("/api/vocab/words?chapter=1", { env, token })).json();
  assert.deepEqual(ch1.words.map((w) => w.w).sort((a, b) => a - b), [10, 11]);

  // 清空某章
  assert.equal((await worker.fetch(call("/api/vocab/words", { method: "DELETE", body: JSON.stringify({ chapter: 1 }) , token}), env)).status, 200);
  const cleared = await (await get("/api/vocab/words", { env, token })).json();
  assert.equal(cleared.words.filter((w) => w.c === 1).length, 0);
  assert.equal(cleared.words.length, 1, "其它章节不受影响");
});

test("词状态：拒绝脏数据与超大提交", async () => {
  const env = makeEnv();
  const { token } = await registerUser(env);
  const bad = await put(
    "/api/vocab/words",
    { changes: [{ c: "x", w: -1 }, { c: 1, w: 2, s: "hacker", cs: -5, wc: "a", seen: null }] },
    { env, token }
  );
  assert.equal(bad.status, 200);
  const data = await (await get("/api/vocab/words", { env, token })).json();
  assert.equal(data.words.length, 1, "非法 c/w 被丢弃，可规范化的脏值被清洗后保留");
  assert.equal(data.words[0].s, "learning", "非法 status 回落到 learning");
  assert.equal(data.words[0].cs, 0, "负数 streak 归零");
  assert.equal(data.words[0].wc, 0, "非数字 wrong_count 归零");
  assert.ok(data.words[0].seen > 0, "seen 缺失/非法时回落到服务器时间（否则永远同步不回来）");

  const many = { changes: Array.from({ length: 900 }, (_, i) => ({ c: 1, w: i + 1, s: "wrong", seen: 1 })) };
  assert.equal((await put("/api/vocab/words", many, { env, token })).status, 413);
});

test("旧版整章 blob 进度：首次拉取时自动迁移为按词状态", async () => {
  const env = makeEnv();
  const { token, userId } = await registerUser(env);
  env.DB.seedLegacyProgress(userId, 3, { wrongBookIds: [7, 8], newWordBookIds: [9], currentIndex: 4 });

  const res = await (await get("/api/vocab/words", { env, token })).json();
  assert.equal(res.migrated, 3, "迁移了 3 条");
  const byWord = new Map(res.words.map((w) => [w.w, w.s]));
  assert.equal(byWord.get(7), "wrong");
  assert.equal(byWord.get(8), "wrong");
  assert.equal(byWord.get(9), "learning");

  const again = await (await get("/api/vocab/words", { env, token })).json();
  assert.equal(again.migrated, 0, "不会重复迁移");
});

// ============ 讲义备注与配图 ============

test("备注：PUT/GET 往返；清空备注且无配图时删除记录", async () => {
  const env = makeEnv();
  const { token } = await registerUser(env);

  await put("/api/vocab/notes", { chapter: 1, word: 3, note: "词根 atmo=水汽" }, { env, token });
  await put("/api/vocab/notes", { chapter: 1, word: 4, note: "易混" }, { env, token });
  let data = await (await get("/api/vocab/notes?chapter=1", { env, token })).json();
  assert.equal(data.notes["3"], "词根 atmo=水汽");
  assert.equal(Object.keys(data.notes).length, 2);

  await put("/api/vocab/notes", { chapter: 1, word: 4, note: "" }, { env, token });
  data = await (await get("/api/vocab/notes?chapter=1", { env, token })).json();
  assert.equal(data.notes["4"], undefined, "空备注被删除");
  assert.equal(Object.keys(data.notes).length, 1, "另一条不受影响");

  assert.equal((await put("/api/vocab/notes", { chapter: 1, word: 0, note: "x" }, { env, token })).status, 400);
});

test("配图：上传后标记 has_image，可读取与删除；超大图拒绝", async () => {
  const env = makeEnv();
  const { token } = await registerUser(env);
  const b64 = Buffer.from("fake-image-bytes".repeat(10)).toString("base64");

  const up = await post("/api/vocab/notes/image", { chapter: 2, word: 5, mime: "image/jpeg", data: b64 }, { env, token });
  assert.equal(up.status, 200);

  const notes = await (await get("/api/vocab/notes?chapter=2", { env, token })).json();
  assert.deepEqual(notes.images, ["5"], "列表接口只给标记，不带 base64");
  assert.equal(notes.notes["5"], undefined);

  const img = await (await get("/api/vocab/notes/image?chapter=2&word=5", { env, token })).json();
  assert.equal(img.mime, "image/jpeg");
  assert.equal(img.data, b64);

  const badMime = await post("/api/vocab/notes/image", { chapter: 2, word: 6, mime: "text/html", data: b64 }, { env, token });
  assert.equal(badMime.status, 400);

  const tooBig = await post(
    "/api/vocab/notes/image",
    { chapter: 2, word: 6, mime: "image/png", data: "A".repeat(400_001) },
    { env, token }
  );
  assert.equal(tooBig.status, 413);

  const del = await worker.fetch(
    call("/api/vocab/notes/image", { method: "DELETE", body: JSON.stringify({ chapter: 2, word: 5 }), token }),
    env
  );
  assert.equal(del.status, 200);
  assert.equal((await get("/api/vocab/notes/image?chapter=2&word=5", { env, token })).status, 404);
  const after = await (await get("/api/vocab/notes?chapter=2", { env, token })).json();
  assert.deepEqual(after.images, [], "删除配图后标记也清掉");
});

// ============ 导出 / 导入 ============

test("导出与导入：备份可完整还原（含备注）", async () => {
  const env = makeEnv();
  const { token, userId } = await registerUser(env);
  await put("/api/vocab/settings", { mode: "chinese", daily: { target: 60 } }, { env, token });
  await put("/api/vocab/words", { changes: [{ c: 1, w: 1, s: "wrong", cs: 0, wc: 2, seen: 111, due: 222 }] }, { env, token });
  await put("/api/vocab/notes", { chapter: 1, word: 1, note: "备注内容" }, { env, token });

  const backup = await (await get("/api/vocab/export", { env, token })).json();
  assert.equal(backup.version, 1);
  assert.equal(backup.words.length, 1);
  assert.equal(backup.notes.length, 1);
  assert.equal(backup.settings.daily.target, 60);

  // 清空后导入还原
  await worker.fetch(call("/api/vocab/words", { method: "DELETE", body: JSON.stringify({ chapter: 1 }), token }), env);
  await put("/api/vocab/notes", { chapter: 1, word: 1, note: "" }, { env, token });
  assert.equal((await (await get("/api/vocab/words", { env, token })).json()).migrated, 0);

  const imported = await post("/api/vocab/import", backup, { env, token });
  assert.equal(imported.status, 200);
  const words = await (await get("/api/vocab/words", { env, token })).json();
  assert.equal(words.words.length, 1);
  assert.equal(words.words[0].s, "wrong");
  const notes = await (await get("/api/vocab/notes?chapter=1", { env, token })).json();
  assert.equal(notes.notes["1"], "备注内容");

  assert.equal((await post("/api/vocab/import", { words: "not-array" }, { env, token })).status, 200);
  assert.equal(await (await get("/api/vocab/words", { env, token })).json().then((d) => d.words.length >= 1), true);
  assert.ok(userId > 0);
});

// ============ 路由 / 静态资源 / 安全头 ============

test("未知接口返回 404 JSON，不会穿透到静态资源", async () => {
  const env = makeEnv();
  const res = await get("/api/nope", { env });
  assert.equal(res.status, 404);
  assert.equal((await res.json()).error, "not_found");
});

test("所有 API 响应带安全响应头且不缓存", async () => {
  const env = makeEnv();
  const res = await get("/api/nope", { env });
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("x-frame-options"), "DENY");
  assert.match(res.headers.get("content-security-policy") || "", /default-src 'self'/);
  assert.match(res.headers.get("cache-control") || "", /no-store/);
  assert.equal(res.headers.get("access-control-allow-origin"), null, "同源应用不再返回 CORS 通配");
});

test("静态资源缓存策略：HTML no-store / JS no-cache / JSON 可缓存", async () => {
  const env = makeEnv();
  const html = await get("/", { env });
  assert.equal(html.headers.get("cache-control"), "no-store");
  const js = await get("/app.js", { env });
  assert.equal(js.headers.get("cache-control"), "no-cache");
  const data = await get("/data-1.json", { env });
  assert.match(data.headers.get("cache-control") || "", /max-age=3600/);
  const svg = await get("/favicon.svg", { env });
  assert.match(svg.headers.get("cache-control") || "", /max-age=86400/);
});

test("接口异常统一返回 500 JSON（不泄露堆栈）", async () => {
  const env = makeEnv();
  env.DB.prepare = () => {
    throw new Error("boom");
  };
  const res = await post("/api/auth/login", { email: "a@b.com", password: "password123" }, { env });
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.equal(body.error, "internal_error");
  assert.equal(JSON.stringify(body).includes("boom"), false);
});

test("cron：清理过期会话与陈旧限流记录", async () => {
  const env = makeEnv();
  const { token } = await registerUser(env);
  env.DB.tables.user_sessions.push({ token: "old", user_id: 1, expires_at: "2000-01-01T00:00:00.000Z" });
  env.DB.tables.auth_throttle.push({ key: "k", failures: 9, window_start: 1, blocked_until: 2 });
  await worker.scheduled({}, env);
  assert.equal(env.DB.tables.user_sessions.some((s) => s.token === "old"), false);
  assert.equal(env.DB.tables.user_sessions.some((s) => s.token === token), true, "有效会话保留");
  assert.equal(env.DB.tables.auth_throttle.length, 0);
});
