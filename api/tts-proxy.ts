/**
 * POST /api/tts-proxy —— 无状态 TTS 转发（T4）。
 *
 * 存在意义：浏览器直连 `openapi.youdao.com` 会被 **CORS 拦截**
 * （上游不返回 `Access-Control-Allow-Origin`）。于是由这个函数转发一次。
 *
 * ── 与 /api/ai-proxy 同一套模式，铁律照抄 ──
 * ```
 * 浏览器（本地生成签名）
 *    ↓ POST /api/tts-proxy   （body: 已签好名的完整表单）
 * Vercel 无状态函数
 *    ↓ 原样转发到 TTS_TARGET（默认有道 ttsapi）
 *    ↓ 原样返回音频流
 * 浏览器
 * ```
 *
 * **代理看不到任何密钥**（这也是方案 B 的关键）：
 * - 有道签名的 `appSecret` **只在浏览器端**参与计算，签好名的表单里只有 `sign`；
 * - ❌ 本文件不 import db / inventory（根本不连库）；
 * - ❌ 不读、不存、不打印 `appSecret`，也不存请求体；
 * - ❌ 不缓存（响应带 `Cache-Control: no-store`）；
 * - ❌ 不记录请求内容到日志（只打一行「转发了一次 + 上游状态」）；
 * - ✅ 校验 Origin（与 ai-proxy 一致，避免被人当免费转发用）。
 *
 * ⚠️ 与 ai-proxy 的唯一差别：**上游主机写死/受限于 `TTS_TARGET` 白名单**，
 *    不接受请求头里指定的任意地址 —— TTS 只需要一个固定上游，
 *    留一个「客户端指定目标」的口子等于把 SSRF 面又开一次，没有必要。
 */
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { applyCors, isOriginAllowed, handleOptions } from './_lib/cors.js';
import { optionalEnv } from './_lib/env.js';
import { readHeader, sendError, sendJson } from './_lib/http.js';
import { TTS_PROXY_TIMEOUT_MS } from './_lib/limits.js';
import type { ApiHandler } from './_lib/types.js';

/** 转发次数计数器（**只累计次数**，不保存任何请求内容） */
let forwardedCount = 0;

/**
 * 允许的上游地址（逗号分隔；默认有道 TTS）。
 *
 * 为什么用环境变量而不是写死常量：本地自动化测试要对着
 * `127.0.0.1` 的假上游跑（与 ai-proxy 的白名单例外同一思路），
 * 生产把 `TTS_TARGET` 留空即用默认值。
 */
function allowedTargets(): string[] {
  return optionalEnv('TTS_TARGET', 'https://openapi.youdao.com/ttsapi')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

/**
 * 把请求体读成 Buffer（Vercel 的 Node 运行时给的是流；本地测试可能直接给字符串）。
 * @param body 请求体
 */
async function readBody(body: unknown): Promise<Buffer | null> {
  if (body === null || body === undefined) return null;
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  if (typeof body === 'object' && Symbol.asyncIterator in (body as object)) {
    const chunks: Buffer[] = [];
    for await (const chunk of body as AsyncIterable<Buffer | string>) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk);
    }
    return Buffer.concat(chunks);
  }
  return null;
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
    console.warn('[tts-proxy] 拒绝非白名单来源（ALLOWED_ORIGIN 里没它）');
    sendError(res, 403, '来源不在白名单内');
    return;
  }

  const targets = allowedTargets();
  if (targets.length === 0) {
    sendError(res, 500, '没有配置 TTS 上游地址（TTS_TARGET）');
    return;
  }

  const body = await readBody(req.body);
  if (body === null || body.byteLength === 0) {
    sendError(res, 400, '请求体为空（应当是一个已签好名的 URL 编码表单）');
    return;
  }

  // 2) 组装转发头：**只带 Content-Type**。
  //    为什么不像 ai-proxy 那样转发 Authorization：TTS 的凭据在签名里，
  //    没有任何请求头需要传给上游；少转发一个头就少一处泄露面。
  const headers = new Headers();
  headers.set('Content-Type', readHeader(req.headers, 'content-type') || 'application/x-www-form-urlencoded');

  /**
   * 3) 依次尝试白名单里的上游，第一个「看起来成功」的就返回。
   *
   * 为什么要支持多个：本地测试会配一个假上游；生产只配有道一个。
   * 任何一个上游失败都要能被下一个接管，否则配了两个也白配。
   */
  let lastError = '';
  for (const target of targets) {
    let upstreamStarted = false;
    try {
      const upstream = await fetch(target, {
        method: 'POST',
        headers,
        body: toArrayBuffer(body),
        signal: AbortSignal.timeout(TTS_PROXY_TIMEOUT_MS),
      });

      forwardedCount += 1;
      // ⚠️ 只打计数与状态码，绝不打印 body / 签名 / 任何请求头
      console.info(`[tts-proxy] 第 ${forwardedCount} 次转发，上游状态 ${upstream.status}`);

      upstreamStarted = true;
      res.statusCode = upstream.status;
      upstream.headers.forEach((value, key) => {
        const lower = key.toLowerCase();
        // 去掉编码/长度（透传时长度会变）与 set-cookie（不把上游会话带回来）
        if (lower === 'set-cookie' || lower === 'content-encoding' || lower === 'content-length') return;
        res.setHeader(key, value);
      });
      res.setHeader('Cache-Control', 'no-store');
      applyCors(req, res);

      if (upstream.body === null) {
        res.end();
        return;
      }
      await pipeline(Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]), res);
      return;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      lastError = message;
      // 上游已经开始返回时不能再改状态码，只能断开（否则会报 "headers already sent"）
      if (upstreamStarted) {
        console.warn('[tts-proxy] 转发中断：', message);
        res.end();
        return;
      }
      console.warn('[tts-proxy] 转发失败：', message);
    }
  }

  sendJson(res, 502, { error: `转发失败：${lastError}` });
};

export default handler;
