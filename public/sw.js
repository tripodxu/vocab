/**
 * 真经刷词 Service Worker（PWA）
 *
 * 策略（v2：发版即时性修订）：
 *   - 页面导航（HTML）：网络优先，离线回落缓存 —— shell 兜底；
 *   - js/css/json：同样**网络优先**（离线回落缓存）。原先对 js/css/json 走
 *     stale-while-revalidate 会把旧代码先喂给页面，发版后用户要多刷一两次
 *     才拿到更新；现在服务器已对这些资源发 no-cache（走 ETag/304），
 *     网络优先既能"改完立刻生效"，离线时也依然可用；
 *   - 图片/字体等不变资源：cache-first，省流量；
 *   - /api/* 一律不拦截（学习状态必须真实在线读写）；
 *   - 版本号变更时清理旧缓存（发版请同步递增 VERSION）。
 */
const VERSION = "v3";
const CACHE = `vocab:${VERSION}`;
const STATIC_STABLE = /\.(?:png|webp|gif|ico|woff2?|ttf|svg)$/;

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) {
        if (key !== CACHE) await caches.delete(key);
      }
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;

  if (req.mode === "navigate") {
    event.respondWith(networkFirst(req));
    return;
  }
  if (STATIC_STABLE.test(url.pathname)) {
    event.respondWith(cacheFirst(req));
    return;
  }
  // js / css / json：网络优先，离线回落（保证发版即时 + 弱网/断网可用）
  event.respondWith(networkFirst(req));
});

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  try {
    const fresh = await fetch(req);
    if (fresh && fresh.ok) cache.put(req, fresh.clone());
    return fresh;
  } catch {
    const cached = await cache.match(req);
    return cached || Response.error();
  }
}

async function cacheFirst(req) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(req);
  if (cached) return cached;
  const fresh = await fetch(req);
  if (fresh && fresh.ok) cache.put(req, fresh.clone());
  return fresh;
}
