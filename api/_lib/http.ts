/**
 * 统一的 JSON 响应 + 请求体解析工具。
 */
import type { ApiResponse, HeaderMap } from './types.js';

/** 响应头：不缓存任何 API 结果（同步数据要实时） */
const NO_STORE = 'no-store';

/**
 * 返回一个 JSON 响应。
 * @param res 响应对象
 * @param status HTTP 状态码
 * @param payload 任意可序列化的数据
 */
export function sendJson(res: ApiResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', NO_STORE);
  res.end(JSON.stringify(payload));
}

/**
 * 返回一个脱敏的错误响应。
 * 说明：错误信息只取 message（不含堆栈），避免把 SQL、连接串、表结构泄露出去。
 * @param res 响应对象
 * @param status HTTP 状态码
 * @param message 给前端看的错误说明
 */
export function sendError(res: ApiResponse, status: number, message: string): void {
  sendJson(res, status, { error: message });
}

/**
 * 把 unknown 的请求体解析成普通对象。
 * Vercel 在 Content-Type 是 application/json 时会自动解析 body；
 * 但本地测试脚本/部分客户端可能传字符串，所以两种都兼容。
 * @param body 原始请求体
 * @returns 解析失败返回 null
 */
export function readJsonBody(body: unknown): Record<string, unknown> | null {
  if (body === null || body === undefined) return null;
  if (typeof body === 'string') {
    try {
      const parsed: unknown = JSON.parse(body);
      return isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return isRecord(body) ? body : null;
}

/**
 * 判断是否是「普通对象」（数组/null 都不算）。
 * @param v 待判断的值
 */
export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * 从查询参数里取一个字符串（兼容 Vercel 的 string | string[]）。
 * @param value 查询参数原值
 */
export function firstQueryValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

/**
 * 读一个请求头，只保留字符串形态（数组取第一项，其余返回空串）。
 * @param headers 请求头集合
 * @param name 头名
 */
export function readHeader(headers: HeaderMap, name: string): string {
  const raw = headers[name] ?? headers[name.toLowerCase()];
  if (typeof raw === 'string') return raw.trim();
  if (Array.isArray(raw) && typeof raw[0] === 'string') return raw[0].trim();
  return '';
}
