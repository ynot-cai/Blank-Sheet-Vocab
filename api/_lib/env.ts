/**
 * 环境变量读取（集中一处，缺变量时报明确错误，方便在 Vercel 日志里排查）。
 *
 * 真实值不写进代码：本地放 `.env.local`（已被 .gitignore 忽略），
 * 线上在 Vercel 项目 Settings → Environment Variables 里填。
 */

/**
 * 取一个必填环境变量。
 * @param name 变量名
 * @throws 变量缺失或为空时抛出，错误信息只提变量名，不含任何值
 */
export function requiredEnv(name: string): string {
  const value = process.env[name];
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`环境变量 ${name} 未设置`);
  return value.trim();
}

/**
 * 取一个可选环境变量。
 * @param name 变量名
 * @param fallback 默认值
 */
export function optionalEnv(name: string, fallback: string): string {
  const value = process.env[name];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback;
}

/**
 * 允许访问 API 的来源白名单（逗号分隔）。
 * 默认只允许本地开发的前端地址；线上必须把 Vercel 域名填进 ALLOWED_ORIGIN。
 */
export function allowedOrigins(): string[] {
  return optionalEnv('ALLOWED_ORIGIN', 'http://localhost:5173')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter((s) => s !== '');
}

/**
 * AI 代理允许转发的**上游主机**白名单（逗号分隔，`*` 表示不限制）。
 *
 * 为什么要有它：代理是公网可访问的，如果不限制目标，
 * 别人的网页就能拿它当跳板去请求任意内网服务（SSRF）。
 * 自用场景建议填自己实际用的 AI 服务域名，例如：
 *   AI_ALLOWED_HOSTS=api.deepseek.com
 * 留空或不填 = `*`（不限制，只在本地开发方便）。
 */
export function allowedUpstreamHosts(): string[] {
  return optionalEnv('AI_ALLOWED_HOSTS', '*')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s !== '');
}
