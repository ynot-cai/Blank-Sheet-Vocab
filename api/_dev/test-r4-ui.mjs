/**
 * R4 的**界面端到端验收测试**：`npm run test:r4-ui`
 * （需要本机有 Chrome / Edge，且先跑过 `npm run build`）
 *
 * 覆盖 R4 提示词里只能靠真浏览器验的项：
 *
 *   **第 3 步的 6 条义项自查（§3.2）**
 *     ③ `bank` 进记忆环节出现 **2 个输入框**（只出现 1 个 = 不合格）
 *     ④ 两个框填「银行」「河岸」→ 判**通过**
 *     ⑤ 把「河岸」改填「岸边」（近义词）→ 仍判**通过**
 *     ⑥ 只填对第一个、第二个乱填 → 判**未通过**
 *
 *   **第 2 步的时限自查**
 *     故意停 12 秒不作答 → 不会被自动提交、不会被判错
 *     （旧代码在 `rounds.ts` 里写的是「等 400×25ms = 10 秒就放弃并继续判分」，
 *      即事实上的超时自动提交；这个用例就是钉住它不许回来）
 *
 *   **第 1 步的斩自查（一 / 二期都测）**
 *     点斩 → 不弹确认框、立即消失、出现「已斩 XXX 〔撤销〕」Toast
 *     8 秒内点撤销 → 完全回来（画布 / 列表 / 库里的状态都回到原样）
 *     库里的状态是**原来的状态**，不是一律回到未背 / 未学
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findBrowser, launch, openSession, serveStatic } from '../../scripts/cdp.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = 4215;
const CDP_PORT = 9367;
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
 * 打开页面、注销 SW、真正 reload（让应用读到最新数据）。
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
 * 清空词库并写入测试词（**义项可以指定**，义项系统的用例全靠它）。
 * @param {any} session CDP 会话
 * @param {{en: string, status?: string, senses?: {text: string, aliases?: string[]}[]}[]} words 测试词
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
      tx.objectStore('sources').put({ id: 'src-r4', name: 'R4测试来源', priority: 3, createdAt: 1, updatedAt: 1, deleted: 0 });
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
          sourceId: 'src-r4',
          rawSources: [],
          attrs: { needSpell: false, failCount: 0, failCountTotal: 0, reviewCount: 0, lastReviewAt: null, learnedAt: null, reviewPriority: 0 },
          status: seed.status || 'unlearned',
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

/**
 * 清空知识点并写入一张测试卡。
 * @param {any} session CDP 会话
 * @param {{id: string, title: string, status?: string}} card 卡片
 */
async function seedCard(session, card) {
  return session.evaluate(`(() => new Promise((resolve) => {
    const c = ${JSON.stringify(card)};
    const req = indexedDB.open('blank-sheet-vocab');
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction(['knowledgeCards'], 'readwrite');
      const store = tx.objectStore('knowledgeCards');
      store.clear();
      store.put({
        id: c.id,
        title: c.title,
        summary: '',
        blocks: [{ id: 'b1', type: 'text', content: '卡片正文' }],
        examTags: ['fill'],
        examLoad: { types: ['fill'], estMinutes: 4 },
        source: {},
        attrs: { selfScoreSum: 0, selfScoreCount: 0, examScoreSum: 0, examScoreCount: 0, lastSelfScore: null, learnedAt: null, lastReviewAt: null, reviewCount: 0, mastery: 0, reviewPriority: 0 },
        status: c.status || 'learning',
        createdAt: 1000,
        updatedAt: 1000,
        deleted: 0,
      });
      tx.oncomplete = () => resolve(true);
    };
  }))()`);
}

/**
 * 读库里单词的状态（验「撤销是否真的把状态还原」）。
 * @param {any} session CDP 会话
 */
async function readWords(session) {
  return session.evaluate(`(() => new Promise((resolve) => {
    const req = indexedDB.open('blank-sheet-vocab');
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction(['words'], 'readonly');
      const all = tx.objectStore('words').getAll();
      all.onsuccess = () => resolve(all.result.map((w) => ({ en: w.en, status: w.status })));
    };
  }))()`);
}

/**
 * 读库里知识点卡片的状态。
 * @param {any} session CDP 会话
 */
async function readCards(session) {
  return session.evaluate(`(() => new Promise((resolve) => {
    const req = indexedDB.open('blank-sheet-vocab');
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction(['knowledgeCards'], 'readonly');
      const all = tx.objectStore('knowledgeCards').getAll();
      all.onsuccess = () => resolve(all.result.map((c) => ({ id: c.id, status: c.status, deleted: c.deleted })));
    };
  }))()`);
}

/** 装一次性探针：把 window.confirm / window.alert 记下来（斩不许弹确认框） */
const CONFIRM_PROBE = `
  window.__confirmCalls = 0;
  window.__alertCalls = 0;
  window.confirm = () => { window.__confirmCalls += 1; return true; };
  window.alert = () => { window.__alertCalls += 1; };
  true;
`;

/** 进入默写环节（一期：背诵页 → 再背一个 → 再次记忆），并等默写框出现 */
const ENTER_MEMORIZE = `(async () => {
  const pick = (t) => [...document.querySelectorAll('.paper-controls button')].find((b) => b.textContent.trim().startsWith(t));
  const next = pick('再背一个');
  if (next) { next.click(); await new Promise((r) => setTimeout(r, 600)); }
  const again = pick('再次记忆');
  if (!again) return 'no-again-button';
  again.click();
  for (let i = 0; i < 40; i += 1) {
    if (document.querySelector('.memorize-box')) return 'ok';
    await new Promise((r) => setTimeout(r, 250));
  }
  return 'no-mem-box';
})()`;

/** 把当前默写框的输入填成给定答案并提交 */
function fillAndSubmit(answers) {
  return `(() => {
    const inputs = [...document.querySelectorAll('.memorize-box .mem-input')];
    const answers = ${JSON.stringify(answers)};
    inputs.forEach((el, i) => {
      el.value = answers[i] ?? '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    document.querySelector('#mem-submit')?.click();
    return inputs.length;
  })()`;
}

// ══════════════════════════════════════════ 主流程

console.log('\n=== R4 验收：义项系统 / 无时间限制 / 斩可撤销（真浏览器） ===\n');

console.log('[0] 前置检查');
if (!existsSync(join(ROOT, 'dist', 'index.html'))) {
  console.error('✗ 没有 dist/，先跑 npm run build');
  process.exit(1);
}
check('dist/index.html 存在', true);

const browser = findBrowser();
if (!browser) {
  console.log('\n⚠ 本机没有 Chrome / Edge，跳过界面验收');
  console.log(`\nR4 界面验收：${passed} 项通过，${failed} 项失败`);
  process.exit(failed > 0 ? 1 : 0);
}
console.log(`  用 ${browser.split('\\').pop()} 跑无头检查`);

const server = serveStatic({ root: ROOT, port: PORT, mode: 'preview' });
let chrome = null;

try {
  const up = await waitForServer(`${ORIGIN}/`);
  if (!up) throw new Error(`预览服务没起来（${ORIGIN}）`);
  chrome = await launch(browser, CDP_PORT, { windowSize: '1280,900' });

  // ─────────────── [1] §3.2 ③④⑤⑥：bank 两个义项、几个框、怎么判
  console.log('\n[1] 义项系统：bank 有 2 个义项 → 2 个输入框 → 逐义项判分');
  {
    const s = await openSession(CDP_PORT, `${ORIGIN}/#/home`);
    try {
      await openFresh(s, '#/home');
      await s.evaluate(CONFIRM_PROBE);
      await seedWords(s, [
        { en: 'bank', senses: [{ text: 'n. 银行', aliases: [] }, { text: 'n. 河岸', aliases: ['岸边'] }] },
      ]);
      await s.evaluate(`location.hash = '#/learn'`);
      await new Promise((r) => setTimeout(r, 1500));

      const entered = await s.evaluate(ENTER_MEMORIZE);
      check('能进入记忆（默写）环节', entered === 'ok', String(entered));

      // ③ 几个义项就几个输入框
      const boxes = await s.evaluate(`document.querySelectorAll('.memorize-box .mem-input').length`);
      check('③ bank 出现 **2 个**输入框（不是一个）', boxes === 2, `实际 ${boxes} 个`);

      // ④ 一个填「银行」、一个填「河岸」→ 通过
      await s.evaluate(fillAndSubmit(['银行', '河岸']));
      await waitFor(s, `!!document.querySelector('.answer-card')`);
      const case4 = await s.evaluate(`[...document.querySelectorAll('.answer-cmp-line')].map((e) => e.className.includes('ok') ? 'ok' : 'bad')`);
      check('④ 填「银行」+「河岸」→ 两条都判对（通过）', case4.length === 2 && case4.every((x) => x === 'ok'), JSON.stringify(case4));
      await s.evaluate(`document.querySelector('.answer-card')?.click()`);
      await new Promise((r) => setTimeout(r, 800));

      // ⑤ 把「河岸」换成近义词「岸边」→ 仍通过
      await s.evaluate(ENTER_MEMORIZE);
      await s.evaluate(fillAndSubmit(['银行', '岸边']));
      await waitFor(s, `!!document.querySelector('.answer-card')`);
      const case5 = await s.evaluate(`[...document.querySelectorAll('.answer-cmp-line')].map((e) => e.className.includes('ok') ? 'ok' : 'bad')`);
      check('⑤ 填「银行」+「岸边」（近义词）→ 仍判通过', case5.length === 2 && case5.every((x) => x === 'ok'), JSON.stringify(case5));
      await s.evaluate(`document.querySelector('.answer-card')?.click()`);
      await new Promise((r) => setTimeout(r, 800));

      // ⑥ 只填对第一个 → 未通过
      await s.evaluate(ENTER_MEMORIZE);
      await s.evaluate(fillAndSubmit(['银行', '大海']));
      await waitFor(s, `!!document.querySelector('.answer-card')`);
      const case6 = await s.evaluate(`[...document.querySelectorAll('.answer-cmp-line')].map((e) => e.className.includes('ok') ? 'ok' : 'bad')`);
      check('⑥ 只答对第一个、第二个乱填 → 判**未通过**（要求全部义项都对）', case6.join(',') === 'ok,bad', JSON.stringify(case6));
      const failFlag = await s.evaluate(`!!document.querySelector('.answer-card .answer-cmp-bad, .answer-card .answer-cmp-line.bad')`);
      check('⑥ 答案卡上明确标出哪一条没通过', failFlag === true);
      await s.evaluate(`document.querySelector('.answer-card')?.click()`);
      await new Promise((r) => setTimeout(r, 800));

      // ─────────────── [2] R1：停 12 秒不作答，不许被自动提交
      console.log('\n[2] 无强制时间限制：停 12 秒不作答');
      await s.evaluate(ENTER_MEMORIZE);
      await s.evaluate(`(() => {
        const el = document.querySelector('.memorize-box .mem-input');
        if (el) { el.value = '填了一半'; el.dispatchEvent(new Event('input', { bubbles: true })); }
        return true;
      })()`);
      await new Promise((r) => setTimeout(r, 12_000));
      const idle = await s.evaluate(`({
        stillAnswering: !!document.querySelector('.memorize-box'),
        autoSubmitted: !!document.querySelector('.answer-card'),
        overlayHidden: !!document.querySelector('.paper-overlay')?.classList.contains('hidden'),
        keptInput: document.querySelector('.memorize-box .mem-input')?.value ?? null,
      })`);
      check('停 12 秒后**仍然停在默写框**（没有被自动提交）', idle.stillAnswering === true, JSON.stringify(idle));
      check('停 12 秒后**没有**弹出答案卡（没有被判错）', idle.autoSubmitted === false, JSON.stringify(idle));
      check('停 12 秒期间用户已经输入的内容没被丢掉', idle.keptInput === '填了一半', JSON.stringify(idle));
      check('界面上没有倒计时 / 剩余时间元素', (await s.evaluate(`!!document.querySelector('[class*="countdown"], [class*="timer"], [class*="remaining"]')`)) === false);
      // 正常提交，退出这一轮
      await s.evaluate(fillAndSubmit(['银行', '河岸']));
      await waitFor(s, `!!document.querySelector('.answer-card')`);
      await s.evaluate(`document.querySelector('.answer-card')?.click()`);
      await new Promise((r) => setTimeout(r, 800));
    } finally {
      await s.close();
    }
  }

  // ─────────────── [3] R3：一期单词卡斩 → 撤销
  console.log('\n[3] 斩（一期 · 白纸上的单词卡）：不确认 + 可撤销');
  {
    const s = await openSession(CDP_PORT, `${ORIGIN}/#/home`);
    try {
      await openFresh(s, '#/home');
      await s.evaluate(CONFIRM_PROBE);
      // 状态必须是 unlearned，否则 #/learn 抽词时不会要它（背诵页只抽未背的词）。
      // 「撤销是否还原成**原来的**状态（而不是一律 unlearned）」由 [4] 组验：
      // 那里种的是 learned，而 revive() 会把它写成 unlearned，所以断言 learned
      // 才真的证明我们按原值还原了。
      await seedWords(s, [{ en: 'bank', status: 'unlearned', senses: [{ text: 'n. 银行', aliases: [] }, { text: 'n. 河岸', aliases: ['岸边'] }] }]);
      await s.evaluate(`location.hash = '#/learn'`);
      await new Promise((r) => setTimeout(r, 1500));

      // 上纸 → 点中文意思开单词卡
      await s.evaluate(`(() => {
        const next = [...document.querySelectorAll('.paper-controls button')].find((b) => b.textContent.trim().startsWith('再背一个'));
        next?.click();
        return true;
      })()`);
      await new Promise((r) => setTimeout(r, 900));
      const opened = await s.evaluate(`(() => {
        const m = [...document.querySelectorAll('.paper-meaning')].find((e) => !e.classList.contains('hidden'));
        if (!m) return false;
        m.click();
        return true;
      })()`);
      await waitFor(s, `!!document.querySelector('.modal-mask')`);
      check('点中文意思能打开单词卡', opened === true);

      // 点「斩掉此词」
      const chopped = await s.evaluate(`(() => {
        const btn = [...document.querySelectorAll('.modal-mask button')].find((b) => b.textContent.trim().includes('斩掉此词'));
        if (!btn) return false;
        btn.click();
        return true;
      })()`);
      check('单词卡上有「斩掉此词」按钮', chopped === true);
      await new Promise((r) => setTimeout(r, 900));

      const afterChop = await s.evaluate(`({
        confirms: window.__confirmCalls,
        alerts: window.__alertCalls,
        modalStillOpen: !!document.querySelector('.modal-mask'),
        wordsOnPaper: document.querySelectorAll('.paper-word').length,
        undoToasts: [...document.querySelectorAll('.toast-undo')].map((e) => e.textContent.trim()),
      })`);
      check('斩**不弹任何确认框**', afterChop.confirms === 0 && afterChop.alerts === 0, JSON.stringify(afterChop));
      check('斩后单词卡立即关闭（不打断流程）', afterChop.modalStillOpen === false, JSON.stringify(afterChop));
      check('斩后词立即从白纸消失', afterChop.wordsOnPaper === 0, JSON.stringify(afterChop));
      check('出现「已斩 XXX 〔撤销〕」Toast', afterChop.undoToasts.length === 1 && afterChop.undoToasts[0].includes('已斩 bank') && afterChop.undoToasts[0].includes('撤销'), JSON.stringify(afterChop.undoToasts));

      const inDbAfterChop = await readWords(s);
      check('库里状态已变成 chopped', inDbAfterChop.find((w) => w.en === 'bank')?.status === 'chopped', JSON.stringify(inDbAfterChop));

      // 8 秒内点撤销
      await new Promise((r) => setTimeout(r, 1200));
      const undone = await s.evaluate(`(() => {
        const btn = document.querySelector('.toast-undo-btn');
        if (!btn) return false;
        btn.click();
        return true;
      })()`);
      check('撤销按钮在（8 秒窗口内还能点）', undone === true);
      await new Promise((r) => setTimeout(r, 1200));

      const afterUndo = await s.evaluate(`({
        wordsOnPaper: document.querySelectorAll('.paper-word').length,
        toasts: [...document.querySelectorAll('.toast')].map((e) => e.textContent.trim()),
      })`);
      const inDbAfterUndo = await readWords(s);
      check('撤销后词**回到白纸上**（不是只回了库）', afterUndo.wordsOnPaper === 1, JSON.stringify(afterUndo));
      check('撤销后库里的状态回到斩之前的值', inDbAfterUndo.find((w) => w.en === 'bank')?.status === 'unlearned', JSON.stringify(inDbAfterUndo));
      check('给了「已撤销」的反馈', afterUndo.toasts.some((t) => t.includes('已撤销')), JSON.stringify(afterUndo.toasts));
    } finally {
      await s.close();
    }
  }

  // ─────────────── [4] R3：一期列表页斩 → 撤销
  console.log('\n[4] 斩（一期 · 列表页）：不确认 + 可撤销');
  {
    const s = await openSession(CDP_PORT, `${ORIGIN}/#/home`);
    try {
      await openFresh(s, '#/home');
      await s.evaluate(CONFIRM_PROBE);
      await seedWords(s, [{ en: 'bank', status: 'learned' }, { en: 'apple', status: 'learned' }]);
      await s.evaluate(`location.hash = '#/list'`);
      await new Promise((r) => setTimeout(r, 1500));

      const before = await s.evaluate(`[...document.querySelectorAll('.word-en, .list-en, td')].length`);
      await s.evaluate(`(() => {
        const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '斩掉' || b.textContent.trim() === '斩');
        btn?.click();
        return true;
      })()`);
      await new Promise((r) => setTimeout(r, 1000));
      const after = await s.evaluate(`({
        confirms: window.__confirmCalls,
        undoToasts: document.querySelectorAll('.toast-undo').length,
        hasModal: !!document.querySelector('.modal-mask'),
      })`);
      check('列表页斩不弹确认框', after.confirms === 0 && after.hasModal === false, JSON.stringify(after));
      check('列表页斩后出现撤销 Toast', after.undoToasts === 1, JSON.stringify(after));
      check('列表页确实渲染了词（前置条件）', before > 0, String(before));

      await s.evaluate(`document.querySelector('.toast-undo-btn')?.click()`);
      await new Promise((r) => setTimeout(r, 1200));
      const list = await readWords(s);
      // ★ 这里种的是 learned，而 dao.words.revive() 会把它写成 unlearned
      //   （它按 learnedAt 猜状态）。断言 learned 才证明撤销是**按原值还原**的。
      check('列表页撤销后库里状态回到 learned（证明是原值还原，不是 revive 的一律未背）', list.every((w) => w.status === 'learned'), JSON.stringify(list));
    } finally {
      await s.close();
    }
  }

  // ─────────────── [5] R3：二期知识点卡片斩 → 撤销（列表页 + 已斩复活）
  console.log('\n[5] 斩（二期 · 知识点卡片）：不确认 + 可撤销');
  {
    const s = await openSession(CDP_PORT, `${ORIGIN}/#/home`);
    try {
      await openFresh(s, '#/home');
      await s.evaluate(CONFIRM_PROBE);
      await seedCard(s, { id: 'kc-1', title: '定语从句', status: 'learning' });
      await s.evaluate(`location.hash = '#/kc/list'`);
      await new Promise((r) => setTimeout(r, 1800));

      const clicked = await s.evaluate(`(() => {
        const btn = [...document.querySelectorAll('.kc-row-actions button, .kc-list-card button')].find((b) => b.textContent.trim() === '斩');
        if (!btn) return false;
        btn.click();
        return true;
      })()`);
      check('二期卡片列表能点到「斩」', clicked === true);
      await new Promise((r) => setTimeout(r, 1200));

      const after = await s.evaluate(`({
        confirms: window.__confirmCalls,
        alerts: window.__alertCalls,
        undoToasts: [...document.querySelectorAll('.toast-undo')].map((e) => e.textContent.trim()),
        hasModal: !!document.querySelector('.modal-mask'),
      })`);
      check('二期斩不弹确认框', after.confirms === 0 && after.alerts === 0 && after.hasModal === false, JSON.stringify(after));
      check('二期斩后出现「已斩 …〔撤销〕」Toast', after.undoToasts.length === 1 && after.undoToasts[0].includes('撤销'), JSON.stringify(after.undoToasts));

      const dbChopped = await readCards(s);
      check('二期库里已置墓碑（deleted=1）', dbChopped.find((c) => c.id === 'kc-1')?.deleted === 1, JSON.stringify(dbChopped));

      await s.evaluate(`document.querySelector('.toast-undo-btn')?.click()`);
      await new Promise((r) => setTimeout(r, 1500));
      const dbUndone = await readCards(s);
      const c1 = dbUndone.find((c) => c.id === 'kc-1');
      check('二期撤销后墓碑翻回来（deleted=0）', c1?.deleted === 0, JSON.stringify(dbUndone));
      check('二期撤销后状态回到原来的 learning（不是一律 unlearned）', c1?.status === 'learning', JSON.stringify(dbUndone));

      // 永久后悔药：虽然本轮已经撤销，仍要有「已斩」分区入口（超时后的兜底）
      const hasChoppedEntry = await s.evaluate(`document.body.textContent.includes('已斩')`);
      check('列表页仍然保留「已斩」分区（超时后的永久后悔药）', hasChoppedEntry === true);
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

console.log(`\nR4 界面验收：${passed} 项通过，${failed} 项失败`);
if (failed > 0) process.exit(1);
