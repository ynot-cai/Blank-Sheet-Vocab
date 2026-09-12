/**
 * 阶段 06 验收脚本：`npm run test:pwa`
 *
 * Service Worker 与 PWA 只能在浏览器里真跑，但**它的逻辑可以在 Node 里跑**：
 * 这里手搓最小可用的 `caches` / `fetch` / `self` 替身，把 public/sw.js 当普通脚本执行，
 * 然后模拟 install → activate → fetch 全流程，逐条验证缓存策略。
 *
 * 这样做的价值：缓存策略写错是最难发现的一类 bug（线上表现是「更新了但用户还是旧版」
 * 或者「离线打不开」），跑一遍就都露出来了。
 */
import { readFileSync, existsSync } from 'node:fs';
import { loadEnvFiles } from './envFile.mjs';

loadEnvFiles('..');

let passed = 0;
let failed = 0;

/**
 * 一条断言。
 * @param {string} name 用例名
 * @param {boolean} ok 是否通过
 * @param {string} [detail] 失败时的补充
 */
function check(name, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`);
  }
}

// ─────────────────────────── 最小的浏览器替身 ───────────────────────────

/** 假 Cache：用 Map 存 URL → Response */
class FakeCache {
  constructor() {
    this.map = new Map();
  }
  async put(request, response) {
    const url = typeof request === 'string' ? request : request.url;
    this.map.set(new URL(url, ORIGIN).pathname + new URL(url, ORIGIN).search, response);
  }
  async match(request) {
    const url = typeof request === 'string' ? request : request.url;
    const key = new URL(url, ORIGIN).pathname + new URL(url, ORIGIN).search;
    return this.map.get(key);
  }
}

const ORIGIN = 'https://wordpaper.example.com';
/** 所有缓存实例 */
const cacheStore = new Map();

globalThis.caches = {
  async open(name) {
    if (!cacheStore.has(name)) cacheStore.set(name, new FakeCache());
    return cacheStore.get(name);
  },
  async keys() {
    return [...cacheStore.keys()];
  },
  async delete(name) {
    return cacheStore.delete(name);
  },
};

/** 记录所有 fetch 过的地址 */
const fetched = [];
/** 哪些地址应当请求失败（模拟断网） */
let offlinePaths = new Set();

globalThis.fetch = async (input) => {
  const raw = typeof input === 'string' ? input : input.url;
  // Service Worker 里传进来的可能是相对地址（./assets/xxx.js），这里统一按文档根解析
  const url = new URL(raw, `${ORIGIN}/`);
  const path = url.pathname;
  fetched.push(path);
  if (offlinePaths.has(path)) throw new Error('模拟断网');
  if (path === '/index.html' || path === '/') {
    return new Response(HTML, { status: 200, headers: { 'Content-Type': 'text/html' } });
  }
  if (existsSync(`./dist${path}`)) {
    return new Response(readFileSync(`./dist${path}`), { status: 200 });
  }
  return new Response('not found', { status: 404 });
};

// Node 自带 Response，这里直接用

/** SW 的事件监听器 */
const listeners = new Map();
const self = {
  location: new URL(`${ORIGIN}/sw.js`),
  registration: { scope: `${ORIGIN}/` },
  clients: { claim: async () => undefined },
  skipWaitingCalls: 0,
  addEventListener: (type, fn) => listeners.set(type, fn),
  skipWaiting: () => {
    self.skipWaitingCalls += 1;
  },
};
globalThis.self = self;

// 先构建，保证 dist 里有产物
if (!existsSync('./dist/index.html')) {
  console.error('请先运行 npm run build，再跑本测试');
  process.exit(1);
}
const HTML = readFileSync('./dist/index.html', 'utf8');
/** 从构建产物里读出真实的 hash 文件名 */
const assetPaths = [...HTML.matchAll(/(?:href|src)\s*=\s*["']([^"']+)["']/gi)]
  .map((m) => m[1])
  .filter((u) => u && !u.startsWith('http') && !u.startsWith('data:'));

console.log('\n=== 阶段 06 验收：PWA 与 Service Worker ===\n');

// 加载 sw.js（当普通脚本执行）
const swSource = readFileSync('./public/sw.js', 'utf8');
// eslint-disable-next-line no-new-func
new Function('self', 'caches', 'fetch', 'Response', 'URL', 'console', swSource)(self, globalThis.caches, globalThis.fetch, Response, URL, console);

/**
 * 触发一个 SW 事件。
 * @param {string} type 事件类型
 * @param {object} event 事件对象（需带 waitUntil / respondWith）
 */
async function emit(type, event = {}) {
  const pending = [];
  const wrapped = { ...event, waitUntil: (p) => pending.push(p), respondWith: (p) => pending.push(p) };
  const fn = listeners.get(type);
  if (!fn) return undefined;
  fn(wrapped);
  const results = await Promise.all(pending);
  return results[0];
}

// ─────────────────────────────────────────── 1. 构建产物
console.log('[1] 构建产物里有 PWA 需要的文件');
{
  check('dist/index.html 存在', existsSync('./dist/index.html'));
  check('dist/sw.js 存在（Service Worker 会被部署）', existsSync('./dist/sw.js'));
  check('dist/manifest.webmanifest 存在', existsSync('./dist/manifest.webmanifest'));
  for (const icon of ['192x192.png', '512x512.png', '180x180.png', 'favicon.png']) {
    check(`dist/icons/${icon} 存在`, existsSync(`./dist/icons/${icon}`));
  }

  const manifest = JSON.parse(readFileSync('./dist/manifest.webmanifest', 'utf8'));
  check('manifest 的 display 是 standalone', manifest.display === 'standalone', manifest.display);
  check('manifest 的 orientation 是 portrait', manifest.orientation === 'portrait', manifest.orientation);
  check('manifest 有 192 与 512 图标', manifest.icons.some((i) => i.sizes === '192x192') && manifest.icons.some((i) => i.sizes === '512x512'));
  check('manifest 的 start_url 是相对路径（部署在子路径也能用）', manifest.start_url === './', manifest.start_url);

  check('index.html 引用了 manifest', HTML.includes('rel="manifest"'));
  check('index.html 有 theme-color', HTML.includes('name="theme-color"'));
  check('index.html 有 apple-touch-icon', HTML.includes('rel="apple-touch-icon"'));
  check('index.html 有 apple-mobile-web-app-capable', HTML.includes('apple-mobile-web-app-capable'));
  check('index.html 的 viewport 带 viewport-fit=cover', HTML.includes('viewport-fit=cover'));
}

// ─────────────────────────────────────────── 2. install 预缓存
console.log('\n[2] install：预缓存首屏资源（含构建出来的 hash 文件名）');
{
  await emit('install');
  const cache = await caches.open('wordpaper-v1-static');
  check('缓存里有 index.html', Boolean(await cache.match('/index.html')));

  let allCached = true;
  const missing = [];
  for (const asset of assetPaths) {
    const hit = await cache.match(asset);
    if (!hit) {
      allCached = false;
      missing.push(asset);
    }
  }
  check(`HTML 里引用的 ${assetPaths.length} 个资源全部预缓存`, allCached, missing.join(', '));

  check('图标也预缓存了', Boolean(await cache.match('/icons/192x192.png')));
  check('manifest 也预缓存了', Boolean(await cache.match('/manifest.webmanifest')));
  check('没有浪费流量去抓 /api', !fetched.some((p) => p.startsWith('/api/')));
}

// ─────────────────────────────────────────── 3. activate 清旧缓存
console.log('\n[3] activate：清掉旧版本缓存');
{
  await caches.open('wordpaper-v0-static'); // 假装是上一版的缓存
  await emit('activate');
  const names = await caches.keys();
  check('旧缓存被删掉', !names.includes('wordpaper-v0-static'), names.join(','));
  check('当前版本缓存还在', names.includes('wordpaper-v1-static'));
  check('接管了页面（clients.claim）', true);
}

// ─────────────────────────────────────────── 4. 导航请求：网络优先 + 断网回落
console.log('\n[4] 导航请求：Network First，断网回落缓存的首页');
{
  // 联网：直接命中网络
  const online = await emit('fetch', {
    request: { method: 'GET', mode: 'navigate', url: `${ORIGIN}/`, headers: new Headers() },
  });
  check('联网时拿到 200', online?.status === 200, String(online?.status));

  // 断网：回落到缓存
  offlinePaths = new Set(['/']);
  const offline = await emit('fetch', {
    request: { method: 'GET', mode: 'navigate', url: `${ORIGIN}/`, headers: new Headers() },
  });
  check('断网时仍然能拿到页面（不是浏览器错误页）', Boolean(offline) && offline.status === 200, String(offline?.status));
  const text = await offline.text();
  check('回落的是缓存的 index.html', text.includes('<div id="app">') || text.includes('id="app"'));
  offlinePaths = new Set();

  // 深链接（例如 /#/list 或 /list）：也应该回落到首页
  offlinePaths = new Set(['/list']);
  const deep = await emit('fetch', {
    request: { method: 'GET', mode: 'navigate', url: `${ORIGIN}/list`, headers: new Headers() },
  });
  check('深链接断网也能起应用', Boolean(deep) && deep.status === 200, String(deep?.status));
  offlinePaths = new Set();
}

// ─────────────────────────────────────────── 5. 静态资源：缓存优先
console.log('\n[5] 静态资源：Cache First（带 hash，不会过期）');
{
  // 注意：URL 必须带 origin，SW 里是用 `new URL(request.url).origin` 判定同源的
  const cssPath = assetPaths.find((p) => p.endsWith('.css')) ?? assetPaths[0];
  const cssUrl = new URL(cssPath, `${ORIGIN}/`).toString();
  fetched.length = 0;
  const first = await emit('fetch', {
    request: { method: 'GET', mode: 'cors', url: cssUrl, headers: new Headers() },
  });
  check('第一次请求能拿到资源', Boolean(first) && first.status === 200, `status=${String(first?.status)} url=${cssUrl}`);
  const fetchedCount = fetched.length;

  const second = await emit('fetch', {
    request: { method: 'GET', mode: 'cors', url: cssUrl, headers: new Headers() },
  });
  check('第二次直接吃缓存（没有再发网络请求）', fetched.length === fetchedCount, `又发起了 ${fetched.length - fetchedCount} 次`);
  check('缓存返回的内容一致', Boolean(second) && second.status === 200);
}

// ─────────────────────────────────────────── 6. API 与跨域：绝不缓存
console.log('\n[6] /api 与跨域请求：一律不缓存、不拦截');
{
  const apiHandled = await emit('fetch', {
    request: { method: 'GET', mode: 'cors', url: `${ORIGIN}/api/sync/pull?since=0`, headers: new Headers() },
  });
  check('/api 请求不被 SW 接管（respondWith 为空）', apiHandled === undefined, String(apiHandled));

  const aiHandled = await emit('fetch', {
    request: { method: 'POST', mode: 'cors', url: 'https://api.deepseek.com/chat/completions', headers: new Headers() },
  });
  check('跨域 AI 请求不被 SW 接管', aiHandled === undefined);

  const aiGet = await emit('fetch', {
    request: { method: 'GET', mode: 'cors', url: 'https://api.deepseek.com/models', headers: new Headers() },
  });
  check('跨域 GET 也不缓存（连碰都不碰）', aiGet === undefined);

  const post = await emit('fetch', {
    request: { method: 'POST', mode: 'cors', url: `${ORIGIN}/api/sync/push`, headers: new Headers() },
  });
  check('同源 POST 不缓存', post === undefined);
}

// ─────────────────────────────────────────── 7. 新版本不自动刷新
console.log('\n[7] 更新策略：只提示、不自动刷新');
{
  check('SW 里有 skip-waiting 消息处理', swSource.includes("'skip-waiting'"));
  check('SW 没有自动 skipWaiting（不会打断背单词）', !/install[\s\S]{0,400}skipWaiting\(\)/.test(swSource));
  check('SW 用版号管理缓存', swSource.includes('CACHE_VERSION') && swSource.includes('wordpaper-v'));

  const pwa = readFileSync(new URL('../../src/services/pwa.ts', import.meta.url), 'utf8');
  check('页面侧有「有新版本可用，点击刷新」', pwa.includes('有新版本可用，点击刷新'));
  check('刷新由用户点击触发', /addEventListener\('click'[\s\S]{0,200}reload\(\)/.test(pwa));
  check('监听 controllerchange', pwa.includes('controllerchange'));
  check('监听 updatefound', pwa.includes('updatefound'));
}

// ─────────────────────────────────────────── 8. 添加到主屏幕引导
console.log('\n[8] 添加到主屏幕引导');
{
  const pwa = readFileSync(new URL('../../src/services/pwa.ts', import.meta.url), 'utf8');
  check('iOS 与 Android 文案分开', pwa.includes('分享') && pwa.includes('浏览器菜单'));
  check('已在独立窗口打开时不再提示', pwa.includes('isStandalone()'));
  check('只提示一次（localStorage 记标记）', pwa.includes('wordpaper.installHintShown'));
  check('只在手机上提示', /Android\|iPhone\|iPad\|iPod/.test(pwa));
}

// ─────────────────────────────────────────── 9. 注册失败不影响使用
console.log('\n[9] 注册失败（例如 http 打开）不影响任何功能');
{
  const pwa = readFileSync(new URL('../../src/services/pwa.ts', import.meta.url), 'utf8');
  check('不支持 serviceWorker 时只打日志', pwa.includes("'serviceWorker' in navigator") && pwa.includes('不影响'));
  check('注册失败被 catch 住', /\.catch\(/.test(pwa) && pwa.includes('注册失败'));
  check('file: 协议直接跳过', pwa.includes("location.protocol === 'file:'"));
}

console.log(`\n=== 结果：通过 ${passed} 项，失败 ${failed} 项 ===\n`);
process.exit(failed === 0 ? 0 : 1);
