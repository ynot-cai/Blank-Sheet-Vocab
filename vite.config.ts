import { defineConfig } from 'vite';

/**
 * 版本号在构建时注入（`__APP_VERSION__`）：
 * 取 package.json 的 version + 构建时间戳，所以**每次构建都不一样**，
 * footer 与「关于数据」页能用它判断自己看到的是不是最新部署。
 */
const buildStamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');

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
        target: 'http://127.0.0.1:3000',
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
      ],
    },
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    sourcemap: true,
  },
});
