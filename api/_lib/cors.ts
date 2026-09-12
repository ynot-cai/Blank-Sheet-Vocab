/**
 * 统一 CORS 处理。
 *
 * 说明：Serverless Function 必须自己回 OPTIONS 预检，否则浏览器在跨域场景下
 * （例如本地 `npm run dev` 的前端去连线上 Vercel 的 API）会直接预检失败。
 *
 * 安全：允许来源从环境变量 ALLOWED_ORIGIN 读（逗号分隔可填多个），**不使用 `*`**。
 * 自用工具也要保持这个习惯——代理一旦公网可访问，`*` 就等于给别人白用。
 */
import { allowedOrigins } from './env.js';
import { readHeader } from './http.js';
import type { ApiRequest, ApiResponse } from './types.js';

/** 允许的请求方法 */
const ALLOW_METHODS = 'GET, POST, OPTIONS';
/** 允许的请求头（必须包含 X-Space-Key，否则同步接口的预检会失败） */
const ALLOW_HEADERS = 'Content-Type, X-Space-Key, Authorization, X-Target-Url';
/** 预检结果缓存时间（秒） */
const MAX_AGE = '86400';

/**
 * 取请求的 Origin（没有 Origin 时退回 Referer 的源，方便部分客户端）。
 * @param req 请求
 */
function requestOrigin(req: ApiRequest): string {
  const raw = readHeader(req.headers, 'origin');
  if (raw !== '') return raw.replace(/\/+$/, '');
  const referer = readHeader(req.headers, 'referer');
  if (referer === '') return '';
  try {
    return new URL(referer).origin;
  } catch {
    return '';
  }
}

/** 判断来源是否在白名单里（没有来源的请求视为通过：curl / 服务端调用不属于浏览器跨域） */
function isAllowedOrigin(origin: string, origins: string[]): boolean {
  if (origin === '') return true;
  return origins.includes(origin);
}

/**
 * 给响应补 CORS 头。
 *
 * 注意：**即使来源不在白名单也要回 `Access-Control-Allow-Origin`**，
 * 否则浏览器拿到 403 时不会带 CORS 头，前端只能看到一个语焉不详的跨域错误，
 * 排查时完全不知道是「来源被拒」。
 * @param req 请求
 * @param res 响应
 */
export function applyCors(req: ApiRequest, res: ApiResponse): void {
  const origin = requestOrigin(req);
  if (origin !== '') res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', ALLOW_METHODS);
  res.setHeader('Access-Control-Allow-Headers', ALLOW_HEADERS);
  res.setHeader('Access-Control-Max-Age', MAX_AGE);
}

/**
 * 处理 OPTIONS 预检：是预检就直接结束响应并返回 true。
 * @param req 请求
 * @param res 响应
 */
export function handleOptions(req: ApiRequest, res: ApiResponse): boolean {
  if (req.method !== 'OPTIONS') return false;
  applyCors(req, res);
  res.statusCode = 204;
  res.end();
  return true;
}

/**
 * 校验浏览器来源是否在白名单内（非浏览器请求一律放行）。
 * @param req 请求
 */
export function isOriginAllowed(req: ApiRequest): boolean {
  return isAllowedOrigin(requestOrigin(req), allowedOrigins());
}
