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
import { join, dirname, resolve } from 'node:path';
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
 *
 * 注意 `.js` → `.ts` 这一层：api/ 的源码里相对导入写的是 `.js`（TS 的 ESM 标准写法，
 * 因为线上 Vercel 会把 .ts 剥成 .js 且不改 import 路径），而源码文件本身是 `.ts`。
 * 所以 `./db.js` 要判成「能找到 db.ts」才算合法。
 * @param {string} fromFile 发起导入的文件
 * @param {string} spec 导入路径
 */
function resolves(fromFile, spec) {
  const base = join(fromFile, '..', spec);
  const stripJs = base.endsWith('.js') ? base.slice(0, -3) : '';
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.mjs`,
    stripJs !== '' ? `${stripJs}.ts` : '',
    stripJs !== '' ? `${stripJs}.tsx` : '',
    join(base, 'index.ts'),
    join(base, 'index.js'),
  ].filter((c) => c !== '');
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
    //
    // ★ 正则必须**锚定行首**，不能写成 /(?:^|\s)import[\s\S]{0,400}?from/
    //   那种松散写法：代码里出现「import」这个词的地方太多了
    //   （中文注释「这个文件不许 import 任何东西」、断言字符串里也有），
    //   松散正则会把注释/字符串里的话题当成导入语句，
    //   然后报出一个**根本不存在的坏路径**——这个坑真的踩过：
    //   护栏报 `→ ./senseRules` 解析失败，查了半天发现是注释里提了一句 import。
    //   锚定行首之后，只有真正的语句级导入会被匹配到；副作用是
    //   「已经写了对、只是缩进很深的导入」不会被检查，这是可以接受的取舍。
    const specs = [
      ...text.matchAll(/^[ \t]*(?:import|export)[\s\S]*?from[ \t]*['"]([^'"]+)['"]/gm),
      ...text.matchAll(/^[ \t]*import[ \t]*['"]([^'"]+)['"]/gm),
      ...text.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g),
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
  check('根 tsconfig 开启 noEmit', root.compilerOptions?.noEmit === true);

  check('tsconfig.api.json 的 include 覆盖 api', (api.include ?? []).includes('api'), JSON.stringify(api.include));
  check('tsconfig.api.json 只放 Node 类型（看不到 DOM）', !(api.compilerOptions?.types ?? []).includes('vite/client'));
  check('tsconfig.app.json 只放浏览器类型（看不到 Node）', !(app.compilerOptions?.types ?? []).includes('node'));

  // ⚠️ 这条规则被线上 500 教过一次（详见 scripts/emit-api.mjs 顶部注释）：
  // Vercel 用 Node 的类型擦除把 .ts 变成 .js，**但不重写 import 路径**。
  // 所以被部署的源码（api/*.ts 与 api/_lib/*.ts）里，相对导入必须写 .js 后缀。
  // 只有 api/_dev/（本地工具，不部署）才允许写 .ts。
  const deployedFiles = [
    ...walk('api', /\.ts$/).filter((f) => !f.replace(/\\/g, '/').includes('/_dev/')),
  ];
  const wrongExt = [];
  let relCount = 0;
  for (const file of deployedFiles) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/(?:from\s+|import\(\s*)['"](\.[^'"]+)['"]/g)) {
      const spec = m[1];
      relCount += 1;
      if (!spec.endsWith('.js')) wrongExt.push(`${file} → ${spec}`);
    }
  }
  check(
    `被部署的 api 源码 ${relCount} 个相对导入都写 .js 后缀`,
    wrongExt.length === 0,
    `${wrongExt.slice(0, 5).join(' | ')}${wrongExt.length > 5 ? ` …共 ${wrongExt.length} 处` : ''}`,
  );

  // build 脚本必须用 --noEmit 跑 tsc
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  check('build 脚本里 tsc 带 --noEmit', /tsc --noEmit/.test(pkg.scripts?.build ?? ''), pkg.scripts?.build);
  check('build 脚本先跑 preflight（esbuild 二进制检查）', /preflight/.test(pkg.scripts?.build ?? ''), pkg.scripts?.build);
  check('有独立的 typecheck:api 脚本', Boolean(pkg.scripts?.['typecheck:api']));
  check('有独立的 typecheck:app 脚本', Boolean(pkg.scripts?.['typecheck:app']));
  check(
    'package.json 里放行了 esbuild 安装脚本',
    Boolean(pkg.allowScripts?.['esbuild@0.25.12']) ||
      Object.keys(pkg.allowScripts ?? {}).some((k) => k.startsWith('esbuild')),
  );
  check('有 verify:api 脚本（模拟 Vercel 产物并校验）', Boolean(pkg.scripts?.['verify:api']));
}

// ─────────────────────────────────────────── 7. Vercel 产物模拟（线上 500 的本地探测器）
console.log('\n[7] 模拟 Vercel 产物：每个 import 都要能解析到真实文件');
{
  const { execFileSync } = await import('node:child_process');
  const emitDir = '.tmp/api-emit';
  let emitOk = true;
  let emitErr = '';
  try {
    execFileSync(process.execPath, ['scripts/emit-api.mjs'], { stdio: 'pipe' });
  } catch (err) {
    emitOk = false;
    emitErr = err instanceof Error ? err.message : String(err);
  }
  check('能生成 Vercel 产物（剥类型后的 .js）', emitOk, emitErr);

  if (emitOk && existsSync(emitDir)) {
    const jsFiles = [];
    const collect = (dir) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) collect(full);
        else if (name.endsWith('.js')) jsFiles.push(full);
      }
    };
    collect(emitDir);

    const broken = [];
    const tsSpecs = [];
    let specCount = 0;
    for (const file of jsFiles) {
      const code = readFileSync(file, 'utf8');
      for (const m of code.matchAll(/(?:from\s+|import\(\s*)['"](\.[^'"]+)['"]/g)) {
        const spec = m[1];
        specCount += 1;
        if (spec.endsWith('.ts')) tsSpecs.push(`${file} → ${spec}`);
        if (!existsSync(resolve(dirname(file), spec))) broken.push(`${file} → ${spec}`);
      }
    }
    check(`产物里 ${specCount} 个相对导入没有 .ts 说明符`, tsSpecs.length === 0, tsSpecs.slice(0, 5).join(' | '));
    check('产物里所有相对导入都能解析', broken.length === 0, broken.slice(0, 5).join(' | '));

    // 真的把产物跑起来：能加载就算过（不期望它成功处理请求，只要求模块能 import 成功）
    let runnable = true;
    let runErr = '';
    try {
      execFileSync(process.execPath, [join(emitDir, 'health.js')], { stdio: 'pipe', timeout: 20_000 });
    } catch (err) {
      const out = `${err.stdout ?? ''}${err.stderr ?? ''}`;
      // 只加载模块时不该有 ERR_MODULE_NOT_FOUND
      if (String(out).includes('ERR_MODULE_NOT_FOUND') || String(err.message).includes('ERR_MODULE_NOT_FOUND')) {
        runnable = false;
        runErr = 'ERR_MODULE_NOT_FOUND';
      }
    }
    check('产物能被 node 真正加载（不再 ERR_MODULE_NOT_FOUND）', runnable, runErr);
  }
}

// ─────────────────────────────────────────── 8. 前端路由表与 api/ 文件必须一一对应
console.log('\n[8] 前端 API 路由表与 api/ 真实文件对应（防止再次 404）');
{
  // 这条护栏来自线上事故：Vercel 把 api/ 下的文件名映射成路由，
  // api/sync-pull.ts → /api/sync-pull。前端一度写成 /api/sync-pull，
  // 线上一直 404（表现是「同步不了」），而所有本地测试都测不出来——
  // 因为测试是直接调用处理函数、不走 URL 匹配。
  const syncServer = readFileSync('src/dao/syncServer.ts', 'utf8');
  const block = /export const API_ROUTES = \{([\s\S]*?)\} as const/.exec(syncServer);
  check('能读到 API_ROUTES 路由表', block !== null);

  if (block) {
    const entries = [...block[1].matchAll(/(\w+):\s*'([^']+)'/g)].map((m) => ({ key: m[1], path: m[2] }));
    check('路由表不为空', entries.length >= 4, `只有 ${entries.length} 条`);

    const missing = [];
    for (const { key, path } of entries) {
      // '/api/sync-pull' → api/sync-pull.ts
      check(`路由 ${key} 用 /api/ 前缀`, path.startsWith('/api/'), path);
      const file = `api/${path.replace(/^\/api\//, '')}.ts`;
      if (!existsSync(file)) missing.push(`${key} → ${path}（缺 ${file}）`);
    }
    check('每个路由都能对应到 api/ 下的真实文件', missing.length === 0, missing.join(' | '));

    // 反向：api/ 下每个被部署的处理器都必须在路由表里（避免写了没人用 / 漏改）
    const handlers = readdirSync('api')
      .filter((f) => f.endsWith('.ts'))
      .map((f) => `/api/${f.replace(/\.ts$/, '')}`);
    const declared = new Set(entries.map((e) => e.path));
    const undeclared = handlers.filter((h) => !declared.has(h));
    check('api/ 下每个处理器都在路由表里登记', undeclared.length === 0, undeclared.join(', '));
  }

  // 路径里不允许再出现 /api/sync/ 这种带斜杠的老写法
  // 注意：只看**字符串字面量**，注释里提到那个错误写法是说明用的，不算违规
  const srcFiles = walk('src', /\.ts$/);
  const stalePaths = [];
  for (const file of srcFiles) {
    const text = readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '') // 去掉块注释
      .replace(/^\s*\/\/.*$/gm, ''); // 去掉行注释
    if (/['"`]\/api\/sync\//.test(text)) stalePaths.push(file);
  }
  check(
    'src/ 里没有 /api/sync/ 老路径（正确写法是 /api/sync-pull）',
    stalePaths.length === 0,
    stalePaths.join(', '),
  );

  const pkgScripts = JSON.parse(readFileSync('package.json', 'utf8')).scripts ?? {};
  check('有 test:live 脚本（线上接口冒烟测试）', Boolean(pkgScripts['test:live']));
}

console.log(`\n=== 结果：通过 ${passed} 项，失败 ${failed} 项 ===\n`);
process.exit(failed === 0 ? 0 : 1);
