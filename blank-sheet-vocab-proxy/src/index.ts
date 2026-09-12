/**
 * blank-sheet-vocab-proxy：自建转发脚本（可选，独立于前端）。
 *
 * 作用：给「浏览器直连被跨域拦截」的用户一个选择——自己部署这个转发口，
 * 前端设置页「接口地址」填本 Worker 地址即可，前端代码零改动。
 *
 * 安全约束：
 * - 脚本里不硬编码任何真实密钥 / 上游地址 / 域名白名单，全部走环境变量；
 * - 响应里不回显任何密钥内容；
 * - 不透传上游返回的 Authorization 头；
 * - 极简限流：内存 Map 按 CF-Connecting-IP 计数，单 IP 每分钟 > 60 次返回 429
 *   （单实例内存计数，多实例部署会失效，需换 Durable Object / KV）。
 */

/** Worker 环境变量 */
export interface Env {
  /** 上游基础地址，默认 https://api.deepseek.com */
  UPSTREAM_BASE?: string;
  /** 上游密钥：设置了就固定用它，不设置则透传请求里的 Authorization */
  UPSTREAM_KEY?: string;
  /** 访问口令（建议用 wrangler secret put 设置）：设置后必须携带匹配的 Bearer */
  ACCESS_TOKEN?: string;
  /** CORS 允许的来源，默认 * */
  ALLOW_ORIGIN?: string;
}

/** Cloudflare 的 ExecutionContext（只用到 waitUntil，结构化声明即可） */
export interface Ctx {
  waitUntil(promise: Promise<unknown>): void;
}

/** 每 IP 每分钟允许的请求数 */
const RATE_LIMIT = 60;
/** 限流窗口（毫秒） */
const RATE_WINDOW_MS = 60_000;
/** 上游超时 */
const UPSTREAM_TIMEOUT_MS = 120_000;

/** 单实例内存限流计数（见文件头注释） */
const hits = new Map<string, number[]>();

/**
 * 判断某个 IP 是否还在限流额度内（顺手把这次请求记上）。
 * @param ip 客户端 IP（CF-Connecting-IP）
 */
function allowRequest(ip: string): boolean {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (recent.length >= RATE_LIMIT) {
    hits.set(ip, recent);
    return false;
  }
  recent.push(now);
  hits.set(ip, recent);
  return true;
}

/** 给响应补全套 CORS 头（所有响应都带） */
function withCors(headers: Headers, env: Env): Headers {
  const origin = env.ALLOW_ORIGIN?.trim() || '*';
  headers.set('Access-Control-Allow-Origin', origin);
  headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  headers.set('Access-Control-Max-Age', '86400');
  return headers;
}

/** 组装上游地址：UPSTREAM_BASE 去掉结尾斜杠后补 /chat/completions */
function upstreamUrl(env: Env): string {
  const base = (env.UPSTREAM_BASE ?? 'https://api.deepseek.com').trim().replace(/\/+$/, '');
  return `${base}/chat/completions`;
}

export default {
  async fetch(request: Request, env: Env, ctx: Ctx): Promise<Response> {
    // 1) OPTIONS 预检 → 204 + CORS
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: withCors(new Headers(), env) });
    }

    // 2) 非 POST → 405
    if (request.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'method not allowed' }), {
        status: 405,
        headers: withCors(new Headers({ 'Content-Type': 'application/json' }), env),
      });
    }

    // 3) 口令校验（可选）：设置了 ACCESS_TOKEN 就要求 Authorization: Bearer 与之相等
    const accessToken = env.ACCESS_TOKEN ?? '';
    if (accessToken !== '') {
      const auth = request.headers.get('Authorization') ?? '';
      if (auth !== `Bearer ${accessToken}`) {
        return new Response(JSON.stringify({ error: 'forbidden' }), {
          status: 403,
          headers: withCors(new Headers({ 'Content-Type': 'application/json' }), env),
        });
      }
    }

    // 4) 限流：按 CF-Connecting-IP 计数
    const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
    if (!allowRequest(ip)) {
      return new Response(JSON.stringify({ error: 'rate limited' }), {
        status: 429,
        headers: withCors(new Headers({ 'Content-Type': 'application/json' }), env),
      });
    }

    // 5) 组装上游请求：method/body 原样，删 origin/host，固定 Content-Type
    const headers = new Headers(request.headers);
    headers.delete('origin');
    headers.delete('host');
    headers.delete('content-length');
    headers.set('Content-Type', 'application/json');
    // 上游密钥：UPSTREAM_KEY 设置就用它；否则原样透传请求里的 Authorization（用户填什么发什么）
    if (env.UPSTREAM_KEY) {
      headers.set('Authorization', `Bearer ${env.UPSTREAM_KEY}`);
    }

    try {
      const upstream = await fetch(upstreamUrl(env), {
        method: request.method,
        headers,
        body: request.body,
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });

      // 6) 上游响应原样返回（含 status、body，支持流式透传），去掉敏感头 + 补 CORS
      const resHeaders = new Headers(upstream.headers);
      resHeaders.delete('Authorization');
      resHeaders.delete('set-cookie');
      withCors(resHeaders, env);
      return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: resHeaders });
    } catch (err) {
      // 7) 全包 try/catch：异常返回 502（不回显敏感信息以外的内容即可）
      const message = err instanceof Error ? err.message : String(err);
      return new Response(JSON.stringify({ error: message }), {
        status: 502,
        headers: withCors(new Headers({ 'Content-Type': 'application/json' }), env),
      });
    }
  },
};
