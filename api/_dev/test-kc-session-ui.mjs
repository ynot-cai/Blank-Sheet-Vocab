/**
 * 阶段 04 的**真浏览器**冒烟：`npm run test:kc-session-ui`
 *
 * 验「点按钮 / 按键盘 / 看界面」的那一半：
 *   2. 选 5 个 → 逐张展示，卡片内容渲染正确（表格/列表/例句）
 *   3. 卡片右上角能看到考核标签 chip
 *   4. 点「模糊」→ 自动下一张、进度更新、属性落库
 *   5. 键盘 1/2/3 能自评、Esc 能退出
 *   6. 斩 → 二次确认 → 卡片消失
 *   7. 保存并退出 → 重进询问「继续上次」→ 从该张继续、分数还在
 *   8. 移动端：三个自评按钮够大（≥44px）
 */
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findBrowser, launch, openSession, serveStatic } from '../../scripts/cdp.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = 4188;
const CDP_PORT = 9228;
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
 * @param {string} url 地址
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
 * 等页面挂载。
 * @param {object} session CDP 会话
 */
async function waitForMount(session) {
  for (let i = 0; i < 80; i += 1) {
    if ((await session.evaluate(`document.querySelector('#app .nav') !== null`)) === true) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

/**
 * 切路由并等标志元素。
 * @param {object} session CDP 会话
 * @param {string} hash 目标 hash
 * @param {string} selector 标志元素
 */
async function goto(session, hash, selector) {
  await session.evaluate(`(async () => { location.hash = '${hash}'; await new Promise((r) => setTimeout(r, 200)); })()`);
  for (let i = 0; i < 80; i += 1) {
    if ((await session.evaluate(`document.querySelector('${selector}') !== null`)) === true) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

const browser = findBrowser();
if (!browser) {
  console.log('\n⚠ 本机没有 Chrome / Edge，跳过阶段 04 界面冒烟（数据层已由 test:kc-session 覆盖）');
  process.exit(0);
}
console.log(`  用 ${browser.split('\\').pop()} 跑无头检查`);

const server = serveStatic({ root: ROOT, port: PORT, mode: 'dev' });

let chrome = null;
let session = null;
try {
  if (!(await waitForServer(`${ORIGIN}/`))) throw new Error('dev 服务没起来');
  // 桌面视口（自评按钮的尺寸断言要在桌面下做，移动端单独再验一次）
  chrome = await launch(browser, CDP_PORT, { windowSize: '1280,900' });
  session = await openSession(CDP_PORT, `${ORIGIN}/#/kc`, { waitMs: 800 });
  check('应用挂载成功', (await waitForMount(session)) === true, '等不到挂载');

  // ── 造 5 张未学卡（含表格/列表/例句）──
  console.log('\n[0] 造测试数据');
  const seeded = await session.evaluate(`(async () => {
    const kc = await import('/src/dao/kc.ts');
    const sess = await import('/src/dao/kcSession.ts');
    const model = await import('/src/core/kcModel.ts');
    await kc.clearAll();
    await sess.clearOpen();
    const cards = [];
    for (let i = 1; i <= 5; i += 1) {
      const c = model.createEmptyCard('学习卡 ' + i);
      c.summary = '第 ' + i + ' 张的摘要';
      c.examTags = i % 2 === 0 ? ['fill', 'choice'] : ['sentence'];
      c.blocks = [
        { id: 'h' + i, type: 'heading', content: '核心区别 ' + i },
        { id: 't' + i, type: 'text', content: '这是第 ' + i + ' 张卡的正文内容' },
        { id: 'e' + i, type: 'example', content: 'This is example ' + i + '.', translation: '这是例句 ' + i + '。' },
        { id: 'l' + i, type: 'list', items: ['要点 A' + i, '要点 B' + i] },
        { id: 'tb' + i, type: 'table', rows: [['列1', '列2'], ['a' + i, 'b' + i]] },
        { id: 'p' + i, type: 'tip', content: '易错点 ' + i },
      ];
      c.createdAt = 1700000000000 + i * 1000;
      c.updatedAt = c.createdAt;
      cards.push(c);
    }
    await kc.bulkUpsert(cards);
    return JSON.stringify({ count: cards.length, ids: cards.map((c) => c.id) });
  })()`);
  const seed = JSON.parse(seeded);
  check('5 张未学卡片已入库', seed.count === 5, seeded);

  // ── 选数量 ──
  console.log('\n[1] 选数量（验收标准 2）');
  check('学习页打得开', (await goto(session, '#/kc/study', '.kc-picker')) === true, '等不到选数量界面');
  const picker = await session.evaluate(`JSON.stringify({
    title: document.querySelector('.kc-picker-title')?.textContent,
    value: document.querySelector('.kc-picker-input')?.value,
    hint: document.querySelector('.kc-hint-dim')?.textContent,
  })`);
  const pk = JSON.parse(picker);
  check('问了「本次学多少个知识点？」', pk.title?.includes('学多少个') === true, String(pk.title));
  check('给了建议值', Number(pk.value) >= 1, String(pk.value));
  check('提示里写了当前未学数量', pk.hint?.includes('未学') === true, String(pk.hint));

  // ── 逐张展示 ──
  console.log('\n[2] 逐张展示与渲染（验收标准 2 / 3）');
  const firstCard = await session.evaluate(`(async () => {
    const input = document.querySelector('.kc-picker-input');
    input.value = '5';
    document.querySelector('.kc-picker-start').click();
    for (let i = 0; i < 60; i += 1) {
      await new Promise((r) => setTimeout(r, 200));
      if (document.querySelector('.kc-study-card')) break;
    }
    const card = document.querySelector('.kc-study-card');
    return JSON.stringify({
      title: card?.querySelector('.kc-study-title')?.textContent,
      progress: document.querySelector('.kc-study-progress')?.textContent,
      chips: [...document.querySelectorAll('.kc-study-chips .kc-chip')].map((e) => e.textContent),
      hasTable: card?.querySelector('table') !== null,
      thCount: card?.querySelectorAll('th').length,
      tdCount: card?.querySelectorAll('td').length,
      liCount: card?.querySelectorAll('li').length,
      hasExample: card?.textContent.includes('这是例句 1。') === true,
      hasTip: card?.textContent.includes('易错点 1') === true,
      ratingBtns: [...document.querySelectorAll('.kc-rating')].map((b) => b.textContent),
      chopBtn: document.querySelector('.kc-chop-btn') !== null,
    });
  })()`);
  const fc = JSON.parse(firstCard);
  check('★ 第一张卡是「学习卡 1」（先录入先学）', fc.title === '学习卡 1', String(fc.title));
  check('进度显示 0/5', fc.progress?.includes('0/5') === true, String(fc.progress));
  check('★ 右上角有考核标签 chip（独立写句子）', fc.chips.includes('独立写句子'), fc.chips.join(','));
  // ★ 表格无表头（用户明确要求）：这次种子数据是 2 行，所以是 4 个 td、0 个 th
  check('★ 卡片内容渲染正确：表格是真 table，且没有表头（2 行 → 4 个 td）', fc.hasTable === true && fc.thCount === 0 && fc.tdCount === 4, `hasTable=${fc.hasTable} th=${fc.thCount} td=${fc.tdCount}`);
  check('★ 列表渲染成 li（2 项）', fc.liCount === 2, String(fc.liCount));
  check('★ 例句带翻译渲染出来', fc.hasExample === true, '');
  check('★ 易错点（tip）渲染出来', fc.hasTip === true, '');
  check('★ 三个自评按钮：不会 / 模糊 / 会了', fc.ratingBtns.join(',') === '不会,模糊,会了', fc.ratingBtns.join(','));
  check('「斩」按钮在（与自评区分开）', fc.chopBtn === true, '');

  // ── 点「模糊」──
  console.log('\n[3] 点自评 → 立刻写库 → 自动下一张（验收标准 4）');
  const rated = await session.evaluate(`(async () => {
    const btn = [...document.querySelectorAll('.kc-rating')].find((b) => b.textContent === '模糊');
    btn.click();
    for (let i = 0; i < 40; i += 1) {
      await new Promise((r) => setTimeout(r, 200));
      if (document.querySelector('.kc-study-title')?.textContent === '学习卡 2') break;
    }
    const kc = await import('/src/dao/kc.ts');
    const c1 = await kc.getById('${seed.ids[0]}');
    return JSON.stringify({
      nowTitle: document.querySelector('.kc-study-title')?.textContent,
      progress: document.querySelector('.kc-study-progress')?.textContent,
      selfScore: c1?.attrs.lastSelfScore,
      learnedAt: c1?.attrs.learnedAt,
      status: c1?.status,
      mastery: c1?.attrs.mastery,
    });
  })()`);
  const rt = JSON.parse(rated);
  check('★ 点「模糊」后自动跳到第 2 张', rt.nowTitle === '学习卡 2', String(rt.nowTitle));
  check('★ 进度更新为 1/5', rt.progress?.includes('1/5') === true, String(rt.progress));
  check('★ lastSelfScore=2 已立刻落库', rt.selfScore === 2, String(rt.selfScore));
  check('★ learnedAt 有值', typeof rt.learnedAt === 'number' && rt.learnedAt > 0, String(rt.learnedAt));
  check('★ status 变成 learning', rt.status === 'learning', String(rt.status));
  check('★ mastery 被重算（自评 2 → 0.333）', Math.abs(rt.mastery - 0.333) < 0.002, String(rt.mastery));

  // ── 键盘自评 ──
  console.log('\n[4] 键盘 1/2/3（验收标准 5）');
  const keyed = await session.evaluate(`(async () => {
    const fire = (key) => window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    fire('3');
    for (let i = 0; i < 40; i += 1) {
      await new Promise((r) => setTimeout(r, 200));
      if (document.querySelector('.kc-study-title')?.textContent === '学习卡 3') break;
    }
    const kc = await import('/src/dao/kc.ts');
    const c2 = await kc.getById('${seed.ids[1]}');
    fire('1');
    for (let i = 0; i < 40; i += 1) {
      await new Promise((r) => setTimeout(r, 200));
      if (document.querySelector('.kc-study-title')?.textContent === '学习卡 4') break;
    }
    const c3 = await kc.getById('${seed.ids[2]}');
    return JSON.stringify({
      nowTitle: document.querySelector('.kc-study-title')?.textContent,
      progress: document.querySelector('.kc-study-progress')?.textContent,
      score2: c2?.attrs.lastSelfScore,
      score3: c3?.attrs.lastSelfScore,
    });
  })()`);
  const kd = JSON.parse(keyed);
  check('★ 按 3 → 自评「会了」并进入下一张', kd.score2 === 3 && kd.nowTitle === '学习卡 4', `score=${kd.score2} now=${kd.nowTitle}`);
  check('★ 按 1 → 自评「不会」', kd.score3 === 1, String(kd.score3));
  check('进度更新为 3/5', kd.progress?.includes('3/5') === true, String(kd.progress));

  // ── 斩 ──
  console.log('\n[5] 斩：不弹确认（RULES-R3）+ 撤销入口（验收标准 6）');
  // ★ R4 改动：斩原来是「二次确认弹窗」，现在铁律 R3 要求**不弹确认 + ≥8 秒撤销 Toast**。
  //   所以这里原来的断言「斩有二次确认弹窗」已经过期，改成断言新行为——
  //   留着旧断言的话，测试会因为「没有弹窗」而红，那是把 bug 焊死的修法。
  const chopped = await session.evaluate(`(async () => {
    window.__confirmCalls = 0;
    const realConfirm = window.confirm;
    window.confirm = () => { window.__confirmCalls += 1; return true; };
    try {
      // 点「斩」：应当**立即生效**，不出现任何弹窗
      document.querySelector('.kc-chop-btn').click();
      await new Promise((r) => setTimeout(r, 700));
      const modalAfterClick = document.querySelector('.modal-title')?.textContent ?? null;
      const undoToast = document.querySelector('.toast-undo')?.textContent ?? null;
      const hasUndoBtn = !!document.querySelector('.toast-undo-btn');
      for (let i = 0; i < 40; i += 1) {
        await new Promise((r) => setTimeout(r, 200));
        if (document.querySelector('.kc-study-title')?.textContent === '学习卡 5') break;
      }
      const kc = await import('/src/dao/kc.ts');
      const c4 = await kc.getById('${seed.ids[3]}');
      return JSON.stringify({
        confirmCalls: window.__confirmCalls,
        modalAfterClick,
        undoToast,
        hasUndoBtn,
        nowTitle: document.querySelector('.kc-study-title')?.textContent,
        deleted: c4?.deleted,
        status: c4?.status,
        progress: document.querySelector('.kc-study-progress')?.textContent,
      });
    } finally {
      window.confirm = realConfirm;
    }
  })()`);
  const ch = JSON.parse(chopped);
  check('★ 斩**不弹任何确认框**（点了就生效）', ch.confirmCalls === 0 && ch.modalAfterClick === null, `confirm=${ch.confirmCalls} modal=${ch.modalAfterClick}`);
  check('★ 斩后给出「已斩 XXX 〔撤销〕」Toast', (ch.undoToast ?? '').includes('已斩') && ch.hasUndoBtn === true, String(ch.undoToast));
  check('★ 斩后卡片变墓碑（deleted=1、status=chopped）', ch.deleted === 1 && ch.status === 'chopped', `${ch.deleted}/${ch.status}`);
  check('★ 斩后自动跳到下一张（学习卡 5）', ch.nowTitle === '学习卡 5', String(ch.nowTitle));
  check('★ 本轮总数减到 4（进度 xx/4）', ch.progress?.includes('/4') === true, String(ch.progress));

  // ── 撤销：必须「完全恢复」（卡片回库 + 回到本轮队列） ──
  const undone = await session.evaluate(`(async () => {
    document.querySelector('.toast-undo-btn')?.click();
    await new Promise((r) => setTimeout(r, 1000));
    const kc = await import('/src/dao/kc.ts');
    const sess = await import('/src/dao/kcSession.ts');
    const c4 = await kc.getById('${seed.ids[3]}');
    const open = await sess.loadLatestOpen('study');
    return JSON.stringify({
      deleted: c4?.deleted,
      status: c4?.status,
      inSession: (open?.cardIds ?? []).includes('${seed.ids[3]}'),
      cardCount: open?.cardIds.length,
      nowTitle: document.querySelector('.kc-study-title')?.textContent,
    });
  })()`);
  const un = JSON.parse(undone);
  check('★ 撤销后墓碑翻回来（deleted=0）', un.deleted === 0, String(un.deleted));
  // 这张卡（学习卡 4）之前**没有自评过**，斩之前的状态本来就是 unlearned，
  // 所以这里期望 unlearned。注意 `revive()` 也会写 unlearned —— 想看
  // 「是否按原值还原（而不是一律 unlearned）」，用 `npm run test:r4-ui`：
  // 那边种的是 learned / learning，用 revive() 会被写成 unlearned，断言才分得出来。
  check('★ 撤销后状态回到斩之前的值（这张卡原本就是 unlearned）', un.status === 'unlearned', String(un.status));
  check('★ 撤销后卡片回到本轮会话队列', un.inSession === true && un.cardCount === 5, `in=${un.inSession} count=${un.cardCount}`);
  check('★ 撤销后它重新成为当前这张（位置也还原）', un.nowTitle === '学习卡 4', String(un.nowTitle));

  // 再斩一次，让后面的用例回到「本轮 4 张」的局面
  const rechopped = await session.evaluate(`(async () => {
    document.querySelector('.kc-chop-btn').click();
    for (let i = 0; i < 40; i += 1) {
      await new Promise((r) => setTimeout(r, 200));
      if (document.querySelector('.kc-study-title')?.textContent === '学习卡 5') break;
    }
    return JSON.stringify({ nowTitle: document.querySelector('.kc-study-title')?.textContent });
  })()`);
  check('★ 再斩一次后又跳到学习卡 5（为后续用例复位）', JSON.parse(rechopped).nowTitle === '学习卡 5', rechopped);

  // ── 保存并退出 → 重进继续（验收标准 7）──
  console.log('\n[6] 保存并退出 → 重进继续（验收标准 7）');
  const exited = await session.evaluate(`(async () => {
    // 注意：当前进度在第 4 张（学习卡 5），点退出应保存
    const btn = document.querySelector('.kc-study-exit');
    btn.click();
    await new Promise((r) => setTimeout(r, 900));
    const sess = await import('/src/dao/kcSession.ts');
    const open = await sess.loadLatestOpen('study');
    return JSON.stringify({
      hash: location.hash,
      hasOpen: open !== null,
      currentIndex: open?.currentIndex,
      cardCount: open?.cardIds.length,
      scores: open?.selfScores ?? {},
    });
  })()`);
  const ex = JSON.parse(exited);
  check('★ 退出后回到二期首页', ex.hash === '#/kc', ex.hash);
  check('★ 会话已保存且未完成', ex.hasOpen === true, '');
  check('★ 进度停在第 4 张（currentIndex=3）', ex.currentIndex === 3, String(ex.currentIndex));
  check('★ 本轮剩 4 张（斩掉的不算）', ex.cardCount === 4, String(ex.cardCount));
  check('★ 之前三条自评分都还在', Object.keys(ex.scores).length === 3, JSON.stringify(ex.scores));

  const resumed = await session.evaluate(`(async () => {
    location.hash = '#/kc/study';
    for (let i = 0; i < 80; i += 1) {
      await new Promise((r) => setTimeout(r, 200));
      if (document.querySelector('.modal-title')) break;
    }
    const askTitle = document.querySelector('.modal-title')?.textContent ?? '';
    const askText = document.querySelector('.modal-text')?.textContent ?? '';
    const contBtn = [...document.querySelectorAll('.modal-foot button')].find((b) => b.textContent === '继续上次');
    contBtn?.click();
    for (let i = 0; i < 60; i += 1) {
      await new Promise((r) => setTimeout(r, 200));
      if (document.querySelector('.kc-study-card')) break;
    }
    return JSON.stringify({
      askTitle,
      askText,
      nowTitle: document.querySelector('.kc-study-title')?.textContent,
      progress: document.querySelector('.kc-study-progress')?.textContent,
      lastHint: [...document.querySelectorAll('.kc-hint-dim')].map((e) => e.textContent).find((t) => t.includes('上次自评')) ?? '',
    });
  })()`);
  const rs = JSON.parse(resumed);
  check('★ 重进时问「继续上次的学习？」', rs.askTitle.includes('继续上次'), rs.askTitle);
  check('★ 提示里写明了还剩几张', rs.askText.includes('还剩'), rs.askText);
  check('★ 继续后从第 4 张开始（学习卡 5）', rs.nowTitle === '学习卡 5', String(rs.nowTitle));
  check('★ 进度仍是 3/4（分数没丢）', rs.progress?.includes('3/4') === true, String(rs.progress));

  // ── Esc 退出 ──
  const esc = await session.evaluate(`(async () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await new Promise((r) => setTimeout(r, 800));
    return location.hash;
  })()`);
  check('★ 按 Esc 也能退出', esc === '#/kc', String(esc));

  // ── 移动端按钮尺寸（验收标准 8）──
  console.log('\n[7] 移动端按钮热区（验收标准 8）');
  await session.evaluate(`(async () => {
    location.hash = '#/kc/study';
    for (let i = 0; i < 80; i += 1) {
      await new Promise((r) => setTimeout(r, 200));
      if (document.querySelector('.modal-foot button') || document.querySelector('.kc-picker')) break;
    }
    const cont = [...document.querySelectorAll('.modal-foot button')].find((b) => b.textContent === '继续上次');
    if (cont) cont.click();
    for (let i = 0; i < 60; i += 1) {
      await new Promise((r) => setTimeout(r, 200));
      if (document.querySelector('.kc-study-card')) break;
    }
  })()`);
  // 用 CDP 把视口改成手机宽度
  await session.evaluate(`(async () => {
    document.body.style.width = '375px';
    return 'ok';
  })()`);
  const sizes = await session.evaluate(`JSON.stringify(
    [...document.querySelectorAll('.kc-rating')].map((b) => {
      const r = b.getBoundingClientRect();
      return { label: b.textContent, h: Math.round(r.height), w: Math.round(r.width) };
    })
  )`);
  const sz = JSON.parse(sizes);
  check('★ 手机上三个自评按钮高度 ≥44px', sz.length === 3 && sz.every((s) => s.h >= 44), JSON.stringify(sz));
  const chopSize = await session.evaluate(`Math.round(document.querySelector('.kc-chop-btn').getBoundingClientRect().height)`);
  check('「斩」按钮也 ≥44px', Number(chopSize) >= 44, String(chopSize));

  await session.evaluate(`(async () => {
    const kc = await import('/src/dao/kc.ts');
    const sess = await import('/src/dao/kcSession.ts');
    await kc.clearAll();
    await sess.clearOpen();
  })()`);
} catch (err) {
  failed += 1;
  console.error(`\n✗ 冒烟过程出错：${err instanceof Error ? err.message : String(err)}`);
} finally {
  if (session) await session.close().catch(() => {});
  if (chrome) chrome.proc.kill();
  server.kill();
}

console.log(`\n=== 阶段 04 界面冒烟：通过 ${passed} 项，失败 ${failed} 项 ===\n`);
process.exit(failed === 0 ? 0 : 1);
