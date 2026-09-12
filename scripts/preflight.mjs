/**
 * 构建前置检查：`npm run preflight`
 *
 * 在跑 tsc / vite 之前先把「环境本身有问题」和「代码有问题」区分开。
 * 起因：esbuild 的二进制来自平台包（`@esbuild/win32-x64` 这类），
 * 而它自己的 postinstall 脚本可能被 npm 的脚本策略拦下。
 * 那种情况下 `vite build` 会抛一句很难懂的错，让人以为是代码写坏了。
 *
 * 这里逐项检查并给出**可照抄的修复命令**：
 * 1. Node 版本 ≥ 20.6（本项目用 Node 内置的 TypeScript 擦除来跑 api 测试）；
 * 2. `typescript` 可用；
 * 3. `esbuild` 的二进制真的能干活（不是只看文件在不在）；
 * 4. `vite` 可用。
 */
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';

const require = createRequire(import.meta.url);

/** Node 最低版本：需要内置的 --experimental-strip-types 行为（20.6 起有雏形，22+ 稳定） */
const MIN_NODE = [20, 6];

let failed = 0;

/**
 * 打印一项检查结果。
 * @param {string} label 检查项
 * @param {boolean} ok 是否通过
 * @param {string} [detail] 补充说明
 */
function report(label, ok, detail = '') {
  const mark = ok ? '✓' : '✗';
  console.log(`  ${mark} ${label}${detail ? ` —— ${detail}` : ''}`);
  if (!ok) failed += 1;
}

console.log('\n=== 构建前置检查 ===\n');

// ── 1. Node 版本 ──
{
  const cur = process.versions.node.split('.').map(Number);
  const ok =
    cur[0] > MIN_NODE[0] || (cur[0] === MIN_NODE[0] && (cur[1] ?? 0) >= MIN_NODE[1]);
  report(
    `Node 版本 ≥ ${MIN_NODE.join('.')}`,
    ok,
    `当前 v${process.versions.node}${ok ? '' : '（api/ 的测试靠 Node 内置类型擦除跑 TS，版本太低会失败）'}`,
  );
}

// ── 2. TypeScript ──
{
  try {
    const ts = require('typescript');
    report('typescript 可用', true, `v${ts.version}`);
  } catch (err) {
    report('typescript 可用', false, `装上它：npm install    (${err instanceof Error ? err.message : err})`);
  }
}

// ── 3. esbuild 二进制真的能干活 ──
{
  let version = '';
  let ok = false;
  let how = '';
  try {
    const esbuild = require('esbuild');
    version = esbuild.version;
    // 真正跑一次编译：只检查文件在不在是不够的，缺二进制时 require 能过、transform 会炸
    const out = esbuild.transformSync('let n: number = 1', { loader: 'ts' });
    ok = out.code.includes('let n = 1');
    how = 'transform 调用成功';
  } catch (err) {
    how = err instanceof Error ? err.message.split('\n')[0] : String(err);
  }
  report('esbuild 能用（二进制已就位）', ok, ok ? `v${version}，${how}` : how);

  if (!ok) {
    console.log('');
    console.log('  修复命令（照抄即可）：');
    console.log('    npm install-scripts ls                 # 看待审的安装脚本');
    console.log('    npm install-scripts approve esbuild    # 放行 esbuild');
    console.log('    npm rebuild esbuild                    # 补跑它的 postinstall');
    console.log('    还是不行就：rmdir /s /q node_modules && npm install');
    console.log('');
    console.log('  说明：esbuild 的二进制其实来自平台包 @esbuild/win32-x64，');
    console.log('  通常 npm install 时就已经装好了，postinstall 被拦也不影响使用。');
  }
}

// ── 4. vite ──
{
  try {
    require('vite');
    report('vite 可用', true);
  } catch (err) {
    report('vite 可用', false, err instanceof Error ? err.message.split('\n')[0] : String(err));
  }
}

// ── 5. 关键配置文件在位 ──
{
  for (const file of ['tsconfig.json', 'tsconfig.app.json', 'tsconfig.api.json', 'vite.config.ts']) {
    report(`配置文件存在：${file}`, existsSync(file));
  }
}

console.log('');
if (failed > 0) {
  console.log(`前置检查未通过（${failed} 项）。请先按上面的提示修复，再跑构建。\n`);
  process.exit(1);
}
console.log('前置检查全部通过，可以开始构建。\n');
