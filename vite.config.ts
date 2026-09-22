import { defineConfig } from 'vite';

/**
 * 版本号在构建时注入（`__APP_VERSION__`）：
 * 取 package.json 的 version + 构建时间戳，所以**每次构建都不一样**，
 * footer 与「关于数据」页能用它判断自己看到的是不是最新部署。
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

/** Vite 配置：base 用相对路径，方便构建产物直接本地打开。 */
export default defineConfig({
  base: './',
  define: {
    __APP_VERSION__: JSON.stringify(buildStamp),
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
        '**/.*.tmpdir/**',
        '**/*.tmp',
        '**/*.tmpdir/**',
        // ★ 资料/：仓库根目录下 1.6 GB 的学习资料（含视频），**与前端源码无关**。
        // 踩过的坑：vite 默认监听整个项目根，抓到被占用的 `generic.mp4` 时
        // FSWatcher 抛 EBUSY → **整个 dev server 直接退出**（用户那边表现为「网页打不开了」）。
        // 不监听它还有两个好处：启动快得多、不会再被大文件拖住。
        '**/资料/**',
      ],
    },
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    sourcemap: true,
  },
});
