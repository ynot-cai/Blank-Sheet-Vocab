/**
 * 本地直调 API 的测试壳（只在开发时用，Vercel 不会部署这个目录）。
 *
 * 作用：不必登录 Vercel，就能用**和线上完全同一套**处理函数 + SQL 跑验收项
 * （401、空间隔离、软删除、500 条上限、分批推送……）。
 *
 * 用法：
 *   node api/_dev/server.mjs           # 另开一个窗口，当前端 API 用
 *   npm run test:api                   # 跑全部验收项
 *   npm run test:api -- 隔离            # 只跑名字里带「隔离」的用例
 */
import { createServer } from 'node:http';
import { Writable } from 'node:stream';

/**
 * 处理函数分发表：按「路径」索引（OPTIONS 预检也走同一个处理函数）。
 *
 * ⚠️ 路径必须和 src/dao/syncServer.ts 的 API_ROUTES 完全一致。
 * Vercel 把 api/ 下的**文件名**映射成路由，所以是 `/api/sync-pull`（连字符），
 * **不是** `/api/sync-pull`——写成后者本地也一样会 404，
 * 但那样至少能在本地测出来（线上炸过一次就是因为两边不一致）。
 */
export const ROUTES = {
  '/api/health': () => import('../health.ts'),
  '/api/sync-pull': () => import('../sync-pull.ts'),
  '/api/sync-push': () => import('../sync-push.ts'),
  '/api/sync-purge': () => import('../sync-purge.ts'),
  '/api/ai-proxy': () => import('../ai-proxy.ts'),
  // T4：无状态 TTS 转发（与 ai-proxy 同一套模式，上游固定为 TTS_TARGET）
  '/api/tts-proxy': () => import('../tts-proxy.ts'),
  // 二期（知识点）：路由名同样是连字符形式
  '/api/kc-list': () => import('../kc-list.ts'),
  '/api/kc-push': () => import('../kc-push.ts'),
  // 二期阶段 05：三张小表（语境词 / 题目历史 / 题库）
  '/api/context-words': () => import('../context-words.ts'),
  '/api/exam-history': () => import('../exam-history.ts'),
  '/api/bank-questions': () => import('../bank-questions.ts'),
};

/**
 * 造一个「像 Node 响应」的假响应对象。
 * 之所以要真的继承 Writable：AI 代理会用 `pipeline()` 把上游流转发到这里，
 * 普通对象没有 write/end 的流语义，管道会直接报错。
 */
export function createMockResponse() {
  const captured = { status: 200, headers: {}, chunks: [] };
  const res = new Writable({
    write(chunk, _enc, cb) {
      captured.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      cb();
    },
  });
  res.statusCode = 200;
  res.setHeader = (name, value) => {
    captured.headers[String(name).toLowerCase()] = String(value);
  };
  captured.res = res;
  captured.text = () => Buffer.concat(captured.chunks).toString('utf8');
  return captured;
}

/**
 * 按路径找处理函数；OPTIONS 预检由对应的处理函数自己回。
 * @param {string} path 请求路径
 */
function loaderFor(path) {
  return ROUTES[path];
}

/**
 * 给测试脚本用：直接调一个处理函数，不经过 HTTP。
 * @param {object} params
 * @param {'GET'|'POST'|'OPTIONS'} [params.method]
 * @param {string} [params.path] 例如 '/api/sync-pull'
 * @param {Record<string,string>} [params.headers]
 * @param {string} [params.query] 例如 'since=0'
 * @param {unknown} [params.body]
 */
export async function callApi({ method = 'GET', path, headers = {}, query = '', body } = {}) {
  const loader = loaderFor(path);
  if (!loader) throw new Error(`没有这个接口：${method} ${path}`);
  const mod = await loader();
  const handler = mod.default;

  const captured = createMockResponse();
  const res = captured.res;

  const queryObj = {};
  for (const pair of query.split('&')) {
    if (pair === '') continue;
    const [k, v = ''] = pair.split('=');
    queryObj[decodeURIComponent(k)] = decodeURIComponent(v);
  }

  await handler({ method, headers, query: queryObj, body, url: `${path}${query ? `?${query}` : ''}` }, res);

  const text = captured.text();
  let json = null;
  try {
    json = text === '' ? null : JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.statusCode, headers: captured.headers, text, json };
}

/**
 * 起一个标准 Node HTTP 服务，把 /api/* 映射到上面的处理函数。
 * 这样本地前端（走 Vite 代理 `server.proxy['/api']`）就能像连线上一样调 API。
 * @param {number} port
 */
export function startServer(port) {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;
    const method = (req.method ?? 'GET').toUpperCase();

    void (async () => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const raw = Buffer.concat(chunks).toString('utf8');

      const queryObj = {};
      for (const [k, v] of url.searchParams) queryObj[k] = v;

      let body;
      if (raw !== '') {
        try {
          body = JSON.parse(raw);
        } catch {
          body = raw;
        }
      }

      const loader = loaderFor(path);
      if (!loader) {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: `没有这个接口：${method} ${path}` }));
        return;
      }

      const captured = createMockResponse();
      const shim = captured.res;

      try {
        const mod = await loader();
        await mod.default({ method, headers: req.headers, query: queryObj, body, url: req.url }, shim);
      } catch (err) {
        console.error('[api-dev] 处理失败：', err instanceof Error ? err.message : err);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: '本地 API 出错' }));
        } else {
          res.end();
        }
        return;
      }

      // 处理函数已经通过 shim 收下了响应（含流式内容），这里统一发出去
      if (!res.headersSent) {
        /**
         * ★ 合并响应头时必须**先剥掉大小写不同的重名**。
         *
         * 踩过的坑（T4 实测）：处理函数用 `setHeader('Content-Type', 'audio/mpeg')`
         * 设的是**小写键** `content-type`（shim 统一转小写存的），
         * 而这里又写了一个 `'Content-Type': 'application/json; charset=utf-8'`。
         * Node 认为这是两个不同的键，**把两个值用逗号拼起来**：
         * `application/json; charset=utf-8,audio/mpeg`。
         * 浏览器按第一个值处理 → 前端把音频当错误体去 JSON.parse，
         * 表现成「有道 TTS 失败：HTTP 200」这种完全看不出原因的报错。
         *
         * 正确做法：以 captured 里的值为准，先把 writeHead 里同名（忽略大小写）的默认头删掉。
         */
        const headers = { 'Content-Type': 'application/json; charset=utf-8', ...captured.headers };
        if (captured.headers['content-type'] !== undefined) {
          delete headers['Content-Type'];
        }
        res.writeHead(shim.statusCode, headers);
      }
      res.end(Buffer.concat(captured.chunks));
    })();
  });

  server.listen(port, '127.0.0.1', () => {
    console.log(`[api-dev] 本地 API 已启动：http://127.0.0.1:${port}/api/health`);
    console.log('[api-dev] 数据库用的是 TURSO_DATABASE_URL 指向的那个（默认 ./.tmp/dev.db）');
  });
  return server;
}
