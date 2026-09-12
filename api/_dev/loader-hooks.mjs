/**
 * 加载钩子实现（被 loader-register.mjs 注册）。
 * 目的：让 node 直接跑本项目里的 TypeScript 源码（api/**.ts 与 src/**.ts）。
 *
 * 做两件事：
 * 1. `.ts` / `.mts` 标记成 `module-typescript`，交给 Node 内置的类型擦除；
 * 2. **补扩展名**：前端源码（src/）里的相对导入是不带扩展名的（Vite 能解析），
 *    但 Node 的 ESM 解析器要求显式扩展名，所以这里按 .ts → .tsx → .js 的顺序补一遍。
 */

/** 补扩展名时依次尝试的后缀 */
const EXTENSIONS = ['.ts', '.tsx', '.mts', '.js'];

/**
 * 解析模块：`.ts` / `.mts` 按 ESM 格式处理，并补上正确的扩展名。
 * @param {string} specifier 导入路径
 * @param {object} context 解析上下文
 * @param {(s: string, c: object) => Promise<object>} nextResolve 下一环解析器
 */
export async function resolve(specifier, context, nextResolve) {
  // 1) 直接解析（api/ 里都写了扩展名，走这条路）
  let result;
  try {
    result = await nextResolve(specifier, context);
  } catch (err) {
    // 2) 失败且是相对/绝对路径 → 轮流补扩展名再试
    const isRelative = specifier.startsWith('./') || specifier.startsWith('../') || specifier.startsWith('/');
    if (!isRelative || !(err && err.code === 'ERR_MODULE_NOT_FOUND')) throw err;
    for (const ext of EXTENSIONS) {
      try {
        result = await nextResolve(`${specifier}${ext}`, context);
        break;
      } catch {
        /* 继续试下一个后缀 */
      }
    }
    if (!result) throw err;
  }

  if (result.format == null && /\.(m?ts|tsx)$/.test(new URL(result.url).pathname)) {
    return { ...result, format: 'module-typescript' };
  }
  return result;
}

/**
 * 加载模块源码：交给 Node 内置的类型擦除。
 * @param {string} url 模块地址
 * @param {object} context 加载上下文
 * @param {(u: string, c: object) => Promise<object>} nextLoad 下一环加载器
 */
export async function load(url, context, nextLoad) {
  if (/\.(m?ts|tsx)$/.test(new URL(url).pathname)) {
    return nextLoad(url, { ...context, format: 'module-typescript' });
  }
  return nextLoad(url, context);
}
