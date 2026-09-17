#!/usr/bin/env node
/**
 * probeLayout.mjs —— 白纸布局测量与断言脚本（零依赖）
 *
 * 用法：
 *   node probeLayout.mjs --viewport 390x844 --expect-count 16
 *   node probeLayout.mjs --viewport 390x844 --url http://localhost:5173
 *   node probeLayout.mjs --viewport 390x844 --json-only
 *
 * ★ S3 新增（桌面端 2 列回归验收用）：
 *   --min-columns N      断言 columns（DOM 聚类列数）≥ N（默认 3）
 *   --cols-override N    手动列数覆盖（自动 / 3 / 4 / 5 / 6 / 8 / 10），透传给页面的 `cols=N`
 *   --min-y-coverage R   断言词在纵向铺开的比例 ≥ R（默认 0.5 = 至少铺满半张纸）
 *   --preset NAME        预设名（compact / balanced / loose）。本仓库尚未实现 S1 的预设系统，
 *                        传了只会打印一行提示并**按当前默认档位**测量（不做假通过）
 *
 * 原理：
 *   1. 用本机 Edge/Chrome 无头模式打开 #/dev/layout?probe=1
 *   2. 页面内 window.__layoutProbe() 已经把结果写进 <pre id="probe-result">
 *   3. --dump-dom 把 HTML 抓出来，正则提取 JSON
 *   4. 跑断言，输出 PASS/FAIL
 *
 * 目的：用机器数字替代 AI 的口头汇报，杜绝"声称完成但实际没生效"。
 *
 * 退出码：0 = 全部 PASS；1 = 有 FAIL
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ───────────────────────── 参数解析 ─────────────────────────
const argv = process.argv.slice(2);
function arg(name, def) {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : def;
}
const flag = (name) => argv.includes(`--${name}`);

const viewport = arg('viewport', '390x844');
const url = arg('url', 'http://localhost:5173');
const expectCount = Number(arg('expect-count', '16'));
const countMin = Number(arg('count-min', '15'));
const countMax = Number(arg('count-max', '18'));
const minGapRequired = Number(arg('min-gap', '8'));
/**
 * ★ S3：DOM 聚类列数的下限（防退化）。
 * 口径：手机 ≥3 / 平板 ≥4 / 桌面 ≥5 / 大屏 ≥6（由调用方按场景传）。
 */
const minColumns = Number(arg('min-columns', '3'));
/** ★ S3：词在纵向铺开的比例下限（1 = 整张纸；默认 0.5 = 至少铺满半张纸） */
const minYCoverage = Number(arg('min-y-coverage', '0.5'));
/** ★ S3：手动列数覆盖（不传 = 自动）。合法值见 core/config.ts 的 LAYOUT_COLS_OPTIONS */
const colsOverrideRaw = arg('cols-override', '');
const colsOverride = colsOverrideRaw === '' ? null : Number(colsOverrideRaw);
const preset = arg('preset', '');
const jsonOnly = flag('json-only');

if (colsOverride !== null && ![3, 4, 5, 6, 8, 10].includes(colsOverride)) {
  console.error(`✗ --cols-override 只支持 3 / 4 / 5 / 6 / 8 / 10（收到 ${colsOverrideRaw}）`);
  console.error('  可选值见 src/core/config.ts 的 LAYOUT_COLS_OPTIONS');
  process.exit(1);
}
if (preset !== '') {
  console.log(
    `! --preset ${preset}：本仓库尚未实现 S1 的预设系统（settings 里没有 layoutPreset），` +
      '按当前默认档位测量（不做假通过）。',
  );
}
/**
 * 额外透传给调试页的查询参数（形如 `words=long&dvw=390&dvh=844`）。
 *
 * 为什么需要：无头 Chrome 的 `--window-size` **最小窗宽是 504px**，
 * `--viewport 390x844` 实际只会得到 504×749 —— 真机列数根本量不到。
 * 调试页因此支持注入「模拟真机视口」：`dvw`/`dvh` 会覆盖布点用的尺寸，
 * 于是同一套断言可以在**真正的 390×844 布局**上跑。
 * 用法：`--page-args "dvw=390&dvh=844"`（会拼在 `probe=1` 后面）。
 */
const pageArgs = arg('page-args', '');
/** ★ S3：手动列数覆盖要透传给页面（调试页读 `cols=` 后写进设置缓存） */
const colsArg = colsOverride === null ? '' : `cols=${colsOverride}`;

const [vw, vh] = viewport.split('x').map(Number);

/**
 * 传给浏览器的**窗口**高度（默认 = 视口高度）。
 *
 * 为什么需要单独一个参数：Windows 的无头 Edge/Chrome 有两条实测限制——
 *   1. `--window-size` 的**宽度最小值是 504px**（要 390 只会得到 504）；
 *   2. 真实视口高度 = 窗口高度 − 95px（窗口装饰）。
 * 所以在量「真机 390×844」时，必须让窗口足够高（844+95=939），
 * 否则纸面下沿被窗口裁掉，会凭空多出一个「越界 1 个」的假失败。
 * 用法：`--window-height 939 --page-args "dvw=390&dvh=844"`。
 */
const windowHeight = Number(arg('window-height', String(vh)));

// ───────────────────────── 定位浏览器 ─────────────────────────
const BROWSER_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
];

function findBrowser() {
  const custom = arg('browser');
  if (custom && existsSync(custom)) return custom;
  for (const p of BROWSER_CANDIDATES) if (existsSync(p)) return p;
  return process.platform === 'win32' ? 'msedge' : 'google-chrome';
}
const browser = findBrowser();

// ───────────────────────── 执行 dump-dom ─────────────────────────
const profile = mkdtempSync(join(tmpdir(), 'probe-profile-'));
const dumpFile = join(mkdtempSync(join(tmpdir(), 'probe-dump-')), 'dom.html');
const extra = [pageArgs, colsArg].filter((s) => s !== '').join('&');
const target = `${url}/#/dev/layout?probe=1&vw=${vw}&vh=${vh}${extra ? `&${extra}` : ''}`;

let html = '';
try {
  execFileSync(
    browser,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      `--user-data-dir=${profile}`,
      `--window-size=${vw},${windowHeight}`,
      '--virtual-time-budget=8000',
      '--dump-dom',
      target,
    ],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }
  );
  // Edge/Chrome --dump-dom 输出到 stdout
  const out = execFileSync(
    browser,
    [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      `--user-data-dir=${profile}`, `--window-size=${vw},${windowHeight}`,
      '--virtual-time-budget=8000', '--dump-dom', target,
    ],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  );
  html = out;
  writeFileSync(dumpFile, html, 'utf8');
} catch (e) {
  console.error('✗ 浏览器执行失败：', e.message);
  console.error('  目标：', target);
  console.error('  浏览器：', browser);
  console.error('  提示：确认 dev server 已启动，或用 --url 指定正确地址、--browser 指定浏览器路径');
  process.exit(1);
}

// ───────────────────────── 提取 probe 结果 ─────────────────────────
function extractProbe(html) {
  // 优先找 <pre id="probe-result">{...}</pre>
  const preRe = /<pre[^>]*id=["']probe-result["'][^>]*>([\s\S]*?)<\/pre>/i;
  const m = html.match(preRe);
  if (m) {
    const raw = m[1]
      .replace(/&quot;/g, '"').replace(/&#34;/g, '"')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .trim();
    try { return JSON.parse(raw); } catch { /* fallthrough */ }
  }
  // 兜底：找 __LAYOUT_PROBE__ = {...}
  const jsRe = /__LAYOUT_PROBE__\s*=\s*(\{[\s\S]*?\})\s*;?/;
  const m2 = html.match(jsRe);
  if (m2) {
    try { return JSON.parse(m2[1]); } catch { /* fallthrough */ }
  }
  return null;
}

const probe = extractProbe(html);

if (!probe) {
  console.error('✗ 未能从页面提取布局测量数据。');
  console.error('  确认：');
  console.error('   1. 页面 #/dev/layout 已实现');
  console.error('   2. 页面内调用了 window.__layoutProbe() 并把结果写入 <pre id="probe-result">');
  console.error('   3. 支持 ?probe=1 参数自动执行测量');
  console.error('  DOM 已保存到：', dumpFile);
  process.exit(1);
}

if (jsonOnly) {
  console.log(JSON.stringify(probe, null, 2));
  process.exit(0);
}

// ───────────────────────── 断言 ─────────────────────────
const checks = [];
const ck = (name, actual, pred, expectText) =>
  checks.push({ name, actual, ok: pred, expectText });

ck('layoutViewport', `${probe.layoutViewport?.[0]}x${probe.layoutViewport?.[1]}`,
  probe.layoutViewport?.[0] === vw && probe.layoutViewport?.[1] === vh,
  `${vw}x${vh}（布点实际用的尺寸 = 注入的模拟真机尺寸）`);

ck('wordCount', probe.wordCount,
  probe.wordCount >= countMin && probe.wordCount <= countMax,
  `${countMin}~${countMax}（期望 ${expectCount}）`);

ck('overlapPairs', probe.overlapPairs, probe.overlapPairs === 0, '0');

ck('buttonOverlaps', probe.buttonOverlaps, probe.buttonOverlaps === 0, '0');

ck('outOfBounds', probe.outOfBounds, probe.outOfBounds === 0, '0');

ck('minGap', probe.minGap, probe.minGap >= minGapRequired, `>= ${minGapRequired}`);

// ★ S3：列数下限按场景传（手机 3 / 平板 4 / 桌面 5 / 大屏 6）
ck('columns', probe.columns, probe.columns >= minColumns, `>= ${minColumns}`);

// ★ S3：手动列数覆盖是否真的生效（网格列数 = 用户指定值）
if (colsOverride !== null) {
  ck('grid.cols=覆盖值', probe.layout?.cols, probe.layout?.cols === colsOverride, `= ${colsOverride}`);
  ck('colsOverridden', probe.layout?.colsOverridden, probe.layout?.colsOverridden === true, 'true');
}

/**
 * ★ S3：DOM 与网格的一致性检查 —— 每个词的落点都必须落在**声明的网格列**里。
 *
 * 为什么不能只数 `columns`（20px 容差的 DOM 聚类）：格内抖动会让同一列的词被拆成
 * 好几簇，于是「6 列」被数成 11 簇。这条按**列距**（可用宽 ÷ 列数）反算每个词
 * 属于哪一列，能直接证明「屏幕上真的是 6 列」，而不是靠簇数猜。
 */
if (probe.layout?.area && probe.layout.cols > 0 && probe.boxes.length > 0) {
  const { area, cols: gridCols } = probe.layout;
  const offX = probe.layout.sheetOffsetX ?? 0;
  const pitch = area.width / gridCols;
  const used = new Set();
  let outside = 0;
  for (const b of probe.boxes) {
    const slot = Math.floor((b.cx - offX - area.x) / pitch);
    if (slot < 0 || slot >= gridCols) outside += 1;
    else used.add(slot);
  }
  ck(
    'grid.cols↔DOM',
    `${used.size}/${gridCols} 列有词，越列 ${outside}`,
    outside === 0 && used.size <= gridCols,
    '每个词都落在声明的网格列内',
  );
}

// ★ S3：均匀散布 —— 词在纵向要铺开（不许全挤在顶部几行）
if (probe.spread) {
  ck(
    'spread.yCoverage',
    probe.spread.yCoverage,
    probe.spread.yCoverage >= minYCoverage,
    `>= ${minYCoverage}（1 = 铺满整张纸）`,
  );
}

// 可选：避让区合理性 —— **整条横带**式的避让区里不许有单词。
//   ★ 为什么要先判形状：手机的避让区是「整条底部横带」（横带里当然不许有词），
//     而平板/桌面的按钮是**右下角方块** —— 词本来就可以在它左边、甚至它下面
//     （方块右边的区域也是可用纸面）。拿横带的口径去判方块，会凭空多出假失败
//     （实测：820×1180 平板报「避让带内 2 个词」，而那 2 个词离按钮还有一大截）。
//     方块形状的避让由 buttonOverlaps 的真实矩形判交负责，这里不重复判。
const bandRects = (probe.avoidRects ?? []).filter(
  (r) => r.width >= (probe.layoutViewport?.[0] ?? 0) * 0.95,
);
if (bandRects.length > 0 && probe.boxes) {
  const bandTop = Math.min(...bandRects.map(r => r.y));
  const wordsInBand = probe.boxes.filter(b => b.y + b.h > bandTop + 0.5).length;
  ck('wordsInAvoidBand', wordsInBand, wordsInBand === 0,
    '0（底部横带里不应有单词）');
}

// ───────────────────────── 输出 ─────────────────────────
console.log('\n=== 布局测量 ===');
console.log(`viewport      : 布点 ${probe.layoutViewport?.[0]}x${probe.layoutViewport?.[1]}（真实窗口 ${probe.viewport?.[0]}x${probe.viewport?.[1]}，无头窗口受物理屏幕限制）`);
console.log(`wordCount     : ${probe.wordCount}`);
console.log(`columns/rows  : ${probe.columns} / ${probe.rows}（DOM 聚类）`);
console.log(`grid          : ${probe.layout?.cols} 列 × ${probe.layout?.rows} 行 = ${probe.layout?.gridCapacity} 格，放下 ${probe.layout?.capacity} 个`);
console.log(`算法/设备     : ${probe.layout?.algorithm} / ${probe.layout?.deviceKind}（字号 ${probe.layout?.fontSize}px）`);
console.log(`列数来源      : ${probe.layout?.colsOverridden ? `手动覆盖 ${probe.layout?.colsRequested}` : `自动（下限 ${probe.layout?.minCols} 列，宽度上限 ${probe.layout?.maxCols} 列）`}`);
console.log(`overlapPairs  : ${probe.overlapPairs}`);
console.log(`buttonOverlaps: ${probe.buttonOverlaps}`);
console.log(`outOfBounds   : ${probe.outOfBounds}`);
console.log(`minGap        : ${probe.minGap}`);
if (probe.spread) {
  console.log(
    `散布          : y 覆盖 ${(probe.spread.yCoverage * 100).toFixed(1)}%（y ${probe.spread.yMin}~${probe.spread.yMax} / 纸高 ${probe.spread.sheetH}）` +
      ` · x 覆盖 ${(probe.spread.xCoverage * 100).toFixed(1)}% · y 带数 ${probe.spread.yBands}`,
  );
}
if (probe.avoidRects) {
  console.log(`avoidRects    : ${JSON.stringify(probe.avoidRects)}`);
}

console.log('\n=== 断言 ===');
let failed = 0;
for (const c of checks) {
  const icon = c.ok ? '✓' : '✗';
  if (!c.ok) failed++;
  console.log(`${icon} ${c.name.padEnd(20)} 实际=${String(c.actual).padEnd(8)} 期望=${c.expectText}`);
}

console.log(`\n结果：${checks.length - failed} 通过 / ${failed} 失败`);
console.log('DOM 已保存：', dumpFile, '\n');

if (failed > 0) {
  console.log('存在 FAIL。这是客观测量结果，不允许解释为"其实没问题"。请修复后重跑。');
  process.exit(1);
}
console.log('全部 PASS。');
process.exit(0);
