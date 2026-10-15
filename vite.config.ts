import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';

/**
 * 版本号（三段式 x.x.x）从 package.json 读，构建时注入 `__APP_VERSION__`。
 *
 * ★ 版本 0.0.1 起采用三段式版本管理（规则见 开发必读/开发规则.md）：
 *   第一段大版本由用户指定；第二段小版本在用户要求「上传 git 仓库」时 +1；
 *   第三段小小版本每次对话 +1。每当上层版本 +1，下层版本清零。
 */
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

/**
 * 构建时间戳（形如 `20261015T1955`）。
 * 用途：判断「我看到的是不是最新部署」——刷新后如果这个值变了，就是新版本。
 */
const buildStamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');

/**
 * 本地 API 服务的端口。
 *
 * 默认 3000（`npm run api` / `npx vercel dev` 的默认端口）。
 * 之所以做成可覆盖：端到端验收（`api/_dev/test-*.mjs`）需要**同时**起
 * 一个 vite dev 和一个独立的 API 服务，而 3000 可能被开发中的服务占着 ——
 * 抢占端口会让测试间歇性失败（而且失败原因看起来像功能坏了）。
 * 用 `LOCAL_API_PORT` 与 `npm run api` 保持一致（同一个变量控制两端）。
 */
const apiPort = Number(process.env.LOCAL_API_PORT ?? 3000);

/**
 * Vite 配置：base 用相对路径，方便构建产物直接本地打开。
 *
 * ⚠️ `define` 对象里**不许写注释**：`api/_dev/test-build.mjs` 用
 * `/define:\s*\{([^}]*)\}/` 把这一段抠出来，再按逗号切、取每项 `:` 前的名字，
 * 要求每个名字以 `__` 开头并在 `src/env.d.ts` 里有 `declare const`。
 * 注释会被当成「第一项」的名字，导致护栏报「vite.config.ts 里有 define 注入」为假。
 */
export default defineConfig({
  base: './',
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __APP_BUILD__: JSON.stringify(buildStamp),
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: false,
    open: false,
    // 本地把 /api 代理给后端，和线上「前端和 API 同源」的形态一致，
    // 因此本地开发也不会碰到跨域问题。后端可以是：
    //   npm run api          → 零依赖本地 API（api/_dev/server.mjs）
    //   npx vercel dev       → 官方开发服务器（默认也是 3000 端口）
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${apiPort}`,
        changeOrigin: true,
      },
    },
    watch: {
      // 忽略非源码目录与「编辑器临时文件」。
      // 有些编辑器/工具保存文件时会先写 `.<name>.<pid>.<uuid>.tmpdir/<name>.tmp` 再改名，
      // 这类临时文件常被占用（EBUSY），一旦被文件监听器抓到会直接把 dev server 打挂。
      ignored: [
        '**/.npm-cache/**',
        '**/.git/**',
        '**/dist/**',
        '**/node_modules/**',
        '**/blank-sheet-vocab-proxy/**', // 独立小项目，不属于前端源码
        '**/已归档/**', // 归档文档（大段源码引用，不需要热更新）
        '**/.*.tmpdir/**',
        '**/*.tmp',
        '**/*.tmpdir/**',
      ],
    },
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    sourcemap: true,
  },
});
