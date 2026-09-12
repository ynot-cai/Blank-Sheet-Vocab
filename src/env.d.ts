/**
 * 全局类型补充（Vite define 注入的常量等）。
 * 这个文件不含运行时代码。
 */

/** 构建时间戳（由 vite.config.ts 的 define 注入，每次构建都不同） */
declare const __APP_VERSION__: string;
