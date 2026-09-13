/**
 * 阶段 03 的**真浏览器**冒烟：`npm run test:kc-edit-ui`（需要本机有 Chrome / Edge）
 *
 * 验「点按钮」的那一半（Node 测不到的部分）：
 *   2. 编辑一张卡：改标题、加 tip 块、上移、删除 → 保存后重新打开，改动都在
 *   3. 8 种块都能新建 + 预览能渲染
 *   4. 表格能加行加列
 *   5. 列表页搜索命中块内容、按考法筛选、按掌握度排序
 *   6. 斩 → 默认视图消失 → 切「已斩」能看到 → 复活
 *   8. 编辑器里输入 <script> → 预览渲染成纯文本
 *
 * 不需要任何密钥，也不碰网络。
 */
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findBrowser, launch, openSession, serveStatic } from '../../scripts/cdp.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = 4186;
const CDP_PORT = 9226;
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
 * 等页面挂载（Vite dev 首次编译整张模块图要几秒）。
 * @param {object} session CDP 会话
 * @param {number} timeoutMs 最长等待
 */
async function waitForMount(session, timeoutMs = 30_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const ok = await session.evaluate(`document.querySelector('#app .nav') !== null`);
    if (ok === true) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

/**
 * 切路由并等目标元素出现。
 * @param {object} session CDP 会话
 * @param {string} hash 目标 hash
 * @param {string} selector 渲染完成标志
 */
async function goto(session, hash, selector) {
  await session.evaluate(`(async () => { location.hash = '${hash}'; await new Promise((r) => setTimeout(r, 200)); })()`);
  for (let i = 0; i < 80; i += 1) {
    const found = await session.evaluate(`document.querySelector('${selector}') !== null`);
    if (found === true) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

const browser = findBrowser();
if (!browser) {
  console.log('\n⚠ 本机没有 Chrome / Edge，跳过阶段 03 界面冒烟（数据层已由 test:kc-edit 覆盖）');
  process.exit(0);
}
console.log(`  用 ${browser.split('\\').pop()} 跑无头检查`);

const server = serveStatic({ root: ROOT, port: PORT, mode: 'dev' });

let chrome = null;
let session = null;
try {
  if (!(await waitForServer(`${ORIGIN}/`))) throw new Error('dev 服务没起来');
  // ⚠️ 无头窗口默认宽度不到 768px，页面会走**手机卡片流**（表格根本不渲染）。
  // 这个测试要验桌面表格，所以显式要一个 1280 宽的窗口。
  chrome = await launch(browser, CDP_PORT, { windowSize: '1280,900' });
  session = await openSession(CDP_PORT, `${ORIGIN}/#/kc`, { waitMs: 800 });
  const mounted = await waitForMount(session);
  check('应用挂载成功', mounted === true, '等了 30 秒还没挂载');
  const viewport = await session.evaluate('JSON.stringify({ w: window.innerWidth, narrow: window.matchMedia("(max-width: 767px)").matches })');
  check('视口是桌面宽度（列表才会用表格）', JSON.parse(viewport).narrow === false, viewport);

  // ── 造数据（用页面里的 dao，走真实存储） ──
  console.log('\n[0] 造测试数据');
  const seeded = await session.evaluate(`(async () => {
    const kc = await import('/src/dao/kc.ts');
    const model = await import('/src/core/kcModel.ts');
    await kc.clearAll();
    const mk = (title, summary, blocks, tags, mastery, priority) => {
      const c = model.createEmptyCard(title);
      c.summary = summary;
      c.blocks = blocks;
      c.examTags = tags;
      c.attrs.mastery = mastery;
      c.attrs.reviewPriority = priority;
      return c;
    };
    const cards = [
      mk('定语从句', '关系代词', [{ id: 'a1', type: 'text', content: '关系代词在从句中作主语' }], ['fill', 'choice'], 0.2, 9),
      mk('虚拟语气', 'should 省略', [{ id: 'a2', type: 'heading', content: '虚拟语气的三种时态' }], ['sentence'], 0.8, 5),
      mk('非谓语动词', 'doing vs done', [{ id: 'a3', type: 'tip', content: '记住 being done 的用法' }], ['judge'], 0.5, 7),
    ];
    await kc.bulkUpsert(cards);
    return JSON.stringify({ count: cards.length, editId: cards[0].id });
  })()`);
  const seed = JSON.parse(seeded);
  check('3 张测试卡片已入库', seed.count === 3, seeded);
  const editId = seed.editId;

  // ── 列表页 ──
  console.log('\n[1] 卡片列表页（验收标准 5）');
  const listPageReady = await goto(session, '#/kc/list', '.kc-list-table tbody tr');
  check('列表页渲染出来（等到了数据行）', listPageReady === true, '等不到 .kc-list-table tbody tr');
  const listInfo = await session.evaluate(`JSON.stringify({
    tables: document.querySelectorAll('.kc-list-table').length,
    trs: document.querySelectorAll('.kc-list-table tr').length,
    tbodyTrs: document.querySelectorAll('.kc-list-table tbody tr').length,
    rowClass: document.querySelectorAll('.kc-row').length,
    host: (document.querySelector('.kc-list-host')?.innerHTML ?? '').slice(0, 300),
    statNums: [...document.querySelectorAll('.kc-statcell-num')].map((e) => e.textContent),
    titles: [...document.querySelectorAll('.kc-row-title')].map((e) => e.textContent),
  })`);
  const list = JSON.parse(listInfo);
  check('★ 列出 3 张卡', list.tbodyTrs === 3, `tables=${list.tables} tr=${list.trs} tbodyTr=${list.tbodyTrs} rowClass=${list.rowClass}`);
  check('统计条显示 3 张', list.statNums[0] === '3', list.statNums.join(','));
  check('默认按复习优先度降序（定语从句 9 在最前）', list.titles[0] === '定语从句', list.titles.join(' | '));

  // 搜索命中块内容
  const searched = await session.evaluate(`(async () => {
    const input = document.querySelector('.kc-search');
    input.value = '作主语';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 700));
    return JSON.stringify({ rows: document.querySelectorAll('.kc-list-table tbody tr').length, rowClass: document.querySelectorAll('.kc-row').length, titles: [...document.querySelectorAll('.kc-row-title')].map((e) => e.textContent) });
  })()`);
  const sr = JSON.parse(searched);
  check('★ 搜「作主语」命中 1 张（搜得到块内容）', sr.rows === 1 && sr.titles[0] === '定语从句', JSON.stringify(sr));

  // 按考法筛选
  const filtered = await session.evaluate(`(async () => {
    const input = document.querySelector('.kc-search');
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 700));
    const sel = [...document.querySelectorAll('.kc-filter-select')][0];
    sel.value = 'judge';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 500));
    return JSON.stringify({ rows: document.querySelectorAll('.kc-list-table tbody tr').length, rowClass: document.querySelectorAll('.kc-row').length, titles: [...document.querySelectorAll('.kc-row-title')].map((e) => e.textContent) });
  })()`);
  const fr = JSON.parse(filtered);
  check('★ 按考法「判断正误」筛选只剩 1 张', fr.rows === 1 && fr.titles[0] === '非谓语动词', JSON.stringify(fr));

  // 按掌握度排序
  const sorted = await session.evaluate(`(async () => {
    const sel = [...document.querySelectorAll('.kc-filter-select')][0];
    sel.value = '';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 500));
    const sortSel = [...document.querySelectorAll('.kc-filter-select')][1];
    sortSel.value = 'mastery';
    sortSel.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 500));
    return JSON.stringify({ titles: [...document.querySelectorAll('.kc-row-title')].map((e) => e.textContent) });
  })()`);
  const so = JSON.parse(sorted);
  check('★ 按掌握度降序：虚拟语气(0.8) 在最前', so.titles[0] === '虚拟语气', so.titles.join(' | '));
  check('掌握度可视化：有三色点与百分比', (await session.evaluate(`document.querySelectorAll('.kc-mastery-dots').length > 0 && document.querySelectorAll('.kc-mastery-pct').length > 0`)) === true, '');

  // ── 编辑器 ──
  console.log('\n[2] 块编辑器（验收标准 2 / 3 / 4 / 8）');
  check('编辑页打得开', (await goto(session, `#/kc/edit?id=${editId}`, '.kc-editor')) === true, '等不到编辑器');
  const initial = await session.evaluate(`JSON.stringify({
    title: document.querySelector('.kc-title-input')?.value,
    blocks: document.querySelectorAll('.kc-editor-block').length,
    types: [...document.querySelectorAll('.kc-type-tag')].map((e) => e.textContent),
    insertBtns: [...document.querySelectorAll('.kc-insert-btn')].map((e) => e.textContent),
  })`);
  const ini = JSON.parse(initial);
  check('标题读出来了', ini.title === '定语从句', String(ini.title));
  check('原有 1 个块', ini.blocks === 1, String(ini.blocks));
  check('★ 新增块工具条有 8 个按钮', ini.insertBtns.length === 8, ini.insertBtns.join(','));
  check('工具条覆盖 8 种类型', ['标题', '正文', '例句', '列表', '表格', '代码', '引用', '提示'].every((t) => ini.insertBtns.some((b) => b.includes(t))), ini.insertBtns.join(','));

  // 改标题 + 加 tip 块 + 改文本
  const edited = await session.evaluate(`(async () => {
    const title = document.querySelector('.kc-title-input');
    title.value = '改过的标题';
    title.dispatchEvent(new Event('input', { bubbles: true }));

    // 点「＋提示」加一个 tip 块
    const tipBtn = [...document.querySelectorAll('.kc-insert-btn')].find((b) => b.textContent.includes('提示'));
    tipBtn.click();
    await new Promise((r) => setTimeout(r, 200));

    // 在新块的 textarea 里输入内容
    const blocks = [...document.querySelectorAll('.kc-editor-block')];
    const last = blocks[blocks.length - 1];
    const ta = last.querySelector('textarea');
    ta.value = '这是易错点';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 200));

    return JSON.stringify({
      blockCount: document.querySelectorAll('.kc-editor-block').length,
      types: [...document.querySelectorAll('.kc-type-tag')].map((e) => e.textContent),
    });
  })()`);
  const ed = JSON.parse(edited);
  check('★ 加了 tip 块后共 2 块', ed.blockCount === 2, String(ed.blockCount));
  check('新块类型标签是「提示」', ed.types.includes('提示'), ed.types.join(','));

  // 再加 6 种块，凑齐 8 种（表格/列表/例句/代码/引用/标题）
  const allTypes = await session.evaluate(`(async () => {
    for (const label of ['标题', '例句', '列表', '表格', '代码', '引用']) {
      const btn = [...document.querySelectorAll('.kc-insert-btn')].find((b) => b.textContent.includes(label));
      btn.click();
      await new Promise((r) => setTimeout(r, 150));
    }
    return JSON.stringify({
      blockCount: document.querySelectorAll('.kc-editor-block').length,
      types: [...document.querySelectorAll('.kc-type-tag')].map((e) => e.textContent),
    });
  })()`);
  const at = JSON.parse(allTypes);
  check('★ 8 种块全部新建成功', at.blockCount === 8, `块数 ${at.blockCount}`);
  check('8 种类型标签齐全', ['标题', '正文', '例句', '列表', '表格', '代码', '引用', '提示'].every((t) => at.types.includes(t)), at.types.join(','));

  // 表格加行加列（★ 表格没有表头行：所有格子都是 td，第一行也是数据格）
  const tableOps = await session.evaluate(`(async () => {
    const card = [...document.querySelectorAll('.kc-editor-block')].find((b) => b.querySelector('.kc-table-edit'));
    const before = {
      rows: card.querySelectorAll('tr').length,
      cols: card.querySelectorAll('tr:first-child td:not(.kc-table-edit-ops)').length,
      ths: card.querySelectorAll('th').length,
      hint: card.querySelector('.kc-hint-dim')?.textContent ?? '',
      firstCellTag: card.querySelector('tr:first-child td')?.tagName ?? '',
    };
    [...card.querySelectorAll('button')].find((b) => b.textContent.includes('加一行')).click();
    await new Promise((r) => setTimeout(r, 150));
    const card2 = [...document.querySelectorAll('.kc-editor-block')].find((b) => b.querySelector('.kc-table-edit'));
    [...card2.querySelectorAll('button')].find((b) => b.textContent.includes('加一列')).click();
    await new Promise((r) => setTimeout(r, 150));
    const card3 = [...document.querySelectorAll('.kc-editor-block')].find((b) => b.querySelector('.kc-table-edit'));
    const after = { rows: card3.querySelectorAll('tr').length, cols: card3.querySelectorAll('tr:first-child td:not(.kc-table-edit-ops)').length };
    return JSON.stringify({ before, after });
  })()`);
  const to = JSON.parse(tableOps);
  check('★ 表格加行生效（2 → 3 行）', to.after.rows === to.before.rows + 1, JSON.stringify(to));
  check('★ 表格加列生效', to.after.cols === to.before.cols + 1, JSON.stringify(to));
  check('★ 表格编辑器里没有 th（第一行也是数据格）', to.before.ths === 0 && to.before.firstCellTag === 'TD', JSON.stringify(to.before));
  check('★ 编辑器文案不再说「第一行是表头」', !to.before.hint.includes('第一行是表头') && to.before.hint.includes('不写表头'), to.before.hint);

  // 上移一个块（把最后一个 tip 移到第一位）
  const moved = await session.evaluate(`(async () => {
    // 精确定位「提示」块（更早的 table 测试里我在表格单元里输入过 \u2191 字符，
    // 用 find(b => b.textContent === '↑') 可能选中输入框里的内容，所以按块类型找）
    const tipBlock = [...document.querySelectorAll('.kc-editor-block--tip')][0];
    const before = [...document.querySelectorAll('.kc-type-tag')].map((e) => e.textContent);
    [...tipBlock.querySelectorAll('.kc-editor-block-tools button')].find((b) => b.textContent === '↑').click();
    await new Promise((r) => setTimeout(r, 250));
    const after = [...document.querySelectorAll('.kc-type-tag')].map((e) => e.textContent);
    const iBefore = before.indexOf('提示');
    const iAfter = after.indexOf('提示');
    return JSON.stringify({ iBefore, iAfter, after });
  })()`);
  const mv = JSON.parse(moved);
  check('★ 上移生效（提示块的下标往前移了一位）', mv.iAfter === mv.iBefore - 1, JSON.stringify(mv));

  // 删除一块（stub confirm 返回 true）
  const deleted = await session.evaluate(`(async () => {
    window.confirm = () => true;
    const blocks = [...document.querySelectorAll('.kc-editor-block')];
    const before = blocks.length;
    [...blocks[0].querySelectorAll('button')].find((b) => b.textContent === '删除').click();
    await new Promise((r) => setTimeout(r, 200));
    return JSON.stringify({ before, after: document.querySelectorAll('.kc-editor-block').length });
  })()`);
  const dl = JSON.parse(deleted);
  check('★ 删除块生效（8 → 7）', dl.after === dl.before - 1, JSON.stringify(dl));

  // 在正文块里输入 XSS 载荷
  const xss = await session.evaluate(`(async () => {
    const block = [...document.querySelectorAll('.kc-editor-block')].find((b) => [...b.classList].includes('kc-editor-block--text'));
    const ta = block.querySelector('textarea');
    ta.value = '<script>window.__kcXssFired=true</script>';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 200));
    return 'ok';
  })()`);
  check('XSS 载荷已输入编辑器', xss === 'ok', '');

  // 预览：渲染成纯文本
  const preview = await session.evaluate(`(async () => {
    [...document.querySelectorAll('.kc-editor-head button')].find((b) => b.textContent === '预览').click();
    await new Promise((r) => setTimeout(r, 300));
    const host = document.querySelector('.kc-editor-preview');
    return JSON.stringify({
      exists: host !== null,
      danger: host ? host.querySelectorAll('script, img, svg, iframe').length : -1,
      onAttrs: host ? host.querySelectorAll('[onerror], [onload]').length : -1,
      text: host ? host.textContent : '',
      tables: host ? host.querySelectorAll('table').length : 0,
      ths: host ? host.querySelectorAll('table th').length : 0,
      lis: host ? host.querySelectorAll('li').length : 0,
    });
  })()`);
  const pv = JSON.parse(preview);
  check('预览模式渲染出来了', pv.exists === true, '');
  check('★ 预览里没有 script/img/svg/iframe', pv.danger === 0, `找到 ${pv.danger}`);
  check('★ 预览里没有 onerror/onload 属性', pv.onAttrs === 0, `找到 ${pv.onAttrs}`);
  check('★ <script> 以纯文本显示在预览里', pv.text.includes('<script>'), '');
  check('预览里表格渲染成真 table', pv.tables === 1, String(pv.tables));
  check('★ 预览里也没有 th（表格无表头）', pv.ths === 0, String(pv.ths));
  check('哨兵未置位', (await session.evaluate('window.__kcXssFired === undefined')) === true, '');

  // 回到编辑态 → 离开页面（触发 flush 保存）→ 重新打开
  const saved = await session.evaluate(`(async () => {
    [...document.querySelectorAll('.kc-editor-head button')].find((b) => b.textContent === '回到编辑').click();
    await new Promise((r) => setTimeout(r, 200));
    // 切走页面会 flush 未保存的改动
    location.hash = '#/kc/list';
    await new Promise((r) => setTimeout(r, 1200));
    const kc = await import('/src/dao/kc.ts');
    const card = await kc.getById('${editId}');
    return JSON.stringify({
      title: card?.title,
      blocks: card?.blocks.length,
      hasXssBlock: card?.blocks.some((b) => (b.content ?? '').includes('<script>')),
    });
  })()`);
  const sv = JSON.parse(saved);
  check('★ 标题改动已自动保存', sv.title === '改过的标题', String(sv.title));
  check('★ 块改动已保存（7 个块）', sv.blocks === 7, `块数 ${sv.blocks}`);
  check('★ XSS 载荷原样存进库里（渲染层负责安全）', sv.hasXssBlock === true, '');

  // 重新打开编辑页确认改动还在（验收标准 2 的「重新打开，改动都在」）
  const reopened = await session.evaluate(`(async () => {
    location.hash = '#/kc/edit?id=${editId}';
    for (let i = 0; i < 60; i += 1) {
      await new Promise((r) => setTimeout(r, 200));
      if (document.querySelectorAll('.kc-editor-block').length > 0) break;
    }
    return JSON.stringify({
      title: document.querySelector('.kc-title-input')?.value,
      blocks: document.querySelectorAll('.kc-editor-block').length,
      types: [...document.querySelectorAll('.kc-type-tag')].map((e) => e.textContent),
    });
  })()`);
  const ro = JSON.parse(reopened);
  check('★ 重新打开编辑页，改动都在（标题）', ro.title === '改过的标题', String(ro.title));
  check('★ 重新打开编辑页，改动都在（块数与类型）', ro.blocks === 7 && ro.types.includes('表格'), `${ro.blocks} 块 / ${ro.types.join(',')}`);

  // ── 斩 / 复活 ──
  console.log('\n[3] 斩 / 复活（验收标准 6）');
  const chopped = await session.evaluate(`(async () => {
    location.hash = '#/kc/list';
    for (let i = 0; i < 60; i += 1) {
      await new Promise((r) => setTimeout(r, 200));
      if (document.querySelector('.kc-list-table')) break;
    }
    const rows = [...document.querySelectorAll('.kc-list-table tbody tr')];
    const target = rows.find((r) => r.textContent.includes('改过的标题')) ?? rows[0];
    [...target.querySelectorAll('button')].find((b) => b.textContent === '斩').click();
    await new Promise((r) => setTimeout(r, 900));
    return JSON.stringify({
      rows: document.querySelectorAll('.kc-list-table tbody tr').length,
      titles: [...document.querySelectorAll('.kc-row-title')].map((e) => e.textContent),
    });
  })()`);
  const ch = JSON.parse(chopped);
  check('★ 斩掉后从默认视图消失（3 → 2）', ch.rows === 2, JSON.stringify(ch));

  const revived = await session.evaluate(`(async () => {
    // 点统计条上的「已斩」切到已斩视图
    const cell = [...document.querySelectorAll('.kc-statcell')].find((c) => c.textContent.includes('已斩'));
    cell.click();
    await new Promise((r) => setTimeout(r, 700));
    const rows = [...document.querySelectorAll('.kc-list-table tbody tr')];
    const titles = [...document.querySelectorAll('.kc-row-title')].map((e) => e.textContent);
    const target = rows[0];
    const reviveBtn = [...target.querySelectorAll('button')].find((b) => b.textContent === '复活');
    if (reviveBtn) reviveBtn.click();
    await new Promise((r) => setTimeout(r, 900));
    return JSON.stringify({ choppedTitles: titles, afterReviveRows: document.querySelectorAll('.kc-list-table tbody tr').length });
  })()`);
  const rv = JSON.parse(revived);
  check('★ 「已斩」视图里能看到它', rv.choppedTitles.includes('改过的标题'), rv.choppedTitles.join(' | '));
  check('★ 复活后从已斩视图消失', rv.afterReviveRows === 0, String(rv.afterReviveRows));

  await session.evaluate(`(async () => {
    const kc = await import('/src/dao/kc.ts');
    await kc.clearAll();
  })()`);
} catch (err) {
  failed += 1;
  console.error(`\n✗ 冒烟过程出错：${err instanceof Error ? err.message : String(err)}`);
} finally {
  if (session) await session.close().catch(() => {});
  if (chrome) chrome.proc.kill();
  server.kill();
}

console.log(`\n=== 阶段 03 界面冒烟：通过 ${passed} 项，失败 ${failed} 项 ===\n`);
process.exit(failed === 0 ? 0 : 1);
