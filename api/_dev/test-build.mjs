/**
 * 构建完整性自检：`npm run test:build`
 *
 * 起因：改代码时把 `import { escapeHtml } from './dom'` 写成了错的相对路径，
 * 类型检查与前面的各项测试**都没发现**（测试用文本断言，且 Node 加载钩子会补扩展名），
 * 最后是 `npm run build` 才炸。这类问题一旦漏到线上就是白屏。
 *
 * 所以这里做三件事：
 * 1. 逐个检查 src / api 下所有相对导入能否解析到真实文件；
 * 2. 检查 vite.config.ts 里 define 的常量确实被声明过（否则运行时报未定义）；
 * 3. 检查资源引用（index.html / manifest）指向的文件真的存在。
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnvFiles } from './envFile.mjs';

loadEnvFiles('..');

let passed = 0;
let failed = 0;

/**
 * 一条断言。
 * @param {string} name 用例名
 * @param {boolean} ok 是否通过
 * @param {string} [detail] 失败时的补充
 */
function check(name, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`);
  }
}

/**
 * 递归列出目录下的文件。
 * @param {string} dir 目录
 * @param {RegExp} filter 文件名过滤
 */
function walk(dir, filter) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full, filter));
    else if (filter.test(name)) out.push(full);
  }
  return out;
}

/**
 * 解析一个相对导入是否指向真实文件。
 * @param {string} fromFile 发起导入的文件
 * @param {string} spec 导入路径
 */
function resolves(fromFile, spec) {
  const base = join(fromFile, '..', spec);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.mjs`,
    join(base, 'index.ts'),
    join(base, 'index.js'),
  ];
  return candidates.some((c) => existsSync(c) && statSync(c).isFile());
}

console.log('\n=== 构建完整性自检 ===\n');

// ─────────────────────────────────────────── 1. 相对导入能否解析
console.log('[1] 所有相对导入都能解析到真实文件');
{
  const files = [...walk('src', /\.ts$/), ...walk('api', /\.(ts|mjs)$/)];
  const broken = [];
  let total = 0;

  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    // 匹配 `from '...'`、`import('...')`、`import '...'`
    const specs = [
      ...text.matchAll(/(?:^|\s)(?:import|export)[\s\S]{0,400}?from\s+['"]([^'"]+)['"]/g),
      ...text.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g),
      ...text.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm),
    ].map((m) => m[1]);

    for (const spec of specs) {
      if (!spec || (!spec.startsWith('./') && !spec.startsWith('../'))) continue;
      total += 1;
      if (!resolves(file, spec)) broken.push(`${file} → ${spec}`);
    }
  }

  check(`检查了 ${total} 个相对导入`, total > 100, `只找到 ${total} 个，可能是解析规则写错了`);
  check('没有解析不到的导入', broken.length === 0, broken.join(' | '));
}

// ─────────────────────────────────────────── 2. define 注入的常量
console.log('\n[2] 构建期注入的常量有类型声明');
{
  const viteConfig = readFileSync('vite.config.ts', 'utf8');
  const defined = [...viteConfig.matchAll(/define:\s*\{([^}]*)\}/g)]
    .flatMap((m) => m[1].split(','))
    .map((pair) => pair.split(':')[0]?.trim())
    .filter((name) => name && name.startsWith('__'));

  check('vite.config.ts 里有 define 注入', defined.length > 0, defined.join(','));
  const dts = `${readFileSync('src/env.d.ts', 'utf8')}`;
  for (const name of defined) {
    check(`${name} 在 src/env.d.ts 里有声明`, dts.includes(`declare const ${name}`), dts.slice(0, 200));
  }
}

// ─────────────────────────────────────────── 3. 资源引用
console.log('\n[3] index.html / manifest 引用的文件都存在');
{
  const html = readFileSync('index.html', 'utf8');
  const refs = [...html.matchAll(/(?:href|src)\s*=\s*["']([^"']+)["']/gi)]
    .map((m) => m[1])
    .filter((u) => u && !u.startsWith('http') && !u.startsWith('data:') && !u.startsWith('/src/'));

  for (const ref of refs) {
    const local = ref.replace(/^\.\//, '').replace(/^\//, '');
    check(`${ref} 存在`, existsSync(join('public', local)) || existsSync(local), `找的是 public/${local}`);
  }

  const manifest = JSON.parse(readFileSync('public/manifest.webmanifest', 'utf8'));
  for (const icon of manifest.icons) {
    const local = icon.src.replace(/^\.\//, '');
    check(`manifest 图标 ${icon.src} 存在`, existsSync(join('public', local)), `找的是 public/${local}`);
  }
}

// ─────────────────────────────────────────── 4. Service Worker 关键行为
console.log('\n[4] Service Worker 不会误伤 API 与跨域');
{
  const sw = readFileSync('public/sw.js', 'utf8');
  check('有同源判断', sw.includes('url.origin !== self.location.origin'));
  check('排除 /api/', sw.includes("url.pathname.includes('/api/')"));
  check('只处理 GET', sw.includes("request.method !== 'GET'"));
  check('导航请求走 Network First', sw.includes('networkFirst'));
  check('静态资源走 Cache First', sw.includes('cacheFirst'));
}

// ─────────────────────────────────────────── 5. 所有页面/组件文件都被引用
console.log('\n[5] 没有「写了但没接上」的孤儿文件');
{
  const all = walk('src', /\.ts$/).map((f) => f.replace(/\\/g, '/'));
  const referenced = new Set();
  for (const file of walk('src', /\.ts$/)) {
    const text = readFileSync(file, 'utf8');
    // 静态导入 + 动态 import()（selftest 就是按需动态加载的）
    const specs = [
      ...[...text.matchAll(/from\s+['"](\.[^'"]+)['"]/g)].map((m) => m[1]),
      ...[...text.matchAll(/import\(\s*['"](\.[^'"]+)['"]\s*\)/g)].map((m) => m[1]),
    ];
    for (const spec of specs) {
      const base = join(file, '..', spec.replace(/\.ts$/, '')).replace(/\\/g, '/');
      referenced.add(base);
    }
  }
  const orphans = all.filter((f) => {
    const noExt = f.replace(/\.ts$/, '');
    if (noExt.endsWith('main') || noExt.endsWith('env.d')) return false; // 入口与全局声明
    return !referenced.has(noExt) && !referenced.has(`${noExt}/index`);
  });
  check('没有未被任何文件引用的模块', orphans.length === 0, orphans.join(', '));
}

/**
 * 读一个 tsconfig 并解析。
 *
 * tsconfig 允许写注释与尾逗号（JSONC），标准 JSON.parse 会直接报错，
 * 所以这里先去掉注释和尾逗号再解析——不为了「能解析」而把配置里的说明删掉。
 * @param {string} file 文件路径
 */
function readTsConfig(file) {
  const raw = readFileSync(file, 'utf8')
    .replace(/^\s*\/\/.*$/gm, '') // 行注释
    .replace(/\/\*[\s\S]*?\*\//g, '') // 块注释
    .replace(/,(\s*[}\]])/g, '$1'); // 尾逗号
  return JSON.parse(raw);
}

// ─────────────────────────────────────────── 6. 类型检查配置的防回归护栏
console.log('\n[6] 类型检查配置：api/ 必须被覆盖，且 .ts 后缀相关开关不能丢');
{
  // 这一组是「有人好心改坏了」的护栏：
  // - 去掉 allowImportingTsExtensions → 立刻一堆 TS5097；
  // - 把 api/**.ts 的 .ts 后缀去掉 → npm run test / api 本地服务全炸（Node 要求显式扩展名）；
  // - 根 tsconfig 变成零文件 → `npx tsc --noEmit` 静默什么都不查（本次踩的坑）。
  const root = readTsConfig('tsconfig.json');
  const api = readTsConfig('tsconfig.api.json');
  const app = readTsConfig('tsconfig.app.json');

  check('根 tsconfig 的 include 覆盖 api', (root.include ?? []).includes('api'), JSON.stringify(root.include));
  check('根 tsconfig 的 include 覆盖 src', (root.include ?? []).includes('src'), JSON.stringify(root.include));
  check('根 tsconfig 不是零文件的 solution 配置', !(root.files?.length === 0 && (root.include ?? []).length === 0));
  check('根 tsconfig 开启 allowImportingTsExtensions', root.compilerOptions?.allowImportingTsExtensions === true);
  check('根 tsconfig 开启 noEmit（allowImportingTsExtensions 的前提）', root.compilerOptions?.noEmit === true);

  check('tsconfig.api.json 的 include 覆盖 api', (api.include ?? []).includes('api'), JSON.stringify(api.include));
  check('tsconfig.api.json 开启 allowImportingTsExtensions', api.compilerOptions?.allowImportingTsExtensions === true);
  check('tsconfig.api.json 只放 Node 类型（看不到 DOM）', !(api.compilerOptions?.types ?? []).includes('vite/client'));
  check('tsconfig.app.json 只放浏览器类型（看不到 Node）', !(app.compilerOptions?.types ?? []).includes('node'));

  // api 下的相对导入必须都带 .ts（Node 直接跑 TS 源码的前提）
  const apiFiles = walk('api', /\.ts$/);
  const missingExt = [];
  let relCount = 0;
  for (const file of apiFiles) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
      const spec = m[1];
      relCount += 1;
      if (!spec.endsWith('.ts')) missingExt.push(`${file} → ${spec}`);
    }
  }
  check(`api 下的 ${relCount} 个相对导入都带 .ts 后缀`, missingExt.length === 0, missingExt.join(' | '));

  // build 脚本必须用 --noEmit 跑 tsc（用户明确要求的第 2 点）
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  check('build 脚本里 tsc 带 --noEmit', /tsc --noEmit/.test(pkg.scripts?.build ?? ''), pkg.scripts?.build);
  check('build 脚本先跑 preflight（esbuild 二进制检查）', /preflight/.test(pkg.scripts?.build ?? ''), pkg.scripts?.build);
  check('有独立的 typecheck:api 脚本', Boolean(pkg.scripts?.['typecheck:api']));
  check('有独立的 typecheck:app 脚本', Boolean(pkg.scripts?.['typecheck:app']));
  check('package.json 里放行了 esbuild 安装脚本', Boolean(pkg.allowScripts?.['esbuild@0.25.12']) || Object.keys(pkg.allowScripts ?? {}).some((k) => k.startsWith('esbuild')));
}

console.log(`\n=== 结果：通过 ${passed} 项，失败 ${failed} 项 ===\n`);
process.exit(failed === 0 ? 0 : 1);
