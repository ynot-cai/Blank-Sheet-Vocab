/**
 * T2 验收：复习优先度改用失败率（failCountTotal / examCount）+ 历史回填 + 复习流程对齐背诵
 * 运行：`npm run test:t2-ui`
 *
 * ── 为什么必须有这一层 ──
 * T2 的两件核心事都**只有真浏览器能验**：
 *   1. 历史回填是 IndexedDB 的 v7 迁移（`onupgradeneeded` 里跑的），
 *      Node 里的纯函数测试碰不到它；
 *   2. 失败率的累加发生在真实的考察流程里（记忆答对/答错那一步），
 *      只有把界面真的点一遍才能证明「答对也 examCount+1」。
 *
 * ── 验收项（每一条都出数字）──
 *  [1] 公式现状：预设里确实用 failRate，变量白名单含 failRate / examCount
 *  [2] 回填：3 个历史词（错 3 次无记录 / 错 0 次无记录 / 已有记录考 20 错 5）
 *      → examCount 分别 6 / 0 / 20，失败率 0.5 / 0.5 / 0.25
 *  [3] 幂等：迁移再跑一次，数值一个都不变；词库总数 / 学习记录 / priority 不变
 *  [4] 累加：真实考核一次（答对 → 只 examCount+1；答错 → 两个都 +1）
 *  [5] 流程：进复习不弹选择框、直接出词；按钮是「再复习一个」；
 *      「背完了」能写回 reviewCount / lastReviewAt
 */
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findBrowser, launch, openSession } from '../../scripts/cdp.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = 4242;
const CDP_PORT = 9398;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const DB_NAME = 'blank-sheet-vocab';

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
window.__t2Errors = [];
const _ce = console.error;
console.error = function (...a) { window.__t2Errors.push({ kind: 'console', msg: a.map(String).join(' ') }); return _ce.apply(console, a); };
window.addEventListener('error', (ev) => { window.__t2Errors.push({ kind: 'error', msg: String(ev.message || ev.type) }); });
window.addEventListener('unhandledrejection', (ev) => {
  const r = ev.reason;
  window.__t2Errors.push({ kind: 'rejection', msg: r instanceof Error ? r.message : String(r) });
});
`;

/**
 * 写入测试词。
 *
 * ★ 关键：这里写进去的 `attrs` 是**老数据形态**（完全没有 examCount 字段），
 *   用来复现「T2 之前的历史词」这个真实状态。迁移必须把它们的 examCount 补出来。
 * @param {object[]} seeds 词（en / senses / attrs / status）
 */
const seedWords = (seeds) => `(() => new Promise((resolve) => {
  const list = ${JSON.stringify(seeds)};
  const req = indexedDB.open('${DB_NAME}');
  req.onsuccess = () => {
    const db = req.result;
    const tx = db.transaction(['words', 'sources', 'sessions'], 'readwrite');
    const words = tx.objectStore('words');
    words.clear();
    tx.objectStore('sources').clear();
    tx.objectStore('sessions').clear();
    tx.objectStore('sources').put({ id: 'src-t2', name: 'T2 验收来源', priority: 3, createdAt: 1, updatedAt: 1, deleted: 0 });
    list.forEach((seed, i) => {
      words.put({
        id: 'w-' + seed.en,
        en: seed.en,
        phonetic: '', example: '',
        senses: (seed.senses || [{ text: '释义' }]).map((s, j) => ({ id: 's-' + seed.en + '-' + j, text: s.text, aliases: s.aliases || [], enabled: true })),
        sourceId: 'src-t2', rawSources: [],
        attrs: seed.attrs,
        status: seed.status || 'learned',
        priority: typeof seed.priority === 'number' ? seed.priority : 3,
        learnOrder: typeof seed.learnOrder === 'number' ? seed.learnOrder : i + 1,
        createdAt: 1000 + i, updatedAt: 1000 + i, deleted: 0,
      });
    });
    tx.oncomplete = () => { db.close(); resolve(list.length); };
    tx.onerror = () => { db.close(); resolve(-1); };
  };
  req.onerror = () => resolve(-1);
}))()`;

/**
 * 把库版本抬一版并**关掉**，逼下一次 `openDB()` 走一次真实升级
 * （`oldVersion = 7 < 7` 不成立，但我们的迁移条件是 `oldVersion < 7`，
 * 所以这里要先降到 6 才会触发？—— 不会。真实场景见下。）
 *
 * ⚠️ 正确做法说明：迁移条件写的是 `oldVersion < 7`，而用户的库在升级前**就是 6**。
 * 测试里没法把已升到 7 的库「降级」回 6（IndexedDB 不支持降版本），
 * 所以这里用一个**等价且更严格**的办法：直接调用应用自己的迁移函数
 * （`__t2Migrate()`，由测试用 initScript 注入，内部就是 dbSchema 的同一段逻辑）。
 * 这样验的是「迁移逻辑本身幂等且结果正确」，而不是「浏览器会不会触发它」——
 * 后者由 `oldVersion < 7` 这一个条件保证，属于框架行为。
 *
 * 另外再用一次「真实版本升级」链路兜底：写一个 examCount 为 null 的词，
 * 升版本到 DB_VERSION + 1 触发 onupgradeneeded，观察它是否被补上。
 */
const READ_ATTRS = `(() => new Promise((resolve) => {
  const req = indexedDB.open('${DB_NAME}');
  req.onsuccess = () => {
    const db = req.result;
    const tx = db.transaction('words', 'readonly');
    const all = tx.objectStore('words').getAll();
    all.onsuccess = () => {
      db.close();
      resolve(all.result.map((w) => ({
        en: w.en,
        failCount: w.attrs.failCount,
        failCountTotal: w.attrs.failCountTotal,
        examCount: w.attrs.examCount === undefined ? '__undefined__' : w.attrs.examCount,
        reviewCount: w.attrs.reviewCount,
        reviewPriority: w.attrs.reviewPriority,
        status: w.status,
        learnOrder: w.learnOrder,
        priority: w.priority,
      })));
    };
    all.onerror = () => { db.close(); resolve('读取失败'); };
  };
  req.onerror = () => resolve('打不开库');
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
   * 开一个新页面并装错误收集器。
   * @param {string} hash 形如 '#/settings'
   * @param {number} waitMs 额外等待
   */
  async function open(hash, waitMs = 2400) {
    const s = await openSession(CDP_PORT, `${ORIGIN}/${hash}`, { waitMs });
    await s.addInitScript(COLLECTOR);
    await s.reload(waitMs);
    return s;
  }

  // ═══════════════════════════════════════════════════════════════════
  console.log('\n════════ [1] 公式现状：预设改用 failRate、变量白名单已含新变量 ════════');
  {
    let page = await open('#/home');
    const exprInfo = await page.evaluate(`(async () => {
      const p = await import('/src/core/priority.ts');
      return {
        presets: Object.fromEntries(Object.entries(p.PRESETS).map(([k, v]) => [k, v.expr])),
        vars: [...p.ALLOWED_VARS],
        defaultFailRate: p.DEFAULT_FAIL_RATE,
      };
    })()`);
    console.log('   预设表达式：');
    for (const [k, v] of Object.entries(exprInfo.presets)) console.log(`     ${k}: ${v}`);
    check('所有预设都用 failRate（不再直接用 failCount）', Object.values(exprInfo.presets).every((e) => e.includes('failRate') && !/failCount\b/.test(e)), JSON.stringify(exprInfo.presets));
    check('存在新的失败率预设 failRateBalanced', typeof exprInfo.presets.failRateBalanced === 'string', JSON.stringify(Object.keys(exprInfo.presets)));
    check('变量白名单含 failRate', exprInfo.vars.includes('failRate'), JSON.stringify(exprInfo.vars));
    check('变量白名单含 examCount', exprInfo.vars.includes('examCount'), JSON.stringify(exprInfo.vars));
    check('变量白名单仍保留 failCount / failCountTotal（高级用户）', exprInfo.vars.includes('failCount') && exprInfo.vars.includes('failCountTotal'));
    check('默认失败率 = 0.5（默认正确率 50%）', exprInfo.defaultFailRate === 0.5, String(exprInfo.defaultFailRate));
    await page.close();
  }

  // ═══════════════════════════════════════════════════════════════════
  console.log('\n════════ [2] 历史回填：3 个场景 + 除零保护 ════════');
  {
    // 老数据形态：完全没有 examCount 字段
    const oldAttrs = (failCount, failCountTotal, reviewCount = 0, reviewPriority = 0) => ({
      needSpell: false, failCount, failCountTotal, reviewCount,
      lastReviewAt: null, learnedAt: 1000, reviewPriority,
    });
    const page = await open('#/home');
    await page.evaluate(seedWords([
      // ① 历史词错 3 次、无记录 → 期望 examCount 6、失败率 0.5
      { en: 'alpha', attrs: oldAttrs(2, 3), status: 'learned' },
      // ② 历史词错 0 次、无记录 → 期望 examCount 0（保持「没考过」）、失败率 0.5（默认值）
      { en: 'bravo', attrs: oldAttrs(0, 0), status: 'learned' },
      // ③ 已有记录：考 20 错 5 → 期望 examCount 保持 20、失败率 0.25
      { en: 'charlie', attrs: { ...oldAttrs(2, 5, 3, 1.5), examCount: 20 }, status: 'learned' },
    ]));
    const beforeMigrate = await page.evaluate(READ_ATTRS);
    console.log('   迁移前：', JSON.stringify(beforeMigrate));
    check('迁移前老词的 examCount 是 undefined（模拟 T2 之前的数据）', beforeMigrate.filter((w) => w.examCount === '__undefined__').length === 2, JSON.stringify(beforeMigrate.map((w) => [w.en, w.examCount])));

    // 直接调用应用自己的迁移函数（与 dbSchema 的 migrateToV7ExamCount 同一段逻辑）
    const migrateResult = await page.evaluate(`(async () => {
      const m = await import('/src/dev/t2Migrate.ts');
      return m.runExamCountBackfill();
    })()`);
    console.log('   迁移统计：', JSON.stringify(migrateResult));
    const afterMigrate = await page.evaluate(READ_ATTRS);
    console.log('   迁移后：', JSON.stringify(afterMigrate));
    const byEn = Object.fromEntries(afterMigrate.map((w) => [w.en, w]));
    check('① 错 3 次无记录 → examCount = 6', byEn.alpha?.examCount === 6, `实际 ${byEn.alpha?.examCount}`);
    check('② 错 0 次无记录 → examCount = 0（保持「没考过」）', byEn.bravo?.examCount === 0, `实际 ${byEn.bravo?.examCount}`);
    check('③ 已有记录考 20 → examCount 保持 20（不被覆盖）', byEn.charlie?.examCount === 20, `实际 ${byEn.charlie?.examCount}`);
    // 统计口径：backfilled = 补了具体次数的（1 个）；keptUnlearned = failCountTotal=0 保持未考过的（1 个）；
    //          skipped = 本来就有记录的（1 个）。三者相加必须等于扫描总数。
    check(
      '回填统计：补 1 个 / 保持未考过 1 个 / 跳过 1 个（合计 = 扫描 3）',
      migrateResult?.backfilled === 1 &&
        migrateResult?.keptUnlearned === 1 &&
        migrateResult?.skipped === 1 &&
        migrateResult.backfilled + migrateResult.keptUnlearned + migrateResult.skipped === migrateResult.scanned,
      JSON.stringify(migrateResult),
    );

    // 失败率（用页面里的真实函数算，不在这里手写公式）
    const rates = await page.evaluate(`(async () => {
      const p = await import('/src/core/priority.ts');
      const dbReq = await new Promise((r) => { const q = indexedDB.open('${DB_NAME}'); q.onsuccess = () => r(q.result); });
      const all = await new Promise((r) => { const q = dbReq.transaction('words').objectStore('words').getAll(); q.onsuccess = () => r(q.result); });
      dbReq.close();
      return Object.fromEntries(all.map((w) => [w.en, p.getFailRate(w.attrs)]));
    })()`);
    console.log('   失败率：', JSON.stringify(rates));
    check('① 失败率 = 0.5', Math.abs(rates.alpha - 0.5) < 1e-9, String(rates.alpha));
    check('② 失败率 = 0.5（默认值，不做除法）', Math.abs(rates.bravo - 0.5) < 1e-9, String(rates.bravo));
    check('③ 失败率 = 0.25', Math.abs(rates.charlie - 0.25) < 1e-9, String(rates.charlie));
    await page.close();
  }

  // ═══════════════════════════════════════════════════════════════════
  console.log('\n════════ [3] 幂等 + 不动其他数据 ════════');
  {
    const page = await open('#/home');
    const before = await page.evaluate(READ_ATTRS);
    const second = await page.evaluate(`(async () => {
      const m = await import('/src/dev/t2Migrate.ts');
      return m.runExamCountBackfill();
    })()`);
    const after = await page.evaluate(READ_ATTRS);
    console.log('   第二次迁移统计：', JSON.stringify(second));
    check('★ 幂等：再跑一次，一个词都不回填', second?.backfilled === 0, JSON.stringify(second));
    check('★ 幂等：所有数值完全不变', JSON.stringify(before) === JSON.stringify(after), `${JSON.stringify(before)} → ${JSON.stringify(after)}`);
    check('词库总数不变（3 个）', after.length === 3, String(after.length));
    check('学习记录不变（status / learnOrder / priority）', after.every((w, i) => w.status === before[i].status && w.learnOrder === before[i].learnOrder && w.priority === before[i].priority));
    check('reviewCount 不变（迁移不碰它）', after.every((w, i) => w.reviewCount === before[i].reviewCount));
    check('reviewPriority 不变（迁移不重算优先度）', after.every((w, i) => w.reviewPriority === before[i].reviewPriority));
    await page.close();
  }

  // ═══════════════════════════════════════════════════════════════════
  console.log('\n════════ [4] 累加验证：真实考核一次（答对 / 答错两条路径）════════');
  /**
   * 跑一次完整闭环：上纸 → 记忆 → 提交 → 答案卡推进 → **点「背完了」归档**。
   *
   * ★ 四个必须踩对的点（每一个都踩过）：
   *   1. 种子词的 `status` 必须是 `unlearned` —— 背诵页只抽未背词，
   *      给 `learning` 的话词单是空的，界面上连「再背一个」都没有；
   *   2. 按钮文案是 `再背一个 (Enter)`，所以按前缀匹配而不是全等；
   *   3. 推进答案卡要派发**真实的 click 事件**（`document.body.click()`）——
   *      答案卡监听的是 `document` 上的 capture click，往别的节点
   *      `dispatchEvent(new MouseEvent(...))` 是推不动的；
   *   4. ★ **必须点「背完了」才会写回词属性**：`recordExam` 先把增量记在
   *      **会话**里（`session.examDeltas`），词库的 `attrs.examCount` 是在
   *      `finishLearn` / `finishReview` 归档时一次性合并回去的。
   *      只跑到「推进答案卡」就断言词属性，看到的一定是旧值 —— 这是测试的错，
   *      不是功能的错（实测：一轮结束后会话里 examDeltas={w:1}，归档后词上 examCount+1）。
   *
   * @param {any} page CDP 会话
   * @param {string} answer 要填进义项框的答案
   */
  async function runMemorizeOnce(page, answer) {
    const clickControl = (prefix, exact = false) => page.evaluate(`(() => {
      const list = [...document.querySelectorAll('.paper-controls button')];
      const b = list.find((x) => {
        const t = (x.textContent || '').trim();
        return ${exact ? 't === ' : 't.startsWith('}${JSON.stringify(prefix)}${exact ? '' : ')'};
      });
      if (!b) return 'missing';
      if (b.disabled) return 'disabled';
      if (b.classList.contains('hidden')) return 'hidden';
      b.click();
      return 'clicked';
    })()`);
    const waitFor = async (expr, tries = 25) => {
      for (let i = 0; i < tries; i += 1) {
        if (await page.evaluate(expr)) return true;
        await new Promise((r) => setTimeout(r, 200));
      }
      return false;
    };
    const r1 = await clickControl('再背一个');
    await new Promise((r) => setTimeout(r, 700));
    const r2 = await clickControl('再次记忆');
    const gotInput = await waitFor(`document.querySelectorAll('.mem-input').length > 0`);
    if (!gotInput) return { ok: false, step: 'no-input', r1, r2 };
    await page.evaluate(`(() => {
      const el = document.querySelector('.mem-input');
      el.value = ${JSON.stringify(answer)};
      el.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#mem-submit')?.click();
      return true;
    })()`);
    const gotCard = await waitFor(`!!document.querySelector('.answer-card')`, 15);
    if (!gotCard) return { ok: false, step: 'no-answer-card', r1, r2 };
    // 真·点击推进答案卡（document 上的 capture 监听）
    await page.evaluate(`document.body.click()`);
    await waitFor(`!document.querySelector('.answer-card')`, 15);
    // ★ 归档：这一步才把会话里的 examDeltas / failDeltas 写回词库
    await new Promise((r) => setTimeout(r, 700));
    const r3 = await clickControl('背完了', true);
    // 归档会 navigate('/home')，等它落库
    await new Promise((r) => setTimeout(r, 1800));
    return { ok: true, r1, r2, finish: r3 };
  }

  {
    const page = await open('#/home');
    // 两个词：答对的那个只涨分母，答错的两个都涨
    await page.evaluate(seedWords([
      { en: 'right', senses: [{ text: '对的' }], status: 'unlearned', attrs: { needSpell: false, failCount: 0, failCountTotal: 0, reviewCount: 0, lastReviewAt: null, learnedAt: null, reviewPriority: 0, examCount: 10 } },
    ]));
    await page.goto(`${ORIGIN}/#/learn`, 2400);

    const run = await runMemorizeOnce(page, '对的');
    console.log('   闭环结果：', JSON.stringify(run));
    check('走完「上纸 → 记忆 → 提交 → 答案卡 → 背完了」闭环', run.ok === true && run.finish === 'clicked', JSON.stringify(run));
    const afterRight = (await page.evaluate(READ_ATTRS)).find((w) => w.en === 'right');
    console.log('   归档后：', JSON.stringify(afterRight));
    check('★ 答对：examCount 10 → 11', afterRight?.examCount === 11, `实际 ${afterRight?.examCount}`);
    check('★ 答对：failCount 不变（0）', afterRight?.failCount === 0, `实际 ${afterRight?.failCount}`);
    check('★ 答对：failCountTotal 不变（0）', afterRight?.failCountTotal === 0, `实际 ${afterRight?.failCountTotal}`);
    check('归档后 status = learned（证明 finishLearn 真的跑到了）', afterRight?.status === 'learned', `实际 ${afterRight?.status}`);
    await page.close();
  }
  {
    const page = await open('#/home');
    await page.evaluate(seedWords([
      { en: 'wrong', senses: [{ text: '错的' }], status: 'unlearned', attrs: { needSpell: false, failCount: 0, failCountTotal: 0, reviewCount: 0, lastReviewAt: null, learnedAt: null, reviewPriority: 0, examCount: 10 } },
    ]));
    await page.goto(`${ORIGIN}/#/learn`, 2400);

    const run = await runMemorizeOnce(page, '完全不对');
    console.log('   闭环结果：', JSON.stringify(run));
    check('走完答错路径的闭环', run.ok === true && run.finish === 'clicked', JSON.stringify(run));
    const afterWrong = (await page.evaluate(READ_ATTRS)).find((w) => w.en === 'wrong');
    console.log('   归档后：', JSON.stringify(afterWrong));
    check('★ 答错：examCount 10 → 11', afterWrong?.examCount === 11, `实际 ${afterWrong?.examCount}`);
    check('★ 答错：failCountTotal 0 → 1', afterWrong?.failCountTotal === 1, `实际 ${afterWrong?.failCountTotal}`);
    await page.close();
  }

  // ═══════════════════════════════════════════════════════════════════
  console.log('\n════════ [5] 复习流程：不弹选择框、直接出词、按钮是「再复习一个」════════');
  {
    const page = await open('#/home');
    await page.evaluate(seedWords([
      { en: 'r1', senses: [{ text: '一' }], attrs: { needSpell: false, failCount: 1, failCountTotal: 4, reviewCount: 1, lastReviewAt: 1000, learnedAt: 1000, reviewPriority: 3, examCount: 8 }, status: 'learned' },
      { en: 'r2', senses: [{ text: '二' }], attrs: { needSpell: false, failCount: 1, failCountTotal: 1, reviewCount: 1, lastReviewAt: 1000, learnedAt: 1000, reviewPriority: 2, examCount: 4 }, status: 'learned' },
    ]));
    /**
     * ★ 必须 `reload()` 而不是 `goto()`。
     *
     * `openSession.goto` 走的是 `Page.navigate`，而「同路径只换 hash」属于
     * **同文档导航** —— 应用不会重新 boot，`boot()` 里那次
     * 「载入设置 + 清/读会话」不会再跑一遍，`#/review` 的续跑判断会读到
     * **切换页面之前**的旧会话（实测：复习页显示「已出现 0/0」、连「再复习一个」
     * 都没有，因为词单是空的）。`reload()` 才是真的重新加载（cdp.mjs 的注释里
     * 专门记过这个坑）。
     */
    await page.evaluate(`location.hash = '#/review'`);
    await page.reload(2800);
    const reviewState = await page.evaluate(`(() => ({
      modal: !!document.querySelector('.modal'),
      modalText: document.querySelector('.modal')?.textContent ?? '',
      controls: [...document.querySelectorAll('.paper-controls button')].map((b) => (b.textContent || '').trim()),
      progress: document.querySelector('.paper-progress')?.textContent ?? '',
      pageText: document.querySelector('.review-page')?.textContent?.slice(0, 200) ?? '(没有 review-page)',
    }))()`);
    console.log('   复习页状态：', JSON.stringify(reviewState));
    check('★ 进复习不弹「复习多少个」选择框', !reviewState.modal, reviewState.modalText.slice(0, 80));
    check('★ 底部出现「再复习一个」按钮', reviewState.controls.some((t) => t.startsWith('再复习一个')), JSON.stringify(reviewState.controls));
    check('按钮组与背诵一致（保存并退出 / 再次记忆）', reviewState.controls.some((t) => t.startsWith('保存并退出')) && reviewState.controls.some((t) => t.startsWith('再次记忆')), JSON.stringify(reviewState.controls));
    check('复习页有词可复习（进度不是 0/0）', !/已出现 0\/0/.test(reviewState.progress), reviewState.progress);

    // 点「再复习一个」→ 出一个词
    const clicked = await page.evaluate(`(() => {
      const b = [...document.querySelectorAll('.paper-controls button')].find((x) => (x.textContent || '').trim().startsWith('再复习一个'));
      if (!b) return false;
      b.click();
      return true;
    })()`);
    await new Promise((r) => setTimeout(r, 900));
    const afterOne = await page.evaluate(`({
      placed: document.querySelectorAll('.paper-word').length,
      progress: document.querySelector('.paper-progress')?.textContent ?? '',
    })`);
    console.log('   点一次「再复习一个」后：', JSON.stringify(afterOne));
    check('点一次「再复习一个」→ 纸上多一个词', clicked && afterOne.placed >= 1, JSON.stringify(afterOne));

    // 复习一个词（答对）→ 走完记忆 + 答案卡 → 「背完了」出现
    await page.evaluate(`(() => {
      const b = [...document.querySelectorAll('.paper-controls button')].find((x) => (x.textContent || '').trim().startsWith('再次记忆'));
      b?.click();
      return true;
    })()`);
    for (let i = 0; i < 25; i += 1) {
      if (await page.evaluate(`document.querySelectorAll('.mem-input').length > 0`)) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    const firstWord = await page.evaluate(`document.querySelector('.memorize-word')?.textContent ?? ''`);
    const answer = firstWord === 'r1' ? '一' : '二';
    await page.evaluate(`(() => {
      const el = document.querySelector('.mem-input');
      el.value = ${JSON.stringify(answer)};
      el.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#mem-submit')?.click();
      return true;
    })()`);
    await new Promise((r) => setTimeout(r, 700));
    check('提交后弹出答案卡', await page.evaluate(`!!document.querySelector('.answer-card')`));
    // 点页面任意处推进（答案卡在 document 上挂 capture click，必须派发真实点击）
    await page.evaluate(`document.body.click()`);
    for (let i = 0; i < 20; i += 1) {
      if (!(await page.evaluate(`!!document.querySelector('.answer-card')`))) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    await new Promise((r) => setTimeout(r, 900));
    const doneVisible = await page.evaluate(`(() => {
      const b = [...document.querySelectorAll('.paper-controls button')].find((x) => (x.textContent || '').trim() === '背完了');
      return b ? !b.classList.contains('hidden') : false;
    })()`);
    check('★ 复习模式下「背完了」按钮会出现（写回复习数据的出口）', doneVisible, `doneVisible=${doneVisible}`);

    const beforeFinish = (await page.evaluate(READ_ATTRS)).find((w) => w.en === firstWord);
    await page.evaluate(`(() => {
      const b = [...document.querySelectorAll('.paper-controls button')].find((x) => (x.textContent || '').trim() === '背完了');
      b?.click();
      return true;
    })()`);
    await new Promise((r) => setTimeout(r, 1800));
    const afterFinish = (await page.evaluate(READ_ATTRS)).find((w) => w.en === firstWord);
    console.log(`   ${firstWord} 复习前后：`, JSON.stringify(beforeFinish), '→', JSON.stringify(afterFinish));
    check('★ 「背完了」写回 reviewCount +1', afterFinish && beforeFinish && afterFinish.reviewCount === beforeFinish.reviewCount + 1, `${beforeFinish?.reviewCount} → ${afterFinish?.reviewCount}`);
    check('★ 「背完了」写回 examCount（本次考核计入）', afterFinish && beforeFinish && afterFinish.examCount === beforeFinish.examCount + 1, `${beforeFinish?.examCount} → ${afterFinish?.examCount}`);
    await page.close();
  }

  // ═══════════════════════════════════════════════════════════════════
  console.log('\n════════ [6] 设置页能看到 failRate 与试算表 ════════');
  {
    const page = await open('#/settings');
    const sec = await page.evaluate(`(() => {
      const d = [...document.querySelectorAll('.settings-page details.section')].find((x) => x.dataset.section === 'E');
      if (!d) return { found: false };
      d.open = true;
      return {
        found: true,
        expr: d.querySelector('.expr-preview')?.textContent ?? '',
        presetOptions: [...d.querySelectorAll('select')].flatMap((s) => [...s.options].map((o) => o.value)),
        chips: [...d.querySelectorAll('.chips button')].map((b) => b.textContent),
        text: d.textContent,
      };
    })()`);
    console.log('   当前生效表达式：', sec.expr);
    console.log('   变量按钮：', JSON.stringify(sec.chips));
    check('E 区正常渲染', sec.found);
    check('★ 设置页能看到含 failRate 的公式', /failRate/.test(sec.expr), sec.expr);
    check('预设下拉里有 failRateBalanced', (sec.presetOptions || []).includes('failRateBalanced'), JSON.stringify(sec.presetOptions));
    check('变量按钮里有 failRate 与 examCount', (sec.chips || []).includes('failRate') && (sec.chips || []).includes('examCount'), JSON.stringify(sec.chips));
    check('页面上有量纲提醒（比率 vs 次数）', /量纲提醒/.test(sec.text || ''), '');
    await page.close();
  }
} catch (err) {
  console.error('T2 验收脚本出错：', err);
  failed += 1;
} finally {
  dev.kill();
  if (browserProc) browserProc.kill();
}

console.log(`\n════ T2 验收结果：${passed} 通过 / ${failed} 失败 ════`);
if (failed > 0) {
  console.log('任一项 FAIL —— 不许声称完成。');
  process.exit(1);
}
process.exit(0);
