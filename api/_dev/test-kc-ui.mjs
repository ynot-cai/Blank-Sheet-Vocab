/**
 * 二期安全渲染 / 数据层的**真浏览器**冒烟：`npm run test:kc-ui`（需要本机有 Chrome / Edge）
 *
 * 为什么需要它：`test-kc.mjs` 里的 XSS 验证用的是自己写的**最小 DOM 桩**
 * （只实现 blockRender 用到的几个 API）。桩能证明「没有创建 script 元素」，
 * 但证明不了「浏览器真的不执行它」——那要靠真引擎。
 *
 * 所以这里起 `vite dev`（`__kcselftest` 只在 DEV 下挂载，见 main.ts），
 * 用无头 Chrome 真跑一遍 `__kcselftest.run()`：
 *   1. 页面能启动、`window.__kcselftest` 挂上了；
 *   2. mastery 公式全部通过；
 *   3. XSS：把 `<script>` / `<img onerror=...>` 之类真的插进 DOM 后，
 *      **页面上找不到任何危险元素、没有 onerror 属性、哨兵没被置位**；
 *   4. 二期 DAO 在真 IndexedDB 上读写正常（增删改查 / 斩 / 复活 / 分页）。
 */
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findBrowser, launch, openSession, serveStatic } from '../../scripts/cdp.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = 4181;
const CDP_PORT = 9223;
const ORIGIN = `http://127.0.0.1:${PORT}`;

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
 * 等服务器起来。
 * @param {string} url 健康检查地址
 */
async function waitForServer(url) {
  for (let i = 0; i < 80; i += 1) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/**
 * 把自测结果数组汇总成一行说明（失败项列出来）。
 * @param {Array<{name:string, ok:boolean, detail:string}>} rows 结果
 */
function summarize(rows) {
  const bad = rows.filter((r) => !r.ok);
  return bad.length === 0 ? `${rows.length} 项全过` : bad.map((r) => `${r.name}（${r.detail}）`).join('；');
}

const browser = findBrowser();
if (!browser) {
  console.log('\n⚠ 本机没有 Chrome / Edge，跳过二期界面冒烟（数据层已由 test:kc 覆盖）');
  console.log('\n二期界面冒烟：0 项通过，0 项失败');
  process.exit(0);
}
console.log(`  用 ${browser.split('\\').pop()} 跑无头检查`);

// 注意：必须用 dev 模式——`window.__kcselftest` 只在 import.meta.env.DEV 下挂载
const server = serveStatic({ root: ROOT, port: PORT, mode: 'dev' });

let chrome = null;
let session = null;
try {
  const up = await waitForServer(`${ORIGIN}/`);
  if (!up) throw new Error(`dev 服务没起来（${ORIGIN}）`);
  chrome = await launch(browser, CDP_PORT);

  // 首页也会挂 __selftest，但二期自测只需要页面上下文
  session = await openSession(CDP_PORT, `${ORIGIN}/`, { waitMs: 2000 });

  console.log('\n[1] 页面与挂载点');
  const hasApi = await session.evaluate('typeof window.__kcselftest === "object" && window.__kcselftest !== null');
  check('window.__kcselftest 已挂载（DEV 下）', hasApi === true, String(hasApi));
  const apiShape = await session.evaluate(
    'JSON.stringify(Object.keys(window.__kcselftest ?? {}).sort())',
  );
  check(
    '自测入口方法齐全（run / mastery / xss / data）',
    typeof apiShape === 'string' &&
      ['data', 'mastery', 'run', 'xss'].every((k) => apiShape.includes(k)),
    String(apiShape),
  );
  const booted = await session.evaluate('Boolean(document.querySelector("#app")?.children.length)');
  check('应用真的渲染出来了（没掉进错误边界）', booted === true, String(booted));

  console.log('\n[2] mastery 公式（真浏览器里再跑一遍）');
  const masteryRows = await session.evaluate('JSON.stringify(window.__kcselftest.mastery())');
  const mastery = JSON.parse(masteryRows);
  check('mastery 自测全部通过', mastery.every((r) => r.ok), summarize(mastery));

  console.log('\n[3] ★ 安全渲染：真浏览器里插入攻击载荷');
  // xss(true) = 把测试内容留在页面上，方便断言
  const xssRows = await session.evaluate('JSON.stringify(window.__kcselftest.xss(true))');
  const xss = JSON.parse(xssRows);
  check('XSS 自测全部通过', xss.every((r) => r.ok), summarize(xss));

  // 独立复核（不信自测自己的结论，自己再查一遍 DOM）
  const domCheck = await session.evaluate(`(() => {
    const host = document.getElementById('kc-xss-selftest');
    if (host === null) return JSON.stringify({ found: false });
    const dangerous = host.querySelectorAll('script, img, iframe, svg, object, embed').length;
    const attrs = host.querySelectorAll('[onerror], [onload], [onclick]').length;
    return JSON.stringify({
      found: true,
      dangerous,
      attrs,
      fired: window.__kcXssFired === true,
      sampleText: (host.textContent ?? '').slice(0, 120),
      blockCount: host.querySelectorAll('.kc-block').length,
    });
  })()`);
  const dom = JSON.parse(domCheck);
  check('测试容器真的插进了 DOM（断言才有意义）', dom.found === true, domCheck);
  check('★ 页面里没有 script/img/iframe/svg 等危险元素', dom.dangerous === 0, `找到 ${dom.dangerous} 个`);
  check('★ 页面里没有 onerror/onload/onclick 属性', dom.attrs === 0, `找到 ${dom.attrs} 个`);
  check('★ 注入的脚本没有执行（哨兵未置位）', dom.fired === false, '哨兵被置位 = 有脚本跑了');
  check('攻击载荷以纯文本显示出来了', typeof dom.sampleText === 'string' && dom.sampleText.includes('<script>'), dom.sampleText);
  check('渲染出的块数不为 0（每个块都挂了容器）', dom.blockCount > 0, `块数 ${dom.blockCount}`);

  // 页面自己有没有发起可疑请求（XSS 的典型特征是偷着发请求）
  const suspicious = session.requests('evil');
  check('★ 没有向攻击者地址发过请求', suspicious.length === 0, JSON.stringify(suspicious));

  console.log('\n[4] 二期 DAO 在真 IndexedDB 上读写');
  // 注意：CDP 的 Runtime.evaluate 里不能用顶层 await，必须包一层 async IIFE
  const dataRows = await session.evaluate('(async () => JSON.stringify(await window.__kcselftest.data()))()');
  const data = JSON.parse(dataRows);
  check('数据层自测全部通过', data.every((r) => r.ok), summarize(data));

  const tableCheck = await session.evaluate(`(async () => {
    const req = indexedDB.open('blank-sheet-vocab');
    const db = await new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const names = [...db.objectStoreNames];
    db.close();
    return JSON.stringify(names);
  })()`);
  const names = JSON.parse(tableCheck);
  const need = ['words', 'sources', 'settings', 'sessions', 'knowledgeCards', 'dailyContextWords', 'examRecords', 'bankQuestions'];
  check('★ 真浏览器里 8 张表都在（一期 4 + 二期 4）', need.every((n) => names.includes(n)), names.join(', '));

  console.log('\n[5] 清理与收尾');
  const leftover = await session.evaluate(`(async () => {
    const host = document.getElementById('kc-xss-selftest');
    if (host !== null) host.remove();
    return document.getElementById('kc-xss-selftest') === null;
  })()`);
  check('页面上的测试内容已移除', leftover === true, String(leftover));

  // ── ⑥ 设置页渲染 + 单个分区失败时的隔离（用户实测报「设置界面渲染失败」）──
  // 这条抓的是一类真事故：设置页有 ~10 处 `void (async () => …)()`，
  // 任何一处异步失败都会变成**未捕获拒绝**，被错误边界接住后**整页**变成兜底页。
  console.log('\n[6] ★ 设置页：正常渲染 + 某一块坏掉时不拖垮整页');
  await session.evaluate(`(async () => {
    location.hash = '#/kc';
    await new Promise((r) => setTimeout(r, 400));
    location.hash = '#/kc/settings';
    await new Promise((r) => setTimeout(r, 800));
  })()`);
  const ok = await session.evaluate(`JSON.stringify({
    page: document.querySelector('.kc-set-page') !== null,
    sections: document.querySelectorAll('.kc-set-section').length,
    nums: document.querySelectorAll('.kc-set-num').length,
    buttons: document.querySelectorAll('.kc-set-btn').length,
    fatal: document.querySelector('.fatal-page') !== null,
  })`);
  const okv = JSON.parse(ok);
  check('★ 设置页打得开（四个分区都在）', okv.page === true && okv.sections >= 4, ok);
  check('公式参数输入框齐全（≥ 10 个）', okv.nums >= 10, String(okv.nums));
  check('按钮齐全（预设 / 保存 / 重算 / 清空）', okv.buttons >= 9, String(okv.buttons));
  check('没有掉进错误边界', okv.fatal === false, '');

  // 弄坏「二期卡片表」的事务：模拟陈旧连接（表不存在）
  const broken = await session.evaluate(`(async () => {
    const proto = IDBDatabase.prototype;
    if (window.__origTx === undefined) window.__origTx = proto.transaction;
    proto.transaction = function (store, mode) {
      if (String(store).includes('knowledgeCards')) throw new Error('模拟陈旧连接：表不存在');
      return window.__origTx.call(this, store, mode);
    };
    location.hash = '#/kc';
    await new Promise((r) => setTimeout(r, 400));
    location.hash = '#/kc/settings';
    await new Promise((r) => setTimeout(r, 1200));
    const page = document.querySelector('.kc-set-page');
    return JSON.stringify({
      rendered: page !== null,
      sections: document.querySelectorAll('.kc-set-section').length,
      fatal: document.querySelector('.fatal-page') !== null,
      routerFail: (document.querySelector('#app')?.textContent ?? '').includes('页面渲染失败'),
      toasts: [...document.querySelectorAll('.toast')].map((t) => t.textContent ?? ''),
    });
  })()`);
  const bv = JSON.parse(broken);
  check('★★ 表读不出来时设置页**仍然渲染出来**（不再整页变兜底页）', bv.rendered === true, broken);
  check('★★ 没有触发错误边界 / 也没变成「页面渲染失败」', bv.fatal === false && bv.routerFail === false, broken);
  check('★ 出错的那一块自己给了提示（其余分区照常可用）', bv.toasts.length > 0, JSON.stringify(bv.toasts));
  check('四个分区结构仍然完整', bv.sections >= 4, String(bv.sections));

  // 恢复原型，别影响后面的用例
  await session.evaluate(`(() => {
    if (window.__origTx !== undefined) IDBDatabase.prototype.transaction = window.__origTx;
    return true;
  })()`);
} catch (err) {
  failed += 1;
  console.error(`\n✗ 冒烟过程出错：${err instanceof Error ? err.message : String(err)}`);
} finally {
  if (session) await session.close().catch(() => {});
  if (chrome) chrome.proc.kill();
  server.kill();
}

console.log(`\n=== 二期界面冒烟：通过 ${passed} 项，失败 ${failed} 项 ===\n`);
process.exit(failed === 0 ? 0 : 1);
