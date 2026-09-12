/**
 * 同步码校验：从请求头 `X-Space-Key` 取出 spaceKey。
 *
 * **安全前提（必须牢记）**：这里拿到的是 `SHA-256(同步码)` 的十六进制字符串。
 * 明文同步码只存在于用户自己的浏览器里（localStorage / IndexedDB），
 * 服务器全程不接收、不存储、不打印明文——所以数据库被拖走也推不出同步码。
 *
 * 客户端上传前先做哈希，所以这里只接受 64 位十六进制。
 */
import type { ApiRequest } from './types.ts';

/** spaceKey 的合法格式：SHA-256 的十六进制表示 */
const SPACE_KEY_RE = /^[0-9a-f]{64}$/i;

/** spaceKey 非法时抛的错误（附带 HTTP 状态码，交给处理函数统一转成响应） */
export class SpaceKeyError extends Error {
  /** HTTP 状态码 */
  readonly status: number;

  /**
   * @param message 错误说明
   * @param status HTTP 状态码
   */
  constructor(message: string, status = 401) {
    super(message);
    this.name = 'SpaceKeyError';
    this.status = status;
  }
}

/**
 * 读一个请求头，只保留字符串形态。
 * Vercel 会把头名规范化成小写，所以先查小写、再兜底查原文（本地测试脚本可能不规范化）。
 * @param req 请求
 * @param name 头名
 */
function readHeader(req: ApiRequest, name: string): string {
  const raw = req.headers[name] ?? req.headers[name.toLowerCase()];
  if (typeof raw === 'string') return raw.trim();
  if (Array.isArray(raw) && typeof raw[0] === 'string') return raw[0].trim();
  return '';
}

/**
 * 读请求头里的 spaceKey（不做校验，可能返回空串）。
 * @param req 请求
 */
export function getSpaceKey(req: ApiRequest): string {
  return readHeader(req, 'x-space-key');
}

/**
 * 取并校验 spaceKey；缺失或非法时抛 SpaceKeyError（HTTP 401）。
 * @param req 请求
 * @throws SpaceKeyError
 */
export function requireSpaceKey(req: ApiRequest): string {
  const key = getSpaceKey(req);
  if (key === '') throw new SpaceKeyError('缺少 X-Space-Key 请求头', 401);
  if (!SPACE_KEY_RE.test(key)) {
    throw new SpaceKeyError('X-Space-Key 必须是同步码的 SHA-256 哈希（64 位十六进制）', 401);
  }
  return key.toLowerCase();
}

/**
 * 日志用的 spaceKey 缩写：**最多前 8 位**，绝不打印完整值。
 * @param spaceKey 完整 spaceKey
 */
export function spaceKeyHint(spaceKey: string): string {
  return `${spaceKey.slice(0, 8)}…`;
}
