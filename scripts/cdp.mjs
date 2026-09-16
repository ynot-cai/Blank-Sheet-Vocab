/**
 * 无头浏览器 + CDP 的真实页面检查工具。
 *
 * 为什么不用 `--dump-dom`：实测它抓到的 `<div id="app">` 是空的——
 * 模块脚本还没跑就被 dump 了。而我们要验的恰恰是「JS 跑完之后渲染出了什么」，
 * 所以必须走 CDP：开远程调试端口 → WebSocket 连上 → 等 load → Runtime.evaluate 取 DOM。
 *
 * 这个模块被 test-presets-ui.mjs 复用。
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** 可用的 Chromium 内核浏览器 */
const CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

/**
 * 找一个浏览器。
 */
export function findBrowser() {
  return CANDIDATES.find((p) => existsSync(p)) ?? null;
}

/**
 * 起一个本地静态/预览服务（用 node 直接跑 vite 的入口，不经 shell）。
 *
 * 为什么不经 shell：`spawn(..., { shell: true })` 传数组参数会触发 Node 的
 * DEP0190 警告（参数不转义，有注入风险）。这里改成「用当前 node 直接执行
 * vite 的 JS 入口」，既没有 shell，也不依赖 PATH 里的 npx。
 *
 * @param {{ root: string, port: number, mode?: 'preview' | 'dev' }} opts 参数
 */
export function serveStatic(opts) {
  const viteBin = join(opts.root, 'node_modules', 'vite', 'bin', 'vite.js');
  if (!existsSync(viteBin)) throw new Error(`找不到 vite：${viteBin}`);
  const mode = opts.mode ?? 'preview';
  return spawn(
    process.execPath,
    [viteBin, mode, '--port', String(opts.port), '--strictPort'],
    { cwd: opts.root, stdio: 'ignore' },
  );
}

/**
 * 起一个带远程调试的无头浏览器，返回操作句柄。
 * @param {string} browser 浏览器可执行文件
 * @param {number} port 调试端口
 * @param {{ windowSize?: string }} [opts] `windowSize` 形如 '1280,900'。
 *   **无头窗口默认宽度不到 768px**，响应式页面会走手机布局（表格不渲染）——
 *   要验桌面布局就必须显式指定，这个坑踩过。
 */
export async function launch(browser, port, opts = {}) {
  const proc = spawn(
    browser,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--no-first-run',
      '--disable-extensions',
      ...(opts.windowSize ? [`--window-size=${opts.windowSize}`] : []),
      // 用临时 profile，避免复用真实用户数据、也避免被已开着的浏览器实例接管
      `--user-data-dir=${process.env.TEMP ?? '.'}\\dsh-cdp-${port}-${Date.now()}`,
      `--remote-debugging-port=${port}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  // 等调试端口就绪
  let version = null;
  for (let i = 0; i < 80; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) {
        version = await res.json();
        break;
      }
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!version) {
    proc.kill();
    throw new Error('浏览器调试端口没起来');
  }

  return { proc, version };
}

/**
 * 打开一个页面并返回一个可反复求值的会话（适合「点一下、等一等、再看」的流程测试）。
 * @param {number} port 调试端口
 * @param {string} url 目标地址
 * @param {{ waitMs?: number }} [opts] 首次加载后额外等待时间
 */
export async function openSession(port, url, opts = {}) {
  const created = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  if (!created.ok) throw new Error(`新建标签页失败：HTTP ${created.status}`);
  const target = await created.json();

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let msgId = 0;
  const pending = new Map();
  let loadFired = false;
  /** 页面上发生的网络请求（排查「请求到底发去哪了」用） */
  const network = [];

  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
      return;
    }
    if (msg.method === 'Page.loadEventFired') loadFired = true;
    if (msg.method === 'Network.requestWillBeSent') {
      network.push({ url: msg.params.request.url, method: msg.params.request.method });
    }
  });

  // 必须等 WebSocket 真正连上再发命令，否则 send 会写在未打开的连接上
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('WebSocket 连接失败')), { once: true });
  });

  /** 发一条 CDP 命令 */
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      msgId += 1;
      const id = msgId;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.enable');
  // 页面可能是新建时就开始加载的，这里显式导航一次以拿到确定的 load 事件
  await send('Page.navigate', { url });
  for (let i = 0; i < 120 && !loadFired; i += 1) await new Promise((r) => setTimeout(r, 100));
  await new Promise((r) => setTimeout(r, opts.waitMs ?? 1200));

  return {
    /**
     * 在页面里跑一段表达式并把结果取回来。
     * @param {string} expression 要执行的表达式（返回 JSON 可序列化的值）
     */
    async evaluate(expression) {
      const res = await send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      if (res.exceptionDetails) {
        throw new Error(`页面里执行出错：${res.exceptionDetails.exception?.description ?? res.exceptionDetails.text}`);
      }
      return res.result?.value;
    },
    /** 取当前页面 HTML */
    async html() {
      return this.evaluate('document.documentElement.outerHTML');
    },
    /**
     * 取页面发过的网络请求（排查「请求到底发去哪了」用）。
     * @param {string} [filter] 只看 URL 含该子串的
     */
    requests(filter) {
      return filter ? network.filter((r) => r.url.includes(filter)) : [...network];
    },
    /** 清空已记录的请求 */
    clearRequests() {
      network.length = 0;
    },
    /**
     * 在每个新文档**执行任何页面脚本之前**注入一段脚本（返回本次注入的 identifier）。
     *
     * 用途：给测试打桩。典型场景是 R2/R3 的 AI 调用——用 `window.fetch` 的替身
     * 返回固定 JSON，就能在不联网、不花钱的前提下把「AI 整理」的整条链路跑通，
     * 而且**响应内容完全可控**，能精确构造出要验的输入形态
     * （比如「高兴/快乐/愉快 平铺成 3 个义项」这种要被合并的样子）。
     *
     * 必须在 `Page.navigate` 之前调用才生效（所以这个 API 返回后要重新导航一次）。
     * @param source 要注入的 JS 源码
     */
    async addInitScript(source) {
      const res = await send('Page.addScriptToEvaluateOnNewDocument', { source });
      return res?.identifier ?? null;
    },
    /**
     * 撤销一次 addInitScript 注入。
     * @param identifier addInitScript 返回的 identifier
     */
    async removeInitScript(identifier) {
      if (!identifier) return;
      await send('Page.removeScriptToEvaluateOnNewDocument', { identifier });
    },
    /**
     * 重新导航到某个地址（等 load 事件 + 额外等待）。
     * @param url 目标地址
     * @param waitMs 额外等待毫秒
     */
    async goto(url, waitMs = 1200) {
      loadFired = false;
      await send('Page.navigate', { url });
      for (let i = 0; i < 120 && !loadFired; i += 1) await new Promise((r) => setTimeout(r, 100));
      await new Promise((r) => setTimeout(r, waitMs));
    },
    /**
     * **真正重新加载**当前页面（等 load 事件 + 额外等待）。
     *
     * ★ 为什么必须单独有一个：本应用是 hash 路由，`Page.navigate` 到
     *   「同路径、只换 hash」的地址属于**同文档导航**——不重新加载页面，
     *   于是 `main.ts` 的 boot() 不会再跑一遍，内存里的设置缓存还是旧的。
     *   测试里「写数据 → 重新导航 → 期望应用看到新数据」的写法会因此静默失效
     *   （实测：AI 密钥写进了库，但页面读到的还是空 key，排查了很久）。
     *   需要应用真的重读数据时，用这个而不是 goto。
     * @param waitMs 额外等待毫秒
     */
    async reload(waitMs = 2000) {
      loadFired = false;
      await send('Page.reload', { ignoreCache: true });
      for (let i = 0; i < 120 && !loadFired; i += 1) await new Promise((r) => setTimeout(r, 100));
      await new Promise((r) => setTimeout(r, waitMs));
    },
    /** 关掉这个标签页 */
    async close() {
      ws.close();
      await fetch(`http://127.0.0.1:${port}/json/close/${target.id}`).catch(() => {});
    },
    /**
     * 往一个 `<input type="file">` 里**真的塞文件**（R1 的文件上传测试要用）。
     *
     * 为什么要走 CDP 的 `DOM.setFileInputFiles` 而不是在页面里 `new File()`：
     * 前者走的是浏览器的真实选文件路径，`input.files` 是货真价实的 FileList，
     * 后面 `file.arrayBuffer()` / `File.text()` 拿到的字节与用户选中时**完全一致**；
     * 后者构造出来的 File 在部分场景下与真实文件行为有差异（size/type/流式读取）。
     * 既然要验「docx/pdf 真的能解析」，就不能在输入这一环放水。
     *
     * @param selector 文件输入框的 CSS 选择器
     * @param files 本机绝对路径数组
     * @returns 是否成功设置
     */
    async setFileInput(selector, files) {
      await send('DOM.enable');
      const doc = await send('DOM.getDocument', { depth: -1 });
      const found = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector });
      if (!found?.nodeId) return false;
      await send('DOM.setFileInputFiles', { nodeId: found.nodeId, files });
      return true;
    },
    /**
     * 把视口**精确**设成指定尺寸（手机适配验收必须）。
     *
     * 为什么不能用 `--window-size`：Windows 无头 Chromium 的最小窗宽是 504px，
     * 而且真实视口高度 = 窗口高度 − 95px。要验「390×844 真机上的一屏几个词」，
     * 只能走 CDP 的 `Emulation.setDeviceMetricsOverride`（它直接改布局视口，
     * 与真机开发者工具里的设备模拟是同一套机制）。
     * @param width 视口宽（CSS 像素）
     * @param height 视口高（CSS 像素）
     * @param deviceScaleFactor 设备像素比，默认 1
     */
    async setViewport(width, height, deviceScaleFactor = 1) {
      await send('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor,
        mobile: width <= 1024,
      });
      // 让页面按新尺寸重排（resize 事件会触发 applySettings/重新布点）
      await this.evaluate('window.dispatchEvent(new Event("resize"))');
      await new Promise((r) => setTimeout(r, 300));
    },
    /** 取消视口模拟（回到真实窗口尺寸） */
    async clearViewport() {
      await send('Emulation.clearDeviceMetricsOverride');
      await this.evaluate('window.dispatchEvent(new Event("resize"))');
      await new Promise((r) => setTimeout(r, 300));
    },
  };
}

/**
 * 打开一个页面，等它跑完，然后取回渲染后的 HTML。
 * @param {number} port 调试端口
 * @param {string} url 目标地址
 * @param {{ waitMs?: number }} [opts] 额外等待时间（等异步渲染）
 */
export async function renderedHtml(port, url, opts = {}) {
  const session = await openSession(port, url, opts);
  try {
    return await session.html();
  } finally {
    await session.close();
  }
}
