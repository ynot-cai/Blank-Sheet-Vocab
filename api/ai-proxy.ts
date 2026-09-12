/**
 * POST /api/ai-proxy —— 无状态 AI 转发（阶段 03）。
 *
 * 存在意义：很多 AI 服务不返回 CORS 头，浏览器直连会被拦；于是由这个函数转发一次。
 *
 * **它是无状态的，这也是方案 B 的安全底线**：
 * - 密钥随每次请求的 `Authorization` 头过来，用完即弃；
 * - ❌ 不写数据库（本文件**不 import** db / inventory，根本不连 Turso）；
 * - ❌ 不写日志（全文件只打一行「转发了一次」，**不含** authorization / key / token / body）；
 * - ❌ 不缓存（响应带 `Cache-Control: no-store`）；
 * - ❌ 不回显任何请求头；
 * - ❌ 没有任何把密钥存进变量、文件、全局的逻辑。
 *
 * 请求：
 * - `X-Target-Url`：目标 AI 完整地址（必须 https）
 * - `Authorization`：用户自己的密钥（原样转发，不解析、不记录）
 * - body：标准 OpenAI 兼容请求体，原样转发
 */
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { allowedUpstreamHosts } from './_lib/env.js';
import { applyCors, isOriginAllowed, handleOptions } from './_lib/cors.js';
import { readHeader, sendError, sendJson } from './_lib/http.js';
import { AI_PROXY_TIMEOUT_MS } from './_lib/limits.js';
import type { ApiHandler } from './_lib/types.js';

/** 转发次数计数器（**只累计次数**，不保存任何请求内容） */
let forwardedCount = 0;

/**
 * 目标地址校验结果：ok 或一个说明原因。
 * 用「结果对象」而不是布尔值，是为了能区分 400（地址不合法）和 403（主机不在白名单）。
 */
type TargetCheck = { ok: true; url: URL } | { ok: false; status: number; message: string };

/**
 * 校验目标地址。
 *
 * 规则：
 * 1. 必须是合法 URL；
 * 2. 协议默认只允许 https；**例外**：主机在 `AI_ALLOWED_HOSTS` 白名单里时允许 http
 *    （这条例外是给本地开发/自动化测试对着 127.0.0.1 起假上游用的；
 *    生产把白名单填成真实 AI 域名，就没有任何 http 能通过）；
 * 3. 主机必须在 `AI_ALLOWED_HOSTS` 白名单里（`*` = 不限制），
 *    否则代理就成了访问任意地址的跳板（SSRF）。
 *
 * @param raw X-Target-Url 的值
 */
function checkTarget(raw: string): TargetCheck {
  if (raw.trim() === '') return { ok: false, status: 400, message: '缺少 X-Target-Url 请求头' };
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, status: 400, message: 'X-Target-Url 不是合法的 URL' };
  }
  const hostOk = hostAllowed(url.hostname);
  if (url.protocol === 'https:') {
    if (!hostOk) {
      return { ok: false, status: 403, message: `上游主机不在 AI_ALLOWED_HOSTS 白名单里：${url.hostname}` };
    }
    return { ok: true, url };
  }
  if (url.protocol === 'http:' && hostOk) return { ok: true, url };
  if (url.protocol === 'http:') {
    return { ok: false, status: 403, message: `上游主机不在 AI_ALLOWED_HOSTS 白名单里：${url.hostname}` };
  }
  return { ok: false, status: 400, message: `只支持 http(s) 目标，收到的是 ${url.protocol}` };
}

/**
 * 目标主机是否在白名单里（`*` = 不限制）。
 * 说明：白名单挡的是「拿你的代理去请求任意地址」（SSRF），自用场景建议填真实 AI 域名。
 * @param hostname 目标主机名
 */
function hostAllowed(hostname: string): boolean {
  const list = allowedUpstreamHosts();
  if (list.includes('*')) return true;
  const host = hostname.toLowerCase();
  return list.some((entry) => host === entry || host.endsWith(`.${entry}`));
}

/**
 * 把请求体读成 Buffer（Vercel 的 Node 运行时给的是流；本地测试可能直接给对象）。
 * @param body 请求体
 */
async function readBody(body: unknown): Promise<Buffer | null> {  if (body === null || body === undefined) return null;
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  if (typeof body === 'object' && Symbol.asyncIterator in (body as object)) {
    const chunks: Buffer[] = [];
    for await (const chunk of body as AsyncIterable<Buffer | string>) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk);
    }
    return Buffer.concat(chunks);
  }
  try {
    return Buffer.from(JSON.stringify(body), 'utf8');
  } catch {
    return null;
  }
}

/**
 * Buffer → ArrayBuffer（只取这一段，不带底层内存池的多余字节）。
 * @param buf Node Buffer
 */
function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

const handler: ApiHandler = async (req, res) => {
  if (handleOptions(req, res)) return;
  applyCors(req, res);

  if (req.method !== 'POST') {
    sendError(res, 405, '只支持 POST');
    return;
  }

  // 1) 来源校验：防止别人把你的代理当免费转发（代理是公网可访问的）
  if (!isOriginAllowed(req)) {
    console.warn('[ai-proxy] 拒绝非白名单来源（ALLOWED_ORIGIN 里没它）');
    sendError(res, 403, '来源不在白名单内');
    return;
  }

  // 2) 目标地址校验（协议 + 上游主机白名单）
  const targetCheck = checkTarget(readHeader(req.headers, 'x-target-url'));
  if (!targetCheck.ok) {
    console.warn(`[ai-proxy] 拒绝目标地址（${targetCheck.status}）`);
    sendError(res, targetCheck.status, targetCheck.message);
    return;
  }
  const target = targetCheck.url;

  // 3) 密钥必须由客户端带过来（服务器不保存任何密钥，没带就没法转发）
  const authorization = readHeader(req.headers, 'authorization');
  if (authorization === '') {
    sendError(res, 400, '缺少 Authorization 请求头（密钥只由你的浏览器提供，服务器不保存）');
    return;
  }

  // 4) 组装转发头：剥掉属于本代理的头，保留上游需要的
  const headers = new Headers();
  headers.set('Authorization', authorization);
  headers.set('Content-Type', readHeader(req.headers, 'content-type') || 'application/json');
  const accept = readHeader(req.headers, 'accept');
  if (accept !== '') headers.set('Accept', accept);

  const body = await readBody(req.body);
  // 交给 fetch 的 body 用 ArrayBuffer：
  // 纯 Node 类型下 Buffer 本身是合法的 BodyInit，但根 tsconfig（`npx tsc --noEmit` 用的那个）
  // 会把 DOM 的 BodyInit 一起并进来，那时 `Buffer` 和 `Uint8Array` 都不满足 DOM 的 BodyInit
  // （DOM 只认 ArrayBuffer / ArrayBufferView / Blob / string / FormData / URLSearchParams）→ TS2769。
  // ArrayBuffer 是它明确接受的类型，且在两套类型集下都合法。
  const bodyInit: ArrayBuffer | undefined = body === null ? undefined : toArrayBuffer(body);
  let upstreamStarted = false;

  try {
    const upstream = await fetch(target.toString(), {
      method: 'POST',
      headers,
      body: bodyInit,
      signal: AbortSignal.timeout(AI_PROXY_TIMEOUT_MS),
    });

    forwardedCount += 1;
    // ⚠️ 只打一个计数，绝不打印密钥、目标 body 或请求头
    console.info(`[ai-proxy] 第 ${forwardedCount} 次转发，上游状态 ${upstream.status}`);

    // 6) 原样返回上游状态与响应头（去掉 set-cookie，避免把上游会话带回来）
    //    注意：没有转发任何**请求**头给客户端，只转发上游响应头
    upstreamStarted = true;
    res.statusCode = upstream.status;
    upstream.headers.forEach((value, key) => {
      const lower = key.toLowerCase();
      if (lower === 'set-cookie' || lower === 'content-encoding' || lower === 'content-length') return;
      res.setHeader(key, value);
    });
    res.setHeader('Cache-Control', 'no-store');
    applyCors(req, res);

    // 7) 流式透传（SSE 也不缓冲）：直接把上游 body 管道给客户端
    if (upstream.body === null) {
      res.end();
      return;
    }
    await pipeline(Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]), res);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // 上游已经开始返回时不能再改状态码，只能断开（否则会报 "headers already sent"）
    if (upstreamStarted) {
      console.warn('[ai-proxy] 转发中断：', message);
      res.end();
      return;
    }
    console.warn('[ai-proxy] 转发失败：', message);
    sendJson(res, 502, { error: `转发失败：${message}` });
  }
};

export default handler;
