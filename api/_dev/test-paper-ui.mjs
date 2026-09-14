/**
 * 背诵流程的**界面端到端验收**：`npm run test:paper-ui`
 * （需要本机有 Chrome / Edge，且先跑过 `npm run build`）
 *
 * 这些只能靠真浏览器验（纯 Node 那套 `test-paper.mjs` 只能验纯函数与接线）：
 *   [1] Enter 在义项框之间**逐格切换**，最后一格才提交
 *   [2] 记忆答案卡 = 普通单词卡：**能改**（改完真的写库）、点卡内控件**不会关卡片**
 *   [3] 答案卡上能**斩**，斩完能撤销
 *   [4] 「保存并退出」→ 再点「背诵」（**不带 ?resume=1**）→ 位置 / 进度 / 记忆遍数都还在
 *   [5] 拼写环节只拼**当次记忆选中的词**里标了「拼」的那些
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findBrowser, launch, openSession, serveStatic } from '../../scripts/cdp.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = 4217;
const CDP_PORT = 9369;
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
 * @param {number} tries 最多尝试次数（每次 250ms）
 */
async function waitFor(session, expression, tries = 60) {
  for (let i = 0; i < tries; i += 1) {
    if (await session.evaluate(expression)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

/**
 * 打开页面、注销 SW、真正 reload。
 * @param {any} session CDP 会话
 * @param {string} hash 目标 hash
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
 * 清空词库并写入测试词（义项与「拼」标记都可指定）。
 * @param {any} session CDP 会话
 * @param {{en: string, needSpell?: boolean, senses?: {text: string, aliases?: string[]}[]}[]} words 测试词
 */
async function seedWords(session, words) {
  return session.evaluate(`(() => new Promise((resolve) => {
    const seeds = ${JSON.stringify(words)};
    const req = indexedDB.open('blank-sheet-vocab');
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction(['words', 'sources', 'sessions'], 'readwrite');
      const store = tx.objectStore('words');
      store.clear();
      tx.objectStore('sources').clear();
      tx.objectStore('sessions').clear();
      tx.objectStore('sources').put({ id: 'src-p', name: '背诵测试来源', priority: 3, createdAt: 1, updatedAt: 1, deleted: 0 });
      seeds.forEach((seed, i) => {
        store.put({
          id: 'w-' + seed.en,
          en: seed.en,
          phonetic: '',
          example: '',
          senses: (seed.senses || [{ text: '释义' + (i + 1), aliases: [] }]).map((s, k) => ({
            id: 's-' + seed.en + '-' + k,
            text: s.text,
            aliases: s.aliases || [],
            enabled: true,
          })),
          sourceId: 'src-p',
          rawSources: [],
          attrs: { needSpell: seed.needSpell === true, failCount: 0, failCountTotal: 0, reviewCount: 0, lastReviewAt: null, learnedAt: null, reviewPriority: 0 },
          status: 'unlearned',
          priority: 3,
          learnOrder: null,
          createdAt: 1000 + i,
          updatedAt: 1,
          deleted: 0,
        });
      });
      tx.oncomplete = () => resolve(seeds.length);
    };
  }))()`);
}

/** 读词库里的词（验「改义项真的写库了」） */
async function readWords(session) {
  return session.evaluate(`(() => new Promise((resolve) => {
    const req = indexedDB.open('blank-sheet-vocab');
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction(['words'], 'readonly');
      const all = tx.objectStore('words').getAll();
      all.onsuccess = () => resolve(all.result.map((w) => ({ en: w.en, phonetic: w.phonetic, status: w.status, needSpell: w.attrs.needSpell })));
    };
  }))()`);
}

/** 读会话存档（验「进度 / 位置 / 记忆遍数都留下来了」） */
async function readSession(session) {
  return session.evaluate(`(() => new Promise((resolve) => {
    const req = indexedDB.open('blank-sheet-vocab');
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction(['sessions'], 'readonly');
      const all = tx.objectStore('sessions').getAll();
      all.onsuccess = () => resolve(all.result.map((s) => ({
        wordIds: s.wordIds, shownIds: s.shownIds, memorizeCount: s.memorizeCount,
        placements: s.placements, lastRoundFailedIds: s.lastRoundFailedIds ?? null,
      })));
    };
  }))()`);
}

/** 画布上每个词的位置（CSS left/top，可用来验「同一次会话的位置没变」） */
const PLACEMENTS_EXPR = `[...document.querySelectorAll('.paper-word-zone')].map((z) => z.style.left + ',' + z.style.top).sort()`;

/** 在某个输入框上按 Enter（合成事件：监听器就挂在这个元素上，与真实按键等价） */
function pressEnterOn(selector, index = 0) {
  return `(() => {
    const el = [...document.querySelectorAll(${JSON.stringify(selector)})][${index}];
    if (!el) return false;
    el.focus();
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    return true;
  })()`;
}

// ══════════════════════════════════════════ 主流程

console.log('\n=== 背诵流程验收：Enter 逐格 / 答案卡可改可斩 / 保存续跑 / 拼写词源 ===\n');

console.log('[0] 前置检查');
if (!existsSync(join(ROOT, 'dist', 'index.html'))) {
  console.error('✗ 没有 dist/，先跑 npm run build');
  process.exit(1);
}
check('dist/index.html 存在', true);

const browser = findBrowser();
if (!browser) {
  console.log('\n⚠ 本机没有 Chrome / Edge，跳过界面验收');
  console.log(`\n背诵流程界面验收：${passed} 项通过，${failed} 项失败`);
  process.exit(failed > 0 ? 1 : 0);
}
console.log(`  用 ${browser.split('\\').pop()} 跑无头检查`);

const server = serveStatic({ root: ROOT, port: PORT, mode: 'preview' });
let chrome = null;

try {
  const up = await waitForServer(`${ORIGIN}/`);
  if (!up) throw new Error(`预览服务没起来（${ORIGIN}）`);
  chrome = await launch(browser, CDP_PORT, { windowSize: '1280,900' });

  // ─────────────── [1][2][3] Enter 逐格 + 答案卡可改可斩
  console.log('\n[1] 义项输入框：Enter 逐格切换，最后一格才提交');
  {
    const s = await openSession(CDP_PORT, `${ORIGIN}/#/home`);
    try {
      await openFresh(s, '#/home');
      await seedWords(s, [
        { en: 'bank', senses: [{ text: 'n. 银行', aliases: [] }, { text: 'n. 河岸', aliases: ['岸边'] }] },
      ]);
      await s.evaluate(`location.hash = '#/learn'`);
      await new Promise((r) => setTimeout(r, 1500));

      // 上纸 → 再次记忆
      await s.evaluate(`(() => {
        const b = [...document.querySelectorAll('.paper-controls button')].find((x) => x.textContent.trim().startsWith('再背一个'));
        b?.click();
        return true;
      })()`);
      await new Promise((r) => setTimeout(r, 800));
      await s.evaluate(`(() => {
        const b = [...document.querySelectorAll('.paper-controls button')].find((x) => x.textContent.trim().startsWith('再次记忆'));
        b?.click();
        return true;
      })()`);
      check('进入记忆环节（出现 2 个义项输入框）', await waitFor(s, `document.querySelectorAll('.mem-input').length === 2`));
      check('界面上有「按 Enter 填下一个义项」的提示', (await s.evaluate(`!!document.querySelector('.mem-hint')`)) === true);

      // 第一格填好 → Enter → 应该跳到第二格，且**不**弹答案卡
      await s.evaluate(`(() => {
        const inputs = [...document.querySelectorAll('.mem-input')];
        inputs[0].value = '银行';
        inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`);
      await s.evaluate(pressEnterOn('.mem-input', 0));
      await new Promise((r) => setTimeout(r, 500));
      const afterFirst = await s.evaluate(`({
        focusedIndex: [...document.querySelectorAll('.mem-input')].indexOf(document.activeElement),
        answerCard: !!document.querySelector('.answer-card'),
        value0: document.querySelectorAll('.mem-input')[0]?.value ?? '',
      })`);
      check('★ 第一格按 Enter → 焦点跳到第二格', afterFirst.focusedIndex === 1, JSON.stringify(afterFirst));
      check('★ 第一格按 Enter **不会**提交（没有弹答案卡）', afterFirst.answerCard === false, JSON.stringify(afterFirst));
      check('第一格填的内容还在（切换不该清空）', afterFirst.value0 === '银行', JSON.stringify(afterFirst));

      // 第二格填好 → Enter → 这次应该提交
      await s.evaluate(`(() => {
        const inputs = [...document.querySelectorAll('.mem-input')];
        inputs[1].value = '岸边';
        inputs[1].dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`);
      await s.evaluate(pressEnterOn('.mem-input', 1));
      check('★ 最后一格按 Enter → 提交（弹出答案卡）', await waitFor(s, `!!document.querySelector('.answer-card')`));
      const marks = await s.evaluate(`[...document.querySelectorAll('.answer-cmp-line')].map((e) => e.className.includes('ok') ? 'ok' : 'bad')`);
      check('两格都判对（含近义词「岸边」）', marks.join(',') === 'ok,ok', JSON.stringify(marks));

      // ─────────────── [2] 答案卡 = 普通单词卡
      const cardShape = await s.evaluate(`({
        editableInputs: document.querySelectorAll('.answer-card input').length,
        hasSpell: [...document.querySelectorAll('.answer-card button')].some((b) => b.textContent.includes('拼')),
        hasChop: [...document.querySelectorAll('.answer-card button')].some((b) => b.textContent.includes('斩掉此词')),
        hasViewSenses: [...document.querySelectorAll('.answer-card button')].some((b) => b.textContent.includes('查看义项')),
      })`);
      check('★ 答案卡是可编辑的（有输入框）', cardShape.editableInputs > 0, JSON.stringify(cardShape));
      check('★ 答案卡上有「拼」按钮', cardShape.hasSpell === true, JSON.stringify(cardShape));
      check('★ 答案卡上有「斩掉此词」按钮', cardShape.hasChop === true, JSON.stringify(cardShape));
      check('答案卡上仍保留「查看义项」', cardShape.hasViewSenses === true, JSON.stringify(cardShape));

      // 点卡内的输入框 → 卡片不许关（否则没法改）
      await s.evaluate(`(() => {
        const el = document.querySelector('.answer-card input');
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        return true;
      })()`);
      await new Promise((r) => setTimeout(r, 300));
      check('★ 点卡内输入框不会把卡片关掉', (await s.evaluate(`!!document.querySelector('.answer-card')`)) === true);

      // 展开义项面板 → 点面板内部也不许关
      await s.evaluate(`(() => {
        const b = [...document.querySelectorAll('.answer-card button')].find((x) => x.textContent.includes('查看义项'));
        b?.click();
        return true;
      })()`);
      await new Promise((r) => setTimeout(r, 400));
      const panelOpen = await s.evaluate(`!document.querySelector('.answer-card .sense-panel')?.classList.contains('hidden')`);
      check('点「查看义项」能展开义项面板', panelOpen === true);
      await s.evaluate(`(() => {
        const el = document.querySelector('.answer-card .sense-panel');
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        return true;
      })()`);
      await new Promise((r) => setTimeout(r, 300));
      check('★ 点义项面板不会把卡片关掉', (await s.evaluate(`!!document.querySelector('.answer-card')`)) === true);

      // 真的改一个字段（音标）→ 等防抖 → 库里要变
      await s.evaluate(`(() => {
        const el = document.querySelector('.answer-card input');
        el.value = '/bæŋk/';
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`);
      await new Promise((r) => setTimeout(r, 1200));
      const wordsAfterEdit = await readWords(s);
      check('★ 在答案卡里改音标 → 真的写进库了（考察中也能改）', wordsAfterEdit.find((w) => w.en === 'bank')?.phonetic === '/bæŋk/', JSON.stringify(wordsAfterEdit));

      // ─────────────── [3] 答案卡上斩 + 撤销
      await s.evaluate(`(() => {
        const b = [...document.querySelectorAll('.answer-card button')].find((x) => x.textContent.includes('斩掉此词'));
        b?.click();
        return true;
      })()`);
      await new Promise((r) => setTimeout(r, 800));
      const afterChop = await s.evaluate(`({
        toasts: [...document.querySelectorAll('.toast-undo')].map((e) => e.textContent.trim()),
        cardStillOpen: !!document.querySelector('.answer-card'),
      })`);
      const choppedWords = await readWords(s);
      check('★ 在答案卡上斩 → 库里变成 chopped', choppedWords.find((w) => w.en === 'bank')?.status === 'chopped', JSON.stringify(choppedWords));
      check('★ 斩后出现「已斩 …〔撤销〕」Toast', afterChop.toasts.length === 1 && afterChop.toasts[0].includes('撤销'), JSON.stringify(afterChop.toasts));
      check('斩不会把答案卡弄没（撤销完还能接着看）', afterChop.cardStillOpen === true, JSON.stringify(afterChop));

      await s.evaluate(`document.querySelector('.toast-undo-btn')?.click()`);
      await new Promise((r) => setTimeout(r, 900));
      const restoredWords = await readWords(s);
      check('★ 撤销后词回到未斩状态', restoredWords.find((w) => w.en === 'bank')?.status === 'unlearned', JSON.stringify(restoredWords));

      // 推进答案卡（点画布外部区域）
      await s.evaluate(`(() => {
        const el = document.querySelector('.paper-sheet') ?? document.body;
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        return true;
      })()`);
      await new Promise((r) => setTimeout(r, 600));
      check('点卡片外部能推进（回到白纸浏览）', (await s.evaluate(`!!document.querySelector('.answer-card')`)) === false);
    } finally {
      await s.close();
    }
  }

  // ─────────────── [5] 拼写环节只拼当次记忆选中的词
  console.log('\n[2] 拼写环节：只拼「当次记忆选到 + 标了拼」的词');
  {
    const s = await openSession(CDP_PORT, `${ORIGIN}/#/home`);
    try {
      await openFresh(s, '#/home');
      await seedWords(s, [
        { en: 'apple', needSpell: true, senses: [{ text: 'n. 苹果', aliases: [] }] },
        { en: 'banana', needSpell: false, senses: [{ text: 'n. 香蕉', aliases: [] }] },
      ]);
      await s.evaluate(`location.hash = '#/learn'`);
      await new Promise((r) => setTimeout(r, 1500));

      // 两个词都上纸（每点一次上一个）
      for (let i = 0; i < 2; i += 1) {
        await s.evaluate(`(() => {
          const b = [...document.querySelectorAll('.paper-controls button')].find((x) => x.textContent.trim().startsWith('再背一个'));
          b?.click();
          return true;
        })()`);
        await new Promise((r) => setTimeout(r, 700));
      }
      await s.evaluate(`(() => {
        const b = [...document.querySelectorAll('.paper-controls button')].find((x) => x.textContent.trim().startsWith('再次记忆'));
        b?.click();
        return true;
      })()`);
      check('进入记忆环节', await waitFor(s, `!!document.querySelector('.memorize-box')`));

      // 把这一轮记忆走完（每题：填答案 → 提交 → 推进答案卡）
      let sawSpell = false;
      for (let i = 0; i < 40; i += 1) {
        const state = await s.evaluate(`({
          mem: !!document.querySelector('.memorize-box'),
          spell: !!document.querySelector('.spell-meanings'),
          card: !!document.querySelector('.answer-card'),
          overlay: !document.querySelector('.paper-overlay')?.classList.contains('hidden'),
        })`);
        if (state.spell) sawSpell = true;
        if (!state.overlay && !state.card && !state.mem && !state.spell) break;
        await s.evaluate(`(() => {
          const card = document.querySelector('.answer-card');
          if (card) { card.click(); return 'advance'; }
          const inputs = [...document.querySelectorAll('.memorize-box .mem-input, .spell-input')];
          if (inputs.length > 0) {
            for (const el of inputs) {
              if (!el.value) { el.value = '苹果'; el.dispatchEvent(new Event('input', { bubbles: true })); }
            }
            document.querySelector('#mem-submit, #spell-submit')?.click();
            return 'submit';
          }
          return 'idle';
        })()`);
        await new Promise((r) => setTimeout(r, 350));
      }
      check('★ 出现了拼写环节（标了「拼」的词就在当次记忆选中的词里）', sawSpell === true);

      // 拼写只出现 apple（banana 没标拼）——用中文意思反查是哪张卡
      const spellMeanings = await s.evaluate(`[...document.querySelectorAll('.spell-meanings')].map((e) => e.textContent.trim())`);
      check('★ 拼写环节只出现标了「拼」的那个词（苹果）', spellMeanings.length === 0 || spellMeanings.every((t) => t.includes('苹果')), JSON.stringify(spellMeanings));
    } finally {
      await s.close();
    }
  }

  // ─────────────── [3] 保存并退出 → 不带 resume 直接续跑
  console.log('\n[3] 「保存并退出」→ 再点「背诵」直接续跑（位置 / 进度 / 遍数都在）');
  {
    const s = await openSession(CDP_PORT, `${ORIGIN}/#/home`);
    try {
      await openFresh(s, '#/home');
      // ★ 关键：队列里放 **6 个**词，但只点 **3 个**上纸 —— 用户实测就是这个局面
      //   （词库里词多、这一轮只背了几个）。老代码要求「队列里每个词都有落点」
      //   才恢复，于是重进变成一面白纸。这条断言就是钉住它。
      await seedWords(s, [
        { en: 'alpha', senses: [{ text: 'n. 甲', aliases: [] }] },
        { en: 'beta', senses: [{ text: 'n. 乙', aliases: [] }] },
        { en: 'gamma', senses: [{ text: 'n. 丙', aliases: [] }] },
        { en: 'delta', senses: [{ text: 'n. 丁', aliases: [] }] },
        { en: 'epsilon', senses: [{ text: 'n. 戊', aliases: [] }] },
        { en: 'zeta', senses: [{ text: 'n. 己', aliases: [] }] },
      ]);
      await s.evaluate(`location.hash = '#/learn'`);
      await new Promise((r) => setTimeout(r, 1500));

      // 上 3 个词（点满 memorizeEvery=3 之后按钮会变成「记忆」，所以正好 3 次）
      for (let i = 0; i < 3; i += 1) {
        await s.evaluate(`(() => {
          const b = [...document.querySelectorAll('.paper-controls button')].find((x) => x.textContent.trim().startsWith('再背一个'));
          b?.click();
          return true;
        })()`);
        await new Promise((r) => setTimeout(r, 700));
      }
      await s.evaluate(`(() => {
        const b = [...document.querySelectorAll('.paper-controls button')].find((x) => x.textContent.trim().startsWith('再次记忆'));
        b?.click();
        return true;
      })()`);
      await waitFor(s, `!!document.querySelector('.memorize-box')`);
      for (let i = 0; i < 30; i += 1) {
        const st = await s.evaluate(`({ mem: !!document.querySelector('.memorize-box'), card: !!document.querySelector('.answer-card'), overlay: !document.querySelector('.paper-overlay')?.classList.contains('hidden') })`);
        if (!st.mem && !st.card && !st.overlay) break;
        await s.evaluate(`(() => {
          const card = document.querySelector('.answer-card');
          if (card) { card.click(); return 'advance'; }
          const inputs = [...document.querySelectorAll('.memorize-box .mem-input')];
          if (inputs.length > 0) {
            for (const el of inputs) { if (!el.value) { el.value = '甲'; el.dispatchEvent(new Event('input', { bubbles: true })); } }
            document.querySelector('#mem-submit')?.click();
            return 'submit';
          }
          return 'idle';
        })()`);
        await new Promise((r) => setTimeout(r, 350));
      }

      const beforeExit = await s.evaluate(`({
        placements: ${PLACEMENTS_EXPR},
        words: document.querySelectorAll('.paper-word').length,
        progress: document.querySelector('.paper-progress')?.textContent ?? '',
      })`);
      check('退出前纸上有 3 个词（队列里一共 6 个）', beforeExit.words === 3, JSON.stringify(beforeExit));
      check('进度文案只统计「纸上的词」的记忆遍数（不是整个队列）', /每词已记忆 1\//.test(beforeExit.progress), beforeExit.progress);

      // 保存并退出
      await s.evaluate(`(() => {
        const b = [...document.querySelectorAll('.paper-controls button')].find((x) => x.textContent.trim().startsWith('保存并退出'));
        b?.click();
        return true;
      })()`);
      await waitFor(s, `location.hash === '#/home'`);
      check('点「保存并退出」回到了首页', (await s.evaluate(`location.hash`)) === '#/home');

      const saved = (await readSession(s))[0];
      check('存档里有完整词单与已出现的 3 个词', Array.isArray(saved?.wordIds) && saved.wordIds.length === 6 && saved.shownIds.length === 3, JSON.stringify(saved?.wordIds) + '/' + JSON.stringify(saved?.shownIds));
      check('★ 存档里有每个词在白纸上的位置', Object.keys(saved?.placements ?? {}).length >= 2, JSON.stringify(Object.keys(saved?.placements ?? {})));
      check('★ 存档里有每词的记忆遍数', Object.values(saved?.memorizeCount ?? {}).some((n) => n >= 1), JSON.stringify(saved?.memorizeCount));
      check('★ 存档里有上一轮未通过的词字段（老存档兼容字段也在）', saved !== undefined && 'lastRoundFailedIds' in saved, JSON.stringify(saved?.lastRoundFailedIds));

      // 再点「背诵」——注意：**不带 ?resume=1**，模拟用户直接点导航
      await s.evaluate(`location.hash = '#/home'`);
      await new Promise((r) => setTimeout(r, 400));
      await s.evaluate(`location.hash = '#/learn'`);
      await new Promise((r) => setTimeout(r, 1800));

      const afterResume = await s.evaluate(`({
        placements: ${PLACEMENTS_EXPR},
        words: document.querySelectorAll('.paper-word').length,
        progress: document.querySelector('.paper-progress')?.textContent ?? '',
      })`);
      check('★ 直接点「背诵」就恢复了上次的 3 个词（没有从头开始、更不是白纸）', afterResume.words === 3, JSON.stringify(afterResume));
      check('★ 恢复后每个词的位置与退出前**完全一致**', JSON.stringify(afterResume.placements) === JSON.stringify(beforeExit.placements), `前 ${JSON.stringify(beforeExit.placements)}\n    后 ${JSON.stringify(afterResume.placements)}`);
      check('★ 恢复后进度文案里的记忆遍数也回来了（每词 1 遍）', /每词已记忆 1\//.test(afterResume.progress), afterResume.progress);
      check('恢复后的进度文案与退出前一致', afterResume.progress === beforeExit.progress, `前「${beforeExit.progress}」后「${afterResume.progress}」`);

      // 出口：重新开始
      check('页面上有「重新开始」按钮（续跑自动化后的显式出口）', (await s.evaluate(`[...document.querySelectorAll('.paper-controls button')].some((b) => b.textContent.trim() === '重新开始')`)) === true);
    } finally {
      await s.close();
    }
  }

  // ─────────────── [4] ★ 背完了只归档「上过纸的词」（用户报的严重 bug）
  console.log('\n[4] 「背完了」只归档本轮上过纸的词，队列里没轮到的保持「未背」');
  {
    const s = await openSession(CDP_PORT, `${ORIGIN}/#/home`);
    try {
      await openFresh(s, '#/home');
      await seedWords(s, [
        { en: 'a1', senses: [{ text: 'n. 一', aliases: [] }] },
        { en: 'a2', senses: [{ text: 'n. 二', aliases: [] }] },
        { en: 'a3', senses: [{ text: 'n. 三', aliases: [] }] },
        { en: 'a4', senses: [{ text: 'n. 四', aliases: [] }] },
        { en: 'a5', senses: [{ text: 'n. 五', aliases: [] }] },
        { en: 'a6', senses: [{ text: 'n. 六', aliases: [] }] },
      ]);
      await s.evaluate(`location.hash = '#/learn'`);
      await new Promise((r) => setTimeout(r, 1500));

      for (let i = 0; i < 3; i += 1) {
        await s.evaluate(`(() => {
          const b = [...document.querySelectorAll('.paper-controls button')].find((x) => x.textContent.trim().startsWith('再背一个'));
          b?.click();
          return true;
        })()`);
        await new Promise((r) => setTimeout(r, 700));
      }
      await s.evaluate(`(() => {
        const b = [...document.querySelectorAll('.paper-controls button')].find((x) => x.textContent.trim().startsWith('再次记忆'));
        b?.click();
        return true;
      })()`);
      await waitFor(s, `!!document.querySelector('.memorize-box')`);
      for (let i = 0; i < 30; i += 1) {
        const st = await s.evaluate(`({ mem: !!document.querySelector('.memorize-box'), card: !!document.querySelector('.answer-card'), overlay: !document.querySelector('.paper-overlay')?.classList.contains('hidden') })`);
        if (!st.mem && !st.card && !st.overlay) break;
        await s.evaluate(`(() => {
          const card = document.querySelector('.answer-card');
          if (card) { card.click(); return 'advance'; }
          const inputs = [...document.querySelectorAll('.memorize-box .mem-input')];
          if (inputs.length > 0) {
            for (const el of inputs) { if (!el.value) { el.value = '一'; el.dispatchEvent(new Event('input', { bubbles: true })); } }
            document.querySelector('#mem-submit')?.click();
            return 'submit';
          }
          return 'idle';
        })()`);
        await new Promise((r) => setTimeout(r, 350));
      }

      const clicked = await s.evaluate(`(() => {
        const b = [...document.querySelectorAll('.paper-controls button')].find((x) => x.textContent.trim().startsWith('背完了') && !x.classList.contains('hidden'));
        if (!b) return false;
        b.click();
        return true;
      })()`);
      check('记忆达标后「背完了」出现了', clicked === true);
      await new Promise((r) => setTimeout(r, 1600));
      const words = await readWords(s);
      const learned = words.filter((w) => w.status === 'learned').map((w) => w.en).sort();
      const unlearned = words.filter((w) => w.status === 'unlearned').map((w) => w.en).sort();
      check('★ 只有上过纸的 3 个词变成「已背」', learned.length === 3, JSON.stringify(learned));
      check('★ 队列里没轮到的 3 个词仍是「未背」（没有被一起归档）', unlearned.length === 3, JSON.stringify(unlearned));
      check('★ 已背的正好是上纸的那 3 个（a1/a2/a3）', learned.join(',') === 'a1,a2,a3', JSON.stringify(learned));
    } finally {
      await s.close();
    }
  }

  // ─────────────── [5] ★ 卡片编辑一定写库（用户报「改了不保存」）
  console.log('\n[5] 卡片编辑：连改两个词 / 改完立刻退出 / 改完立刻斩 —— 都必须保存');
  {
    const s = await openSession(CDP_PORT, `${ORIGIN}/#/home`);
    try {
      await openFresh(s, '#/home');
      await seedWords(s, [
        { en: 'e1', senses: [{ text: 'n. 一', aliases: [] }] },
        { en: 'e2', senses: [{ text: 'n. 二', aliases: [] }] },
      ]);
      await s.evaluate(`location.hash = '#/learn'`);
      await new Promise((r) => setTimeout(r, 1500));
      for (let i = 0; i < 2; i += 1) {
        await s.evaluate(`(() => {
          const b = [...document.querySelectorAll('.paper-controls button')].find((x) => x.textContent.trim().startsWith('再背一个'));
          b?.click();
          return true;
        })()`);
        await new Promise((r) => setTimeout(r, 700));
      }

      /** 打开某个词的卡片、改音标、关掉（返回是否成功） */
      const editCard = (en, value, close) => `(() => {
        const zone = [...document.querySelectorAll('.paper-word-zone')].find((z) => z.querySelector('.paper-word')?.textContent.trim() === ${JSON.stringify(en)});
        if (!zone) return 'no-zone';
        const meaning = zone.querySelector('.paper-meaning');
        if (meaning.classList.contains('hidden')) zone.querySelector('.paper-word').click();
        zone.querySelector('.paper-meaning').click();
        return 'opened';
      })()`;

      // —— 连改两个不同的词（相隔不到防抖窗口）——
      await s.evaluate(editCard('e1'));
      await new Promise((r) => setTimeout(r, 350));
      await s.evaluate(`(() => {
        const el = document.querySelector('.modal-mask input');
        el.value = '/E1/';
        el.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('.modal-mask .modal-close')?.click();
        return true;
      })()`);
      // 立刻改第二个词（不等 600ms）
      await s.evaluate(editCard('e2'));
      await new Promise((r) => setTimeout(r, 300));
      await s.evaluate(`(() => {
        const el = document.querySelector('.modal-mask input');
        el.value = '/E2/';
        el.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('.modal-mask .modal-close')?.click();
        return true;
      })()`);
      await new Promise((r) => setTimeout(r, 1500));
      const both = await readWords(s);
      check('★ 连改两个词：**两个都写进了库**（不是只写最后一个）', both.find((w) => w.en === 'e1')?.phonetic === '/E1/' && both.find((w) => w.en === 'e2')?.phonetic === '/E2/', JSON.stringify(both));

      // —— 改完**立刻**保存并退出（防抖窗口内退出）——
      await s.evaluate(editCard('e1'));
      await new Promise((r) => setTimeout(r, 300));
      await s.evaluate(`(() => {
        const el = document.querySelector('.modal-mask input');
        el.value = '/E1-EXIT/';
        el.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('.modal-mask .modal-close')?.click();
        document.querySelector('.paper-controls button:nth-child(3)')?.click();
        const b = [...document.querySelectorAll('.paper-controls button')].find((x) => x.textContent.trim().startsWith('保存并退出'));
        b?.click();
        return true;
      })()`);
      await waitFor(s, `location.hash === '#/home'`);
      await new Promise((r) => setTimeout(r, 900));
      const afterExit = await readWords(s);
      check('★ 改完立刻「保存并退出」：改动也写进了库（防抖窗口内退出不丢）', afterExit.find((w) => w.en === 'e1')?.phonetic === '/E1-EXIT/', JSON.stringify(afterExit));

      // —— 改完**立刻斩**：编辑要保存，斩也要生效（不能被迟到的写入复活）——
      await s.evaluate(`location.hash = '#/learn'`);
      await new Promise((r) => setTimeout(r, 1600));
      await s.evaluate(editCard('e2'));
      await new Promise((r) => setTimeout(r, 300));
      await s.evaluate(`(() => {
        const el = document.querySelector('.modal-mask input');
        el.value = '/E2-CHOP/';
        el.dispatchEvent(new Event('input', { bubbles: true }));
        const chop = [...document.querySelectorAll('.modal-mask button')].find((x) => x.textContent.includes('斩掉此词'));
        chop?.click();
        return true;
      })()`);
      await new Promise((r) => setTimeout(r, 1600));
      const afterChop = await readWords(s);
      const e2 = afterChop.find((w) => w.en === 'e2');
      check('★ 改完立刻斩：编辑保存了', e2?.phonetic === '/E2-CHOP/', JSON.stringify(afterChop));
      check('★ 改完立刻斩：斩也生效了（没被迟到的写入复活成未背）', e2?.status === 'chopped', JSON.stringify(afterChop));
    } finally {
      await s.close();
    }
  }
} finally {
  try {
    chrome?.proc.kill();
  } catch {
    /* 忽略 */
  }
  server.kill();
}

console.log(`\n背诵流程界面验收：${passed} 项通过，${failed} 项失败`);
if (failed > 0) process.exit(1);
