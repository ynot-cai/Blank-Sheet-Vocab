/**
 * 加载钩子实现（被 loader-register.mjs 注册）。
 * 目的：让 node 直接跑本项目里的 TypeScript 源码（api/**.ts 与 src/**.ts）。
 *
 * 做两件事：
 * 1. `.ts` / `.mts` 标记成 `module-typescript`，交给 Node 内置的类型擦除；
 * 2. **把 `.js` 说明符映射回同名 `.ts`**：api/ 的源码按 TypeScript ESM 的标准写法
 *    写 `from './_lib/db.js'`，原因是线上 Vercel 会把 .ts 剥成 .js，
 *    而 Node 的类型擦除**不重写 import 路径**——源码写 .ts，线上就会
 *    ERR_MODULE_NOT_FOUND（这个坑已经踩过一次，见 scripts/emit-api.mjs）。
 *    但本地源码里只有 `db.ts`，所以这里补一层 `.js` → `.ts` 的映射。
 *    顺带也支持**不带扩展名**的写法（src/ 里的相对导入就是这样，按 .ts → .tsx → .mts → .js 找）。
 */

/** 补扩展名时依次尝试的后缀 */
const EXTENSIONS = ['.ts', '.tsx', '.mts', '.js'];

/**
 * 尝试解析一个候选说明符，失败返回 null（不抛）。
 * @param {string} specifier 说明符
 * @param {object} context 解析上下文
 * @param {(s: string, c: object) => Promise<object>} nextResolve 下一环解析器
 */
async function tryResolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch {
    return null;
  }
}

/**
 * 解析模块：`.js` → 同名 `.ts` 映射 + 无扩展名时补后缀。
 * @param {string} specifier 导入路径
 * @param {object} context 解析上下文
 * @param {(s: string, c: object) => Promise<object>} nextResolve 下一环解析器
 */
export async function resolve(specifier, context, nextResolve) {
  let result = await tryResolve(specifier, context);

  const isRelative = specifier.startsWith('./') || specifier.startsWith('../') || specifier.startsWith('/');
  if (result === null && isRelative) {
    // 情况一：`.js` 说明符 → 试同名 `.ts`（只在原样解析失败时才试，
    // 这样构建产物里的真 .js 会优先命中，不会被源码顶掉）
    if (/\.js$/.test(specifier)) {
      result = await tryResolve(`${specifier.slice(0, -3)}.ts`, context, nextResolve);
    }
    // 情况二：完全不带扩展名 → 依次补后缀
    if (result === null && !/\.[cm]?[jt]s$/.test(specifier)) {
      for (const ext of EXTENSIONS) {
        result = await tryResolve(`${specifier}${ext}`, context, nextResolve);
        if (result !== null) break;
      }
    }
  }

  // 都不行就把原始错误抛出来（错误信息更准确）
  if (result === null) return nextResolve(specifier, context);

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
