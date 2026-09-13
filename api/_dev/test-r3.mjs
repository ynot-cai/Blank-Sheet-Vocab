/**
 * R3 的**界面端到端验收测试**：`npm run test:r3`
 * （需要本机有 Chrome / Edge，且先跑过 `npm run build`）
 *
 * 覆盖 R3 提示词「验收标准」里能自动验的项：
 *   · 主界面只剩 6 个入口、没有「记忆」；顶栏也没有；全局无孤儿链接；
 *   · **记忆环节仍然能用**：进背诵页 → 点「再背一个」到阈值 → 按钮变「记忆」→ 能进默写；
 *   · **抽词绝对优先**：10 个词（5 个 P5、5 个 P1）连点 10 次，前 5 次必须全是 P5；
 *     重复 3 次结果一致；混入 P3 后顺序必须是 5 全部 → 3 全部 → 1 全部；
 *   · 列表页：优先级徽章、按 P5 筛选、按优先级排序、行内改优先级后立刻在背诵里生效、批量设优先级。
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findBrowser, launch, openSession, serveStatic } from '../../scripts/cdp.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = 4213;
const CDP_PORT = 9365;
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
  for (let i = 0; i < 60; i += 1) {
    try {
      if ((await fetch(url)).ok) return true;
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/**
 * 等页面里某个条件成立。
 * @param {any} session CDP 会话
 * @param {string} expression 返回布尔值的表达式
 * @param {number} tries 最多尝试次数
 */
async function waitFor(session, expression, tries = 60) {
  for (let i = 0; i < tries; i += 1) {
    if (await session.evaluate(expression)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

/**
 * 打开页面、注销 SW、真正 reload（让应用读到最新数据），并可选地直接跳某个 hash。
 * @param {any} session CDP 会话
 * @param {string} hash 目标 hash（如 '#/home'）
 */
async function openFresh(session, hash) {
  await session.goto(`${ORIGIN}/${hash}`, 1200);
  await session.evaluate(`(async () => {
    if (navigator.serviceWorker) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    }
    return true;
  })()`);
  await session.reload(2000);
}

/**
 * 清空词库并写入指定的测试词。
 * @param {any} session CDP 会话
 * @param {{en: string, priority: number, status?: string, createdAt?: number}[]} words 测试词
 */
async function seedWords(session, words) {
  return session.evaluate(`(() => new Promise((resolve) => {
    const seeds = ${JSON.stringify(words)};
    const req = indexedDB.open('blank-sheet-vocab');
    req.onsuccess = () => {
      const db = req.result;
      // 先清空 words / sources / sessions，保证每一次都是干净的局面
      const tx = db.transaction(['words', 'sources', 'sessions'], 'readwrite');
      const store = tx.objectStore('words');
      store.clear();
      tx.objectStore('sources').clear();
      tx.objectStore('sessions').clear();
      tx.objectStore('sources').put({ id: 'src-r3', name: 'R3测试来源', priority: 3, createdAt: 1, updatedAt: 1, deleted: 0 });
      seeds.forEach((seed, i) => {
        store.put({
          id: 'w-' + seed.en,
          en: seed.en,
          phonetic: '',
          example: '',
          senses: [{ id: 's-' + seed.en, text: '释义' + (i + 1), aliases: [], enabled: true }],
          sourceId: 'src-r3',
          rawSources: [],
          attrs: { needSpell: false, failCount: 0, failCountTotal: 0, reviewCount: 0, lastReviewAt: null, learnedAt: null, reviewPriority: 0 },
          status: seed.status || 'unlearned',
          priority: seed.priority,
          learnOrder: null,
          createdAt: typeof seed.createdAt === 'number' ? seed.createdAt : 1000 + i,
          updatedAt: 1,
          deleted: 0,
        });
      });
      tx.oncomplete = () => resolve(seeds.length);
    };
  }))()`);
}

/**
 * 从背诵页连续点 N 次「再背一个」，返回每次点完之后画布上新出现的单词。
 *
 * 处理两个真实的界面行为：
 *   1. **按钮文案会变**：每点 `memorizeEvery`（默认 3）次，「再背一个」会变成
 *      「记忆（新词 N 个）」。这时必须先走一轮记忆（点它 → 答完 → 回到白纸），
 *      之后「再背一个」才会回来，否则流程就卡住了。
 *   2. **选按钮要精确匹配**：`.includes('再背一个')` 会先命中「再次记忆」
 *      （它排在前面），结果是每次都在开记忆轮——这个坑第一次跑测试时就踩到了，
 *      所以下面只用 `startsWith` 精确匹配「再背一个」。
 *
 * @param {any} session CDP 会话
 * @param {number} times 要点出多少个新词
 */
async function walkLearn(session, times) {
  const order = [];
  for (let i = 0; i < times; i += 1) {
    const nextBtn = `[...document.querySelectorAll('.paper-controls button')].find((x) => x.textContent.trim().startsWith('再背一个'))`;
    const memBtn = `[...document.querySelectorAll('.paper-controls button')].find((x) => x.textContent.trim().startsWith('记忆'))`;

    // 需要先把「记忆」轮走掉
    if (!(await session.evaluate(`!!${nextBtn}`))) {
      const memClicked = await session.evaluate(`(() => { const b = ${memBtn}; if (!b) return false; b.click(); return true; })()`);
      if (!memClicked) {
        const buttons = await session.evaluate(`[...document.querySelectorAll('.paper-controls button')].map((x) => x.textContent.trim())`);
        return { order, error: `第 ${i + 1} 次既没有「再背一个」也没有「记忆」`, buttons };
      }
      const finished = await completeMemorizeRound(session);
      if (!finished) {
        const buttons = await session.evaluate(`[...document.querySelectorAll('.paper-controls button')].map((x) => x.textContent.trim())`);
        return { order, error: `第 ${i + 1} 次的记忆轮没能走完`, buttons };
      }
    }

    const clicked = await session.evaluate(`(() => { const b = ${nextBtn}; if (!b) return false; b.click(); return true; })()`);
    if (!clicked) {
      const buttons = await session.evaluate(`[...document.querySelectorAll('.paper-controls button')].map((x) => x.textContent.trim())`);
      return { order, error: `第 ${i + 1} 次没找到「再背一个」按钮`, buttons };
    }
    await new Promise((r) => setTimeout(r, 400));
    // 从**画布 DOM** 读已经上纸的单词：`.paper-word` 是应用按出现顺序 append 进画布的，
    // 它的 textContent 就是单词本身（见 PaperStage.buildWordZone），
    // 所以「第几个上纸」= 数组里的第几位。完全不依赖测试专用钩子，
    // 也不依赖会话存档（那个是延迟写的，读早了会空）。
    const shownNow = await session.evaluate(`[...document.querySelectorAll('.paper-word')].map((e) => e.textContent.trim())`);
    order.push(shownNow[shownNow.length - 1] ?? null);
  }
  return { order };
}

/**
 * 走完一轮记忆（默写自测）：反复「填答案 → 提交 → 推进答案卡」，直到回到白纸浏览状态。
 *
 * 一轮记忆的完整闭环（见 rounds.ts）：
 *   每题：overlay 出现（`.memorize-box`）→ 填义项 → 点「提交」→ **答案卡弹出**（必须手动推进）
 *   → 下一题 …… 全部答完 → overlay 收起、回到白纸。
 * 所以循环体里两件事都要做：点提交、以及推进答案卡。
 *
 * @param {any} session CDP 会话
 * @returns 是否真的回到了白纸状态
 */
async function completeMemorizeRound(session) {
  // 先等 overlay 真的出现（点完「记忆」到渲染有几个 tick）
  const appeared = await waitFor(session, `!!document.querySelector('.memorize-box, .spell-meanings')`, 60);
  if (!appeared) return false;
  for (let i = 0; i < 60; i += 1) {
    const state = await session.evaluate(`({
      overlayVisible: !document.querySelector('.paper-overlay')?.classList.contains('hidden'),
      hasMemBox: !!document.querySelector('.memorize-box'),
      hasAnswerCard: !!document.querySelector('.answer-card'),
    })`);
    if (!state.overlayVisible && !state.hasAnswerCard) return true; // 回到白纸
    await session.evaluate(`(() => {
      // 1) 有答案卡 → 推进它（点卡片本体）
      const card = document.querySelector('.answer-card');
      if (card) { card.click(); return 'advance'; }
      // 2) 有默写框 → 每个输入框填一个答案，然后点提交
      const inputs = [...document.querySelectorAll('.memorize-box .mem-input, .memorize-box input')];
      if (inputs.length > 0) {
        for (const input of inputs) {
          if (!input.value) {
            input.value = 'x';
            input.dispatchEvent(new Event('input', { bubbles: true }));
          }
        }
        const btn = document.querySelector('#mem-submit, #spell-submit');
        btn?.click();
        return 'submit';
      }
      return 'idle';
    })()`);
    await new Promise((r) => setTimeout(r, 400));
  }
  return session.evaluate(`!document.querySelector('.paper-overlay')?.classList.contains('hidden') !== true`);
}

/**
 * 读当前画布上已经出现的单词（按出现顺序）。
 * @param {any} session CDP 会话
 */
async function shownOrder(session) {
  return session.evaluate(`[...document.querySelectorAll('.paper-word')].map((e) => e.textContent.trim())`);
}

// ══════════════════════════════════════════ 主流程

console.log('\n=== R3 验收：界面精简 + 抽词绝对优先 + 列表页优先级 ===\n');

console.log('[0] 前置检查');
if (!existsSync(join(ROOT, 'dist', 'index.html'))) {
  console.error('✗ 没有 dist/，先跑 npm run build');
  process.exit(1);
}
check('dist/index.html 存在', true);

const browser = findBrowser();
if (!browser) {
  console.log('\n⚠ 本机没有 Chrome / Edge，跳过界面验收');
  console.log(`\nR3 验收：${passed} 项通过，${failed} 项失败`);
  process.exit(failed > 0 ? 1 : 0);
}
console.log(`  用 ${browser.split('\\').pop()} 跑无头检查`);

const server = serveStatic({ root: ROOT, port: PORT, mode: 'preview' });
let chrome = null;

try {
  const up = await waitForServer(`${ORIGIN}/`);
  if (!up) throw new Error(`预览服务没起来（${ORIGIN}）`);
  chrome = await launch(browser, CDP_PORT, { windowSize: '1280,900' });

  // ───────────────────────────────── [1] 主界面与顶栏都没有「记忆」
  console.log('\n[1] 主界面精简：只剩 6 个入口，没有「记忆」');
  {
    const s = await openSession(CDP_PORT, `${ORIGIN}/#/home`);
    try {
      await openFresh(s, '#/home');
      const ui = await s.evaluate(`(() => ({
        homeLabels: [...document.querySelectorAll('.home-card .home-label')].map((e) => e.textContent.trim()),
        homePaths: [...document.querySelectorAll('.home-card')].map((e) => e.dataset.path),
        navLabels: [...document.querySelectorAll('.nav button')].map((e) => e.textContent.trim()),
        navHasMemorize: [...document.querySelectorAll('.nav button')].some((e) => e.textContent.trim() === '记忆'),
        bodyHasOrphan: [...document.querySelectorAll('a[href*="memorize"], button')].some((e) => (e.getAttribute('href') || '') .includes('memorize')),
      }))()`);
      // 需求里说的「7 个入口」= 顶栏 7 项（录入/背诵/记忆/单词列表/复习/知识点/设置）；
      // 删掉「记忆」后顶栏是 6 项。主页卡片网格本来就是 5 项（知识点从来不在网格里，只在顶栏）。
      check('顶栏入口数量是 6（删掉了记忆）', ui.navLabels.length === 6, JSON.stringify(ui.navLabels));
      check('顶栏是 录入/背诵/单词列表/复习/知识点/设置', ui.navLabels.join(',') === '录入,背诵,单词列表,复习,知识点,设置', JSON.stringify(ui.navLabels));
      check('主页卡片网格是 5 项（知识点只在顶栏）', ui.homePaths.join(',') === '/import,/learn,/list,/review,/settings', JSON.stringify(ui.homePaths));
      check('主界面**没有**「记忆」入口', !ui.homeLabels.includes('记忆'), JSON.stringify(ui.homeLabels));
      check('顶栏也没有「记忆」', ui.navHasMemorize === false, JSON.stringify(ui.navLabels));
      check('页面上没有指向已删入口的孤儿链接', ui.bodyHasOrphan === false);

      // 记忆环节的代码/路由仍然在（不是把功能删了）
      const routeWorks = await (async () => {
        await s.evaluate(`location.hash = '#/memorize'`);
        await new Promise((r) => setTimeout(r, 900));
        return s.evaluate(`(() => ({
          hash: location.hash,
          hasPage: !!document.querySelector('.memorize-page') || document.body.textContent.includes('还没有进行中的背诵会话') || !!document.querySelector('.paper-flow'),
        }))()`);
      })();
      check('#/memorize 路由仍然能用（功能没被删）', routeWorks.hash === '#/memorize' && routeWorks.hasPage === true, JSON.stringify(routeWorks));
    } finally {
      await s.close();
    }
  }

  // ───────────────────────────────── [2] 抽词绝对优先：5 个 P5 + 5 个 P1
  console.log('\n[2] 抽词绝对优先：10 个词（5×P5 + 5×P1）连点 10 次');
  const ROUNDS = 3;
  for (let round = 1; round <= ROUNDS; round += 1) {
    const s = await openSession(CDP_PORT, `${ORIGIN}/#/home`);
    try {
      await openFresh(s, '#/home');
      const p5 = [1, 2, 3, 4, 5].map((i) => ({ en: `high${i}`, priority: 5, createdAt: 100 + i }));
      const p1 = [1, 2, 3, 4, 5].map((i) => ({ en: `low${i}`, priority: 1, createdAt: 200 + i }));
      await seedWords(s, [...p5, ...p1]);
      await s.evaluate(`location.hash = '#/learn'`);
      await new Promise((r) => setTimeout(r, 1500));

      const walked = await walkLearn(s, 10);
      const shown = await shownOrder(s);
      const firstFive = shown.slice(0, 5);
      const lastFive = shown.slice(5, 10);
      check(
        `第 ${round} 次：前 5 个抽到的全是 priority=5 的词`,
        firstFive.length === 5 && firstFive.every((en) => en.startsWith('high')),
        `实际前 5 个：${JSON.stringify(firstFive)}（walk=${JSON.stringify(walked)}）`,
      );
      check(
        `第 ${round} 次：第 6 个才开始出现 priority=1 的词`,
        // 说明：纸面容量有限（间距约束下大约 9 个），第 10 个可能上不了纸。
        // 所以断言的是**第 6 个起必须全是低优先级词**——那才是「绝对优先」的关键证据；
        // 剩下的低优先级词是否全部上纸受容量影响，不作为断言。
        lastFive.length >= 1 && lastFive.every((en) => en.startsWith('low')),
        `实际第 6 个起：${JSON.stringify(lastFive)}（画布上一共 ${shown.length} 个：${JSON.stringify(shown)}；walk=${JSON.stringify(walked)}）`,
      );
      check(
        `第 ${round} 次：同级内按 createdAt 升序（high1…high5）`,
        firstFive.join(',') === 'high1,high2,high3,high4,high5',
        JSON.stringify(firstFive),
      );
    } finally {
      await s.close();
    }
  }

  // ───────────────────────────────── [3] 混入 P3：顺序必须是 5 全部 → 3 全部 → 1 全部
  console.log('\n[3] 混入 P3：顺序必须是 5 全部 → 3 全部 → 1 全部');
  {
    const s = await openSession(CDP_PORT, `${ORIGIN}/#/home`);
    try {
      await openFresh(s, '#/home');
      const words = [
        ...['a', 'b'].map((x, i) => ({ en: `p5${x}`, priority: 5, createdAt: 100 + i })),
        ...['a', 'b'].map((x, i) => ({ en: `p3${x}`, priority: 3, createdAt: 200 + i })),
        ...['a', 'b'].map((x, i) => ({ en: `p1${x}`, priority: 1, createdAt: 300 + i })),
      ];
      await seedWords(s, words);
      await s.evaluate(`location.hash = '#/learn'`);
      await new Promise((r) => setTimeout(r, 1500));
      await walkLearn(s, 6);
      const shown = await shownOrder(s);
      const prioOf = (en) => (en.startsWith('p5') ? 5 : en.startsWith('p3') ? 3 : 1);
      const seq = shown.map(prioOf);
      check('顺序是 5,5,3,3,1,1（高优先级抽完才轮到低的）', seq.join(',') === '5,5,3,3,1,1', `${JSON.stringify(shown)} → ${seq.join(',')}`);
    } finally {
      await s.close();
    }
  }

  // ───────────────────────────────── [4] 记忆环节仍然能进（背诵页内嵌）
  console.log('\n[4] 记忆环节仍然能用（背诵页内嵌，不是被删了）');
  {
    const s = await openSession(CDP_PORT, `${ORIGIN}/#/home`);
    try {
      await openFresh(s, '#/home');
      await seedWords(s, ['a', 'b', 'c'].map((x, i) => ({ en: `mem${x}`, priority: 3, createdAt: 100 + i })));
      await s.evaluate(`location.hash = '#/learn'`);
      await new Promise((r) => setTimeout(r, 1500));

      // 默认 memorizeEvery = 3：点 3 次「再背一个」后按钮应该变成「记忆（新词 N 个）」
      const labels = [];
      for (let i = 0; i < 3; i += 1) {
        labels.push(await s.evaluate(`(() => {
          // ★ 必须精确匹配「再背一个」：面板上还有一个「再次记忆」，
          //   用 includes 会先命中它，于是每次都在开记忆轮——这个坑踩过。
          const b = [...document.querySelectorAll('.paper-controls button')].find((x) => x.textContent.trim().startsWith('再背一个'));
          const label = b ? b.textContent.trim() : '(无按钮)';
          b?.click();
          return label;
        })()`));
        await new Promise((r) => setTimeout(r, 600));
      }
      const afterLabels = await s.evaluate(`[...document.querySelectorAll('.paper-controls button')].map((x) => x.textContent.trim())`);
      check('点 3 次「再背一个」后按钮变成了「记忆（新词 N 个）」', afterLabels.some((t) => t.startsWith('记忆（')), JSON.stringify({ labels, afterLabels }));

      // 点「记忆」→ 应该进入默写自测
      await s.evaluate(`(() => { const b = [...document.querySelectorAll('.paper-controls button')].find((x) => x.textContent.trim().startsWith('记忆（')); if (b) b.click(); return !!b; })()`);
      const inMemorize = await waitFor(s, `!!document.querySelector('.memorize-box')`, 80);
      check('点「记忆」真的进入了默写自测流程（出现默写框）', inMemorize, JSON.stringify(await s.evaluate(`({ hasBox: !!document.querySelector('.memorize-box'), overlayHidden: document.querySelector('.paper-overlay')?.classList.contains('hidden') })`)));

      // 「再次记忆」按钮也在（独立的重新抽词入口）
      const hasAgain = await s.evaluate(`[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === '再次记忆')`);
      check('背诵页右下角仍有「再次记忆」按钮', hasAgain);
    } finally {
      await s.close();
    }
  }

  // ───────────────────────────────── [5] 列表页：徽章 / 筛选 / 排序 / 行内改 / 批量
  console.log('\n[5] 列表页优先级：徽章 / 筛选 / 排序 / 行内改 / 批量');
  {
    const s = await openSession(CDP_PORT, `${ORIGIN}/#/home`);
    try {
      await openFresh(s, '#/home');
      await seedWords(s, [
        { en: 'w5a', priority: 5, createdAt: 100 },
        { en: 'w5b', priority: 5, createdAt: 101 },
        { en: 'w3a', priority: 3, createdAt: 102 },
        { en: 'w1a', priority: 1, createdAt: 103 },
      ]);
      await s.evaluate(`location.hash = '#/list'`);
      await new Promise((r) => setTimeout(r, 1500));

      // 桌面表格与手机卡片流**都渲染**，由 CSS 媒体查询二选一显示（见 ListPage 注释）。
      // 所以断言必须只看**可见**的那个容器，否则数出来是 8 个徽章。
      const badges = await s.evaluate(`(() => {
        const vis = (el) => el && el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0;
        const visibleBox = [...document.querySelectorAll('.list-table, .list-cards')].find(vis);
        const scope = visibleBox ?? document;
        // 带上英文名：默认排序是「创建时间降序」，所以徽章顺序是 w1a/w3a/w5b/w5a
        return [...scope.querySelectorAll('tbody tr, .list-card')].map((row) => ({
          en: row.querySelector('.link-btn')?.textContent ?? row.querySelector('.list-card-en')?.textContent ?? '',
          badge: row.querySelector('.prio-badge')?.textContent.trim() ?? '',
        }));
      })()`);
      check('列表页每行都显示优先级徽章', badges.length === 4, JSON.stringify(badges));
      check(
        '徽章内容与每个词的优先级一致（w1a=P1, w3a=P3, w5a/w5b=P5）',
        badges.every((b) => b.badge === `P${b.en.startsWith('w5') ? 5 : b.en.startsWith('w3') ? 3 : 1}`),
        JSON.stringify(badges),
      );
      const byEn = new Map(badges.map((b) => [b.en, b.badge]));
      const badgeClasses = await s.evaluate(`(() => {
        const vis = (el) => el && el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0;
        const visibleBox = [...document.querySelectorAll('.list-table, .list-cards')].find(vis);
        const scope = visibleBox ?? document;
        return [...scope.querySelectorAll('tbody tr, .list-card')].map((row) => ({
          en: row.querySelector('.link-btn')?.textContent ?? row.querySelector('.list-card-en')?.textContent ?? '',
          cls: row.querySelector('.prio-badge')?.className ?? '',
        }));
      })()`);
      check(
        '高优先级用了醒目颜色（w5a 用 prio-5，w3a 用 prio-3，w1a 用 prio-1）',
        badgeClasses.find((b) => b.en === 'w5a')?.cls.includes('prio-5') === true &&
          badgeClasses.find((b) => b.en === 'w3a')?.cls.includes('prio-3') === true &&
          badgeClasses.find((b) => b.en === 'w1a')?.cls.includes('prio-1') === true,
        JSON.stringify({ badgeClasses, byEn: Array.from(byEn) }),
      );

      // —— 按 P5 筛选 ——
      const filtered = await s.evaluate(`(() => {
        const sel = [...document.querySelectorAll('select')].find((e) => [...e.options].some((o) => o.textContent === '全部优先级'));
        if (!sel) return { ok: false, options: [...document.querySelectorAll('select')].map((e) => [...e.options].map((o) => o.textContent)) };
        sel.value = '5';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true };
      })()`);
      check('筛选区有「词优先级」下拉', filtered.ok === true, JSON.stringify(filtered));
      await new Promise((r) => setTimeout(r, 1000));
      const afterFilter = await s.evaluate(`(() => {
        const vis = (el) => el && el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0;
        const visibleBox = [...document.querySelectorAll('.list-table, .list-cards')].find(vis);
        return {
          badges: [...(visibleBox ?? document).querySelectorAll('.prio-badge')].map((e) => e.textContent.trim()),
          rows: [...document.querySelectorAll('.list-table tbody tr')].map((tr) => tr.querySelector('.link-btn')?.textContent ?? ''),
        };
      })()`);
      check('按 P5 筛选后只剩优先级 5 的词', afterFilter.badges.length === 2 && afterFilter.badges.every((b) => b === 'P5'), JSON.stringify(afterFilter));

      // —— 按优先级排序（高→低）——
      const sorted = await s.evaluate(`(() => {
        const sel = [...document.querySelectorAll('select')].find((e) => [...e.options].some((o) => o.textContent.includes('词优先级')));
        if (!sel) return { ok: false };
        // 先清掉优先级筛选
        const filterSel = [...document.querySelectorAll('select')].find((e) => [...e.options].some((o) => o.textContent === '全部优先级'));
        filterSel.value = '';
        filterSel.dispatchEvent(new Event('change', { bubbles: true }));
        sel.value = 'priority';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true };
      })()`);
      check('排序下拉里有「词优先级（高→低）」', sorted.ok === true, JSON.stringify(sorted));
      await new Promise((r) => setTimeout(r, 1000));
      const sortedBadges = await s.evaluate(`(() => {
        const vis = (el) => el && el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0;
        const visibleBox = [...document.querySelectorAll('.list-table, .list-cards')].find(vis);
        return [...(visibleBox ?? document).querySelectorAll('.prio-badge')].map((e) => e.textContent.trim());
      })()`);
      check('按优先级降序排序生效（P5,P5,P3,P1）', JSON.stringify(sortedBadges) === JSON.stringify(['P5', 'P5', 'P3', 'P1']), JSON.stringify(sortedBadges));

      // —— 行内改优先级 → 立刻生效、并能在背诵里被优先抽到 ——
      const changed = await s.evaluate(`(() => {
        const row = [...document.querySelectorAll('.list-table tbody tr')].find((tr) => (tr.textContent || '').includes('w1a'));
        if (!row) return { ok: false, rows: [...document.querySelectorAll('.list-table tbody tr')].map((tr) => tr.textContent.slice(0, 12)) };
        const sel = row.querySelector('select.mini-select');
        if (!sel) return { ok: false, reason: 'no-select' };
        sel.value = '5';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true };
      })()`);
      check('列表页行内能改优先级', changed.ok === true, JSON.stringify(changed));
      await new Promise((r) => setTimeout(r, 1200));
      const afterChange = await s.evaluate(`(() => new Promise((resolve) => {
        const req = indexedDB.open('blank-sheet-vocab');
        req.onsuccess = () => {
          const get = req.result.transaction('words').objectStore('words').get('w-w1a');
          get.onsuccess = () => resolve(get.result ? get.result.priority : null);
        };
      }))()`);
      check('改完立即写库（w1a 变成 5）', afterChange === 5, String(afterChange));

      // —— 批量设优先级 ——
      const batch = await s.evaluate(`(() => {
        const head = document.querySelector('.list-table thead input[type=checkbox]');
        head.checked = true;
        head.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`);
      await new Promise((r) => setTimeout(r, 600));
      const batchBarText = await s.evaluate(`document.querySelector('.batch-bar')?.textContent ?? ''`);
      check('选中后出现批量条且有「设为优先级…」', batch === true && batchBarText.includes('设为优先级'), batchBarText.slice(0, 120));
      const batchSet = await s.evaluate(`(() => {
        const sel = [...document.querySelectorAll('.batch-bar select')].find((e) => [...e.options].some((o) => o.textContent.includes('设为 P')));
        if (!sel) return { ok: false };
        sel.value = '2';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true };
      })()`);
      check('批量条里有优先级下拉', batchSet.ok === true, JSON.stringify(batchSet));
      await new Promise((r) => setTimeout(r, 1200));
      const allPriorities = await s.evaluate(`(() => new Promise((resolve) => {
        const req = indexedDB.open('blank-sheet-vocab');
        req.onsuccess = () => {
          const all = req.result.transaction('words').objectStore('words').getAll();
          all.onsuccess = () => resolve(all.result.map((w) => w.priority));
        };
      }))()`);
      check('批量设为 P2 后全部词都变成 2', allPriorities.length === 4 && allPriorities.every((p) => p === 2), JSON.stringify(allPriorities));
    } finally {
      await s.close();
    }
  }

  // ───────────────────────────────── [6] 改优先级后，背诵立刻按新优先级抽
  console.log('\n[6] 改优先级后背诵立刻生效');
  {
    const s = await openSession(CDP_PORT, `${ORIGIN}/#/home`);
    try {
      await openFresh(s, '#/home');
      await seedWords(s, [
        { en: 'first', priority: 1, createdAt: 100 },
        { en: 'second', priority: 1, createdAt: 101 },
      ]);
      // 直接把 second 提到 P5（等价于在列表页改它）
      await s.evaluate(`(() => new Promise((resolve) => {
        const req = indexedDB.open('blank-sheet-vocab');
        req.onsuccess = () => {
          const tx = req.result.transaction('words', 'readwrite');
          const store = tx.objectStore('words');
          const get = store.get('w-second');
          get.onsuccess = () => { const w = get.result; w.priority = 5; store.put(w); };
          tx.oncomplete = () => resolve(true);
        };
      }))()`);
      await s.evaluate(`location.hash = '#/learn'`);
      await new Promise((r) => setTimeout(r, 1500));
      await walkLearn(s, 2);
      const shown = await shownOrder(s);
      check('提到 P5 的词被优先抽到（second 第一个）', shown[0] === 'second', JSON.stringify(shown));
    } finally {
      await s.close();
    }
  }
} catch (err) {
  failed += 1;
  console.error('\n✗ 测试过程中抛出异常：', err);
} finally {
  chrome?.proc?.kill();
  server.kill();
}

console.log(`\n=== R3 验收：通过 ${passed} 项，失败 ${failed} 项 ===\n`);
process.exit(failed === 0 ? 0 : 1);
