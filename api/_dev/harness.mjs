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

/** 一个处理函数的最小形状：按「路径」索引，OPTIONS 预检也走同一个处理函数 */
export const ROUTES = {
  '/api/health': () => import('../health.ts'),
  '/api/sync/pull': () => import('../sync-pull.ts'),
  '/api/sync/push': () => import('../sync-push.ts'),
  '/api/sync/purge': () => import('../sync-purge.ts'),
  '/api/ai-proxy': () => import('../ai-proxy.ts'),
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
 * @param {string} [params.path] 例如 '/api/sync/pull'
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
        res.writeHead(shim.statusCode, { 'Content-Type': 'application/json; charset=utf-8', ...captured.headers });
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
