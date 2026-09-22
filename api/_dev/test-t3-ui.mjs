/**
 * T3 验收：考核「提示」改为朗诵一遍 + 「提示后算作未通过」设置 + 计数规则
 * 运行：`npm run test:t3-ui`
 *
 * ── 本阶段的三条硬约束（都要能验）──
 * 1. 不记录每个单词的提示统计（不新增任何持久化字段，hintUsed 只在内存里）；
 * 2. 不回填历史（开关只对之后的考核生效）；
 * 3. 开关这个设置**不改变已记录的次数**。
 *
 * ── 验收项 ──
 *  [1] 提示按钮：出现在考核界面、文案是「朗诵一遍」、可重复点击、
 *      点击确实调用朗读（用 stub 抓）、老的「首字母+长度」已消失
 *  [2] 设置项：设置页能看到「提示后算作未通过」，默认「否」
 *  [3] 五个场景 A~E（逐个跑真实考核并贴数字）
 *  [4] 不记录提示统计：全表扫描 attrs 没有新增字段；题目结束后内存态丢弃
 *  [5] 开关不改变历史：先考 3 次 → 拨开关 → 复查 failCount/examCount 一个都没变
 *  [6] 不回填历史：代码里没有迁移；老词数值不变
 *  [7] 选择题 / 判断正误不显示该按钮
 */
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findBrowser, launch, openSession } from '../../scripts/cdp.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = 4243;
const CDP_PORT = 9403;
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

/**
 * 注入：错误收集器 + **朗读调用记录**。
 *
 * ★ 为什么不整体替换 `speechSynthesis`：那是个陷阱。
 *   自己造的假对象里 `voice` 只能是普通对象，而真实代码会执行
 *   `utter.voice = voice` —— 赋值给一个普通对象会抛
 *   `Failed to set the 'voice' property …: Failed to convert value to 'SpeechSynthesisVoice'`。
 *   于是自动朗读那一步抛错，**整个背诵轮次在 refreshUi 之后中断**，
 *   测出来的表现是「进不了记忆环节、提示按钮不存在」——
 *   看起来像功能没做，其实是 stub 把应用打坏了（这个坑实测踩过一次）。
 *
 * 正确做法：**只包一层 `speak`**（抄下文本再调用原实现），
 * 不动 `speechSynthesis` 与 `SpeechSynthesisUtterance` 的真身。
 * 无头 Chrome 里大概率没有可用 voice，`pickVoice` 返回 null、`utter.voice` 不会被赋值，
 * 正好也不会发出声音 —— 我们要的证据只是「调了朗读、念的是哪个词」。
 */
const COLLECTOR = `
window.__t3Errors = [];
window.__t3Spoken = [];
(() => {
  /**
   * ★ 无头环境里 window.speechSynthesis 可能**根本不存在**（isSupported() 为 false）。
   *   那样的话 speak() 会静默降级、一个字都不念，HintButton 也就不记 hintUsed ——
   *   这是**正确**的产品行为（设备不支持朗读时不该把用户判成「用了提示」），
   *   但会让「点击确实朗读了」这条断言测不出来，所以补一个最小形状的对象。
   *
   * ⚠️ 只补 speak / cancel / getVoices / addEventListener 这几个真被调用的成员，
   *   **utterance 仍是浏览器真身**。上一版自己造 utterance 类的写法会让
   *   utter.voice = … 抛 TypeError（"Failed to convert value to SpeechSynthesisVoice"），
   *   把整轮背诵在 refreshUi 之后打断，表现成「进不了记忆环节」—— 那个坑踩过一次。
   */
  if (!('speechSynthesis' in window)) {
    Object.defineProperty(window, 'speechSynthesis', {
      value: { speak() {}, cancel() {}, getVoices() { return []; }, addEventListener() {}, removeEventListener() {} },
      configurable: true,
      writable: true,
    });
  }
  /**
   * 记录朗读调用：包一层 speechSynthesis.speak。
   *
   * ⚠️ 为什么不去包 SpeechSynthesisUtterance.prototype.text：
   *   实测 Chrome 里它是 **data property**（不是 accessor），
   *   Object.getOwnPropertyDescriptor(...).set 为 undefined，包装会**静默失效**
   *   （测试拿到空数组、看着像「没朗读」，其实是探针没装上）。
   *   包 speak 更直接：utterance 从参数里拿到，text 读一下就有了。
   */
  const synth = window.speechSynthesis;
  const rawSpeak = synth.speak.bind(synth);
  synth.speak = function (utter) {
    // 只记文本：判据就是「念的是不是这个单词」
    try { window.__t3Spoken.push(String(utter && utter.text)); } catch (e) { /* 记录失败不影响主流程 */ }
    return rawSpeak(utter);
  };
})();
const _ce = console.error;
console.error = function (...a) { window.__t3Errors.push({ kind: 'console', msg: a.map(String).join(' ') }); return _ce.apply(console, a); };
const _cw = console.warn;
console.warn = function (...a) { window.__t3Errors.push({ kind: 'console', msg: a.map(String).join(' ') }); return _cw.apply(console, a); };
window.addEventListener('error', (ev) => window.__t3Errors.push({ kind: 'error', msg: String(ev.message || ev.type) }));
window.addEventListener('unhandledrejection', (ev) => {
  const r = ev.reason;
  window.__t3Errors.push({ kind: 'rejection', msg: r instanceof Error ? r.message : String(r) });
});
`;

/**
 * 写入测试词。
 *
 * ★ 这里的 `attrs` 里**故意完全没有 examCount 字段**（老数据形态），
 *   用来验「不回填历史」；需要它的用例单独传。
 * @param {object[]} seeds 词
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
    tx.objectStore('sources').put({ id: 'src-t3', name: 'T3 验收来源', priority: 3, createdAt: 1, updatedAt: 1, deleted: 0 });
    list.forEach((seed, i) => {
      words.put({
        id: 'w-' + seed.en,
        en: seed.en,
        phonetic: '', example: '',
        senses: (seed.senses || [{ text: '释义' }]).map((s, j) => ({ id: 's-' + seed.en + '-' + j, text: s.text, aliases: s.aliases || [], enabled: true })),
        sourceId: 'src-t3', rawSources: [],
        attrs: seed.attrs,
        status: seed.status || 'unlearned',
        priority: typeof seed.priority === 'number' ? seed.priority : 3,
        learnOrder: null,
        createdAt: 1000 + i, updatedAt: 1000 + i, deleted: 0,
      });
    });
    tx.oncomplete = () => { db.close(); resolve(list.length); };
    tx.onerror = () => { db.close(); resolve(-1); };
  };
  req.onerror = () => resolve(-1);
}))()`;

/** 读回词的全部 attrs 键（验「没有新增持久化字段」） */
const READ_ATTR_KEYS = `(() => new Promise((resolve) => {
  const req = indexedDB.open('${DB_NAME}');
  req.onsuccess = () => {
    const db = req.result;
    const all = db.transaction('words').objectStore('words').getAll();
    all.onsuccess = () => {
      db.close();
      resolve(all.result.map((w) => ({ en: w.en, keys: Object.keys(w.attrs || {}).sort(), attrs: w.attrs })));
    };
  };
  req.onerror = () => resolve('open-failed');
}))()`;

/** 读单个词的要点 */
const READ_ONE = (en) => `(() => new Promise((resolve) => {
  const req = indexedDB.open('${DB_NAME}');
  req.onsuccess = () => {
    const db = req.result;
    const g = db.transaction('words').objectStore('words').get('w-${en}');
    g.onsuccess = () => {
      db.close();
      const w = g.result;
      resolve(w ? { en: w.en, failCount: w.attrs.failCount, failCountTotal: w.attrs.failCountTotal, examCount: w.attrs.examCount === undefined ? '__undefined__' : w.attrs.examCount, status: w.status } : null);
    };
  };
  req.onerror = () => resolve('open-failed');
}))()`;

/** 老数据的属性（不带 examCount，模拟 T2 之前 / 从未被回填的词） */
const oldAttrs = (failCount = 0, failCountTotal = 0) => ({
  needSpell: false,
  failCount,
  failCountTotal,
  reviewCount: 0,
  lastReviewAt: null,
  learnedAt: null,
  reviewPriority: 0,
});

/**
 * 背诵页「真的可以操作了」的判据。
 *
 * 为什么不是「`.paper-next` 存在」：那个按钮在 `initFlow()` 完成前就在 DOM 里了，
 * 而 `words`（本轮词单）要等 `dao.words.getAll()` 回来才填。就绪的可靠信号是
 * **进度文字里出现了真实词单长度**（形如 `已出现 0/N`，N ≥ 1）。
 */
const LEARN_READY = `/已出现 \\d+\\/[1-9]\\d*/.test(document.querySelector('.paper-progress')?.textContent ?? '')`;

/** 把设置写成指定状态（不走设置页，避免为了测判分去点一堆控件） */
const setHintFails = (value) => `(async () => {
  const dao = await import('/src/dao/index.ts');
  const cfg = await import('/src/core/config.ts');
  await dao.settings.set({ practice: { ...cfg.getSettings().practice, hintFails: ${value} } });
  const fresh = await dao.settings.get();
  return fresh.practice.hintFails;
})()`;

const dev = startDev();
let browserProc = null;

try {
  if (!(await waitForServer(ORIGIN))) throw new Error('dev server 没起来');
  const browser = findBrowser();
  if (!browser) throw new Error('找不到 Chrome / Edge');
  const launched = await launch(browser, CDP_PORT, { windowSize: '1280,900' });
  browserProc = launched.proc;

  /**
   * 切到某个 hash 路由并**真正重新加载**。
   *
   * ★ 为什么不直接用 `page.goto('#/xxx')`：那是 `Page.navigate`，
   *   而「同路径只换 hash」属于**同文档导航** —— 应用不会重新 boot、
   *   路由也不会重渲染。实测后果：种完词再 goto 到 `#/learn`，
   *   页面还停在上一次的 DOM 上，测试就抓不到新渲染出来的提示按钮
   *   （T2 的复习页也栽在同一个坑里，见 test-t2-ui.mjs 的注释）。
   *   `reload()` 才是真的重新加载。
   *
   * @param {any} page CDP 会话
   * @param {string} hash 形如 '#/learn'
   * @param {number} waitMs 额外等待
   * @param {string} readyExpr 等这个表达式为真才算页面就绪
   */
  async function gotoRoute(page, hash, waitMs = 2400, readyExpr = LEARN_READY) {
    await page.evaluate(`location.hash = ${JSON.stringify(hash)}`);
    await page.reload(waitMs);
    /**
     * ★ 双重保险：`reload()` 只等 load 事件，而白纸的按钮是**异步**渲染出来的。
     *
     * ⚠️ 就绪条件不能写成「`.paper-next` 存在」—— 那个按钮在 `initFlow()` 完成
     *    **之前**就已经渲染进 DOM 了，而 `words` 要等 `dao.words.getAll()` 回来才填。
     *    实测后果：点击时 `words` 还是空数组，`nextAction()` 直接 return，
     *    界面显示「已出现 0/1」（词单已就绪但没上纸），后续全都进不去 ——
     *    看起来像「提示按钮没做出来」，其实是测试点得太早。
     *    可靠信号是**进度文字里出现了真实的词单长度**（`0/N`，N ≥ 1）。
     */
    for (let i = 0; i < 30; i += 1) {
      if (await page.evaluate(readyExpr)) return true;
      await new Promise((r) => setTimeout(r, 200));
    }
    return false;
  }

  /**
   * 开一个新页面（装 stub 与错误收集器）。
   * @param {string} hash 形如 '#/settings'
   * @param {number} waitMs 额外等待
   */
  async function open(hash, waitMs = 2400) {
    const s = await openSession(CDP_PORT, `${ORIGIN}/${hash}`, { waitMs });
    await s.addInitScript(COLLECTOR);
    await s.reload(waitMs);
    return s;
  }

  /**
   * 跑一次完整的默写考核（上纸 → 记忆 → 填答案 → 提交）。
   *
   * @param {any} page CDP 会话
   * @param {{answer?: string, useHint: boolean, senseByWord?: Record<string,string>}} opts 答案与是否点提示
   * @returns {Promise<{ok: boolean, step?: string}>}
   */
  async function runOneExam(page, opts) {
    const clickControl = (prefix, exact = false) => page.evaluate(`(() => {
      const list = [...document.querySelectorAll('.paper-controls button')];
      const b = list.find((x) => {
        const t = (x.textContent || '').trim();
        return ${exact ? 't === ' : 't.startsWith('}${JSON.stringify(prefix)}${exact ? '' : ')'};
      });
      if (!b) return 'missing';
      if (b.disabled) return 'disabled';
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
    /**
     * ★ 等按钮**真的可用**再点下一步，而不是 sleep 一个固定毫秒数。
     *
     * 踩过的坑：这里原来是 `setTimeout(700)`，而「再背一个」只把词放上纸、
     * 由随后的 `refreshUi()` 去启用「再次记忆」。固定等待在首次渲染时会赶在
     * refreshUi 之前去点那个还是 disabled 的按钮 —— `click()` 落在 disabled
     * 元素上是**静默无效**的，于是整个考核环节进不去，测出来的表现是
     * 「提示按钮不存在」，看着像功能没做，其实是测试的时序问题。
     */
    const waitEnabled = async (prefix, tries = 25) => {
      for (let i = 0; i < tries; i += 1) {
        const state = await page.evaluate(`(() => {
          const b = [...document.querySelectorAll('.paper-controls button')].find((x) => (x.textContent||'').trim().startsWith(${JSON.stringify(prefix)}));
          if (!b) return 'missing';
          return b.disabled ? 'disabled' : 'enabled';
        })()`);
        if (state === 'enabled') return 'enabled';
        await new Promise((r) => setTimeout(r, 200));
      }
      return 'timeout';
    };
    const ready1 = await waitEnabled('再次记忆');
    const r2 = await clickControl('再次记忆');
    if (!(await waitFor(`document.querySelectorAll('.mem-input').length > 0`))) {
      // 诊断信息一起带出去：真的失败时不用再跑一遍才知道卡在哪
      return { ok: false, step: 'no-input', r1, ready1, r2 };
    }
    if (opts.useHint) {
      const clicked = await page.evaluate(`(() => {
        const b = document.querySelector('[data-role="speak-hint"]');
        if (!b) return 'missing';
        b.click();
        return 'clicked';
      })()`);
      if (clicked !== 'clicked') return { ok: false, step: 'hint-' + clicked };
      await new Promise((r) => setTimeout(r, 200));
    }
    /**
     * 答案：调用方没给就用**题面里的单词**（记忆环节的题干就是英文单词，
     * 而义项是中文 —— 所以「答对」= 填上这个词对应的那个中文释义）。
     * 传 `answer` 时按传的来；这里额外支持 `answerFromSense`，
     * 让多词场景（第 5 节连考 3 个词）不必为每个词硬编码答案。
     */
    const answerToUse = opts.answer !== undefined && opts.answer !== ''
      ? opts.answer
      : await page.evaluate(`(() => {
          const en = document.querySelector('.memorize-word')?.textContent?.trim() ?? '';
          const map = ${JSON.stringify(opts.senseByWord ?? {})};
          return map[en] ?? '';
        })()`);
    await page.evaluate(`(() => {
      const el = document.querySelector('.mem-input');
      el.value = ${JSON.stringify(answerToUse)};
      el.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#mem-submit')?.click();
      return true;
    })()`);
    if (!(await waitFor(`!!document.querySelector('.answer-card')`, 15))) return { ok: false, step: 'no-answer-card' };
    await page.evaluate(`document.body.click()`);
    await waitFor(`!document.querySelector('.answer-card')`, 15);
    // 「背完了」要等它出现（每个词都记忆达标后才会显示），不能 sleep 一个常数
    const readyFinish = await waitEnabled('背完了', 25);
    const fin = await clickControl('背完了', true);
    if (fin !== 'clicked') return { ok: false, step: 'finish-' + fin, readyFinish };
    await new Promise((r) => setTimeout(r, 1800));
    return { ok: true };
  }

  // ═══════════════════════════════════════════════════════════════════
  console.log('\n════════ [1] 提示按钮：文案 / 朗读 / 可重复点 / 老提示已消失 ════════');
  {
    const page = await open('#/home');
    await page.evaluate(seedWords([
      { en: 'abandon', senses: [{ text: '放弃' }], attrs: oldAttrs() },
    ]));
    const ready = await gotoRoute(page, '#/learn');
    check('背诵页渲染就绪（出现「再背一个」按钮）', ready, `ready=${ready}`);
    const click1 = await page.evaluate(`(() => {
      const b = [...document.querySelectorAll('.paper-controls button')].find((x) => (x.textContent||'').trim().startsWith('再背一个'));
      if (!b) return 'missing';
      if (b.disabled) return 'disabled';
      b.click();
      return 'clicked';
    })()`);
    await new Promise((r) => setTimeout(r, 1400));
    const afterPut = await page.evaluate(`(() => ({
      onPaper: document.querySelectorAll('.paper-word').length,
      progress: document.querySelector('.paper-progress')?.textContent ?? '',
      againDisabled: [...document.querySelectorAll('.paper-controls button')].find((x) => (x.textContent||'').trim().startsWith('再次记忆'))?.disabled ?? null,
    }))()`);
    const click2 = await page.evaluate(`(() => {
      const b = [...document.querySelectorAll('.paper-controls button')].find((x) => (x.textContent||'').trim().startsWith('再次记忆'));
      if (!b) return 'missing';
      if (b.disabled) return 'disabled';
      b.click();
      return 'clicked';
    })()`);
    console.log('   上纸：', click1, JSON.stringify(afterPut), '│ 再次记忆：', click2);
    for (let i = 0; i < 25; i += 1) {
      if (await page.evaluate(`document.querySelectorAll('.mem-input').length > 0`)) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    const btnInfo = await page.evaluate(`(() => {
      const b = document.querySelector('[data-role="speak-hint"]');
      return {
        exists: !!b,
        text: b?.textContent ?? '',
        hintRow: !!document.querySelector('.mem-hint-row'),
        oldHint: !!document.querySelector('#spell-hint, .spell-hint-text'),
        masked: /_/.test(document.querySelector('.memorize-box')?.textContent ?? ''),
      };
    })()`);
    console.log('   提示按钮：', JSON.stringify(btnInfo));
    check('考核界面出现提示按钮', btnInfo.exists, JSON.stringify(btnInfo));
    check('★ 文案是「朗诵一遍」', btnInfo.text.includes('朗诵一遍'), btnInfo.text);
    check('★ 老的「首字母+长度」提示已消失（没有 #spell-hint / 掩码下划线）', !btnInfo.oldHint && !btnInfo.masked, JSON.stringify(btnInfo));

    // 点两次：可重复、每次真的调了朗读、念的是这个单词
    const spoken1 = await page.evaluate(`(() => {
      window.__t3Spoken.length = 0;
      const el = document.querySelector('[data-role="speak-hint"]');
      if (!el) return ['__no_button__'];
      el.click();
      return window.__t3Spoken.slice();
    })()`);
    await new Promise((r) => setTimeout(r, 200));
    const spoken2 = await page.evaluate(`(() => { document.querySelector('[data-role="speak-hint"]').click(); return window.__t3Spoken.map((s) => s.text); })()`);
    console.log('   第一次点：', JSON.stringify(spoken1), '第二次点：', JSON.stringify(spoken2));
    check('★ 点击确实调用了朗读', spoken1.includes('abandon'), JSON.stringify(spoken1));
    check('★ 只念单词本身（不念音标、不念中文释义）', spoken1.every((t) => t === 'abandon'), JSON.stringify(spoken1));
    check('★ 可重复点击（第二次仍然朗读）', spoken2.length === 2, JSON.stringify(spoken2));
    const usedFlag = await page.evaluate(`document.querySelector('[data-role="speak-hint"]').dataset.used === '1'`);
    check('用过提示后 DOM 上留下 used 标记（判分与 Enter 提交共用）', usedFlag);
    check('页面没有未捕获异常', (await page.evaluate(`(window.__t3Errors ?? []).filter((e) => e.kind !== 'console').length`)) === 0);
    await page.close();
  }

  // ═══════════════════════════════════════════════════════════════════
  console.log('\n════════ [2] 设置项：存在且默认「否」 ════════');
  {
    const page = await open('#/settings');
    const sec = await page.evaluate(`(() => {
      const d = [...document.querySelectorAll('.settings-page details.section')].find((x) => x.dataset.section === 'D');
      if (!d) return { found: false };
      d.open = true;
      const box = d.querySelector('[data-role="hint-fails"]');
      return {
        found: true,
        hasBox: !!box,
        options: box ? [...box.querySelectorAll('input[type=radio]')].map((r) => ({ value: r.value, checked: r.checked })) : [],
        labels: box ? [...box.querySelectorAll('.radio-row')].map((l) => l.textContent) : [],
        text: d.textContent,
      };
    })()`);
    console.log('   设置项：', JSON.stringify(sec));
    check('★ 设置页 D 区有「提示后算作未通过」', sec.hasBox, JSON.stringify(sec.options));
    check('两个选项（是 / 否）', sec.options.length === 2, JSON.stringify(sec.options));
    check('★ 默认是「否」', sec.options.find((o) => o.value === 'no')?.checked === true && sec.options.find((o) => o.value === 'yes')?.checked === false, JSON.stringify(sec.options));
    check('选项文案写清了后果', sec.labels.some((l) => /用了提示就记一次未通过/.test(l)), JSON.stringify(sec.labels));
    check('说明里写明「只对开启之后生效、不改历史」', /不会改变已记录的历史次数/.test(sec.text || ''), '');
    await page.close();
  }

  // ═══════════════════════════════════════════════════════════════════
  console.log('\n════════ [3] 五个场景 A~E（真实考核，逐个出数字）════════');
  {
    /**
     * 表格来自阶段文档 T3 §3.3。
     * 每行：设置 / 用提示 / 答案 / 期望 pass / 期望 examCount 增量 / 期望 failCount 增量
     */
    const cases = [
      { id: 'A', hintFails: false, useHint: true, answer: '放弃', expectPass: true },
      { id: 'B', hintFails: false, useHint: true, answer: '错的答案', expectPass: false },
      { id: 'C', hintFails: true, useHint: true, answer: '放弃', expectPass: false },
      { id: 'D', hintFails: true, useHint: false, answer: '放弃', expectPass: true },
      { id: 'E', hintFails: true, useHint: true, answer: '错的答案', expectPass: false },
    ];
    const rows = [];
    for (const c of cases) {
      const page = await open('#/home');
      // 每个场景换成独立的词，避免互相干扰
      const en = `case${c.id.toLowerCase()}`;
      await page.evaluate(seedWords([{ en, senses: [{ text: '放弃' }], attrs: oldAttrs() }]));
      const okSetting = await page.evaluate(setHintFails(c.hintFails));
      if (okSetting !== c.hintFails) throw new Error(`设置写入失败：期望 ${c.hintFails}，实际 ${okSetting}`);
      await gotoRoute(page, '#/learn');
      const run = await runOneExam(page, { answer: c.answer, useHint: c.useHint });
      const after = await page.evaluate(READ_ONE(en));
      // 期望的增量：每次考核 examCount 必 +1；未通过时 failCount 也 +1
      const expectExam = 1;
      const expectFail = c.expectPass ? 0 : 1;
      rows.push({
        场景: c.id,
        设置: c.hintFails ? '是' : '否',
        用提示: c.useHint ? '是' : '否',
        答案: c.answer === '放弃' ? '对' : '错',
        pass: c.expectPass ? '✅ 对' : '❌ 错',
        examCount增量: after?.examCount === '__undefined__' ? '未定义' : `${after?.examCount}`,
        failCount增量: `${after?.failCount}`,
        failCountTotal增量: `${after?.failCountTotal}`,
      });
      console.log(`   场景 ${c.id}（设置=${c.hintFails ? '是' : '否'} 提示=${c.useHint ? '用了' : '没用'} 答案=${c.answer === '放弃' ? '对' : '错'}）`);
      console.log(`      跑通=${run.ok} 实际 examCount=${after?.examCount} failCount=${after?.failCount} failCountTotal=${after?.failCountTotal}`);
      check(`场景 ${c.id}：考核被记录（examCount +1）`, after?.examCount === expectExam, `实际 ${after?.examCount}，期望 ${expectExam}`);
      check(`场景 ${c.id}：failCount ${expectFail === 0 ? '不变' : '+1'}`, after?.failCount === expectFail, `实际 ${after?.failCount}，期望 ${expectFail}`);
      check(`场景 ${c.id}：failCountTotal ${expectFail === 0 ? '不变' : '+1'}`, after?.failCountTotal === expectFail, `实际 ${after?.failCountTotal}，期望 ${expectFail}`);
      await page.close();
    }
    console.log('\n   场景汇总表（examCount / failCount 均为考核后的值）：');
    console.table(rows);
    // ★ 重点：场景 C（开启 + 用了提示 + 答对 → 必须记为未通过）
    const cRow = rows.find((r) => r.场景 === 'C');
    check('★ 重点场景 C：开启 + 用了提示 + 答对 → 记为未通过（failCount=1）', cRow?.failCount增量 === '1', JSON.stringify(cRow));
  }

  // ═══════════════════════════════════════════════════════════════════
  console.log('\n════════ [4] 不记录提示统计（没有新增持久化字段）════════');
  {
    const page = await open('#/home');
    const keys = await page.evaluate(READ_ATTR_KEYS);
    console.log('   attrs 字段：', JSON.stringify(keys[0]?.keys ?? []));
    const BANNED = ['hintCount', 'passWithHintCount', 'hintUsedTotal', 'hintUsed', 'hintStats', 'hintCountTotal'];
    const found = keys.flatMap((k) => k.keys.filter((x) => BANNED.includes(x)).map((x) => `${k.en}.${x}`));
    check('★ 词属性里没有任何提示统计字段', found.length === 0, JSON.stringify(found));
    // 表结构未变：words 表只有原来的键
    const shape = await page.evaluate(`(() => new Promise((resolve) => {
      const req = indexedDB.open('${DB_NAME}');
      req.onsuccess = () => {
        const db = req.result;
        const all = db.transaction('words').objectStore('words').getAll();
        all.onsuccess = () => {
          db.close();
          resolve({ rowKeys: Object.keys(all.result[0] ?? {}).sort(), version: db.version });
        };
      };
      req.onerror = () => resolve('open-failed');
    }))()`);
    console.log('   words 行字段：', JSON.stringify(shape.rowKeys), '库版本', shape.version);
    check('★ words 表结构未变（没有新列）', !shape.rowKeys.some((k) => /hint/i.test(k)), JSON.stringify(shape.rowKeys));
    check('库版本仍是 7（T3 没有加迁移，因此没有抬版本）', shape.version === 7, String(shape.version));
    await page.close();
  }

  // ═══════════════════════════════════════════════════════════════════
  console.log('\n════════ [5] 开关不改变历史：先考 3 次 → 拨开关 → 复查 ════════');
  {
    const page = await open('#/home');
    /**
     * 用 **3 个词各考一次**，而不是同一个词考 3 次。
     *
     * 为什么：背诵会把考过的词归档成 `learned`，而背诵页只抽**未背**词
     * （`LearnPage.pickWords` 过滤 `status === 'unlearned'`）——
     * 同一个词考完一次就再也抽不到了。第一版就是这么写的，结果只考成了 1 次
     * （`第 2 次考核没跑通：r1 missing`）。3 个词各考一次同样能证明
     * 「拨开关前后已记录的次数不变」，而且更贴近真实使用。
     */
    await page.evaluate(seedWords([
      { en: 'hist1', senses: [{ text: '历史一' }], attrs: oldAttrs() },
      { en: 'hist2', senses: [{ text: '历史二' }], attrs: oldAttrs() },
      { en: 'hist3', senses: [{ text: '历史三' }], attrs: oldAttrs() },
    ]));
    await page.evaluate(setHintFails(false));
    const senseByWord = { hist1: '历史一', hist2: '历史二', hist3: '历史三' };
    for (let i = 0; i < 3; i += 1) {
      /**
       * ★ 每一轮都要**重新进背诵页**：一轮结束会 `navigate('/home')`，
       *   而留在那一页的 DOM 已经没有白纸流程了（上一版就是因此第 2、3 轮
       *   报 `r1 missing`）。每轮都重新 goto 一次，拿到干净的一屏。
       */
      const ready = await gotoRoute(page, '#/learn');
      if (!ready) {
        console.log(`   第 ${i + 1} 次考核：背诵页没就绪`);
        break;
      }
      const run = await runOneExam(page, { useHint: false, senseByWord });
      if (!run.ok) {
        console.log(`   第 ${i + 1} 次考核没跑通：`, JSON.stringify(run));
        break;
      }
    }
    const before = await page.evaluate(READ_ATTR_KEYS);
    const sum = (list) => list.reduce((n, w) => n + (typeof w.attrs.examCount === 'number' ? w.attrs.examCount : 0), 0);
    const fails = (list) => list.reduce((n, w) => n + w.attrs.failCount, 0);
    const failsTotal = (list) => list.reduce((n, w) => n + w.attrs.failCountTotal, 0);
    console.log('   拨开关前：', JSON.stringify(before.map((w) => [w.en, w.attrs.examCount, w.attrs.failCount, w.attrs.failCountTotal])));
    check('确实考核了 3 次（三个词的 examCount 各 +1）', before.every((w) => w.attrs.examCount === 1), JSON.stringify(before.map((w) => [w.en, w.attrs.examCount])));
    const flipped = await page.evaluate(setHintFails(true));
    const after = await page.evaluate(READ_ATTR_KEYS);
    console.log(`   拨开关后（hintFails=${flipped}）：`, JSON.stringify(after.map((w) => [w.en, w.attrs.examCount, w.attrs.failCount, w.attrs.failCountTotal])));
    check('★ 拨开关不改变 failCount', fails(after) === fails(before), `${fails(before)} → ${fails(after)}`);
    check('★ 拨开关不改变 failCountTotal', failsTotal(after) === failsTotal(before), `${failsTotal(before)} → ${failsTotal(after)}`);
    check('★ 拨开关不改变 examCount', sum(after) === sum(before), `${sum(before)} → ${sum(after)}`);
    check('★ 拨开关不改变任何词的任何属性', JSON.stringify(after) === JSON.stringify(before));
    await page.close();
  }

  // ═══════════════════════════════════════════════════════════════════
  console.log('\n════════ [6] 不回填历史：老词数值不变 + 代码里没有迁移 ════════');
  {
    const page = await open('#/home');
    await page.evaluate(seedWords([
      { en: 'legacy3', attrs: oldAttrs(2, 3) },
      { en: 'legacy0', attrs: oldAttrs(0, 0) },
    ]));
    const before = await page.evaluate(READ_ATTR_KEYS);
    // 重启页面（会走 boot + openDB；如果 T3 偷偷加了回填，这里就会变）
    await page.reload(2400);
    const after = await page.evaluate(READ_ATTR_KEYS);
    const b3 = before.find((w) => w.en === 'legacy3')?.attrs;
    const a3 = after.find((w) => w.en === 'legacy3')?.attrs;
    const b0 = before.find((w) => w.en === 'legacy0')?.attrs;
    const a0 = after.find((w) => w.en === 'legacy0')?.attrs;
    console.log('   legacy3 重启前/后：', JSON.stringify(b3), '→', JSON.stringify(a3));
    console.log('   legacy0 重启前/后：', JSON.stringify(b0), '→', JSON.stringify(a0));
    check('★ 老词 examCount 仍是未定义（T3 没有回填）', a3?.examCount === undefined && a0?.examCount === undefined, JSON.stringify([a3?.examCount, a0?.examCount]));
    check('★ 老词的其他属性一个都没变', JSON.stringify(b3) === JSON.stringify(a3) && JSON.stringify(b0) === JSON.stringify(a0));
    check('attrs 里没有新增提示相关字段', !(a3 && Object.keys(a3).some((k) => /hint/i.test(k))), JSON.stringify(Object.keys(a3 ?? {})));
    await page.close();
  }

  // ═══════════════════════════════════════════════════════════════════
  console.log('\n════════ [7] 二期：题型与提示的对应关系 ════════');
  {
    const page = await open('#/home');
    const map = await page.evaluate(`(async () => {
      const hb = await import('/src/ui/components/HintButton.ts');
      return {
        fill: hb.shouldShowHint('fill'),
        sentence: hb.shouldShowHint('sentence'),
        choice: hb.shouldShowHint('choice'),
        judge: hb.shouldShowHint('judge'),
        spell: hb.shouldShowHint('spell'),
      };
    })()`);
    console.log('   题型 → 是否显示提示：', JSON.stringify(map));
    check('★ 语法填空显示提示', map.fill === true);
    check('★ 写句子显示提示', map.sentence === true);
    check('★ 选择题不显示提示', map.choice === false);
    check('★ 判断正误不显示提示', map.judge === false);
    check('一期拼写显示提示', map.spell === true);
    await page.close();
  }
} catch (err) {
  console.error('T3 验收脚本出错：', err);
  failed += 1;
} finally {
  dev.kill();
  if (browserProc) browserProc.kill();
}

console.log(`\n════ T3 验收结果：${passed} 通过 / ${failed} 失败 ════`);
if (failed > 0) {
  console.log('任一项 FAIL —— 不许声称完成。');
  process.exit(1);
}
process.exit(0);
