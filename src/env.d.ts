/**
 * 全局类型补充（Vite define 注入的常量等）。
 * 这个文件不含运行时代码。
 */

/** 构建时间戳（由 vite.config.ts 的 define 注入，每次构建都不同） */
declare const __APP_VERSION__: string;

/**
 * `?url` 后缀的模块导入（R1 的 PDF worker 用到）。
 *
 * Vite 会把带 `?url` 的导入替换成**该资源的 URL 字符串**，
 * 但 `vite/client` 的类型声明只覆盖了 `?raw` / `?worker` 等少数后缀，
 * 没有 `?url`——不补这一句，`import x from '...?url'` 会报「找不到模块」。
 *
 * 注意：`.mjs?url` 这种「扩展名 + 后缀」的组合必须单独声明，
 * 因为 TS 的模块匹配是**按完整说明符**做的，通配 `*?url` 匹配不到带扩展名的路径。
 */
declare module '*?url' {
  const src: string;
  export default src;
}
