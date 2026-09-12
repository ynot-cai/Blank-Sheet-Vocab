/**
 * 校验 Vercel 产物（`.tmp/api-emit/`）里每一个相对 import 都能解析到真实文件。
 *
 * 这是「线上 500」那类问题的本地探测器：
 * 只要产物里有 `from './x.ts'` 而磁盘上是 `x.js`，这里就会报出来。
 * 由 `npm run emit:api` 生成产物，再由本脚本检查（两者都在 test:build 里跑）。
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';

/** 产物目录 */
const EMIT_DIR = '.tmp/api-emit';

/**
 * 递归列出所有 .js 文件。
 * @param {string} dir 目录
 */
function listJs(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listJs(full));
    else if (name.endsWith('.js')) out.push(full);
  }
  return out;
}

if (!existsSync(EMIT_DIR)) {
  console.error(`❌ 找不到产物目录 ${EMIT_DIR}，请先跑 npm run emit:api`);
  process.exit(1);
}

const files = listJs(EMIT_DIR);
let total = 0;
const broken = [];
/** 记录产物里还残留的 .ts 说明符（这正是线上崩溃的直接原因） */
const tsSpecifiers = [];

for (const file of files) {
  const code = readFileSync(file, 'utf8');
  for (const m of code.matchAll(/(?:from\s+|import\(\s*)['"](\.[^'"]+)['"]/g)) {
    const spec = m[1];
    total += 1;
    if (spec.endsWith('.ts')) tsSpecifiers.push(`${file} → ${spec}`);
    const target = resolve(dirname(file), spec);
    if (!existsSync(target)) broken.push(`${file} → ${spec}`);
  }
}

console.log(`检查 ${files.length} 个产物文件，共 ${total} 处相对导入`);
console.log('');

let failed = 0;

if (tsSpecifiers.length > 0) {
  failed += 1;
  console.log(`✗ 产物里还有 ${tsSpecifiers.length} 处 .ts 说明符（线上会 ERR_MODULE_NOT_FOUND）：`);
  for (const item of tsSpecifiers.slice(0, 10)) console.log(`    ${item}`);
  console.log('  修复：源码里的相对导入要写 .js 后缀，见 scripts/fix-api-extensions.mjs 顶部注释');
} else {
  console.log('✓ 产物里没有任何 .ts 说明符');
}

if (broken.length > 0) {
  failed += 1;
  console.log(`✗ 有 ${broken.length} 处导入解析不到真实文件：`);
  for (const item of broken.slice(0, 10)) console.log(`    ${item}`);
} else {
  console.log('✓ 所有相对导入都能解析到真实文件');
}

console.log('');
if (failed > 0) {
  console.log('产物校验未通过 —— 部署上去一定会 500，先修好再推。\n');
  process.exit(1);
}
console.log('产物校验通过：这份代码部署到 Vercel 能正常加载。\n');
