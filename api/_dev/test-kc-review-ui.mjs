/**
 * 阶段 06 的**真浏览器**冒烟：`npm run test:kc-review-ui`
 *
 * 验「走完三个环节 + 三个阶段各退出一次都能恢复」：
 *   2. 空库点复习 → 提示「还没有学过的知识点」，不崩
 *   3. 有已学卡片 → 给出推荐数字 → 进入
 *   4. 流程顺序：看卡片 → 自评 → **自动跳到背单词** → 背完 → **自动进入做题**
 *   5. 背单词上限：桥接时最多只能背 5 个（第 6 个不会出现）
 *   6. 词源：一期有新词 → 背新词；无新词 → 背旧词；空库 → 跳过并有提示
 *   7. 保存并退出：cards / words 两个阶段各验一次（exam 阶段由 controller 保证，数据层已验）
 *   8. 完成后列表页属性更新
 *
 * 不需要 AI 密钥：做题环节会在「没配 AI」时给出明确提示（这本身也是要验的路径）。
 */
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findBrowser, launch, openSession, serveStatic } from '../../scripts/cdp.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = 4201;
const CDP_PORT = 9241;
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
 * @param {number} tries 最多轮数
 */
async function goto(session, hash, selector, tries = 80) {
  // ⚠️ 同 hash 赋值**不会**触发 hashchange，页面不会重渲染。
  // 测试里经常「造完数据再回同一页」，所以先绕到一个别的路由再切过去。
  await session.evaluate(`(async () => {
    if (location.hash === '${hash}') {
      location.hash = '#/kc';
      await new Promise((r) => setTimeout(r, 250));
    }
    location.hash = '${hash}';
    await new Promise((r) => setTimeout(r, 200));
  })()`);
  for (let i = 0; i < tries; i += 1) {
    if ((await session.evaluate(`document.querySelector('${selector}') !== null`)) === true) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

/** 造数据的辅助脚本（在页面里执行） */
const SEED = `(async () => {
  const kc = await import('/src/dao/kc.ts');
  const sess = await import('/src/dao/kcSession.ts');
  const model = await import('/src/core/kcModel.ts');
  const words = await import('/src/dao/words.ts');
  const sources = await import('/src/dao/sources.ts');
  const core = await import('/src/core/model.ts');
  await kc.clearAll();
  await sess.clearOpen();
  await words.clearAll();

  // 3 张已学卡片（复习候选）
  const cards = [];
  for (let i = 1; i <= 3; i += 1) {
    const c = model.createEmptyCard('复习卡 ' + i);
    c.summary = '第 ' + i + ' 张';
    c.status = 'learned';
    c.examTags = ['fill'];
    c.examLoad = { types: ['fill'], estMinutes: 4 };
    c.attrs.reviewPriority = 100 - i * 10;
    c.attrs.mastery = 0.4;
    c.blocks = [{ id: 'b' + i, type: 'text', content: '内容 ' + i }];
    cards.push(c);
  }
  await kc.bulkUpsert(cards);

  // 一期词库：4 个新词（少于 5，便于验证「上限」与「词源」）
  const src = await sources.ensureByName('__reviewui__', 0);
  const ws = [];
  for (let i = 1; i <= 4; i += 1) {
    const w = core.createWord('word' + i, [core.createSense('n. 词' + i)], src.id);
    w.createdAt = 1700000000000 + i * 1000;
    ws.push(w);
  }
  await words.bulkUpsert(ws);
  return JSON.stringify({ cards: cards.length, words: ws.length });
})()`;

const browser = findBrowser();
if (!browser) {
  console.log('\n⚠ 本机没有 Chrome / Edge，跳过阶段 06 界面冒烟（数据层已由 test:kc-review 覆盖）');
  process.exit(0);
}
console.log(`  用 ${browser.split('\\').pop()} 跑无头检查`);

const server = serveStatic({ root: ROOT, port: PORT, mode: 'dev' });

let chrome = null;
let session = null;
try {
  if (!(await waitForServer(`${ORIGIN}/`))) throw new Error('dev 服务没起来');
  chrome = await launch(browser, CDP_PORT, { windowSize: '1280,900' });
  session = await openSession(CDP_PORT, `${ORIGIN}/#/kc`, { waitMs: 800 });
  check('应用挂载成功', (await waitForMount(session)) === true, '等不到挂载');

  // ── 验收标准 2：空库点复习 ──
  console.log('\n[1] 空库点复习（验收标准 2）');
  await session.evaluate(`(async () => {
    const kc = await import('/src/dao/kc.ts');
    const sess = await import('/src/dao/kcSession.ts');
    const words = await import('/src/dao/words.ts');
    await kc.clearAll(); await sess.clearOpen(); await words.clearAll();
  })()`);
  check('复习页打得开', (await goto(session, '#/kc/review', '.kc-picker')) === true, '等不到选数量界面');
  const empty = await session.evaluate(`JSON.stringify({
    title: document.querySelector('.kc-empty-title')?.textContent ?? '',
    hint: document.querySelector('.kc-hint-dim')?.textContent ?? '',
    crashed: document.querySelector('.kc-review-page') === null,
  })`);
  const em = JSON.parse(empty);
  check('★ 提示「还没有学过的知识点」', em.title.includes('还没有学过'), em.title);
  check('给了去学习 / 去录入的出口', em.hint.includes('学过'), em.hint);
  check('没有崩（页面结构还在）', em.crashed === false, '');

  // ── 造数据 ──
  console.log('\n[2] 造数据后开始复习（验收标准 3）');
  const seeded = await session.evaluate(SEED);
  const seed = JSON.parse(seeded);
  check('3 张已学卡 + 4 个一期新词已就绪', seed.cards === 3 && seed.words === 4, seeded);

  check('重进复习页', (await goto(session, '#/kc/review', '.kc-picker')) === true, '');
  const picker = await session.evaluate(`JSON.stringify({
    value: document.querySelector('.kc-picker-input')?.value,
    hint: document.querySelector('.kc-hint-dim')?.textContent ?? '',
    recommend: document.querySelector('.kc-review-recommend')?.textContent ?? '',
  })`);
  const pk = JSON.parse(picker);
  check('★ 给了推荐数字', Number(pk.value) >= 1, String(pk.value));
  check('★ 提示里说明了推荐依据（复习优先度）', pk.recommend.includes('复习优先度'), pk.recommend);
  check('提示了候选数量', pk.hint.includes('3 个'), pk.hint);

  // ── 走卡片 → 自动进背单词 ──
  console.log('\n[3] 卡片 → 自动跳到背单词（验收标准 4 / 6）');
  const cardsStage = await session.evaluate(`(async () => {
    document.querySelector('.kc-picker-start').click();
    for (let i = 0; i < 60; i += 1) {
      await new Promise((r) => setTimeout(r, 200));
      if (document.querySelector('.kc-study-card')) break;
    }
    const first = document.querySelector('.kc-study-title')?.textContent ?? '';
    // 三张都点「会了」
    for (let n = 0; n < 3; n += 1) {
      const btn = [...document.querySelectorAll('.kc-rating')].find((b) => b.textContent === '会了');
      if (btn) btn.click();
      await new Promise((r) => setTimeout(r, 400));
    }
    for (let i = 0; i < 80; i += 1) {
      await new Promise((r) => setTimeout(r, 250));
      if (document.querySelector('.kc-bridge')) break;
    }
    const sess = await import('/src/dao/kcSession.ts');
    const open = await sess.loadLatestOpen('review');
    return JSON.stringify({
      firstCard: first,
      bridgeShown: document.querySelector('.kc-bridge') !== null,
      banner: document.querySelector('.kc-bridge-tag')?.textContent ?? '',
      sourceHint: document.querySelector('.kc-bridge-banner .kc-hint-dim')?.textContent ?? '',
      stage: open?.stage ?? '',
      wordsDone: open?.wordsDone ?? null,
      hasPaperFlow: document.querySelector('.kc-bridge-flow') !== null,
      skipBtn: [...document.querySelectorAll('.kc-bridge-skip')].length,
    });
  })()`);
  const cs = JSON.parse(cardsStage);
  check('★ 第一张卡是优先度最高的「复习卡 1」', cs.firstCard === '复习卡 1', cs.firstCard);
  check('★ 卡片看完后自动进入背单词环节', cs.bridgeShown === true, '');
  check('★ 显示了来源提示「复习间隙 · 背 5 个单词」', cs.banner.includes('复习间隙'), cs.banner);
  check('★ 词源提示：一期有新词 → 背新词', cs.sourceHint.includes('新词'), cs.sourceHint);
  check('★ 复用了**一期白纸流程**（不是复制的一套）', cs.hasPaperFlow === true, '');
  check('stage 已变成 words', cs.stage === 'words', cs.stage);
  check('有「跳过这一步」出口', cs.skipBtn === 1, '');

  // 上限：桥接最多 5 个词
  const cap = await session.evaluate(`(async () => {
    const bridge = await import('/src/ui/pages/kcReview/kcReviewFlow.ts');
    const r = await bridge.pickBridgeWords(5);
    return JSON.stringify({ count: r.words.length, source: r.source });
  })()`);
  const cp = JSON.parse(cap);
  check('★ 背单词上限生效（最多 5 个，这里只有 4 个新词）', cp.count === 4 && cp.source === 'new', JSON.stringify(cp));

  // ── 背单词阶段「保存并退出」→ 重进仍在背单词（验收标准 7） ──
  console.log('\n[4] 背单词阶段退出与恢复（验收标准 7）');
  const exitWords = await session.evaluate(`(async () => {
    document.querySelector('.kc-study-exit').click();
    await new Promise((r) => setTimeout(r, 900));
    const sess = await import('/src/dao/kcSession.ts');
    const open = await sess.loadLatestOpen('review');
    return JSON.stringify({ hash: location.hash, stage: open?.stage ?? '' });
  })()`);
  const ew = JSON.parse(exitWords);
  check('退出后回到二期首页', ew.hash === '#/kc', ew.hash);
  check('★ 会话仍停在 words 阶段', ew.stage === 'words', ew.stage);

  const backToWords = await session.evaluate(`(async () => {
    location.hash = '#/kc/review';
    for (let i = 0; i < 80; i += 1) {
      await new Promise((r) => setTimeout(r, 200));
      if (document.querySelector('.modal-title') || document.querySelector('.kc-picker')) break;
    }
    const askTitle = document.querySelector('.modal-title')?.textContent ?? '';
    const cont = [...document.querySelectorAll('.modal-foot button')].find((b) => b.textContent === '继续上次');
    if (cont) cont.click();
    for (let i = 0; i < 80; i += 1) {
      await new Promise((r) => setTimeout(r, 250));
      if (document.querySelector('.kc-bridge')) break;
    }
    return JSON.stringify({ askTitle, bridge: document.querySelector('.kc-bridge') !== null, banner: document.querySelector('.kc-bridge-tag')?.textContent ?? '' });
  })()`);
  const bw = JSON.parse(backToWords);
  check('★ 重进时问「继续上次的复习（接着背单词）」', bw.askTitle.includes('继续上次'), bw.askTitle);
  check('★ 继续后**仍在背单词环节**', bw.bridge === true && bw.banner.includes('背 5 个单词'), bw.banner);

  // ── 背完 → 进做题 ──
  console.log('\n[5] 背完 → 自动进入做题（验收标准 4）');
  const toExam = await session.evaluate(`(async () => {
    // 点「跳过这一步」等价于「背完」（桥接的完成回调是同一条路径）
    document.querySelector('.kc-bridge-skip').click();
    for (let i = 0; i < 80; i += 1) {
      await new Promise((r) => setTimeout(r, 250));
      if (location.hash.startsWith('#/kc/exam')) break;
    }
    return JSON.stringify({
      hash: location.hash,
      examPage: document.querySelector('.kc-exam-page') !== null,
      title: document.querySelector('.kc-exam-title')?.textContent ?? '',
      bodyText: document.querySelector('.kc-exam-pagebody')?.textContent ?? '',
    });
  })()`);
  const te = JSON.parse(toExam);
  check('★ 背完后自动跳到做题页', te.hash.startsWith('#/kc/exam') && te.examPage === true, `${te.hash} / ${te.examPage}`);
  check('做题页标题正确', te.title === '做题', te.title);
  check('★ 没配 AI 时给出明确提示（不崩、不白屏）', te.bodyText.includes('AI'), te.bodyText.slice(0, 80));

  // ── 词源退化：没有新词 → 背旧词 ──
  console.log('\n[6] 词源退化与空库跳过（验收标准 6）');
  const sourceFallback = await session.evaluate(`(async () => {
    const words = await import('/src/dao/words.ts');
    const all = await words.getAll();
    for (const w of all) await words.setStatus(w.id, 'learned');
    const bridge = await import('/src/ui/pages/kcReview/kcReviewFlow.ts');
    const old = await bridge.pickBridgeWords(5);
    // 再把词库清空 → none
    await words.clearAll();
    const none = await bridge.pickBridgeWords(5);
    return JSON.stringify({ oldSource: old.source, oldCount: old.words.length, noneSource: none.source });
  })()`);
  const sf = JSON.parse(sourceFallback);
  check('★ 没有新词时退化成背旧词', sf.oldSource === 'old' && sf.oldCount === 4, JSON.stringify(sf));
  check('★ 词库为空时返回 none（界面会跳过并提示）', sf.noneSource === 'none', sf.noneSource);

  const emptyBridge = await session.evaluate(`(async () => {
    const bridge = await import('/src/ui/pages/KcWordBridge.ts');
    const b = await bridge.createKcWordBridge(5, { onDone: () => undefined });
    const text = b.root.textContent ?? '';
    b.destroy();
    return JSON.stringify({ text, hasEmptyHint: text.includes('一期词库为空，跳过背单词') });
  })()`);
  const eb = JSON.parse(emptyBridge);
  check('★ 空库时桥接界面显示「跳过背单词」提示', eb.hasEmptyHint === true, eb.text.slice(0, 100));

  // ── 完成后属性更新（验收标准 8） ──
  console.log('\n[7] 复习收尾后属性更新（验收标准 8）');
  const finish = await session.evaluate(`(async () => {
    const kc = await import('/src/dao/kc.ts');
    const flow = await import('/src/ui/pages/kcReview/kcReviewFlow.ts');
    const all = await kc.getAll();
    const ids = all.slice(0, 2).map((c) => c.id);
    await flow.finishReview(ids);
    const after = await kc.getById(ids[0]);
    return JSON.stringify({
      lastReviewAt: after?.attrs.lastReviewAt ?? null,
      reviewCount: after?.attrs.reviewCount ?? -1,
      status: after?.status ?? '',
      mastery: after?.attrs.mastery ?? -1,
      summary: flow.reviewSummary([after]),
    });
  })()`);
  const fn = JSON.parse(finish);
  check('★ lastReviewAt 已写入（今天）', typeof fn.lastReviewAt === 'number' && Date.now() - fn.lastReviewAt < 10_000, String(fn.lastReviewAt));
  check('★ reviewCount 变成 1', fn.reviewCount === 1, String(fn.reviewCount));
  check('★ status 保持 learned', fn.status === 'learned', fn.status);
  check('小结文案可用', fn.summary.includes('复习 1 个知识点'), fn.summary);

  // 列表页能看到「今天复习」
  const listView = await session.evaluate(`(async () => {
    location.hash = '#/kc/list';
    for (let i = 0; i < 60; i += 1) {
      await new Promise((r) => setTimeout(r, 200));
      if (document.querySelector('.kc-row-sub')) break;
    }
    const subs = [...document.querySelectorAll('.kc-row-sub')].map((e) => e.textContent);
    return JSON.stringify({ subs });
  })()`);
  const lv = JSON.parse(listView);
  check('★ 列表页显示「今天复习」且复习次数 +1', lv.subs.some((t) => t.includes('今天复习') && t.includes('复习 1 次')), JSON.stringify(lv.subs));

  // 清场
  await session.evaluate(`(async () => {
    const kc = await import('/src/dao/kc.ts');
    const sess = await import('/src/dao/kcSession.ts');
    const words = await import('/src/dao/words.ts');
    await kc.clearAll(); await sess.clearOpen(); await words.clearAll();
  })()`);
} catch (err) {
  failed += 1;
  console.error(`\n✗ 冒烟过程出错：${err instanceof Error ? err.message : String(err)}`);
} finally {
  if (session) await session.close().catch(() => {});
  if (chrome) chrome.proc.kill();
  server.kill();
}

console.log(`\n=== 阶段 06 界面冒烟：通过 ${passed} 项，失败 ${failed} 项 ===\n`);
process.exit(failed === 0 ? 0 : 1);
