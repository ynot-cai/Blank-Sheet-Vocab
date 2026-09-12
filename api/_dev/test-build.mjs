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

console.log(`\n=== 结果：通过 ${passed} 项，失败 ${failed} 项 ===\n`);
process.exit(failed === 0 ? 0 : 1);
