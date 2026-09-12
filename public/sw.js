/* eslint-disable no-undef */
/**
 * 单词白纸 · Service Worker（阶段 06：PWA 离线可用）
 *
 * 为什么手写而不用 vite-plugin-pwa：
 * 我们要的策略很少（静态资源 Cache First、导航 Network First、/api 不缓存），
 * 手写一个 100 行的 sw.js 比引入一整套 workbox 更好读、更好排错；
 * 代价是「构建产物的 hash 文件名」得自己处理——下面 install 时会去解析 index.html，
 * 把它引用的资源一起预缓存，所以离线首屏也能起来。
 *
 * 缓存策略（对应阶段要求）：
 * 1. 预缓存：首页 HTML + 它引用的 js/css/图标/manifest；
 * 2. 静态资源（同源、带 hash）：Cache First，命中即返回，后台不重复请求；
 * 3. 导航请求（打开页面/刷新）：Network First，断网回落缓存的 index.html；
 * 4. `/api/*`：**不缓存**（同步数据必须实时；后端自己会带 no-store）；
 * 5. 跨域（例如 AI 接口）：**绝对不碰**（既不能缓存 AI 响应，也不能缓存密钥相关请求）。
 *
 * 更新：新版本装好后进入 waiting，**不自动刷新**（会打断背单词），
 * 由页面提示「有新版本可用，点击刷新」，用户点了才 skipWaiting + reload。
 */

/* 缓存版本号：改了这个字符串才会触发「清旧缓存 + 重新预缓存」。 */
const CACHE_VERSION = 'wordpaper-v1';
const CACHE_NAME = `${CACHE_VERSION}-static`;
const OFFLINE_URL = './index.html';

/** 允许预缓存的静态资源后缀 */
const PRECACHE_EXT = /\.(?:js|css|png|jpg|jpeg|svg|webp|ico|woff2?|webmanifest)$/i;

/** 当前 SW 的作用域（Vercel 部署在根路径下就是 '/'） */
const SCOPE = new URL(self.registration?.scope ?? self.location.href).pathname;

/**
 * 安装：预缓存首屏所需资源。
 *
 * 关键点是「解析 index.html 找 hash 文件名」——sw.js 是静态文件，
 * 打包时并不知道 `index-abc123.js` 这种名字，只能运行时读一遍 HTML 再抓。
 */
self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      try {
        const res = await fetch(OFFLINE_URL, { cache: 'no-store' });
        if (!res.ok) return;
        const html = await res.clone().text();
        await cache.put(OFFLINE_URL, res);

        // 从 HTML 里抠出所有同源的 js/css/图片，一并预缓存
        const urls = new Set();
        const re = /(?:href|src)\s*=\s*["']([^"']+)["']/gi;
        let m;
        while ((m = re.exec(html)) !== null) {
          const raw = m[1];
          if (!raw || raw.startsWith('data:') || raw.startsWith('http')) continue;
          try {
            const abs = new URL(raw, self.location.href);
            if (abs.origin !== self.location.origin) continue;
            urls.add(abs.pathname + abs.search);
          } catch {
            /* 忽略解析不了的地址 */
          }
        }
        // 顺手把图标也预缓存上（离线时从主屏幕打开要显示图标）
        for (const icon of [
          'icons/192x192.png',
          'icons/512x512.png',
          'icons/180x180.png',
          'icons/favicon.png',
          'favicon.png',
          'manifest.webmanifest',
        ]) {
          urls.add(`${SCOPE}${icon}`.replace(/\/{2,}/g, '/'));
        }
        await Promise.all(
          [...urls].map(async (url) => {
            try {
              const r = await fetch(url, { cache: 'no-store' });
              if (r.ok) await cache.put(url, r);
            } catch {
              /* 单个资源失败不影响整体安装 */
            }
          }),
        );
      } catch (err) {
        // 离线/首次安装时抓不到也没关系，运行时再补
        console.warn('[sw] 预缓存失败（不影响使用）', err);
      }
    })(),
  );
});

/** 激活：清掉旧版本缓存并立即接管（配合页面的「点击刷新」） */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((n) => n.startsWith('wordpaper-') && n !== CACHE_NAME).map((n) => caches.delete(n)));
      await self.clients.claim();
    })(),
  );
});

/** 页面点了「有新版本可用，点击刷新」→ 接管 */
self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});

/**
 * 判断请求能不能缓存。
 * @param {Request} request
 */
function isCacheable(request) {
  const url = new URL(request.url);
  // 跨域一律不碰（AI 接口、图床等）
  if (url.origin !== self.location.origin) return false;
  // 同步接口不缓存（数据要实时）
  if (url.pathname.startsWith(`${SCOPE}api/`) || url.pathname.includes('/api/')) return false;
  if (request.method !== 'GET') return false;
  return true;
}

/**
 * 网络优先：导航请求（打开页面 / 刷新）用它。
 * @param {Request} request
 */
async function networkFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const fresh = await fetch(request);
    if (fresh.ok) await cache.put(OFFLINE_URL, fresh.clone());
    return fresh;
  } catch (err) {
    const cached = (await cache.match(OFFLINE_URL)) ?? (await cache.match(request));
    if (cached) return cached;
    throw err;
  }
}

/**
 * 缓存优先：带 hash 的静态资源用它（内容变了文件名就变，所以缓存不会过期）。
 * @param {Request} request
 */
async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) return cached;
  const fresh = await fetch(request);
  if (fresh.ok) await cache.put(request, fresh.clone());
  return fresh;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || !isCacheable(request)) return; // 交给浏览器默认行为

  // 导航请求（地址栏打开、刷新、从主屏幕启动）
  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request));
    return;
  }

  const url = new URL(request.url);
  if (PRECACHE_EXT.test(url.pathname) || url.pathname.endsWith('/manifest.webmanifest')) {
    event.respondWith(cacheFirst(request));
  }
});
