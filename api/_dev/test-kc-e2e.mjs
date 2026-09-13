/**
 * 二期**完整冒烟**（阶段 07 §4）：`npm run test:kc-e2e`
 *
 * 顺序走一遍用户真实路径（不需要 AI 密钥）：
 *   录入 → 卡片列表核对 → 学习（自评）→ 编辑卡片 → 复习（含背单词桥接）→
 *   设置页（改掌握度参数 → 列表页跟着变）→ 题库（批量粘贴 → 筛选）
 *
 * 用**本地假 AI 服务**替掉模型，所以「录入」那一步是真的走完的
 * （真 fetch、真解析、真入库），只是产出可复现。
 */
import { createServer } from 'node:http';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findBrowser, launch, openSession, serveStatic } from '../../scripts/cdp.mjs';
import { FAKE_IMPORT_REPLY } from './kcImportFixture.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = 4203;
const CDP_PORT = 9243;
const AI_PORT = 4204;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const AI_BASE = `http://127.0.0.1:${AI_PORT}`;

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

/** 假 AI 服务（带 CORS：浏览器直连会触发预检） */
function startFakeAi(port) {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
  const server = createServer((req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors).end();
      return;
    }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json', ...cors });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: FAKE_IMPORT_REPLY } }] }));
    });
  });
  server.listen(port, '127.0.0.1');
  return server;
}

/**
 * 等服务器起来。
 * @param {string} url 地址
 */
async function waitForServer(url) {
  for (let i = 0; i < 80; i += 1) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status === 204 || res.status === 405) return true;
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/**
 * 切路由（同 hash 时先绕一圈，否则不会重渲染）。
 * @param {object} session CDP 会话
 * @param {string} hash 目标
 * @param {string} selector 标志元素
 */
async function goto(session, hash, selector) {
  await session.evaluate(`(async () => {
    if (location.hash === '${hash}') { location.hash = '#/kc'; await new Promise((r) => setTimeout(r, 250)); }
    location.hash = '${hash}';
    await new Promise((r) => setTimeout(r, 200));
  })()`);
  for (let i = 0; i < 80; i += 1) {
    if ((await session.evaluate(`document.querySelector('${selector}') !== null`)) === true) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

const browser = findBrowser();
if (!browser) {
  console.log('\n⚠ 本机没有 Chrome / Edge，跳过完整冒烟');
  process.exit(0);
}
console.log(`  用 ${browser.split('\\').pop()} 跑完整冒烟`);

const fakeAi = startFakeAi(AI_PORT);
const server = serveStatic({ root: ROOT, port: PORT, mode: 'dev' });

let chrome = null;
let session = null;
try {
  if (!(await waitForServer(`${AI_BASE}/`))) throw new Error('假 AI 服务没起来');
  if (!(await waitForServer(`${ORIGIN}/`))) throw new Error('dev 服务没起来');
  chrome = await launch(browser, CDP_PORT, { windowSize: '1280,900' });
  session = await openSession(CDP_PORT, `${ORIGIN}/#/kc`, { waitMs: 800 });
  for (let i = 0; i < 80; i += 1) {
    if ((await session.evaluate(`document.querySelector('#app .nav') !== null`)) === true) break;
    await new Promise((r) => setTimeout(r, 400));
  }
  check('应用挂载成功', (await session.evaluate(`document.querySelector('#app .nav') !== null`)) === true, '');

  // ── 准备：清库 + 配好假 AI + 一期造几个词（桥接要用） ──
  await session.evaluate(`(async () => {
    const kc = await import('/src/dao/kc.ts');
    const sess = await import('/src/dao/kcSession.ts');
    const words = await import('/src/dao/words.ts');
    const settings = await import('/src/dao/settings.ts');
    const sources = await import('/src/dao/sources.ts');
    const core = await import('/src/core/model.ts');
    await kc.clearAll(); await sess.clearOpen(); await words.clearAll();
    await settings.set({ ai: { baseUrl: '${AI_BASE}', model: 'fake', key: 'fake-key', proxyUrl: '', forceProxy: false } });
    const src = await sources.ensureByName('__e2e__', 0);
    const ws = [];
    for (let i = 1; i <= 3; i += 1) {
      const w = core.createWord('e2eword' + i, [core.createSense('n. 词' + i)], src.id);
      w.createdAt = 1700000000000 + i * 1000;
      ws.push(w);
    }
    await words.bulkUpsert(ws);
  })()`);

  // ── ① 录入（真走一次「发送」） ──
  console.log('\n[1] 录入：发送 → 采纳 → 入库');
  check('录入页打开', (await goto(session, '#/kc/import', '.kc-chat-input')) === true, '');
  const imported = await session.evaluate(`(async () => {
    const input = document.querySelector('.kc-chat-input');
    input.value = '我在定语从句这块不行';
    [...document.querySelectorAll('.kc-composer button')].find((b) => b.textContent === '发送').click();
    for (let i = 0; i < 80; i += 1) {
      await new Promise((r) => setTimeout(r, 250));
      if (document.querySelectorAll('.kc-preview').length > 0) break;
    }
    const previews = [...document.querySelectorAll('.kc-preview')];
    for (const c of previews) {
      const btn = [...c.querySelectorAll('button')].find((b) => b.textContent === '采纳');
      if (btn) btn.click();
      await new Promise((r) => setTimeout(r, 60));
    }
    const commit = [...document.querySelectorAll('.kc-import-bar button')].find((b) => b.textContent.includes('确认入库'));
    const label = commit?.textContent ?? '';
    commit?.click();
    for (let i = 0; i < 40; i += 1) {
      await new Promise((r) => setTimeout(r, 200));
      if (document.querySelector('.modal-title')?.textContent === '入库完成') break;
    }
    const todo = [...document.querySelectorAll('.modal-foot button')].find((b) => b.textContent === '继续录入');
    todo?.click();
    const kc = await import('/src/dao/kc.ts');
    const all = await kc.getAll();
    return JSON.stringify({ previews: previews.length, label, count: all.length, titles: all.map((c) => c.title) });
  })()`);
  const im = JSON.parse(imported);
  check('★ 生成 2 张卡片预览', im.previews === 2, String(im.previews));
  check('★ 采纳 2 张并入库', im.label.includes('2 张') && im.count === 2, `${im.label} / 库里 ${im.count} 张`);
  // 说明：`getAll()` 是按主键（id）顺序返回的，**不保证入库顺序**，所以断言标题集合。
  check(
    '两张卡的标题都对（定语从句 + 关系副词）',
    im.titles.length === 2 && im.titles.some((x) => x.includes('定语从句')) && im.titles.some((x) => x.includes('关系副词')),
    JSON.stringify(im.titles),
  );

  // ── ② 卡片列表核对 ──
  console.log('\n[2] 卡片列表');
  check('列表页打开', (await goto(session, '#/kc/list', '.kc-list-table tbody tr')) === true, '');
  const list = await session.evaluate(`JSON.stringify({
    rows: document.querySelectorAll('.kc-list-table tbody tr').length,
    stats: [...document.querySelectorAll('.kc-statcell-num')].map((e) => e.textContent),
  })`);
  const ls = JSON.parse(list);
  check('★ 列出 2 张卡', ls.rows === 2, String(ls.rows));
  check('统计条显示 2 张', ls.stats[0] === '2', ls.stats.join(','));

  // ── ③ 学习（自评） ──
  console.log('\n[3] 学习：自评');
  check('学习页打开', (await goto(session, '#/kc/study', '.kc-picker')) === true, '');
  const studied = await session.evaluate(`(async () => {
    document.querySelector('.kc-picker-start').click();
    for (let i = 0; i < 60; i += 1) {
      await new Promise((r) => setTimeout(r, 200));
      if (document.querySelector('.kc-study-card')) break;
    }
    let n = 0;
    for (let round = 0; round < 5; round += 1) {
      const btn = [...document.querySelectorAll('.kc-rating')].find((b) => b.textContent === '会了');
      if (!btn) break;
      btn.click();
      n += 1;
      await new Promise((r) => setTimeout(r, 500));
    }
    const kc = await import('/src/dao/kc.ts');
    const all = await kc.getAll();
    return JSON.stringify({ rated: n, learning: all.filter((c) => c.status === 'learning').length, scores: all.map((c) => c.attrs.lastSelfScore) });
  })()`);
  const sd = JSON.parse(studied);
  check('★ 两张卡都自评了', sd.rated === 2, String(sd.rated));
  check('★ 状态都变成 learning', sd.learning === 2, String(sd.learning));
  check('★ 分数都落库为 3', sd.scores.every((s) => s === 3), JSON.stringify(sd.scores));

  // ── ④ 编辑卡片（改标题 + 加块） ──
  console.log('\n[4] 编辑卡片');
  const editId = await session.evaluate(`(async () => {
    const kc = await import('/src/dao/kc.ts');
    return (await kc.getAll())[0].id;
  })()`);
  check('编辑页打开', (await goto(session, `#/kc/edit?id=${editId}`, '.kc-editor')) === true, '');
  const edited = await session.evaluate(`(async () => {
    const title = document.querySelector('.kc-title-input');
    title.value = '改过的标题（冒烟）';
    title.dispatchEvent(new Event('input', { bubbles: true }));
    [...document.querySelectorAll('.kc-insert-btn')].find((b) => b.textContent.includes('提示')).click();
    await new Promise((r) => setTimeout(r, 200));
    const blocks = [...document.querySelectorAll('.kc-editor-block')];
    const ta = blocks[blocks.length - 1].querySelector('textarea');
    ta.value = '冒烟加的易错点';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 1500));
    const kc = await import('/src/dao/kc.ts');
    const c = await kc.getById('${editId}');
    return JSON.stringify({ title: c?.title, blocks: c?.blocks.length, hasTip: c?.blocks.some((b) => b.type === 'tip') });
  })()`);
  const ed = JSON.parse(edited);
  check('★ 标题改动已自动保存', ed.title === '改过的标题（冒烟）', String(ed.title));
  check('★ 新增的 tip 块已保存', ed.hasTip === true && ed.blocks > 0, `${ed.blocks} 块`);

  // ── ⑤ 复习（含背单词桥接） ──
  console.log('\n[5] 复习：卡片 → 背单词桥接');
  check('复习页打开', (await goto(session, '#/kc/review', '.kc-picker')) === true, '');
  const reviewed = await session.evaluate(`(async () => {
    document.querySelector('.kc-picker-start').click();
    for (let i = 0; i < 60; i += 1) {
      await new Promise((r) => setTimeout(r, 200));
      if (document.querySelector('.kc-study-card')) break;
    }
    for (let round = 0; round < 5; round += 1) {
      const btn = [...document.querySelectorAll('.kc-rating')].find((b) => b.textContent === '模糊');
      if (!btn) break;
      btn.click();
      await new Promise((r) => setTimeout(r, 500));
    }
    for (let i = 0; i < 80; i += 1) {
      await new Promise((r) => setTimeout(r, 250));
      if (document.querySelector('.kc-bridge')) break;
    }
    const sess = await import('/src/dao/kcSession.ts');
    const open = await sess.loadLatestOpen('review');
    return JSON.stringify({
      bridge: document.querySelector('.kc-bridge') !== null,
      banner: document.querySelector('.kc-bridge-tag')?.textContent ?? '',
      flow: document.querySelector('.kc-bridge-flow') !== null,
      stage: open?.stage ?? '',
    });
  })()`);
  const rv = JSON.parse(reviewed);
  check('★ 复习走完卡片后进入背单词环节', rv.bridge === true, '');
  check('★ 桥接显示了来源提示', rv.banner.includes('复习间隙'), rv.banner);
  check('★ 复用的是一期白纸流程', rv.flow === true, '');
  check('会话停在 words 阶段', rv.stage === 'words', rv.stage);

  // 桥接结束 → 做题（没配真 AI 时给明确提示，不崩）
  const afterBridge = await session.evaluate(`(async () => {
    document.querySelector('.kc-bridge-skip').click();
    for (let i = 0; i < 80; i += 1) {
      await new Promise((r) => setTimeout(r, 250));
      if (location.hash.startsWith('#/kc/exam')) break;
    }
    return JSON.stringify({ hash: location.hash, text: document.querySelector('.kc-exam-pagebody')?.textContent?.slice(0, 60) ?? '' });
  })()`);
  const ab = JSON.parse(afterBridge);
  check('★ 桥接结束后自动进入做题', ab.hash.startsWith('#/kc/exam'), ab.hash);
  check('做题页有内容（没白屏）', ab.text.length > 0, ab.text);

  // ── ⑥ 设置页：改掌握度参数 → 列表页跟着变 ──
  console.log('\n[6] 设置页：改参数 → 列表页变化');
  check('设置页打开', (await goto(session, '#/kc/settings', '.kc-set-page')) === true, '');
  const setting = await session.evaluate(`(async () => {
    const ctxMod = await import('/src/ui/pages/kcSettings/kcSettingsCtx.ts');
    const kc = await import('/src/dao/kc.ts');
    const before = (await kc.getAll()).map((c) => c.attrs.mastery);
    // 改成「关掉惩罚」——掌握度应该普遍上升
    await ctxMod.patchKcSettings({ mastery: { w1: 0.6, w2: 0.4, penalty: 0 } });
    const after = (await kc.getAll()).map((c) => c.attrs.mastery);
    return JSON.stringify({ before, after });
  })()`);
  const st = JSON.parse(setting);
  check('★ 改 penalty=0 后所有卡的掌握度都变了', st.before.join(',') !== st.after.join(','), `${st.before.join(',')} → ${st.after.join(',')}`);
  check('★ 掌握度都上升了（惩罚被去掉）', st.after.every((v, i) => v >= st.before[i]), '');

  const listAfter = await session.evaluate(`(async () => {
    location.hash = '#/kc/list';
    for (let i = 0; i < 60; i += 1) {
      await new Promise((r) => setTimeout(r, 200));
      if (document.querySelector('.kc-mastery-pct')) break;
    }
    return JSON.stringify({ pcts: [...document.querySelectorAll('.kc-mastery-pct')].map((e) => e.textContent) });
  })()`);
  const la = JSON.parse(listAfter);
  check('★ 列表页的掌握度跟着变了', la.pcts.length === 2 && la.pcts.some((p) => p !== '0%'), la.pcts.join(','));

  // ── ⑦ 题库：批量粘贴 → 筛选 ──
  console.log('\n[7] 题库：批量粘贴 → 筛选');
  check('题库页打开', (await goto(session, '#/kc/bank', '.kc-bank-page')) === true, '');
  const banked = await session.evaluate(`(async () => {
    const imp = await import('/src/ui/pages/kcBank/kcBankImport.ts');
    const bank = await import('/src/dao/examBank.ts');
    // ⚠️ 题目之间要留空行（或编号 / --- 分隔）：不留空行的话整段会被当成**一道题**
    // （切分规则见 kcBankImport：空行 → 编号 → --- → 整段）。
    const text = [
      'He is the man ____ helped me.',
      '',
      'Choose the best answer:',
      'A. who',
      'B. which',
      '',
      '判断下面句子是否正确：He go to school yesterday.',
    ].join('\\n');
    const items = imp.splitBankText(text, 'fill', '2023全国甲卷');
    for (const it of items) await bank.addBankQuestion(it.type, it.content, '2023全国甲卷');
    const all = await bank.listBankQuestions();
    const choices = await bank.listBankQuestions('choice');
    return JSON.stringify({ parsed: items.length, types: items.map((x) => x.type), total: all.length, choiceCount: choices.length });
  })()`);
  const bk = JSON.parse(banked);
  check('★ 批量粘贴切成 3 道（空行分隔）', bk.parsed === 3, JSON.stringify(bk.types));
  check('★ 三种题型都判对了（填空 / 选择 / 判断）', bk.types.join(',') === 'fill,choice,judge', bk.types.join(','));
  check('★ 题库里有 3 条、按题型筛出 1 条选择题', bk.total === 3 && bk.choiceCount === 1, JSON.stringify(bk));

  // 清场
  await session.evaluate(`(async () => {
    const kc = await import('/src/dao/kc.ts');
    const sess = await import('/src/dao/kcSession.ts');
    const words = await import('/src/dao/words.ts');
    const bank = await import('/src/dao/examBank.ts');
    await kc.clearAll(); await sess.clearOpen(); await words.clearAll(); await bank.clearAll();
  })()`);
} catch (err) {
  failed += 1;
  console.error(`\n✗ 冒烟过程出错：${err instanceof Error ? err.message : String(err)}`);
} finally {
  if (session) await session.close().catch(() => {});
  if (chrome) chrome.proc.kill();
  server.kill();
  fakeAi.close();
}

console.log(`\n=== 二期完整冒烟：通过 ${passed} 项，失败 ${failed} 项 ===\n`);
process.exit(failed === 0 ? 0 : 1);
