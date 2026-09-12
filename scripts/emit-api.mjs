/**
 * Vercel 产物模拟器（`npm run emit:api`）
 *
 * 为什么需要它：Vercel 部署 api/ 时的真实行为是——**用 Node 的类型擦除把 .ts 变成 .js，
 * 但 import 路径原样保留**（Node 不重写模块说明符）。如果源码里写 `from './_lib/db.ts'`，
 * 产物里就是 `from './_lib/db.ts'`，而磁盘上只有 `db.js` → 线上 500：
 *   ERR_MODULE_NOT_FOUND: Cannot find module '/var/task/api/_lib/db.ts'
 *
 * 这个坑本地一切正常（node 直接跑 .ts 源码、vite 构建也不报错），只有线上会炸。
 * 所以这里把「线上那一步」搬到本地来：真的剥一次类型、写到 .tmp/api-emit/，
 * 再逐个检查产物里的 import 能不能解析到实际存在的文件。
 *
 * 产物只写到 .tmp/（已在 .gitignore 里），不会被提交。
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { stripTypeScriptTypes } from 'node:module';

/** 输出目录（临时，不提交） */
const OUT_ROOT = '.tmp/api-emit';

/**
 * 递归列出目录下所有 .ts 文件。
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

/**
 * 剥掉类型（模拟 Vercel 的编译步骤）。
 * @param {string} file 源文件
 * @param {string} source 源码
 */
function strip(file, source) {
  const mode = file.endsWith('.mts') ? 'module' : 'strip';
  return stripTypeScriptTypes(source, { mode, sourceUrl: file });
}

rmSync(OUT_ROOT, { recursive: true, force: true });

const sources = listTs('api').filter((f) => !f.replace(/\\/g, '/').includes('/_dev/'));
let emitted = 0;

for (const file of sources) {
  const code = strip(file, readFileSync(file, 'utf8'));
  const dest = join(OUT_ROOT, relative('api', file)).replace(/\.ts$/, '.js');
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, code, 'utf8');
  emitted += 1;
}

console.log(`已模拟生成 ${emitted} 个文件 → ${OUT_ROOT}/`);
console.log('（这就是 Vercel 部署 api/ 后 /var/task 里大致的样子，import 路径与源码完全一致）');
