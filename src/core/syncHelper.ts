/**
 * 同步用到的小工具：哈希、地址拼接、时间显示。
 *
 * **安全说明（改代码前必读）**：
 * 明文同步码只存在这台设备的浏览器里（设置 → 云同步 → 同步码，落在 IndexedDB 里）。
 * 发请求前先在这里做 SHA-256，请求头 `X-Space-Key` 带的是**哈希**，
 * 服务器全程不知道明文同步码，数据库里也只存哈希。
 */

/**
 * 计算 SHA-256（Web Crypto），返回 64 位小写十六进制。
 * @param text 原文
 */
export async function sha256(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  // 部分老浏览器/非安全上下文没有 crypto.subtle（HTTP 下会是 undefined）
  if (typeof crypto === 'undefined' || !crypto.subtle) {
    throw new Error('当前环境不支持 Web Crypto，需要 HTTPS 或 localhost 才能用云同步');
  }
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * 同步码 → spaceKey（服务器用它隔离数据空间，只存哈希）。
 * @param syncCode 明文同步码
 */
export function getSpaceKey(syncCode: string): Promise<string> {
  return sha256(syncCode.trim());
}

/**
 * 拼接 API 地址：用户只填域名，路径由代码补，避免各人填法不一。
 * @param apiBase 后端地址，如 `https://blank-sheet-vocab.vercel.app`（可带结尾斜杠）
 * @param path 接口路径，如 `/api/sync-pull`（路径集中定义在 `src/dao/syncServer.ts` 的 `API_ROUTES`）
 */
export function apiUrl(apiBase: string, path: string): string {
  const base = apiBase.trim().replace(/\/+$/, '');
  return `${base}${path}`;
}

/**
 * 规范化后端地址：去掉结尾斜杠、去掉误填的 `/api` 后缀。
 * @param raw 用户填的地址
 */
export function normalizeApiBase(raw: string): string {
  return raw
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/api$/i, '');
}

/**
 * 同步码是否可用（至少 8 位、必须含字母和数字）。
 * @param code 同步码
 * @param minLength 最短长度
 */
export function isSyncCodeValid(code: string, minLength: number): boolean {
  const trimmed = code.trim();
  if (trimmed.length < minLength) return false;
  return /[a-z]/i.test(trimmed) && /\d/.test(trimmed);
}

/**
 * 把时间戳转成「3 分钟前」这种相对时间。
 * @param ts 时间戳（0 表示从未）
 */
export function relativeTime(ts: number): string {
  if (!ts) return '从未同步';
  const diff = Date.now() - ts;
  if (diff < 0) return '刚刚';
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${Math.max(sec, 1)} 秒前`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  const day = Math.floor(hour / 24);
  if (day < 30) return `${day} 天前`;
  return new Date(ts).toLocaleDateString();
}
