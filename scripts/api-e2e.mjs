/**
 * api-e2e.mjs —— 真实端到端接口测试
 *
 * 与 test/worker.test.js 的区别：那个用的是内存版 D1 假实现（验证路由与逻辑），
 * 这个跑在真实 workerd + 真实 SQLite(D1 local) 上，能验证 SQL 语义本身。
 *
 * 用法：
 *   npm run db:migrate:local
 *   npm run dev             # 另开终端
 *   node scripts/api-e2e.mjs [baseUrl]
 */
const BASE = process.argv[2] || process.env.E2E_BASE || "http://127.0.0.1:8787";
const email = `e2e_${Date.now()}@example.com`;
const password = "e2epassword123";

let pass = 0;
let fail = 0;
const results = [];

function check(name, condition, detail = "") {
  if (condition) {
    pass++;
    console.log(`  ✔ ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    fail++;
    console.log(`  ✖ ${name}${detail ? ` — ${detail}` : ""}`);
  }
  results.push({ name, ok: Boolean(condition), detail });
}

/** @param {string} path @param {{ method?: string, token?: string, body?: any, raw?: boolean }} [opts] */
async function call(path, opts = {}) {
  const headers = { "content-type": "application/json" };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  const res = await fetch(BASE + path, {
    method: opts.method || "GET",
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  if (opts.raw) return res;
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  return { status: res.status, data, headers: res.headers, text };
}

async function main() {
  console.log(`\n目标：${BASE}\n`);

  /* ---------- 1. 静态资源与响应头 ---------- */
  console.log("1) 静态资源 / 安全头 / 缓存策略");
  const home = await call("/", { raw: true });
  const homeHtml = await home.text();
  check("首页 200", home.status === 200);
  check("首页带 CSP", (home.headers.get("content-security-policy") || "").includes("script-src 'self'"));
  check("首页 nosniff", home.headers.get("x-content-type-options") === "nosniff");
  check("首页 no-store", (home.headers.get("cache-control") || "").includes("no-store"));
  check("首页引用 app.js（新前端）", homeHtml.includes('src="app.js"'));
  check("首页无内联脚本", !/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/.test(homeHtml));
  check("首页无旧版标记（无 inline style / vocab-auth script）", !homeHtml.includes("<style>") && !homeHtml.includes('src="vocab-auth.js"'));

  const js = await call("/app.js", { raw: true });
  check("app.js 200", js.status === 200);
  check("app.js no-cache（改完即生效）", (js.headers.get("cache-control") || "").includes("no-cache"));

  const dataRes = await call("/data-1.json", { raw: true });
  check("词库 200", dataRes.status === 200);
  check("词库可缓存 max-age=3600", (dataRes.headers.get("cache-control") || "").includes("max-age=3600"));
  const words1 = await dataRes.json();
  check("词库解析成功且为数组", Array.isArray(words1) && words1.length > 0, `${words1.length} 词`);
  check("词库字段完整", words1.every((w) => w.word && w.meaningCN && typeof w.id === "number"));

  const css = await call("/tokens.css", { raw: true });
  check("tokens.css 200", css.status === 200);

  const unknownApi = await call("/api/nope");
  check("未知接口 404 JSON", unknownApi.status === 404 && unknownApi.data?.error === "not_found");
  check("未知接口无 CORS 通配", !unknownApi.headers.get("access-control-allow-origin"));

  /* ---------- 2. 注册 / 登录 / 鉴权 ---------- */
  console.log("\n2) 注册 / 登录 / 鉴权");
  const reg = await call("/api/auth/register", { method: "POST", body: { email, password, nickname: "E2E" } });
  check("注册成功", reg.status === 200 && reg.data?.token?.length >= 32, reg.data?.error || "");
  check("注册返回 userId", Number(reg.data?.userId) > 0, `userId=${reg.data?.userId}`);
  const userId = Number(reg.data.userId);
  let token = reg.data.token;

  const dup = await call("/api/auth/register", { method: "POST", body: { email, password } });
  check("重复邮箱 409", dup.status === 409);

  const weak = await call("/api/auth/register", { method: "POST", body: { email: `x${email}`, password: "short" } });
  check("弱密码 400", weak.status === 400);

  check("无 token 访问受保护接口 401", (await call("/api/account/profile")).status === 401);
  const profile = await call("/api/account/profile", { token });
  check("带 token 读取资料", profile.status === 200 && profile.data?.email === email);

  const login = await call("/api/auth/login", { method: "POST", body: { email, password } });
  check("登录成功", login.status === 200 && login.data?.token);
  check("登录返回同一 userId", Number(login.data?.userId) === userId);

  const badLogin = await call("/api/auth/login", { method: "POST", body: { email, password: "wrongpassword" } });
  check("错误密码 401", badLogin.status === 401);

  /* ---------- 3. 按词学习状态（真实 SQL 的 LWW） ---------- */
  console.log("\n3) 按词学习状态（真实 SQLite 的 upsert / LWW）");
  const now = Date.now();
  const changes = [
    { c: 1, w: 10, s: "wrong", cs: 0, wc: 1, seen: now, due: now + 86400000 },
    { c: 1, w: 11, s: "learning", cs: 1, wc: 0, seen: now, due: 0 },
    { c: 2, w: 5, s: "mastered", cs: 2, wc: 1, seen: now, due: 0 },
  ];
  const put1 = await call("/api/vocab/words", { method: "PUT", token, body: { changes } });
  check("写入 3 条词状态", put1.status === 200 && put1.data?.applied === 3, JSON.stringify(put1.data));

  const getAll = await call("/api/vocab/words", { token });
  check("读回 3 条", getAll.data?.words?.length === 3, `${getAll.data?.words?.length} 条`);
  const w10 = getAll.data.words.find((w) => w.c === 1 && w.w === 10);
  check("字段与写入一致", w10?.s === "wrong" && w10?.wc === 1 && w10?.due === now + 86400000);

  // 更旧的 seen 必须被 SQL 层的 WHERE 挡住
  await call("/api/vocab/words", {
    method: "PUT",
    token,
    body: { changes: [{ c: 1, w: 10, s: "mastered", cs: 9, wc: 9, seen: now - 60000, due: 0 }] },
  });
  const afterOlder = await call("/api/vocab/words", { token });
  const w10b = afterOlder.data.words.find((w) => w.c === 1 && w.w === 10);
  check("真实 SQLite 上更旧的 seen 被忽略", w10b?.s === "wrong" && w10b?.cs === 0, `now=${w10b?.s}/${w10b?.cs}`);

  // 更新的 seen 必须覆盖
  await call("/api/vocab/words", {
    method: "PUT",
    token,
    body: { changes: [{ c: 1, w: 10, s: "mastered", cs: 2, wc: 1, seen: now + 60000, due: 0 }] },
  });
  const afterNewer = await call("/api/vocab/words", { token });
  const w10c = afterNewer.data.words.find((w) => w.c === 1 && w.w === 10);
  check("真实 SQLite 上更新的 seen 覆盖成功", w10c?.s === "mastered" && w10c?.cs === 2);

  const sinceRes = await call(`/api/vocab/words?since=${now + 30000}`, { token });
  check("since 增量只返回更新的记录", sinceRes.data?.words?.length === 1, `${sinceRes.data?.words?.length} 条`);

  const byChapter = await call("/api/vocab/words?chapter=1", { token });
  check("按章节过滤", byChapter.data?.words?.length === 2);

  const dirty = await call("/api/vocab/words", {
    method: "PUT",
    token,
    body: { changes: [{ c: "x", w: -1 }, { c: 3, w: 7, s: "bogus", cs: -5, wc: "a", seen: null }] },
  });
  check("脏数据被清洗（不报错）", dirty.status === 200);
  const cleaned = await call("/api/vocab/words?chapter=3", { token });
  check("非法 status 归一化为 learning 且 seen 非 0", cleaned.data?.words?.[0]?.s === "learning" && cleaned.data.words[0].seen > 0);

  const tooMany = await call("/api/vocab/words", {
    method: "PUT",
    token,
    body: { changes: Array.from({ length: 900 }, (_, i) => ({ c: 4, w: i + 1, s: "wrong", seen: now })) },
  });
  check("单次超过 800 条返回 413", tooMany.status === 413);

  const chunk = await call("/api/vocab/words", {
    method: "PUT",
    token,
    body: { changes: Array.from({ length: 500 }, (_, i) => ({ c: 4, w: i + 1, s: "wrong", cs: 0, wc: 1, seen: now, due: 0 })) },
  });
  check("500 条分块上传成功（客户端队列的切块边界）", chunk.status === 200 && chunk.data?.applied === 500);

  const reset = await call("/api/vocab/words", { method: "DELETE", token, body: { chapter: 4 } });
  check("清空本章", reset.status === 200);
  const afterReset = await call("/api/vocab/words?chapter=4", { token });
  check("本章已清空且其它章不受影响", afterReset.data?.words?.length === 0 && (await call("/api/vocab/words?chapter=1", { token })).data.words.length === 2);

  /* ---------- 4. 设置 ---------- */
  console.log("\n4) 设置同步");
  const settings = { mode: "audio", hint: 2, daily: { target: 80, count: 12, date: "2026-09-17", streak: 3 } };
  check("写入设置", (await call("/api/vocab/settings", { method: "PUT", token, body: settings })).status === 200);
  const gotSettings = await call("/api/vocab/settings", { token });
  check("设置往返一致", JSON.stringify(gotSettings.data?.settings) === JSON.stringify(settings));
  const huge = await call("/api/vocab/settings", { method: "PUT", token, body: { blob: "x".repeat(9000) } });
  check("超过 8KB 返回 413", huge.status === 413);

  /* ---------- 5. 讲义备注与配图 ---------- */
  console.log("\n5) 讲义备注与配图");
  check("写入备注", (await call("/api/vocab/notes", { method: "PUT", token, body: { chapter: 1, word: 3, note: "词根 atmo=水汽" } })).status === 200);
  const notes = await call("/api/vocab/notes?chapter=1", { token });
  check("读回备注", notes.data?.notes?.["3"] === "词根 atmo=水汽");

  const b64 = Buffer.from("fake-jpeg-bytes".repeat(20)).toString("base64");
  const imgUp = await call("/api/vocab/notes/image", { method: "POST", token, body: { chapter: 1, word: 3, mime: "image/jpeg", data: b64 } });
  check("上传配图", imgUp.status === 200);
  const notes2 = await call("/api/vocab/notes?chapter=1", { token });
  check("列表只给 has_image 标记（不含 base64）", notes2.data?.images?.includes("3") && !JSON.stringify(notes2.data).includes(b64.slice(0, 32)));
  const imgGet = await call("/api/vocab/notes/image?chapter=1&word=3", { token });
  check("按需读取配图", imgGet.data?.data === b64 && imgGet.data?.mime === "image/jpeg");
  check("非法 mime 被拒", (await call("/api/vocab/notes/image", { method: "POST", token, body: { chapter: 1, word: 4, mime: "text/html", data: b64 } })).status === 400);
  check("超大图被拒", (await call("/api/vocab/notes/image", { method: "POST", token, body: { chapter: 1, word: 4, mime: "image/png", data: "A".repeat(400001) } })).status === 413);
  check("删除配图", (await call("/api/vocab/notes/image", { method: "DELETE", token, body: { chapter: 1, word: 3 } })).status === 200);
  check("删除后 404", (await call("/api/vocab/notes/image?chapter=1&word=3", { token })).status === 404);

  /* ---------- 6. 导出 / 导入 ---------- */
  console.log("\n6) 备份导出与导入");
  // 到此为止的词状态：ch1 w10+w11、ch2 w5、ch3 w7（ch4 的 500 条已被"清空本章"删除）
  const expectedWordRows = 4;
  const backup = await call("/api/vocab/export", { token });
  check("导出结构完整", backup.data?.version === 1 && Array.isArray(backup.data?.words) && Array.isArray(backup.data?.notes));
  check(
    "导出词状态条数与实际写入一致",
    backup.data?.words?.length === expectedWordRows,
    `${backup.data?.words?.length} 条（期望 ${expectedWordRows}）`
  );
  const importRes = await call("/api/vocab/import", { method: "POST", token, body: backup.data });
  check(
    "导入备份成功",
    importRes.status === 200 && importRes.data?.words === expectedWordRows,
    JSON.stringify(importRes.data)
  );

  /* ---------- 7. 登出与限流 ---------- */
  console.log("\n7) 登出 / 限流");
  const out = await call("/api/auth/logout", { method: "POST", token });
  check("登出成功", out.status === 200);
  check("登出后旧 token 立即失效", (await call("/api/account/profile", { token })).status === 401);

  // 第 2 步已经失败过 1 次（badLogin），所以再失败 7 次就达到阈值 8
  let firstBlockedAt = 0;
  for (let i = 1; i <= 10; i++) {
    const status = (await call("/api/auth/login", { method: "POST", body: { email, password: "wrongpassword" } })).status;
    if (status === 429 && !firstBlockedAt) firstBlockedAt = i;
  }
  const blocked = await call("/api/auth/login", { method: "POST", body: { email, password } });
  check(
    "累计失败达到阈值后限流（正确密码也被拒）",
    firstBlockedAt > 0 && firstBlockedAt <= 8 && blocked.status === 429,
    `第 ${firstBlockedAt} 次循环开始返回 429，阈值=8 次失败`
  );
  check("限流响应是 JSON 且带提示", blocked.data?.error === "rate_limited" && typeof blocked.data?.msg === "string");

  /* ---------- 8. 改密码 ---------- */
  console.log("\n8) 改密码与会话吊销");
  const login2 = await call("/api/auth/login", { method: "POST", body: { email, password } });
  // 上面已被限流会影响同 IP+邮箱，换一个 IP 头无法通过 fetch 设置，这里用另一个账号验证
  const email2 = `e2e2_${Date.now()}@example.com`;
  const reg2 = await call("/api/auth/register", { method: "POST", body: { email: email2, password } });
  const t2a = reg2.data.token;
  const login2b = await call("/api/auth/login", { method: "POST", body: { email: email2, password } });
  const t2b = login2b.data.token;
  check("同一账号两个会话", Boolean(t2a && t2b));
  const badPw = await call("/api/account/password", { method: "POST", token: t2b, body: { currentPassword: "nope12345", newPassword: "newpassword1" } });
  check("当前密码错误 401", badPw.status === 401);
  const okPw = await call("/api/account/password", { method: "POST", token: t2b, body: { currentPassword: password, newPassword: "newpassword1" } });
  check("改密码成功", okPw.status === 200);
  check("其它会话被吊销", (await call("/api/account/profile", { token: t2a })).status === 401);
  check("当前会话保留", (await call("/api/account/profile", { token: t2b })).status === 200);
  check("新密码可登录", (await call("/api/auth/login", { method: "POST", body: { email: email2, password: "newpassword1" } })).status === 200);

  /* ---------- 9. 结果 ---------- */
  console.log(`\n${fail ? "✖" : "✔"} API 端到端：${pass}/${pass + fail} 项通过`);
  console.log(`   （测试账号：${email} / ${email2}，userId=${userId}）`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error("\n无法执行：", err?.message || err);
  console.error("请确认 npm run db:migrate:local 已执行、且 npm run dev 正在运行（默认 http://127.0.0.1:8787）");
  process.exit(2);
});
