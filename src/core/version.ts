/**
 * 应用版本信息（构建时注入）。
 *
 * ★ 版本 0.0.1 起：本项目的版本号是**三段式 x.x.x 的语义版本**，
 *   它来自 `package.json` 的 `version` 字段（构建时由 vite.config.ts 注入）。
 *   版本规则见 `开发必读/开发规则.md`，历次变更见 `关于项目/版本更新日志.md`。
 *
 * 与「构建时间戳」的分工：
 * - `appVersion()`      → `0.0.1`，回答「这是哪个版本」
 * - `appBuildStamp()`   → `20261015T1955`，回答「这是不是最新部署的那一次构建」
 *   版本号可以不变（例如只改了注释），但每次构建的时间戳一定不同。
 */

/**
 * 三段式语义版本（形如 `0.0.1`）。
 * 没经过构建的环境（某些测试）返回 `'dev'`。
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
 * 构建时间戳（形如 `20261015T1955`）。
 * 用途：判断「我看到的是不是最新部署」——刷新后如果这个值变了，就是新版本。
 */
export function appBuildStamp(): string {
  try {
    return typeof __APP_BUILD__ === 'string' ? __APP_BUILD__ : 'dev';
  } catch {
    return 'dev';
  }
}

/**
 * 构建时间戳的展示形式：`2026-10-15 19:55`。
 */
export function appBuildLabel(): string {
  const raw = appBuildStamp();
  if (raw === 'dev' || raw.length < 13) return raw;
  const y = raw.slice(0, 4);
  const m = raw.slice(4, 6);
  const d = raw.slice(6, 8);
  const hh = raw.slice(9, 11);
  const mm = raw.slice(11, 13);
  return `${y}-${m}-${d} ${hh}:${mm}`;
}

/**
 * 完整版本标签：`版本 0.0.1（构建 2026-10-15 19:55）`。
 */
export function appVersionLabel(): string {
  return `版本 ${appVersion()}（构建 ${appBuildLabel()}）`;
}
