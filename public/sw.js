/**
 * 真经刷词 Service Worker（PWA）
 *
 * 策略（对应优化计划 2-10）：
 *   - 页面导航（HTML）：网络优先，离线回落缓存 —— shell 兜底；
 *   - 词库/题源等静态资源（json/css/js/svg/字体）：stale-while-revalidate，
 *     先回缓存保证秒开与弱网可用，后台刷新缓存；
 *   - /api/* 一律不拦截（学习状态必须真实在线读写）；
 *   - 版本号变更时清理旧缓存。
 */
const VERSION = "v1";
const CACHE = `vocab:${VERSION}`;
const SWR_PATTERN = /\.(json|css|js|svg|png|webp|woff2?)$/;

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
  if (SWR_PATTERN.test(url.pathname)) {
    event.respondWith(staleWhileRevalidate(req));
  }
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

async function staleWhileRevalidate(req) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(req);
  const refresh = fetch(req)
    .then((res) => {
      if (res && res.ok) cache.put(req, res.clone());
      return res;
    })
    .catch(() => null);
  return cached || (await refresh) || Response.error();
}
