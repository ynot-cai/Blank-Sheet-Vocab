#!/usr/bin/env node
/**
 * probeLayout.mjs —— 手机端布局测量与断言脚本（零依赖）
 *
 * 用法：
 *   node probeLayout.mjs --viewport 390x844 --expect-count 16
 *   node probeLayout.mjs --viewport 390x844 --url http://localhost:5173
 *   node probeLayout.mjs --viewport 390x844 --json-only
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
const jsonOnly = flag('json-only');
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
const target = `${url}/#/dev/layout?probe=1&vw=${vw}&vh=${vh}${pageArgs ? `&${pageArgs}` : ''}`;

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

ck('viewport', `${probe.viewport?.[0]}x${probe.viewport?.[1]}`,
  probe.viewport?.[0] === vw && probe.viewport?.[1] === vh, `${vw}x${vh}`);

ck('wordCount', probe.wordCount,
  probe.wordCount >= countMin && probe.wordCount <= countMax,
  `${countMin}~${countMax}（期望 ${expectCount}）`);

ck('overlapPairs', probe.overlapPairs, probe.overlapPairs === 0, '0');

ck('buttonOverlaps', probe.buttonOverlaps, probe.buttonOverlaps === 0, '0');

ck('outOfBounds', probe.outOfBounds, probe.outOfBounds === 0, '0');

ck('minGap', probe.minGap, probe.minGap >= minGapRequired, `>= ${minGapRequired}`);

ck('columns', probe.columns, probe.columns >= 3, '>= 3（不能是 1 竖列）');

// 可选：避让区合理性 —— 单词不应全挤在避让区同侧
if (probe.avoidRects && probe.boxes) {
  const avoidTop = Math.min(...probe.avoidRects.map(r => r.y));
  const wordsBelowAvoid = probe.boxes.filter(b => b.y > avoidTop).length;
  ck('wordsBelowAvoidBand', wordsBelowAvoid, wordsBelowAvoid === 0,
    '0（避让带内不应有单词）');
}

// ───────────────────────── 输出 ─────────────────────────
console.log('\n=== 布局测量 ===');
console.log(`viewport      : ${probe.viewport?.[0]}x${probe.viewport?.[1]}`);
console.log(`wordCount     : ${probe.wordCount}`);
console.log(`columns/rows  : ${probe.columns} / ${probe.rows}`);
console.log(`overlapPairs  : ${probe.overlapPairs}`);
console.log(`buttonOverlaps: ${probe.buttonOverlaps}`);
console.log(`outOfBounds   : ${probe.outOfBounds}`);
console.log(`minGap        : ${probe.minGap}`);
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
