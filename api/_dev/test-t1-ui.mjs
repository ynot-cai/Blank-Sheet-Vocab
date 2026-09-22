/**
 * T1 验收：布局调整改确认制 + 预览隔离 + 应用后 8 秒自动回滚 + 设置页骨架加固
 * 运行：`npm run test:t1-ui`（会自己起 vite dev，无需手动开服务器）
 *
 * ── 为什么必须有这一层 ──
 * T1 修的是**界面崩溃**，而崩溃只在真实浏览器里才存在：
 * `layout.mobile.button` 丢失导致的 `TypeError` 只有在设置页真的去读
 * `currentSettings().layout.mobile.button.diameterPx` 时才发生。
 * Node 里的纯函数测试（test-mobile / test-paper）永远看不到这一类问题。
 *
 * ── 验收项（每一条都出数字）──
 *  1. 确认机制：改预设/列数 → 背诵页不立即变化（未点应用）；出现「应用并预览」；
 *     点取消 → 恢复原值；点应用 → 落库 + 出现 8 秒观察条；
 *  2. 自动回滚：观察期内注入 throw → 自动回滚到 lastKnownGood、Toast、页不白屏、词库完好；
 *  3. 预览隔离：让预览 renderFn 抛异常 → 其他分组照常、预览区显示「预览不可用」；
 *  4. 未应用不落盘：改了不点应用直接刷新 → 配置仍是原值；
 *  5. 崩溃注入回归：旧版本会白屏的 8 种「残缺 layout」全部「白屏=否」；
 *  6. 分组隔离：某一组渲染失败时其他分组照常显示。
 */
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findBrowser, launch, openSession } from '../../scripts/cdp.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = 4241;
const CDP_PORT = 9397;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const MIRROR = 'blank-sheet-vocab.settings';
const SNAPSHOT = 'wp.layout.lastKnownGood';

let passed = 0;
let failed = 0;

/**
 * 一条断言。
 * @param {string} name 用例名
 * @param {boolean} ok 是否通过
 * @param {string} detail 失败时的具体数值
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

/** 起 vite dev */
function startDev() {
  const viteBin = join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  return spawn(process.execPath, [viteBin, '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: 'ignore' });
}

/** 等服务器就绪 */
async function waitForServer(url) {
  for (let i = 0; i < 120; i += 1) {
    try {
      if ((await fetch(url)).ok) return true;
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/** 注入到每个页面的错误收集器 */
const COLLECTOR = `
window.__t1Errors = [];
const _ce = console.error;
console.error = function (...a) { window.__t1Errors.push({ kind: 'console', msg: a.map(String).join(' ') }); return _ce.apply(console, a); };
window.addEventListener('error', (ev) => {
  window.__t1Errors.push({ kind: 'error', msg: String(ev.message || ev.type) });
});
window.addEventListener('unhandledrejection', (ev) => {
  const r = ev.reason;
  window.__t1Errors.push({ kind: 'rejection', msg: r instanceof Error ? r.message : String(r) });
});
`;

/** 读页面当前状态（白屏 / 致命页 / 分组数 / 异常数） */
const OBSERVE = `(() => ({
  fatal: !!document.querySelector('[data-role="fatal-page"]'),
  fatalMsg: document.querySelector('.fatal-msg')?.textContent ?? '',
  settingsPage: !!document.querySelector('.settings-page'),
  groups: [...document.querySelectorAll('.settings-page details.section')].map((d) => d.dataset.section),
  sectionFailed: !!document.querySelector('[data-role="settings-section-failed"]'),
  previewFailed: !!document.querySelector('[data-role="layout-preview-failed"]'),
  previewCards: document.querySelectorAll('.layout-preview-card').length,
  observeBanner: !!document.querySelector('[data-role="layout-observe"]'),
  dirtyWarn: !!document.querySelector('.layout-action-warn'),
  /**
   * 未捕获异常数（只看 window.onerror / unhandledrejection）。
   *
   * ★ 为什么不把 console.error 也算进来：被 try/catch 接住的错误**本来就该**打一条
   *   console.error（那是给开发者看的诊断），它恰恰证明隔离生效了。
   *   把两者混在一起数，会让「预览隔离成功」反而被断成「产生了未捕获异常」——
   *   这正是本脚本第一版踩的坑。
   */
  errCount: (window.__t1Errors ?? []).filter((e) => e.kind !== 'console').length,
  consoleErrCount: (window.__t1Errors ?? []).filter((e) => e.kind === 'console').length,
  errs: (window.__t1Errors ?? []).slice(0, 4),
  bodyLen: document.body.innerText.length,
}))()`;

/** 读 IndexedDB 里的设置真源（layout + colsOverride） */
const READ_DB_LAYOUT = `(() => new Promise((resolve) => {
  const req = indexedDB.open('blank-sheet-vocab');
  req.onsuccess = () => {
    const db = req.result;
    const tx = db.transaction('settings', 'readonly');
    const g = tx.objectStore('settings').get('main');
    g.onsuccess = () => {
      db.close();
      const v = g.result?.value ?? {};
      resolve(JSON.stringify({ layout: v.layout ?? null, cols: v.layoutColsOverride ?? null }));
    };
    g.onerror = () => { db.close(); resolve('读取失败'); };
  };
  req.onerror = () => resolve('打不开库');
}))()`;

/** 直接往 IndexedDB 写一份「残缺 layout」（复现旧版本会白屏的数据状态） */
const writeDbMobile = (json) => `(() => new Promise((resolve) => {
  const req = indexedDB.open('blank-sheet-vocab');
  req.onsuccess = () => {
    const db = req.result;
    const tx = db.transaction('settings', 'readwrite');
    const store = tx.objectStore('settings');
    const g = store.get('main');
    g.onsuccess = () => {
      const row = g.result ?? { key: 'main', value: {} };
      row.value = row.value ?? {};
      row.value.layout = row.value.layout ?? {};
      row.value.layout.mobile = ${json};
      store.put(row);
      tx.oncomplete = () => { db.close(); resolve(true); };
      tx.onerror = () => { db.close(); resolve(false); };
    };
    g.onerror = () => { db.close(); resolve(false); };
  };
  req.onerror = () => resolve(false);
}))()`;

/** 清空词库并写 3 个测试词（验「回滚不动数据」与「词库完好」） */
const SEED_WORDS = `(() => new Promise((resolve) => {
  const seeds = ['abandon', 'benefit', 'capable'];
  const req = indexedDB.open('blank-sheet-vocab');
  req.onsuccess = () => {
    const db = req.result;
    const tx = db.transaction(['words', 'sources'], 'readwrite');
    const store = tx.objectStore('words');
    store.clear();
    tx.objectStore('sources').clear();
    tx.objectStore('sources').put({ id: 'src-t1', name: 'T1 验收', priority: 3, createdAt: 1, updatedAt: 1, deleted: 0 });
    seeds.forEach((en, i) => {
      store.put({
        id: 'w-' + en, en, phonetic: '', example: '',
        senses: [{ id: 's-' + en, text: '释义' + (i + 1), aliases: [], enabled: true }],
        sourceId: 'src-t1', rawSources: [],
        attrs: { needSpell: false, failCount: 0, failCountTotal: 0, reviewCount: 0, lastReviewAt: null, learnedAt: null, reviewPriority: 0 },
        status: 'unlearned', priority: 3, learnOrder: null, createdAt: 1 + i, updatedAt: 1 + i, deleted: 0,
      });
    });
    tx.oncomplete = () => { db.close(); resolve(seeds.length); };
    tx.onerror = () => { db.close(); resolve(-1); };
  };
  req.onerror = () => resolve(-1);
}))()`;

/** 数词库里的词（验回滚不动数据） */
const COUNT_WORDS = `(() => new Promise((resolve) => {
  const req = indexedDB.open('blank-sheet-vocab');
  req.onsuccess = () => {
    const db = req.result;
    const tx = db.transaction('words', 'readonly');
    const g = tx.objectStore('words').count();
    g.onsuccess = () => { db.close(); resolve(g.result); };
    g.onerror = () => { db.close(); resolve(-1); };
  };
  req.onerror = () => resolve(-1);
}))()`;

const dev = startDev();
let browserProc = null;

try {
  if (!(await waitForServer(ORIGIN))) throw new Error('dev server 没起来');
  const browser = findBrowser();
  if (!browser) throw new Error('找不到 Chrome / Edge');
  const launched = await launch(browser, CDP_PORT, { windowSize: '1280,900' });
  browserProc = launched.proc;

  /**
   * 开一个新页面（装错误收集器、等 boot 完成）。
   * @param {string} hash 形如 '#/settings'
   * @param {number} waitMs 额外等待
   * @param {string} query 查询串（要放在 `#` **之前**，hash 里那一段是路由自己的 query）
   */
  async function open(hash, waitMs = 2400, query = '') {
    const s = await openSession(CDP_PORT, `${ORIGIN}/${query}${hash}`, { waitMs });
    await s.addInitScript(COLLECTOR);
    await s.reload(waitMs);
    return s;
  }

  /** 设置页里 C2 分组的选择器前缀 */
  const C2 = `[...document.querySelectorAll('.settings-page details.section')].find((d) => d.dataset.section === 'C2')`;

  // ═══════════════════════════════════════════════════════════════════
  console.log('\n════════ [0] 准备：清数据 + 写 3 个词 ════════');
  let page = await open('#/settings');
  await page.evaluate(SEED_WORDS);
  await page.evaluate(`localStorage.removeItem('${SNAPSHOT}')`);
  await page.evaluate(writeDbMobile('{"edgeMarginPx":8,"minGapPx":8,"fontSizePx":16,"targetCount":16,"button":{"diameterPx":50,"gapPx":16,"labelFontPx":12}}'));
  await page.close();

  // ═══════════════════════════════════════════════════════════════════
  console.log('\n════════ [1] 确认机制：改列数 → 不应用 → 背诵页不变化 ════════');
  page = await open('#/settings');
  const s1 = await page.evaluate(OBSERVE);
  check('设置页正常打开（8 个分组）', s1.settingsPage && s1.groups.length === 8, `分组=${JSON.stringify(s1.groups)}`);
  check('初始没有未应用提示', !s1.dirtyWarn, `dirtyWarn=${s1.dirtyWarn}`);
  check('预览渲染出 3 张卡（手机/平板/桌面）', s1.previewCards === 3, `previewCards=${s1.previewCards}`);

  const dbBefore = JSON.parse(await page.evaluate(READ_DB_LAYOUT));
  // 改列数：auto → 6（未点应用）
  await page.evaluate(`(() => {
    const sel = ${C2}.querySelector('select');
    sel.value = '6';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await new Promise((r) => setTimeout(r, 600));
  const s1b = await page.evaluate(OBSERVE);
  const dbAfterEdit = JSON.parse(await page.evaluate(READ_DB_LAYOUT));
  check('改完出现「⚠ 有未应用的修改」', s1b.dirtyWarn, `dirtyWarn=${s1b.dirtyWarn}`);
  check('出现「应用并预览」按钮', await page.evaluate(`!!${C2}.querySelector('.layout-action-apply')`));
  check('出现「取消」按钮', await page.evaluate(`!!${C2}.querySelector('.layout-action-cancel')`));
  check(
    '未点应用 → 库里 layoutColsOverride 仍是原值',
    dbAfterEdit.cols === dbBefore.cols,
    `改前=${JSON.stringify(dbBefore.cols)} 改后=${JSON.stringify(dbAfterEdit.cols)}`,
  );
  // 背诵页（换标签页看真实设置）
  const learnTabs = await open('#/learn');
  const learnCols = await learnTabs.evaluate(`(() => { try { return JSON.parse(localStorage.getItem('${MIRROR}')).layoutColsOverride; } catch (e) { return 'ERR'; } })()`);
  check('背诵页看到的列数没变（=auto）', learnCols === 'auto', `背诵页读到 ${JSON.stringify(learnCols)}`);
  await learnTabs.close();

  // ═══════════════════════════════════════════════════════════════════
  console.log('\n════════ [2] 取消 → 恢复原值 ════════');
  await page.evaluate(`${C2}.querySelector('.layout-action-cancel').click()`);
  await new Promise((r) => setTimeout(r, 500));
  const s2 = await page.evaluate(OBSERVE);
  const colsValueAfterCancel = await page.evaluate(`${C2}.querySelector('select').value`);
  check('取消后「未应用」提示消失', !s2.dirtyWarn, `dirtyWarn=${s2.dirtyWarn}`);
  check('取消后列数控件回到 auto', colsValueAfterCancel === 'auto', `控件值=${colsValueAfterCancel}`);
  check('取消后没有弹致命页', !s2.fatal, `fatal=${s2.fatal} msg=${s2.fatalMsg}`);

  // ═══════════════════════════════════════════════════════════════════
  console.log('\n════════ [3] 应用 → 落库 + 8 秒观察条 ════════');
  await page.evaluate(`(() => {
    const sel = ${C2}.querySelector('select');
    sel.value = '6';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await new Promise((r) => setTimeout(r, 400));
  await page.evaluate(`${C2}.querySelector('.layout-action-apply').click()`);
  await new Promise((r) => setTimeout(r, 900));
  const s3 = await page.evaluate(OBSERVE);
  const db3 = JSON.parse(await page.evaluate(READ_DB_LAYOUT));
  check('应用后出现 8 秒观察条', s3.observeBanner, `observeBanner=${s3.observeBanner}`);
  check('应用后没有弹致命页', !s3.fatal, `fatal=${s3.fatal} msg=${s3.fatalMsg}`);
  check('断言的落库值：layoutColsOverride = 6', db3.cols === 6, `实际=${JSON.stringify(db3.cols)}`);
  check(
    '★ 核心回归：应用后 layout.mobile.button 仍然完整',
    db3.layout?.mobile?.button?.diameterPx === 50,
    `mobile=${JSON.stringify(db3.layout?.mobile)}`,
  );
  // 点「我确认正常」收尾
  const confirmed = await page.evaluate(`(() => {
    const btn = document.querySelector('[data-role="layout-observe"] .layout-observe-ok');
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
  await new Promise((r) => setTimeout(r, 400));
  const s3b = await page.evaluate(OBSERVE);
  check('点「我确认正常」后观察条消失', confirmed && !s3b.observeBanner, `confirmed=${confirmed} banner=${s3b.observeBanner}`);
  check(
    '确认后 lastKnownGood 已更新为 6 列',
    (await page.evaluate(`(() => { try { return JSON.parse(localStorage.getItem('${SNAPSHOT}')).colsOverride; } catch (e) { return 'ERR'; } })()`)) === 6,
  );
  await page.close();

  // ═══════════════════════════════════════════════════════════════════
  console.log('\n════════ [4] 自动回滚：观察期内注入 throw ════════');
  page = await open('#/settings');
  const wordsBefore = await page.evaluate(COUNT_WORDS);
  // 先确认已回到 8 列基线（lastKnownGood=6，这里的「应用」目标是 8）
  await page.evaluate(`(() => {
    const sel = ${C2}.querySelector('select');
    sel.value = '8';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await new Promise((r) => setTimeout(r, 400));
  await page.evaluate(`${C2}.querySelector('.layout-action-apply').click()`);
  await new Promise((r) => setTimeout(r, 900));
  const dbApplied = JSON.parse(await page.evaluate(READ_DB_LAYOUT));
  check('应用 8 列已落库', dbApplied.cols === 8, `实际=${JSON.stringify(dbApplied.cols)}`);
  // 在观察期内制造一个未捕获异常
  await page.evaluate(`(() => { setTimeout(() => { throw new Error('（注入）观察期内的异常'); }, 0); return true; })()`);
  await new Promise((r) => setTimeout(r, 1500));
  const s4 = await page.evaluate(OBSERVE);
  const dbRolled = JSON.parse(await page.evaluate(READ_DB_LAYOUT));
  const wordsAfter = await page.evaluate(COUNT_WORDS);
  check('★ 检测到异常后自动回滚：layoutColsOverride 回到 6', dbRolled.cols === 6, `实际=${JSON.stringify(dbRolled.cols)}`);
  check('回滚后页面不白屏（设置页还在）', s4.settingsPage && s4.bodyLen > 200, `settingsPage=${s4.settingsPage} bodyLen=${s4.bodyLen}`);
  check('回滚后致命页已被撤掉', !s4.fatal, `fatal=${s4.fatal} msg=${s4.fatalMsg}`);
  check('回滚后观察条消失', !s4.observeBanner, `observeBanner=${s4.observeBanner}`);
  check('回滚不删数据：词库仍是 3 个词', wordsAfter === wordsBefore && wordsAfter === 3, `前=${wordsBefore} 后=${wordsAfter}`);
  const rollbackToast = await page.evaluate(`[...document.querySelectorAll('.toast')].map((t) => t.textContent).join(' | ')`);
  check('回滚有 Toast 提示', /已检测到异常并还原/.test(rollbackToast), `toast=${JSON.stringify(rollbackToast)}`);
  check(
    '★ 核心回归：回滚后的 layout.mobile.button 仍完整',
    dbRolled.layout?.mobile?.button?.diameterPx === 50,
    `mobile=${JSON.stringify(dbRolled.layout?.mobile)}`,
  );
  await page.close();

  // ═══════════════════════════════════════════════════════════════════
  console.log('\n════════ [5] 预览隔离：让预览 renderFn 抛异常 ════════');
  page = await open('#/settings', 2400, '?bustPreview=1');
  const s5 = await page.evaluate(OBSERVE);
  check('预览抛异常时显示「预览不可用」', s5.previewFailed, `previewFailed=${s5.previewFailed}`);
  check('★ 预览崩了但设置页 8 个分组照常显示', s5.groups.length === 8, `分组=${JSON.stringify(s5.groups)}`);
  check('预览崩了但没弹致命页', !s5.fatal, `fatal=${s5.fatal} msg=${s5.fatalMsg}`);
  check('预览崩了但 C2 控件仍可用（能找到应用按钮容器）', await page.evaluate(`!!${C2}.querySelector('.layout-action-bar')`));
  /**
   * ★ 这里读 `textContent` 而不是 `innerText`：C2 分组默认是**折叠**的，
   *   而 `innerText` 对未渲染内容返回空串（它按 CSS 可见性算）。
   *   第一版测试就是栽在这上面 —— 按钮明明在 DOM 里，断言却拿到空字符串。
   *   顺带把折叠打开，让文本真的是「用户看得见」的那一份。
   */
  await page.evaluate(`(() => { const c2 = ${C2}; if (c2) c2.open = true; return true; })()`);
  await new Promise((r) => setTimeout(r, 200));
  const previewFallbackText = await page.evaluate(
    `document.querySelector('[data-role="layout-preview-failed"]')?.textContent ?? ''`,
  );
  check(
    '预览失败提示带两个出口（改用适中预设 / 取消修改）',
    /改用适中预设/.test(previewFallbackText) && /取消修改/.test(previewFallbackText),
    JSON.stringify(previewFallbackText),
  );
  check(
    '预览失败没有产生**未捕获**异常（只有一条 console.error 诊断）',
    s5.errCount === 0,
    `未捕获=${s5.errCount} console=${s5.consoleErrCount} errs=${JSON.stringify(s5.errs)}`,
  );
  await page.close();

  // ═══════════════════════════════════════════════════════════════════
  console.log('\n════════ [6] 未应用不落盘：改了不点应用直接刷新 ════════');
  page = await open('#/settings');
  const db6Before = JSON.parse(await page.evaluate(READ_DB_LAYOUT));
  await page.evaluate(`(() => {
    const inputs = ${C2}.querySelectorAll('input[type=number]');
    inputs[0].value = '55';
    inputs[0].dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await new Promise((r) => setTimeout(r, 400));
  const dirty6 = await page.evaluate(OBSERVE);
  check('改动后出现未应用提示', dirty6.dirtyWarn, `dirtyWarn=${dirty6.dirtyWarn}`);
  await page.reload(2200);
  const db6After = JSON.parse(await page.evaluate(READ_DB_LAYOUT));
  const inputBack = await page.evaluate(`${C2}.querySelectorAll('input[type=number]')[0].value`);
  check(
    '★ 刷新后配置仍是原值（未应用不落盘）',
    JSON.stringify(db6After) === JSON.stringify(db6Before),
    `刷新前=${JSON.stringify(db6Before)} 刷新后=${JSON.stringify(db6After)}`,
  );
  check('刷新后输入框显示已保存值（55 被丢弃）', inputBack !== '55', `输入框=${inputBack}`);
  check('刷新后没有未应用提示', !(await page.evaluate(OBSERVE)).dirtyWarn);
  await page.close();

  // ═══════════════════════════════════════════════════════════════════
  console.log('\n════════ [7] 崩溃注入回归：8 种残缺 layout 全部「白屏=否」 ════════');
  const dirtyCases = [
    ['layout.mobile = {} 缺全部字段', '{}'],
    ['layout.mobile.button = null', '{"button":null}'],
    ['layout.mobile.button = {} 缺字段', '{"button":{}}'],
    ['只留 edgeMarginPx（旧版本崩溃后的落库状态）', '{"edgeMarginPx":18}'],
    ['fontSizePx = null', '{"fontSizePx":null}'],
    ['fontSizePx = "abc"', '{"fontSizePx":"abc"}'],
    ['button.diameterPx = -1e9', '{"button":{"diameterPx":-1000000000}}'],
    ['edgeMarginPx = 1e9', '{"edgeMarginPx":1000000000}'],
  ];
  const rows = [];
  for (const [label, json] of dirtyCases) {
    const seed = await open('#/settings', 1800);
    await seed.evaluate(writeDbMobile(json));
    await seed.close();

    const sPage = await open('#/settings', 2400);
    const st = await sPage.evaluate(OBSERVE);
    await sPage.close();
    const lPage = await open('#/learn', 2400);
    const lt = await lPage.evaluate(OBSERVE);
    await lPage.close();

    rows.push({
      用例: label,
      设置页白屏: st.fatal ? '是' : '否',
      设置页分组: st.groups.length,
      设置页异常: st.errCount,
      背诵页白屏: lt.fatal ? '是' : '否',
      背诵页异常: lt.errCount,
    });
    console.log(
      `   ${label}\n      设置页: 白屏=${st.fatal ? '是' : '否'} 分组=${st.groups.length} 异常=${st.errCount}\n` +
        `      背诵页: 白屏=${lt.fatal ? '是' : '否'} 异常=${lt.errCount}`,
    );
  }
  console.log('\n   崩溃注入汇总表：');
  console.table(rows);
  check(
    '★ 8 种脏数据全部「白屏=否」（设置页）',
    rows.every((r) => r.设置页白屏 === '否'),
    JSON.stringify(rows.filter((r) => r.设置页白屏 === '是')),
  );
  check(
    '★ 8 种脏数据全部「白屏=否」（背诵页）',
    rows.every((r) => r.背诵页白屏 === '否'),
    JSON.stringify(rows.filter((r) => r.背诵页白屏 === '是')),
  );
  check(
    '★ 8 种脏数据下设置页 8 个分组都在（不再整页打不开）',
    rows.every((r) => r.设置页分组 === 8),
    JSON.stringify(rows.map((r) => r.设置页分组)),
  );

  // ═══════════════════════════════════════════════════════════════════
  console.log('\n════════ [8] 收尾：恢复默认布局 ════════');
  page = await open('#/settings');
  await page.evaluate(writeDbMobile('{"edgeMarginPx":8,"minGapPx":8,"fontSizePx":16,"targetCount":16,"button":{"diameterPx":50,"gapPx":16,"labelFontPx":12}}'));
  await page.evaluate(`(() => {
    const req = indexedDB.open('blank-sheet-vocab');
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('settings', 'readwrite');
      const store = tx.objectStore('settings');
      const g = store.get('main');
      g.onsuccess = () => {
        const row = g.result ?? { key: 'main', value: {} };
        row.value.layoutColsOverride = 'auto';
        store.put(row);
        tx.oncomplete = () => db.close();
      };
    };
    return true;
  })()`);
  await page.evaluate(`localStorage.removeItem('${SNAPSHOT}')`);
  await new Promise((r) => setTimeout(r, 600));
  const finalState = await page.evaluate(OBSERVE);
  check('收尾后设置页正常、无致命页', finalState.settingsPage && !finalState.fatal, `fatal=${finalState.fatal}`);
  await page.close();
} catch (err) {
  console.error('T1 验收脚本出错：', err);
  failed += 1;
} finally {
  dev.kill();
  if (browserProc) browserProc.kill();
}

console.log(`\n════ T1 验收结果：${passed} 通过 / ${failed} 失败 ════`);
if (failed > 0) {
  console.log('任一项 FAIL —— 不许声称完成。');
  process.exit(1);
}
process.exit(0);
