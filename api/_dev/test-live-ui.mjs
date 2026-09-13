/**
 * **线上站点**的真浏览器冒烟：`npm run test:live-ui [站点地址]`
 *
 * ══════════════════════════════════════════════════════════════
 * 为什么必须有这一套（别的套件都替代不了）
 * ══════════════════════════════════════════════════════════════
 * 本地那十几套测试跑的都是 **dev 模式 + 源码**：
 *   - `test:kc-*` 系列：起本地 vite dev，模块是现编现发的；
 *   - `test:live`：只打 `/api/*` 接口，**完全不碰前端**。
 * 于是「本地全绿、线上打不开」这类事故它们一个都拦不住，而这类事故真发生过：
 *   - `package.json` 带 UTF-8 BOM → dev 的 PostCSS 解析失败 → CSS 全 500 → 白屏；
 *   - `/api/xxx` 路径带斜杠 → 线上 404（`test:live` 就是为这条加的）。
 *
 * 这一套打的是**生产构建产物**（`dist/` 上传后的那一份），
 * 用真 Chrome 打开线上地址，验证：能不能挂载、页面渲不渲染、会不会白屏、
 * 二期入口在不在、**设置页**（用户实测报过「渲染失败」的那一页）开不开得起来。
 *
 * 用法：
 *   npm run test:live-ui                                  # 默认打 https://blank-sheet-vocab.vercel.app
 *   npm run test:live-ui -- https://你的域名               # 指定站点
 * 说明：只读自检，不写任何数据；需要本机有 Chrome / Edge。
 */
import { findBrowser, launch, openSession } from '../../scripts/cdp.mjs';

/** 站点地址：命令行第一个参数 > 环境变量 > 默认线上地址 */
const ORIGIN = (process.argv[2] ?? process.env.LIVE_SITE_BASE ?? 'https://blank-sheet-vocab.vercel.app').replace(
  /\/+$/,
  '',
);
const CDP_PORT = 9251;

let passed = 0;
let failed = 0;

/**
 * 一条断言。
 * @param {string} name 用例名
 * @param {boolean} ok 是否通过
 * @param {string} [detail] 补充
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
  console.log('\n⚠ 本机没有 Chrome / Edge，跳过线上界面自检（接口层已由 test:live 覆盖）\n');
  process.exit(0);
}
console.log(`  用 ${browser.split('\\').pop()} 打开 ${ORIGIN}`);

let chrome = null;
let session = null;
try {
  chrome = await launch(browser, CDP_PORT, { windowSize: '1280,900' });
  session = await openSession(CDP_PORT, `${ORIGIN}/#/kc`, { waitMs: 1500 });

  // ── ① 能不能挂载（线上首次要下 bundle，给足 40 秒）──
  console.log('\n[1] 线上构建能否在真浏览器里跑起来');
  let mounted = false;
  for (let i = 0; i < 40; i += 1) {
    if ((await session.evaluate(`document.querySelector('#app .nav') !== null`)) === true) {
      mounted = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  check('★ 线上站点挂载成功（没白屏）', mounted === true, '40 秒内没等到顶栏');
  const shell = await session.evaluate(`JSON.stringify({
    title: document.title,
    nav: document.querySelector('.nav')?.textContent?.slice(0, 40) ?? '',
    hasKcNav: (document.querySelector('.nav')?.textContent ?? '').includes('知识点'),
    fatal: document.querySelector('.fatal-page') !== null,
    bodyLen: document.body.textContent.length,
  })`);
  const sh = JSON.parse(shell);
  check('页面标题是「白纸单词」', sh.title.includes('白纸单词'), sh.title);
  check('★ 顶栏有「知识点」入口（二期已上线）', sh.hasKcNav === true, sh.nav);
  check('没有掉进错误边界', sh.fatal === false, '');
  check('页面有实际内容', sh.bodyLen > 50, String(sh.bodyLen));
  const assets = session.requests('/assets/').map((r) => r.url);
  check('静态资源真的下下来了（bundle 404 会白屏，但上面的断言看不出来）', assets.length > 0, JSON.stringify(assets.slice(0, 4)));

  // ── ② 二期首页 ──
  console.log('\n[2] 二期首页与入口');
  await session.evaluate(`(async () => { location.hash = '#/kc'; await new Promise((r) => setTimeout(r, 1200)); })()`);
  const home = JSON.parse(
    await session.evaluate(`JSON.stringify({
      page: document.querySelector('.kc-home') !== null,
      entries: [...document.querySelectorAll('.kc-home-grid .kc-entry-label')].map((e) => e.textContent),
      crashed: document.querySelector('.fatal-page') !== null,
    })`),
  );
  check('★ 二期首页打得开', home.page === true && home.crashed === false, JSON.stringify(home));
  check(
    '★ 六个入口都在（录入 / 卡片列表 / 学习 / 复习 / 题库 / 设置）',
    ['录入', '卡片列表', '学习', '复习', '题库', '设置'].every((t) => home.entries.includes(t)),
    JSON.stringify(home.entries),
  );
  check('★ 没有独立的「做题」入口（做题是学习/复习里的一步）', !home.entries.includes('做题'), JSON.stringify(home.entries));

  // ── ③ 设置页（用户实测报过「渲染失败」的那一页）──
  console.log('\n[3] 二期设置页（真机上坏过的那一页）');
  await session.evaluate(`(async () => {
    location.hash = '#/kc';
    await new Promise((r) => setTimeout(r, 500));
    location.hash = '#/kc/settings';
    await new Promise((r) => setTimeout(r, 1500));
  })()`);
  const set = JSON.parse(
    await session.evaluate(`JSON.stringify({
      page: document.querySelector('.kc-set-page') !== null,
      sections: document.querySelectorAll('.kc-set-section').length,
      nums: document.querySelectorAll('.kc-set-num').length,
      fatal: document.querySelector('.fatal-page') !== null,
      routerFail: (document.querySelector('#app')?.textContent ?? '').includes('页面渲染失败'),
    })`),
  );
  check('★★ 设置页正常渲染（四个分区都在）', set.page === true && set.sections >= 4, JSON.stringify(set));
  check('参数输入框齐全（≥ 10 个）', set.nums >= 10, String(set.nums));
  check('没有掉进错误边界 / 没有「页面渲染失败」', set.fatal === false && set.routerFail === false, JSON.stringify(set));

  // ── ④ 一期回归（二期上线不该影响一期）──
  console.log('\n[4] 一期回归');
  await session.evaluate(`(async () => { location.hash = '#/'; await new Promise((r) => setTimeout(r, 1200)); })()`);
  const one = JSON.parse(
    await session.evaluate(`JSON.stringify({
      fatal: document.querySelector('.fatal-page') !== null,
      text: document.body.textContent.slice(0, 200),
    })`),
  );
  check('★ 一期首页正常（没崩）', one.fatal === false, one.text.slice(0, 80));
  check('一期「背诵」入口还在', one.text.includes('背诵'), one.text.slice(0, 80));
} catch (err) {
  failed += 1;
  console.error(`\n✗ 线上界面自检出错：${err instanceof Error ? err.message : String(err)}`);
} finally {
  if (session) await session.close().catch(() => {});
  if (chrome) chrome.proc.kill();
}

console.log(`\n=== 线上站点真浏览器自检：通过 ${passed} 项，失败 ${failed} 项 ===\n`);
process.exit(failed === 0 ? 0 : 1);
