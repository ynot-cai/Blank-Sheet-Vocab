/**
 * 一次性迁移脚本：把 api/**\/*.ts 里相对导入的 `.ts` 后缀改成 `.js`。
 *
 * 为什么必须改（血泪教训，别再改回去）：
 * Vercel 部署 api/ 时用 Node 的类型擦除把 .ts 变成 .js，**但不重写 import 路径**。
 * 源码写 `from './_lib/db.ts'` → 线上产物还是找 `db.ts` → 磁盘上只有 `db.js` → 500。
 *
 * 为什么改成 .js 而不是「去掉后缀」：
 * - `.js` 是 TypeScript ESM 的标准写法（NodeNext / bundler 都支持），
 *   产物里路径与文件名天然一致，不需要任何运行时魔法；
 * - 「去掉后缀」在 Node 的 ESM 下不合法（ERR_MODULE_NOT_FOUND），
 *   而且 Vercel 的产物也不保证能解析。
 *
 * 本地由 api/_dev/loader-hooks.mjs 把 `.js` 映射回同名 `.ts`，所以测试照样能跑。
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 递归列出目录下的 .ts 文件。
 * @param {string} dir 目录
 */
function listTs(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listTs(full));
    else if (name.endsWith('.ts')) out.push(full);
  }
  return out;
}

let changedFiles = 0;
let changedSpecs = 0;

for (const file of listTs('api')) {
  const before = readFileSync(file, 'utf8');
  // 只改「以 .ts 结尾的相对说明符」，不碰包名（如 '@libsql/client'）
  const after = before.replace(
    /(from\s+|import\(\s*)(['"])(\.{1,2}\/[^'"]+)\.ts\2/g,
    (match, prefix, quote, spec) => {
      changedSpecs += 1;
      return `${prefix}${quote}${spec}.js${quote}`;
    },
  );
  if (after !== before) {
    writeFileSync(file, after, 'utf8');
    changedFiles += 1;
    console.log(`  改：${file}`);
  }
}

console.log('');
console.log(`一共修改 ${changedFiles} 个文件，${changedSpecs} 处 import`);
console.log('（.ts → .js：这是 Vercel/Node ESM 下唯一能跑通的写法）');
