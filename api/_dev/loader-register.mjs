/**
 * Node 的 ESM 加载钩子：让 `import './x.ts'` 以 TypeScript 模块加载。
 *
 * 为什么需要：
 * Node 24 已内置 TypeScript 类型擦除，但它按路径后缀判断模块类型，
 * 认不出 `.ts` 后缀（默认当未知格式），于是报 ERR_UNKNOWN_FILE_EXTENSION。
 * 这里做两件事就够：
 * 1. `resolve` 时把 `.ts` / `.mts` 标记成 `module` 格式；
 * 2. `load` 时告诉 Node 它是 TypeScript（`module-typescript`）。
 *
 * 这个钩子只服务于本地开发脚本（api/_dev），Vercel 构建完全用不到它。
 */
import { register } from 'node:module';

register(new URL('./loader-hooks.mjs', import.meta.url));
