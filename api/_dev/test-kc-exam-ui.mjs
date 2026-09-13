/**
 * 做题流程的**真浏览器**冒烟：`npm run test:kc-exam-ui`
 *
 * 专门盯用户本轮提的两条要求（它们都只能在浏览器里验）：
 *   1. **一口气出完所有题**（阶段 08）：进做题时先把这一轮所有题都生成好，
 *      答题过程中**不再**发任何出题请求（用假 AI 的请求日志数出来）。
 *   2. **Enter 键全程可用**：填空提交 → 已评分下一题 → 选择题 ↑↓ 换项 + Enter 确认
 *      → 最后 Enter 收尾；而且**不能重复提交**（记录条数要精确）。
 *   另外顺带验「主界面没有独立『做题』入口」与「学习页自动跳回做题」。
 *
 * 用**本地假 AI 服务**（带 CORS）替掉模型，所以出题 / 评分是真的走完的
 * （真 fetch、真解析、真落库），只是产出可复现。
 */
import { createServer } from 'node:http';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findBrowser, launch, openSession, serveStatic } from '../../scripts/cdp.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = 4205;
const CDP_PORT = 9245;
const AI_PORT = 4206;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const AI_BASE = `http://127.0.0.1:${AI_PORT}`;
/** 假 AI 的「思考时间」：留出这段时间，界面上才看得到「正在出题」的进度界面 */
const FAKE_AI_DELAY_MS = 400;

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
 * 假 AI 服务：按提示词内容分辨「出题 / 评分」，并把每次请求记进日志。
 *
 * 为什么要记日志：用户要的是「出题时间全部挪到第一题之前」，
 * 这条要求唯一的客观证据就是「答题过程中没有新的出题请求」。
 * @param port 端口
 */
function startFakeAi(port) {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS, GET',
  };
  /** 请求日志：{ kind, type } */
  const log = [];
  const server = createServer((req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors).end();
      return;
    }
    if (req.url === '/__log') {
      res.writeHead(200, { 'Content-Type': 'application/json', ...cors }).end(JSON.stringify(log));
      return;
    }
    const chunks = [];
    req.on('data',((c) => chunks.push(c)));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      // 题型要从**用户消息**里的【本次题型要求】取：系统提示词里四个题型都列了一遍，
      // 直接在整段 body 上正则会永远匹配到第一个（fill）。
      let userMsg = '';
      try {
        const parsed = JSON.parse(body);
        userMsg = (parsed.messages ?? []).find((m) => m.role === 'user')?.content ?? '';
      } catch {
        userMsg = body;
      }
      const isGrade = /评分标准打分|【学生的答案】/.test(userMsg);
      const isExam = /请为下面这个知识点出一道/.test(userMsg);
      const type = (/【本次题型要求】[\s\S]*?`(fill|choice|judge|sentence)`/.exec(userMsg) ?? [])[1] ?? 'fill';
      let content;
      if (isGrade) {
        log.push({ kind: 'grade', type });
        content = JSON.stringify({ score: 3, reason: '对；Enter 提交生效了。' });
      } else if (isExam) {
        log.push({ kind: 'question', type });
        content =
          type === 'choice'
            ? JSON.stringify({
                question: '选择正确的答案：\nA. where\nB. which\nC. who\nD. when',
                contextWord: '',
                expected: 'A（从句完整，用关系副词 where）',
              })
            : JSON.stringify({ question: 'He ___ (go) to school yesterday.', contextWord: '', expected: 'went' });
      } else {
        log.push({ kind: 'other', type });
        content = JSON.stringify({ cards: [] });
      }
      // 用一点延迟模拟真实模型：界面上的「正在出题」才有机会被看到
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json', ...cors });
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }));
      }, FAKE_AI_DELAY_MS);
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
 * 读假 AI 的请求日志。
 */
async function aiLog() {
  return fetch(`${AI_BASE}/__log`).then((r) => r.json());
}

/** 造数据：1 张卡（fill + choice 两道题）+ 一个走到做题的学习会话 + 配好假 AI */
const SEED = `(async () => {
  const kc = await import('/src/dao/kc.ts');
  const sess = await import('/src/dao/kcSession.ts');
  const settings = await import('/src/dao/settings.ts');
  const model = await import('/src/core/kcModel.ts');
  await kc.clearAll();
  await sess.clearOpen();
  await settings.set({ ai: { baseUrl: '${AI_BASE}', model: 'fake', key: 'fake-key', proxyUrl: '', forceProxy: false } });
  const c = model.createEmptyCard('批量出题卡');
  c.summary = '两道题：填空 + 选择';
  c.status = 'learning';
  c.examTags = ['fill', 'choice'];
  c.examLoad = { types: ['fill', 'choice'], estMinutes: 4 };
  c.blocks = [{ id: 'b1', type: 'text', content: '关系副词作状语' }];
  await kc.bulkUpsert([c]);
  // 做题是学习流程里的一步：得先有「卡片已看完」的会话（用户明确要求没有独立做题入口）
  const s = sess.createSession('study', [c.id]);
  s.selfScores[c.id] = 3;
  await sess.save(s);
  return JSON.stringify({ id: c.id });
})()`;

/** 建一个「学习流程走到做题」的会话（用于验做题续跑） */
const SESSION = `(async () => {
  const kc = await import('/src/dao/kc.ts');
  const sess = await import('/src/dao/kcSession.ts');
  const all = await kc.getAll();
  const s = sess.createSession('study', [all[0].id]);
  s.stage = 'exam';
  s.examIndex = 1;
  s.selfScores[all[0].id] = 3;
  await sess.save(s);
  return JSON.stringify({ id: s.id });
})()`;

const browser = findBrowser();
if (!browser) {
  console.log('\n⚠ 本机没有 Chrome / Edge，跳过做题界面冒烟（数据层已由 test:kc-exam 覆盖）');
  process.exit(0);
}
console.log(`  用 ${browser.split('\\').pop()} 跑无头检查`);

const fakeAi = startFakeAi(AI_PORT);
const server = serveStatic({ root: ROOT, port: PORT, mode: 'dev' });

let chrome = null;
let session = null;
try {
  if (!(await waitForServer(`${AI_BASE}/__log`))) throw new Error('假 AI 服务没起来');
  if (!(await waitForServer(`${ORIGIN}/`))) throw new Error('dev 服务没起来');
  chrome = await launch(browser, CDP_PORT, { windowSize: '1280,900' });
  session = await openSession(CDP_PORT, `${ORIGIN}/#/kc`, { waitMs: 800 });
  for (let i = 0; i < 80; i += 1) {
    if ((await session.evaluate(`document.querySelector('#app .nav') !== null`)) === true) break;
    await new Promise((r) => setTimeout(r, 400));
  }
  check('应用挂载成功', (await session.evaluate(`document.querySelector('#app .nav') !== null`)) === true, '');

  // ── ① 主界面不再有独立「做题」入口 ──
  console.log('\n[1] 主界面：没有独立「做题」入口（用户明确要求删掉）');
  await session.evaluate(SEED);
  await session.evaluate(`location.hash = '#/kc'`);
  await new Promise((r) => setTimeout(r, 400));
  const entries = await session.evaluate(
    `JSON.stringify([...document.querySelectorAll('.kc-home-grid .kc-entry-label')].map((e) => e.textContent))`,
  );
  const labels = JSON.parse(entries);
  check('★ 入口里没有「做题」', !labels.includes('做题'), labels.join(','));
  check('学习 / 复习 / 录入 还在', ['学习', '复习', '录入'].every((x) => labels.includes(x)), labels.join(','));

  // ── ② 进做题：先一口气出完所有题 ──
  console.log('\n[2] 批量出题：第一题出现之前就把所有题出完（用户明确要求）');
  const seen = await session.evaluate(`(async () => {
    location.hash = '#/kc/exam';
    let prepText = '';
    for (let i = 0; i < 100; i += 1) {
      await new Promise((r) => setTimeout(r, 20));
      const el = document.querySelector('.kc-preparing');
      if (el) { prepText = el.textContent; break; }
    }
    for (let i = 0; i < 100; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
      if (document.querySelector('.kc-exam')) break;
    }
    return JSON.stringify({
      prepText,
      hasQuestion: document.querySelector('.kc-exam') !== null,
      progress: document.querySelector('.kc-exam-progress')?.textContent ?? '',
      question: document.querySelector('.kc-exam-question')?.textContent ?? '',
      hasInput: document.querySelector('.kc-answer-input') !== null,
    });
  })()`);
  const sv = JSON.parse(seen);
  check('★ 出现「一口气出完」的出题进度界面', sv.prepText.includes('一口气'), sv.prepText.slice(0, 60));
  check('进度界面写明了「全部出完才开始答题」', sv.prepText.includes('全部出完'), sv.prepText.slice(0, 80));
  check('★ 第一题出来了', sv.hasQuestion === true, '');
  check('进度显示第 1/2 题', sv.progress.includes('1/2'), sv.progress);
  check('第一题是填空（有输入框）', sv.hasInput === true, sv.question);

  const log1 = await aiLog();
  const q1 = log1.filter((x) => x.kind === 'question');
  check('★ 还没开始答题，2 道题就已经全部出好了', q1.length === 2, JSON.stringify(log1));
  check('★ 出题请求里两种题型都出了（fill + choice）', q1.map((x) => x.type).sort().join(',') === 'choice,fill', JSON.stringify(q1));
  check('还没有发过评分请求', log1.filter((x) => x.kind === 'grade').length === 0, JSON.stringify(log1));

  // ── ③ Enter 提交（填空题）──
  console.log('\n[3] Enter 键：填空提交 → 已评分 → 下一题');
  const submitted = await session.evaluate(`(async () => {
    const input = document.querySelector('.kc-answer-input');
    input.value = 'went';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    for (let i = 0; i < 100; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
      if (document.querySelector('.kc-grade')) break;
    }
    return JSON.stringify({
      graded: document.querySelector('.kc-grade') !== null,
      score: document.querySelector('.kc-grade-score')?.textContent ?? '',
      records: null,
    });
  })()`);
  const sb = JSON.parse(submitted);
  check('★ 填空题里按 Enter 直接提交并评分', sb.graded === true, JSON.stringify(sb));
  check('评分显示 3/3', sb.score === '3/3', sb.score);

  // Enter 走「下一题」：焦点掉在 body 上（答题卡整块重画后就是这样）
  const second = await session.evaluate(`(async () => {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    for (let i = 0; i < 60; i += 1) {
      await new Promise((r) => setTimeout(r, 50));
      if (document.querySelector('.kc-options')) break;
    }
    return JSON.stringify({
      progress: document.querySelector('.kc-exam-progress')?.textContent ?? '',
      hasOptions: document.querySelector('.kc-options') !== null,
      active: document.querySelector('.kc-option-btn--active')?.textContent ?? '',
      optionCount: document.querySelectorAll('.kc-option-btn').length,
    });
  })()`);
  const nd = JSON.parse(second);
  check('★ 评分后按 Enter 直接进下一题（不用去点「继续」）', nd.progress.includes('2/2'), nd.progress);
  check('第二题是选择题（渲染出 4 个选项）', nd.hasOptions === true && nd.optionCount === 4, String(nd.optionCount));
  check('★ 默认高亮第 1 项（什么键都不按也能直接 Enter 作答）', nd.active.startsWith('A.'), nd.active);

  const log2 = await aiLog();
  check(
    '★★ 第二题没有再发出题请求（题目是提前出好的，答题过程中零等待）',
    log2.filter((x) => x.kind === 'question').length === 2,
    JSON.stringify(log2),
  );

  // ── ④ 选择题：↑↓ 换项 + Enter 确认 ──
  console.log('\n[4] Enter 键：选择题 ↑↓ 换项 + Enter 确认');
  const picked = await session.evaluate(`(async () => {
    const btns = [...document.querySelectorAll('.kc-option-btn')];
    btns[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 60));
    const afterArrow = document.querySelector('.kc-option-btn--active')?.textContent ?? '';
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    for (let i = 0; i < 100; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
      if (document.querySelector('.kc-grade')) break;
    }
    const bank = await import('/src/dao/examBank.ts');
    const records = await bank.listRecords();
    return JSON.stringify({
      afterArrow,
      activeNow: document.querySelector('.kc-option-btn--active') !== null,
      graded: document.querySelector('.kc-grade') !== null,
      answers: records.map((r) => r.userAnswer),
      count: records.length,
    });
  })()`);
  const pk = JSON.parse(picked);
  check('★ ↓ 把高亮移到第 2 项', pk.afterArrow.startsWith('B.'), pk.afterArrow);
  check('★ Enter 确认提交了高亮那一项（答案是 B）', pk.graded === true && pk.answers.includes('B'), JSON.stringify(pk.answers));
  check('★ 没有重复提交（两道题只落两条记录）', pk.count === 2, String(pk.count));

  // ── ⑤ Enter 收尾 ──
  console.log('\n[5] Enter 键：做完后 Enter 收尾');
  const finished = await session.evaluate(`(async () => {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    for (let i = 0; i < 100; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
      if (document.querySelector('.kc-finished')) break;
    }
    const sess = await import('/src/dao/kcSession.ts');
    const kc = await import('/src/dao/kc.ts');
    const card = (await kc.getAll())[0];
    return JSON.stringify({
      done: document.querySelector('.kc-finished') !== null,
      openLeft: (await sess.loadLatestOpen()) !== null,
      status: card.status,
      mastery: card.attrs.mastery,
    });
  })()`);
  const fn = JSON.parse(finished);
  check('★ 最后一题按 Enter 直接收尾（到「做完了」）', fn.done === true, JSON.stringify(fn));
  check('会话已清掉（不会再被续跑捞回来）', fn.openLeft === false, '');
  check('卡片状态变成 learned', fn.status === 'learned', fn.status);

  // ── ⑥ 学习页自动跳回做题（做题中途退出后的恢复路径）──
  console.log('\n[6] 做题中途退出 → 再点「学习」自动回到那道题');
  await session.evaluate(SESSION);
  const back = await session.evaluate(`(async () => {
    location.hash = '#/kc';
    await new Promise((r) => setTimeout(r, 300));
    location.hash = '#/kc/study';
    let dialog = '';
    let hash = '';
    for (let i = 0; i < 80; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
      dialog = document.querySelector('.modal-title')?.textContent ?? '';
      hash = location.hash;
      if (hash.startsWith('#/kc/exam') && document.querySelector('.kc-exam-page')) break;
    }
    return JSON.stringify({ dialog, hash, progress: document.querySelector('.kc-exam-progress')?.textContent ?? '' });
  })()`);
  const bk = JSON.parse(back);
  check('★ 点「学习」直接跳到做题页', bk.hash.startsWith('#/kc/exam'), bk.hash);
  check('★ 没有再弹「继续上次 / 重新开始」', bk.dialog === '', bk.dialog);
  check('★ 回到的是刚才那道题（第 2/2 题）', bk.progress.includes('2/2'), bk.progress);

  // ── 清场 ──
  await session.evaluate(`(async () => {
    const kc = await import('/src/dao/kc.ts');
    const sess = await import('/src/dao/kcSession.ts');
    const bank = await import('/src/dao/examBank.ts');
    await kc.clearAll(); await sess.clearOpen(); await bank.clearAll();
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

console.log(`\n=== 做题流程界面冒烟（批量出题 / Enter 全程可用）：通过 ${passed} 项，失败 ${failed} 项 ===\n`);
process.exit(failed === 0 ? 0 : 1);
