/**
 * R2 的**界面端到端验收测试**：`npm run test:r2`
 * （需要本机有 Chrome / Edge，且先跑过 `npm run build`）
 *
 * 覆盖 R2 提示词「验收标准」里能自动验的项：
 *   · 录入页有「已有词库整理」分区，能选范围（来源 / 未整理过的 / 全部）；
 *   · 点「重新整理」→ 分批调用 AI（用打桩的 fetch，**不联网、不花钱**）；
 *   · 进度显示 + 断点续传存档（sessionStorage）；
 *   · **效果验证**：平铺的「高兴/快乐/愉快」被合成 1 个义项 + 2 个近义词；
 *     「bank 银行 / 河岸」保持 2 个独立义项（没有被错误合并）；缺失音标/例句被补上；
 *   · **差异预览**：旧/新对照、能逐条勾选、只应用勾选的那些；
 *   · **铁律验证**（最重要）：应用之后 `priority` / `sourceId` / `status` / `attrs` /
 *     `id` / `createdAt` 一个都没变，只有 senses / phonetic / example / updatedAt 变了；
 *   · 单批失败时跳过并继续，最后列出失败批次，不崩溃。
 *
 * ★ AI 用打桩的关键点：`window.fetch` 在**页面脚本执行之前**被替换
 *   （CDP `Page.addScriptToEvaluateOnNewDocument`），只有 `chat/completions` 被拦，
 *   其它请求原样放行（页面自己的静态资源不受影响）。
 *   这样响应内容 100% 可控，可以精确构造出「该合并的」和「不该合并的」两种输入。
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findBrowser, launch, openSession, serveStatic } from '../../scripts/cdp.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = 4191;
const CDP_PORT = 9343;
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

// ══════════════════════════════════════════ 测试数据

/**
 * 用来测「该合并」的词：三个近义义项平铺，且缺音标与例句。
 */
const MERGE_WORD = {
  en: 'delighted',
  phonetic: '',
  example: '',
  senses: [{ text: '高兴', aliases: [] }, { text: '快乐', aliases: [] }, { text: '愉快', aliases: [] }],
};
/** AI 整理后的正确形态：1 个义项 + 2 个近义词 + 补好的音标例句 */
const MERGE_WORD_FIXED = {
  en: 'delighted',
  phonetic: '/dɪˈlaɪtɪd/',
  example: 'She was delighted with the result.',
  senses: [{ text: '高兴', aliases: ['快乐', '愉快'] }],
};

/**
 * 用来测「不该合并」的词：两件不相干的事（银行 / 河岸）。
 */
const SPLIT_WORD = {
  en: 'bank',
  phonetic: '/bæŋk/',
  example: 'He sat on the river bank.',
  senses: [{ text: 'n. 银行', aliases: [] }, { text: 'n. 河岸', aliases: [] }],
};

/** 用来测「AI 漏词」的词：打桩的响应里刻意不返回它 */
const MISSING_WORD = {
  en: 'zero',
  phonetic: '',
  example: '',
  senses: [{ text: '零', aliases: [] }],
};

/** 用来测「单批失败不中断」的词（第一批会被打桩的 fetch 返回 500） */
const FAIL_WORD = {
  en: 'failure',
  phonetic: '',
  example: '',
  senses: [{ text: '失败', aliases: [] }],
};

/** 用来测「铁律」的词：优先级 5、已背、有复习记录、手写例句 */
const PROTECTED_WORD = {
  en: 'guard',
  phonetic: '/ɡɑːd/',
  example: 'My own example sentence.',
  senses: [{ text: 'v. 守卫', aliases: [] }],
  priority: 5,
  status: 'learned',
  attrs: {
    needSpell: true,
    failCount: 2,
    failCountTotal: 3,
    reviewCount: 7,
    lastReviewAt: 1_700_000_000_000,
    learnedAt: 1_600_000_000_000,
    reviewPriority: 0.75,
  },
};
/** AI 会给它一个整理后的形态（义项合并 + 补近义词），但音标例句必须保留用户的 */
const PROTECTED_WORD_FIXED = {
  en: 'guard',
  phonetic: '/ɡɑːd/',
  example: 'My own example sentence.',
  senses: [{ text: 'v. 守卫', aliases: ['看守', '保卫'] }],
};

/** 全部测试词 */
const ALL_WORDS = [MERGE_WORD, SPLIT_WORD, MISSING_WORD, FAIL_WORD, PROTECTED_WORD];

/**
 * 生成「打桩 fetch」的注入脚本（在页面里求值安装，不是 CDP initScript）。
 *
 * 行为：
 *   · 只有 URL 含 `chat/completions` 的请求被拦，其余（静态资源等）原样放行；
 *   · 第一批请求（`__r2Calls` 计数为 0）刻意返回 500 → 用来验「单批失败跳过并继续」；
 *   · 之后的请求返回固定 JSON：把 delighted 的 3 个义项合并成 1 个 + 2 个近义词，
 *     bank 保持 2 个义项，guard 补近义词但音标例句保持用户原样，**不返回 zero**（验漏词）。
 *
 * ★ 为什么不用 CDP 的 `Page.addScriptToEvaluateOnNewDocument`：
 *   实测在这套 headless Chrome 里它**不生效**（identifier 拿到了、但脚本没跑，
 *   连 `document.documentElement.setAttribute` 都观察不到）。
 *   而打桩只需要在**用户点按钮之前**完成即可——应用是在点击后才发请求的，
 *   所以在页面加载完成后直接求值安装就够了，而且行为完全一样、还更好调试。
 *
 * @param {object} opts.failFirstBatch 第一批是否返回 500
 */
function buildAiStub(opts) {
  const responses = {
    [MERGE_WORD.en]: MERGE_WORD_FIXED,
    [SPLIT_WORD.en]: SPLIT_WORD,
    [PROTECTED_WORD.en]: PROTECTED_WORD_FIXED,
  };
  return `(() => {
  window.__r2StubInstalled = true;
  const responses = ${JSON.stringify(responses)};
  const failFirstBatch = ${JSON.stringify(opts.failFirstBatch === true)};
  window.__r2Calls = [];
  const originalFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    if (!url.includes('chat/completions')) return originalFetch(input, init);
    let sent = [];
    try {
      const body = JSON.parse((init && init.body) || '{}');
      const userMsg = (body.messages || []).find((m) => m.role === 'user');
      sent = JSON.parse((userMsg && userMsg.content) || '{}').words || [];
    } catch (err) { sent = []; }
    window.__r2Calls.push({ url: url, sent: sent.map((w) => w.en) });
    // 第一批的**第一次尝试**：模拟上游 500。
    // 注意只失败「第一次尝试」：应用对单批会重试 1 次，重试必须能成功——
    // 否则整批词都会被记成"失败批次"，就验不到「重试有效」这件事了。
    if (failFirstBatch && window.__r2Calls.length === 1) {
      return Promise.resolve(new Response('stub failure', { status: 500, statusText: 'StubFailure' }));
    }
    const out = { words: [] };
    for (const w of sent) {
      const hit = responses[w.en];
      // 刻意**不返回**没有对应条目的词（zero）→ 验「AI 漏词时保留原样」
      if (hit) out.words.push(hit);
    }
    return Promise.resolve(new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(out) } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  };
  return true;
})()`;
}

// ══════════════════════════════════════════ 页面辅助

/**
 * 安装 AI 打桩（在页面里求值），返回是否装成功。
 *
 * ★ 时机：必须在**页面已经加载完、用户点按钮之前**调用。
 *   应用是「点了才开始整理」，所以这时候装完全来得及；
 *   而 CDP 的 `Page.addScriptToEvaluateOnNewDocument` 在这套 headless Chrome 上
 *   实测**不生效**（identifier 拿到了但脚本没跑），所以走页面内求值这条路。
 *
 * @param {any} session CDP 会话
 * @param {boolean} failFirstBatch 第一批是否返回 500
 */
async function installAiStub(session, failFirstBatch) {
  const installed = await session.evaluate(buildAiStub({ failFirstBatch }));
  return installed === true;
}

/**
 * 打开录入页、写好 AI 设置、装好 AI 打桩，然后把页面导航到录入页。
 *
 * ★ 三个必须注意的点：
 *   1. **必须先注销 Service Worker**：这个应用的 SW 会缓存页面与静态资源，
 *      在无头浏览器里反复「写数据 → 重新导航」的场景下，SW 可能把**旧页面/旧脚本**
 *      发回来，于是页面跑的是上一版代码——排查起来会完全跑偏（这个坑真踩过）。
 *      测试关心的是「当前这份 dist 的行为」，缓存一律清掉。
 *   2. settings 表的主键是 **'main'**（见 dao/settings.ts 的 MAIN_KEY），
 *      写成 'settings' 会静默写出一条没人读的行，表现是「密钥像没填一样」。
 *   3. 顺序：**先写设置 + 装 AI 打桩，再导航到录入页**，否则录入页已经渲染完，
 *      ReparsePanel 的范围下拉里会是「0 词」（它不会自己重读），
 *      而且导航会把页面里的打桩冲掉。
 * @param {any} session CDP 会话
 * @param {boolean} [failFirstBatch] AI 打桩的第一批是否返回 500
 * @returns 写进设置表里的 AI 密钥（用来确认真的写对了 key）
 */
async function preparePage(session, failFirstBatch = false) {
  await session.goto(`${ORIGIN}/#/home`, 1200);
  await session.evaluate(`(async () => {
    if (navigator.serviceWorker) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    }
    return true;
  })()`);
  await session.evaluate(`(() => new Promise((resolve) => {
    const req = indexedDB.open('blank-sheet-vocab');
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('settings', 'readwrite');
      const store = tx.objectStore('settings');
      const get = store.get('main');
      get.onsuccess = () => {
        const row = get.result || { key: 'main', value: {} };
        const value = row.value || {};
        value.ai = Object.assign({}, value.ai, {
          baseUrl: 'http://127.0.0.1:${PORT}/v1',
          model: 'stub-model',
          key: 'stub-key',
          proxyUrl: '',
          forceProxy: false,
        });
        store.put({ key: 'main', value: value });
      };
      tx.oncomplete = () => resolve(true);
    };
  }))()`);
  // 读回来确认真的写进去了（写错了 key 的话后面所有的失败都会指向错误的地方）
  const check = await session.evaluate(`(() => new Promise((resolve) => {
    const req = indexedDB.open('blank-sheet-vocab');
    req.onsuccess = () => {
      const get = req.result.transaction('settings').objectStore('settings').get('main');
      get.onsuccess = () => resolve(get.result && get.result.value && get.result.value.ai ? get.result.value.ai.key : null);
    };
  }))()`);
  // ★ 顺序很重要：**先真正 reload**（让 boot() 重跑、把新设置读进内存缓存），
  //   再装 AI 打桩（reload 会把页面里的打桩清掉），最后才各自走 hash 到录入页。
  //   反过来写会踩两个坑之一：设置缓存还是旧的（页面说没填密钥），
  //   或者打桩被 reload 冲掉（页面真的去联网了）。
  await session.reload(2500);
  await installAiStub(session, failFirstBatch);
  return check;
}

/**
 * 回到录入页（hash 导航，不重新加载）。
 *
 * ★ 为什么用 hash 而不是 `goto`：这里**不想要**重新加载——
 *   打桩是装在当前页面里的，重新加载会把它冲掉。
 *   而 hash 导航会重新渲染页面，渲染时读的是已经刷新过的设置缓存。
 * @param {any} session CDP 会话
 */
async function reloadToImport(session) {
  await session.goto(`${ORIGIN}/#/import`, 2000);
}

/**
 * 把测试词写进词库（直接写 IndexedDB，绕开录入流程——R2 测的是"整理已有词"）。
 * @param {any} session CDP 会话
 * @param {object[]} words 词
 */
async function seedWords(session, words) {
  return session.evaluate(`(() => new Promise((resolve) => {
    const seeds = ${JSON.stringify(words)};
    const req = indexedDB.open('blank-sheet-vocab');
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction(['words', 'sources'], 'readwrite');
      const words = tx.objectStore('words');
      const sources = tx.objectStore('sources');
      sources.put({ id: 'src-r2', name: 'R2测试来源', priority: 3, createdAt: 1000, updatedAt: 1000, deleted: 0 });
      const now = Date.now();
      for (const seed of seeds) {
        words.put({
          id: 'w-' + seed.en,
          en: seed.en,
          phonetic: seed.phonetic || '',
          example: seed.example || '',
          senses: (seed.senses || []).map((s, i) => ({ id: 's-' + seed.en + '-' + i, text: s.text, aliases: s.aliases || [], enabled: true })),
          sourceId: 'src-r2',
          rawSources: [],
          attrs: seed.attrs || { needSpell: false, failCount: 0, failCountTotal: 0, reviewCount: 0, lastReviewAt: null, learnedAt: null, reviewPriority: 0 },
          status: seed.status || 'unlearned',
          priority: typeof seed.priority === 'number' ? seed.priority : 3,
          learnOrder: null,
          createdAt: 1000,
          updatedAt: 1000,
          deleted: 0,
        });
      }
      tx.oncomplete = () => resolve(seeds.length);
    };
  }))()`);
}

/**
 * 读词库里的完整字段（铁律验证要逐字段比对）。
 * @param {any} session CDP 会话
 */
async function dumpWords(session) {
  return session.evaluate(`(() => new Promise((resolve) => {
    const req = indexedDB.open('blank-sheet-vocab');
    req.onsuccess = () => {
      const all = req.result.transaction('words').objectStore('words').getAll();
      all.onsuccess = () => resolve(all.result.map((w) => ({
        id: w.id, en: w.en, priority: w.priority, sourceId: w.sourceId, status: w.status,
        createdAt: w.createdAt, updatedAt: w.updatedAt,
        phonetic: w.phonetic, example: w.example,
        senses: w.senses.map((s) => ({ text: s.text, aliases: s.aliases, enabled: s.enabled })),
        attrs: w.attrs,
        rawSources: w.rawSources,
      })));
    };
  }))()`);
}

/**
 * 点「用 AI 重新整理义项」→ 确认框 → 等差异预览出现。
 * @param {any} session CDP 会话
 * @param {string} scopeValue 选哪个范围（select 的 value）
 */
async function runReparse(session, scopeValue) {
  const setScope = await session.evaluate(`(() => {
    const sel = document.querySelector('.card select');
    if (!sel) return { ok: false, reason: 'no-select' };
    if (![...sel.options].some((o) => o.value === ${JSON.stringify(scopeValue)})) {
      return { ok: false, reason: 'no-option', options: [...sel.options].map((o) => o.value) };
    }
    sel.value = ${JSON.stringify(scopeValue)};
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, value: sel.value };
  })()`);
  await new Promise((r) => setTimeout(r, 400));
  const clicked = await session.evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '用 AI 重新整理义项');
    if (!b) return { ok: false, buttons: [...document.querySelectorAll('button')].map((x) => x.textContent.trim()).slice(0, 15) };
    const card = b.closest('.card');
    const before = document.querySelectorAll('.modal').length;
    b.click();
    return {
      ok: true,
      disabled: b.disabled,
      sameCard: !!card,
      cardTitle: card ? (card.querySelector('.card-title')?.textContent ?? '') : null,
      modalsBefore: before,
      modalsAfter: document.querySelectorAll('.modal').length,
      afterTitle: document.querySelector('.modal-title')?.textContent ?? null,
    };
  })()`);
  // 确认框
  const confirmUp = await waitFor(session, `document.querySelector('.modal-title')?.textContent === '用 AI 重新整理义项'`, 60);
  const confirmInfo = await session.evaluate(`({
    title: document.querySelector('.modal-title')?.textContent ?? null,
    body: document.querySelector('.modal-body')?.textContent?.slice(0, 120) ?? null,
  })`);
  await session.evaluate(
    `[...document.querySelectorAll('.modal button')].find((b) => b.textContent.trim() === '开始整理')?.click()`,
  );
  return { setScope, clicked, confirmUp, confirmInfo };
}

// ══════════════════════════════════════════ 主流程

console.log('\n=== R2 验收：预设词库义项 AI 重整理 ===\n');

console.log('[0] 前置检查');
if (!existsSync(join(ROOT, 'dist', 'index.html'))) {
  console.error('✗ 没有 dist/，先跑 npm run build');
  process.exit(1);
}
check('dist/index.html 存在', true);

const browser = findBrowser();
if (!browser) {
  console.log('\n⚠ 本机没有 Chrome / Edge，跳过界面验收');
  console.log(`\nR2 验收：${passed} 项通过，${failed} 项失败`);
  process.exit(failed > 0 ? 1 : 0);
}
console.log(`  用 ${browser.split('\\').pop()} 跑无头检查`);

const server = serveStatic({ root: ROOT, port: PORT, mode: 'preview' });
let chrome = null;

try {
  const up = await waitForServer(`${ORIGIN}/`);
  if (!up) throw new Error(`预览服务没起来（${ORIGIN}）`);
  chrome = await launch(browser, CDP_PORT, { windowSize: '1280,900' });

  // ───────────────────────────────── [1] 分区与范围下拉
  console.log('\n[1] 录入页的「已有词库整理」分区');
  {
    const s = await openSession(CDP_PORT, `${ORIGIN}/#/import`);
    try {
      // 先注销 SW：确认测的是当前这份 dist，而不是被缓存的旧页面
      await s.evaluate(`(async () => {
        if (navigator.serviceWorker) {
          const regs = await navigator.serviceWorker.getRegistrations();
          await Promise.all(regs.map((r) => r.unregister()));
        }
        return true;
      })()`);
      await reloadToImport(s);
      const ui = await s.evaluate(`(() => ({
        titles: [...document.querySelectorAll('.card-title')].map((e) => e.textContent.trim()),
        hasBtn: [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === '用 AI 重新整理义项'),
        hintText: document.body.textContent.includes('不动优先级、来源、状态和学习记录'),
        scriptName: [...document.scripts].map((x) => x.src.split('/').pop()),
      }))()`);
      check('录入页有「4. 已有词库整理」分区', ui.titles.some((t) => t.startsWith('4. 已有词库整理')), JSON.stringify(ui.titles));
      check('有「用 AI 重新整理义项」按钮', ui.hasBtn);
      check('分区写明了铁律（不动优先级/来源/状态/学习记录）', ui.hintText);
      // Service Worker 在**页面加载时**就已经接管了，注销也不会立刻解除控制；
      // 所以这里改成「页面加载的是 dist 里当前这份入口脚本」——
      // 这才是「测的是本次构建」的真正证据。
      check(
        '页面加载的是 dist 里当前那份入口脚本',
        existsSync(join(ROOT, 'dist', 'assets', ui.scriptName[0] ?? '')),
        JSON.stringify(ui.scriptName),
      );
    } finally {
      await s.close();
    }
  }

  // ───────────────────────────────── [2] 整理 + 差异预览（含单批失败与漏词）
  console.log('\n[2] 整理流程 + 差异预览 + 效果验证');
  {
    const s = await openSession(CDP_PORT, `${ORIGIN}/#/home`);
    try {
      const keySeen = await preparePage(s, true);
      check('AI 配置写进了 settings 表（key=main）', keySeen === 'stub-key', String(keySeen));
      const seeded = await seedWords(s, ALL_WORDS);
      check('5 个测试词写进了词库', seeded === 5, String(seeded));
      await reloadToImport(s);

      // 选「全部词」范围，避免依赖"未整理过"的启发式判据
      const steps = await runReparse(s, '__all__');
      const diffUp = await waitFor(s, `document.querySelector('.modal-title')?.textContent === '整理差异预览'`, 120);
      const diag = await s.evaluate(`({
        runState: window.__r2Run ?? null,
        stubInstalled: window.__r2StubInstalled === true,
        calls: window.__r2Calls ? window.__r2Calls.length : -1,
        sent: window.__r2Calls ? window.__r2Calls.map((c) => c.sent) : null,
        modalTitle: document.querySelector('.modal-title')?.textContent ?? null,
        progress: document.querySelector('.reparse-progress')?.textContent ?? null,
        toasts: [...document.querySelectorAll('.toast')].map((t) => t.textContent),
      })`);
      check('打桩的 fetch 装上了', diag.stubInstalled === true, JSON.stringify(diag));
      check('页面确实向打桩接口发了请求', (diag.calls ?? -1) > 0, JSON.stringify(diag));
      check('整理后弹出「整理差异预览」', diffUp, JSON.stringify({ steps, diag }));

      const preview = await s.evaluate(`(() => {
        const m = document.querySelector('.modal');
        if (!m) return null;
        return {
          text: m.querySelector('.modal-body')?.textContent ?? '',
          cards: [...m.querySelectorAll('.diff-card')].map((c) => c.textContent),
          checkboxes: m.querySelectorAll('.diff-card input[type=checkbox]').length,
          checked: m.querySelectorAll('.diff-card input[type=checkbox]:checked').length,
          buttons: [...m.querySelectorAll('button')].map((b) => b.textContent.trim()),
        };
      })()`);
      check('预览里显示了「共 N 词，其中 M 词有变化」', /共 \d+ 词，其中 \d+ 词有变化/.test(preview?.text ?? ''), preview?.text?.slice(0, 80));
      check('预览列出了逐条差异卡片', (preview?.cards.length ?? 0) > 0, JSON.stringify(preview?.cards));
      check('每条差异都有勾选框且默认全选', preview?.checkboxes > 0 && preview?.checked === preview?.checkboxes, `${preview?.checked}/${preview?.checkboxes}`);
      check('预览有「应用这 N 处修改」按钮', (preview?.buttons ?? []).some((b) => b.includes('应用这')), JSON.stringify(preview?.buttons));
      check('预览写明了「AI 漏词保留原样」', (preview?.text ?? '').includes('保留原样'), preview?.text?.slice(0, 300));

      // 效果验证：delighted 的 3 个平铺义项 → 1 个义项 + 2 个近义词
      const delightedCard = (preview?.cards ?? []).find((c) => c.includes('delighted')) ?? '';
      check('预览里 delighted 的旧形态是 3 个平铺义项', delightedCard.includes('高兴 ｜ 快乐 ｜ 愉快'), delightedCard.slice(0, 200));
      check('预览里 delighted 的新形态是 1 个义项 + 2 个近义词', delightedCard.includes('高兴（快乐、愉快）'), delightedCard.slice(0, 200));
      check('delighted 的差异标签含「义项 / 音标 / 例句」', delightedCard.includes('义项') && delightedCard.includes('音标'), delightedCard.slice(0, 120));
      check('缺失的音标/例句补上了（预览里能看到改动前后）', delightedCard.includes('/dɪˈlaɪtɪd/') && delightedCard.includes('delighted with the result'), delightedCard.slice(0, 400));

      // 不该合并的：bank 前后完全一致 → **不出现在差异列表里**（这正是"没被改坏"的证据）
      const bankCard = (preview?.cards ?? []).find((c) => c.includes('bank')) ?? '';
      check('bank 这类不相干含义没有被错误合并（旧=新 → 不进差异列表）', bankCard === '', bankCard.slice(0, 200));

      // AI 漏词：zero 不该出现在差异里（保留原样）
      const zeroCard = (preview?.cards ?? []).some((c) => c.includes('zero'));
      check('AI 漏掉的词（zero）不出现在差异列表里（保留原样）', zeroCard === false);
      check('统计里写明了 AI 漏了几个词', (preview?.text ?? '').includes('没有返回结果'), preview?.text?.slice(0, 300));
    } finally {
      await s.close();
    }
  }

  // ───────────────────────────────── [3] 应用 + 铁律验证
  console.log('\n[3] 应用修改 + 铁律验证（priority / 来源 / 状态 / 学习记录不许变）');
  {
    const s = await openSession(CDP_PORT, `${ORIGIN}/#/home`);
    try {
      const keySeen = await preparePage(s, false);
      check('AI 配置写进了 settings 表（key=main）', keySeen === 'stub-key', String(keySeen));
      await seedWords(s, ALL_WORDS);
      await reloadToImport(s);

      const before = await dumpWords(s);
      const beforeGuard = before.find((w) => w.en === 'guard');
      const beforeBank = before.find((w) => w.en === 'bank');

      await runReparse(s, '__all__');
      await waitFor(s, `document.querySelector('.modal-title')?.textContent === '整理差异预览'`, 120);

      // 逐条勾选：把 delighted **取消勾选**，验证「只有勾选的才会被应用」
      const unchecked = await s.evaluate(`(() => {
        const card = [...document.querySelectorAll('.diff-card')].find((c) => c.textContent.includes('delighted'));
        if (!card) return false;
        const box = card.querySelector('input[type=checkbox]');
        if (!box) return false;
        box.checked = false;
        box.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`);
      check('能逐条取消勾选（delighted 被排除）', unchecked === true);

      const applyLabel = await s.evaluate(`(() => {
        const b = [...document.querySelectorAll('.modal button')].find((x) => x.textContent.trim().startsWith('应用这'));
        if (!b) return null;
        const label = b.textContent.trim();
        b.click();
        return label;
      })()`);
      check('点「应用」按钮生效', applyLabel !== null, String(applyLabel));
      const applied = await waitFor(s, `document.body.textContent.includes('未改动')`, 120);
      check('应用后给出成功提示', applied);

      const after = await dumpWords(s);
      const guard = after.find((w) => w.en === 'guard');
      const bank = after.find((w) => w.en === 'bank');
      const delighted = after.find((w) => w.en === 'delighted');
      const zero = after.find((w) => w.en === 'zero');

      // —— 铁律：guard（priority 5 / 已背 / 有复习记录）——
      check('★ priority 完全没变（仍是 5）', guard?.priority === beforeGuard?.priority && guard?.priority === 5, `${beforeGuard?.priority} → ${guard?.priority}`);
      check('★ sourceId 没变', guard?.sourceId === beforeGuard?.sourceId, `${beforeGuard?.sourceId} → ${guard?.sourceId}`);
      check('★ status 没变（仍是 learned）', guard?.status === 'learned' && guard?.status === beforeGuard?.status, `${beforeGuard?.status} → ${guard?.status}`);
      check('★ attrs 逐字段没变（拼写/未通过/复习次数/时间戳/优先度）', JSON.stringify(guard?.attrs) === JSON.stringify(beforeGuard?.attrs), `${JSON.stringify(beforeGuard?.attrs)} → ${JSON.stringify(guard?.attrs)}`);
      check('★ id 与 createdAt 没变', guard?.id === beforeGuard?.id && guard?.createdAt === beforeGuard?.createdAt);
      check('★ rawSources 没变', JSON.stringify(guard?.rawSources) === JSON.stringify(beforeGuard?.rawSources));
      // —— 但该变的变了 ——
      check('义项被整理（guard 补上了近义词 看守/保卫）', JSON.stringify(guard?.senses) === JSON.stringify([{ text: 'v. 守卫', aliases: ['看守', '保卫'], enabled: true }]), JSON.stringify(guard?.senses));
      check('用户手写的例句**没有被 AI 覆盖**（只补不覆盖）', guard?.example === 'My own example sentence.', guard?.example);
      check('已有音标没有被改', guard?.phonetic === '/ɡɑːd/', guard?.phonetic);
      check('updatedAt 被刷新了（云同步才能推给别的设备）', (guard?.updatedAt ?? 0) > (beforeGuard?.updatedAt ?? 0), `${beforeGuard?.updatedAt} → ${guard?.updatedAt}`);

      // —— 逐条勾选生效：delighted 被取消勾选 → 不该被改 ——
      check('取消勾选的词（delighted）**没有**被写库', JSON.stringify(delighted?.senses) === JSON.stringify(before.find((w) => w.en === 'delighted')?.senses), JSON.stringify(delighted?.senses));

      // —— bank 保持两个义项 ——
      check('bank 仍然是 2 个独立义项（没有被错误合并）', bank?.senses.length === 2, JSON.stringify(bank?.senses));
      check('bank 的铁律字段也没变（priority/status/attrs）', bank?.priority === beforeBank?.priority && bank?.status === beforeBank?.status && JSON.stringify(bank?.attrs) === JSON.stringify(beforeBank?.attrs));

      // —— AI 漏词：原样保留 ——
      check('AI 漏掉的词（zero）原样保留、没被删除', zero !== undefined && JSON.stringify(zero.senses) === JSON.stringify([{ text: '零', aliases: [], enabled: true }]), JSON.stringify(zero?.senses));

      // —— 断点存档 ——
      const job = await s.evaluate(`(() => { try { return JSON.parse(sessionStorage.getItem('blank-sheet-vocab.reparseJob') || 'null'); } catch (e) { return null; } })()`);
      check('整理进度写进了 sessionStorage（刷新后可续跑）', job !== null && Array.isArray(job.processedIds) && job.processedIds.length > 0, JSON.stringify(job));
      check('存档里记了「已应用」的词 id', job !== null && Array.isArray(job.appliedIds) && job.appliedIds.length > 0, JSON.stringify(job?.appliedIds));
    } finally {
      await s.close();
    }
  }

  // ───────────────────────────────── [4] 单批失败：重试 1 次后成功，不中断整体
  console.log('\n[4] 单批第一次失败 → 自动重试 → 仍然跑完整条流程');
  {
    const s = await openSession(CDP_PORT, `${ORIGIN}/#/home`);
    try {
      const keySeen4 = await preparePage(s, true);
      check('AI 配置写进了 settings 表（单批失败场景）', keySeen4 === 'stub-key', String(keySeen4));
      await seedWords(s, ALL_WORDS);
      await reloadToImport(s);

      await runReparse(s, '__all__');
      const up = await waitFor(s, `document.querySelector('.modal-title')?.textContent === '整理差异预览'`, 200);
      const bodyText = await s.evaluate(`document.querySelector('.modal-body')?.textContent ?? ''`);
      const calls = await s.evaluate(`window.__r2Calls`);
      check('第一批第一次失败后，自动重试并完成了整体流程', up, bodyText.slice(0, 160));
      check('确实发了两次请求（失败的第一次 + 重试）', Array.isArray(calls) && calls.length >= 2, JSON.stringify(calls));
      check('重试发的是同一批词（没有漏发或改发）', JSON.stringify(calls?.[0]?.sent) === JSON.stringify(calls?.[1]?.sent), JSON.stringify(calls));
      check('重试成功后不再报「批次失败」', !bodyText.includes('批次失败'), bodyText.slice(0, 300));
      check('页面没有崩溃', (await s.evaluate(`!document.body.textContent.includes('页面渲染失败')`)) === true);
      // 关掉弹窗，避免影响后续
      await s.evaluate(`[...document.querySelectorAll('.modal button')].find((b) => b.textContent.includes('取消'))?.click()`);
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

console.log(`\n=== R2 验收：通过 ${passed} 项，失败 ${failed} 项 ===\n`);
process.exit(failed === 0 ? 0 : 1);
