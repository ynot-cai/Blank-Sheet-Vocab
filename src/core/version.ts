/**
 * 应用版本信息（构建时注入）。
 */

/**
 * 构建时间戳（形如 `20260501T0930`）。
 * 用途：判断「我看到的是不是最新部署」——刷新后如果这个值变了，就是新版本。
 */
export function appVersion(): string {
  try {
    return typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev';
  } catch {
    // 没经过构建（例如某些测试环境）时 __APP_VERSION__ 不存在
    return 'dev';
  }
}

/**
 * 版本号的展示形式：`2026-05-01 09:30`。
 */
export function appVersionLabel(): string {
  const raw = appVersion();
  if (raw === 'dev' || raw.length < 13) return raw;
  const y = raw.slice(0, 4);
  const m = raw.slice(4, 6);
  const d = raw.slice(6, 8);
  const hh = raw.slice(9, 11);
  const mm = raw.slice(11, 13);
  return `${y}-${m}-${d} ${hh}:${mm}`;
}
