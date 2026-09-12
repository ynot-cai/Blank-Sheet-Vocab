/**
 * 本地 API 服务入口：`node api/_dev/server.mjs`（或 `npm run api`）
 *
 * 为什么需要它：`npx vercel dev` 要登录 Vercel，而这个脚本零依赖、零登录，
 * 跑的是**同一套** api/ 处理函数和同一套 SQL。前端 Vite 已把 /api 代理到这里，
 * 所以本地开发体验和线上基本一致（差别只在 Vercel 的边缘层）。
 */
import { loadEnvFiles } from './envFile.mjs';

loadEnvFiles();

// 没配 Turso 就用本地 SQLite 文件，方便先把功能跑通
process.env.TURSO_DATABASE_URL ??= 'file:./.tmp/dev.db';

const { startServer } = await import('./harness.mjs');
startServer(Number(process.env.LOCAL_API_PORT ?? 3000));
