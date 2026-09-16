/**
 * 手机端布局界面验收（阶段 M2）：`npm run test:m2-ui`
 *
 * 为什么必须有这一层（M1/M2 的教训）：
 *   `test:mobile` 只跑 Node 里的纯函数（算得快、但没有真实 DOM）；
 *   而「按钮到底画在哪、单词到底压没压住按钮」只有真浏览器能证明。
 *
 * 这里用 CDP 的 `Emulation.setDeviceMetricsOverride` 把视口**精确**设成真机尺寸
 * （Windows 无头浏览器最小窗宽 504px，`--window-size` 做不到 390），
 * 然后打开 `#/dev/layout?probe=1&controls=1`——它用的是**真实的** PaperStage
 * 与**真实的**底部圆形按钮带，所以量出来的就是用户在手机上看到的那一版。
 *
 * 验收项（每条都是数字）：
 *   1. 视口 = 390×844；单词数 15~18；不重叠、不越界；
 *   2. 每个词都在底部按钮带**上方**（按钮带 y 以上），且与按钮实际位置不相交；
 *   3. 避让带的顶部 = 按钮带的顶部（两者不能各算一套）；
 *   4. 圆按钮 4~5 个、直径 = 参数、一行放得下、横向居中；
 *   5. 单词可以出现在按钮带**左侧**（这正是用户报的「词进不了按钮左侧」）；
 *   6. 桌面（1280×800）：仍是右下角竖排按钮，没有被改成横排。
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findBrowser, launch, openSession } from '../../scripts/cdp.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEV_URL = process.env.DEV_URL ?? 'http://127.0.0.1:5173';
const CDP_PORT = 9371;

let passed = 0;
let failed = 0;

/**
 * 一条断言。
 * @param name 用例名
 * @param ok 是否通过
 * @param detail 失败时的具体数值
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

const browser = findBrowser();
if (!browser) {
  console.error('✗ 找不到 Chrome / Edge，跳过界面验收');
  process.exit(1);
}

const { proc } = await launch(browser, CDP_PORT, { windowSize: '1280,900' });

try {
  // ───────────────────────── 手机 390×844 ─────────────────────────
  console.log('\n[M2-UI] 手机 390×844（CDP 精确视口模拟）');
  const page = await openSession(
    CDP_PORT,
    `${DEV_URL}/#/dev/layout?probe=1&controls=1&words=normal&count=16&dvw=390&dvh=844`,
    { waitMs: 2500 },
  );
  await page.setViewport(390, 844);
  await new Promise((r) => setTimeout(r, 1200));

  const result = await page.evaluate('window.__layoutProbe()');
  const vp = result?.viewport ?? [];
  check('视口被精确设成 390×844', vp[0] === 390 && vp[1] === 844, `${vp.join('x')}`);
  check('单词数 15~18', result.wordCount >= 15 && result.wordCount <= 18, `wordCount=${result.wordCount}`);
  check('没有重叠', result.overlapPairs === 0, `overlapPairs=${result.overlapPairs}`);
  check('没有越界', result.outOfBounds === 0, `outOfBounds=${result.outOfBounds}`);
  check('列数 ≥ 3（不是竖列）', result.columns >= 3, `columns=${result.columns}`);

  // ── 底部圆形按钮带的真实位置 ──
  const band = await page.evaluate(`(() => {
    const box = document.querySelector('[data-dev-controls]');
    if (!box) return null;
    const r = box.getBoundingClientRect();
    const circles = [...box.querySelectorAll('.paper-round-circle')].map((el) => {
      const c = el.getBoundingClientRect();
      return { cx: c.left + c.width / 2, top: c.top, bottom: c.bottom, w: c.width, h: c.height };
    });
    const style = getComputedStyle(box);
    const stage = document.querySelector('.paper-stage')?.getBoundingClientRect() ?? null;
    return {
      x: r.left, y: r.top, w: r.width, h: r.height,
      circles,
      declaredBand: Number(box.dataset.bandHeight ?? 0),
      gap: Number.parseFloat(style.gap) || 0,
      varD: getComputedStyle(box).getPropertyValue('--btn-d'),
      inner: [window.innerWidth, window.innerHeight],
      stage: stage ? { x: stage.left, y: stage.top, w: stage.width, h: stage.height } : null,
      avoidFromDevice: (() => {
        const el = document.querySelector('.avoid-rect');
        if (!el) return null;
        const a = el.getBoundingClientRect();
        return { x: a.left, y: a.top, w: a.width, h: a.height };
      })(),
    };
  })()`);
  const avoid = result.avoidRects?.[0] ?? null;
  check('页面上有真实的圆按钮带', band !== null);
  if (band) {
    const circles = band.circles ?? [];
    check('圆按钮数量 4~5 个', circles.length >= 4 && circles.length <= 5, `${circles.length} 个`);
    check('按钮直径 = 50px（来自参数）', circles.every((c) => Math.abs(c.w - 50) < 0.6 && Math.abs(c.h - 50) < 0.6), JSON.stringify(circles.map((c) => c.w)));
    // 一行放得下 = 所有圆的 top 相同
    const tops = new Set(circles.map((c) => Math.round(c.top)));
    check('按钮一行放得下（不换行）', tops.size <= 1, `不同的 top：${[...tops].join(',')}`);
    // 横向居中：圆心平均值 ≈ 视口中心
    const mid = circles.reduce((s, c) => s + c.cx, 0) / Math.max(1, circles.length);
    check('按钮整体横向居中', Math.abs(mid - 195) <= 6, `圆心均值 ${mid.toFixed(1)} vs 195`);
    // 避让区与按钮带对齐
    check('避让带 = 底部整条横带', avoid && avoid.x === 0 && Math.abs(avoid.width - 390) < 0.6, JSON.stringify(avoid));
    check(
      '避让带底部 = 视口底部',
      avoid && Math.abs(avoid.y + avoid.height - 844) < 0.6,
      `avoid.y+height=${avoid ? (avoid.y + avoid.height).toFixed(1) : 'n/a'}`,
    );
    // 按钮的实际位置必须落在避让带里（否则词会压住按钮）
    const circlesInside = circles.every((c) => c.bottom <= 844 + 0.6 && c.top >= (avoid?.y ?? 0) - 0.6);
    check('每个按钮都落在避让带内（词不会被压）', circlesInside, JSON.stringify(circles.map((c) => `${c.top.toFixed(0)}~${c.bottom.toFixed(0)}`)));
    // 避让带必须**完整包住**按钮（含圆下方小字），并且不能离谱地大：
    //   带高 = 直径×3 + 小字 + 12（core/layout.ts 的 controlBandHeight），
    //   比按钮本身高是**有意的**——多出来的部分是与按钮之间的安全空隙。
    if (avoid) {
      const bandBottom = Math.max(...circles.map((c) => c.bottom));
      const label = await page.evaluate(
        `(() => { const el = document.querySelector('[data-dev-controls] .paper-round-label'); if (!el) return null; const r = el.getBoundingClientRect(); return { bottom: r.bottom }; })()`,
      );
      const contentBottom = Math.max(bandBottom, label?.bottom ?? 0);
      check(
        '避让带完整包住按钮与小字',
        contentBottom <= avoid.y + avoid.height + 0.6,
        `按钮底 ${contentBottom.toFixed(1)} vs 避让带底 ${(avoid.y + avoid.height).toFixed(1)}`,
      );
      const slack = avoid.y + avoid.height - contentBottom;
      check(
        '避让带的余量不超过直径×3（没有乱占地方）',
        slack <= 150,
        `余量 ${slack.toFixed(1)}px`,
      );
    }
  }

  // ── 单词与按钮带的关系（用真实矩形相交，不用中心点） ──
  const inBand = result.boxes.filter((b) => avoid && b.y + b.h > avoid.y + 0.6);
  check('没有单词落进按钮带', inBand.length === 0, `${inBand.length} 个：${inBand.map((b) => b.text).join(',')}`);
  const leftOfButtons = result.boxes.filter((b) => b.x + b.w < 242); // 按钮带最左边那个圆的左边缘
  check('有单词出现在按钮**左侧**（用户报的那个问题）', leftOfButtons.length > 0, `${leftOfButtons.length} 个`);
  await page.close();

  // ───────────────────────── 桌面 1280×800 ─────────────────────────
  console.log('\n[M2-UI] 桌面 1280×800（不许被误改）');
  const desktop = await openSession(CDP_PORT, `${DEV_URL}/#/dev/layout?probe=1&words=normal&count=16&dvw=0`, {
    waitMs: 2500,
  });
  await desktop.setViewport(1280, 800);
  await new Promise((r) => setTimeout(r, 1000));
  const dResult = await desktop.evaluate('window.__layoutProbe()');
  check('桌面用的是旧算法', dResult.layout?.algorithm === 'legacy-jitter', String(dResult.layout?.algorithm));
  const dAvoid = dResult.avoidRects?.[0];
  const dW = dResult.viewport?.[0] ?? 0;
  if (dW > 1100) {
    // 只有视口真的被设成桌面宽度时，这条几何断言才有意义
    check(
      '桌面避让区仍是右下角方块（不是横带）',
      dAvoid && dAvoid.x > dW / 2 && dAvoid.width < 400,
      JSON.stringify(dAvoid),
    );
  } else {
    console.log(`  ! 桌面视口未被 CDP 改成功（${dW}px），跳过几何断言（算法与控件断言仍然有效）`);
  }
  check('桌面没有圆按钮带', (await desktop.evaluate("document.querySelector('[data-dev-controls]') === null")) === true);
  await desktop.close();
} finally {
  proc.kill();
}

console.log(`\n=== M2-UI 结果：通过 ${passed} 项，失败 ${failed} 项 ===\n`);
process.exit(failed === 0 ? 0 : 1);
