/**
 * 预设词库的**界面**冒烟测试：`npm run test:presets-ui`（需要本机有 Chrome / Edge）
 *
 * 为什么需要它：`test-presets.mjs` 只校验数据文件和源码文本，
 * 但「点一下按钮真的能导入」这件事它验不到——模块路径写错、BASE_URL 拼错、
 * Service Worker 拦了请求、预设没被打进 dist……这些都是**构建产物层面**的问题，
 * 跑一遍真浏览器才暴露，和项目里「本地测不出、只有线上才炸」那两条教训同一类。
 *
 * 做法：起 vite preview 服务 dist → 无头浏览器打开 #/import → 检查
 *   1. 五个预设按钮真的渲染出来了（带正确的词数）；
 *   2. 直接请求 /presets/<id>.json 能拿到且格式正确。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findBrowser, launch, openSession, renderedHtml, serveStatic } from '../../scripts/cdp.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = 4178;
const CDP_PORT = 9222;
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
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

// —— 前置：必须已经构建过 ——
console.log('\n[0] 前置检查');
if (!existsSync(join(ROOT, 'dist', 'index.html'))) {
  console.error('✗ 没有 dist/，先跑 npm run build');
  process.exit(1);
}
check('dist/index.html 存在', true);
const distPresets = ['junior', 'cet4', 'cet6', 'kaoyan', 'ielts'].filter((id) =>
  existsSync(join(ROOT, 'dist', 'presets', `${id}.json`)),
);
check('五档预设都被复制进了 dist/presets/', distPresets.length === 5, `只有 ${distPresets.join(',')}`);

const browser = findBrowser();
if (!browser) {
  console.log('\n⚠ 本机没有 Chrome / Edge，跳过界面冒烟（数据层已由 test:presets 覆盖）');
  console.log(`\n预设界面冒烟：${passed} 项通过，${failed} 项失败`);
  process.exit(failed > 0 ? 1 : 0);
}
console.log(`  用 ${browser.split('\\').pop()} 跑无头检查`);

// —— 起预览服务 + 无头浏览器 ——
const server = serveStatic({ root: ROOT, port: PORT, mode: 'preview' });

let exitCode = 0;
let chrome = null;
try {
  const up = await waitForServer(`${ORIGIN}/`);
  if (!up) throw new Error(`预览服务没起来（${ORIGIN}）`);
  chrome = await launch(browser, CDP_PORT);

  // —— [1] 预设 JSON 能取到 ——
  console.log('\n[1] 预设文件能被真实取到');
  for (const id of ['junior', 'cet4', 'cet6', 'kaoyan', 'ielts']) {
    const res = await fetch(`${ORIGIN}/presets/${id}.json`);
    check(`GET /presets/${id}.json 返回 200`, res.ok, `HTTP ${res.status}`);
    if (!res.ok) continue;
    const data = await res.json();
    check(`  ${id} 内容是合法结构`, Array.isArray(data.entries) && data.entries.length > 0, `entries=${data.entries?.length}`);
  }

  // —— [2] 录入页真的渲染出预设按钮 ——
  console.log('\n[2] 录入页渲染出预设按钮');
  const html = await renderedHtml(CDP_PORT, `${ORIGIN}/#/import`);
  // 从 src/core/presets.ts 读期望值，避免把词数写死在两处
  const manifest = readFileSync(join(ROOT, 'src', 'core', 'presets.ts'), 'utf8');
  const tiers = [...manifest.matchAll(/id: '([a-z0-9]+)',[\s\S]*?label: '([^']+)',[\s\S]*?count: (\d+)/g)].map((m) => ({
    id: m[1],
    label: m[2],
    count: Number(m[3]),
  }));
  check('从清单里解析出 5 个档位', tiers.length === 5, `解析到 ${tiers.length} 个`);

  check('页面出现了「预设词库」区块', html.includes('预设词库'));
  for (const t of tiers) {
    check(`渲染出「${t.label}（${t.count} 词）」按钮`, html.includes(`${t.label}（${t.count} 词）`), 'DOM 里找不到这个按钮');
  }
  // 页面确实渲染成功了（没有掉进错误边界）
  check('页面没有掉进错误边界', !html.includes('页面渲染失败'), 'DOM 里有「页面渲染失败」');
  check('录入页标题在', html.includes('录入单词'));
  // 改名后品牌名应该是新的。
  // 旧名用拼接得到，否则这个文件会被 test-rename.mjs 的「旧名绝迹」扫描搜出来（自指）。
  const oldBrand = `${'单词'}${'白纸'}`;
  check('页面品牌名已改为「白纸单词」', html.includes('白纸单词') && !html.includes(oldBrand), '还残留旧名');

  // —— [2b] 录入页**四个分区都要在**（★ 这条是被真事故逼出来的） ——
  // 加预设区块时我改动了 InputPanel 的挂载顺序，把 `wrap.appendChild(sourceBox)`
  // 当成重复行删掉了，于是「1. 来源」整个区块**没挂上 DOM**：
  // 界面看起来正常（其它区块都在），测试也全绿——因为当时的断言只查了预设相关内容。
  // 所以这里按「区块清单」整体验一遍，而不是只验我新加的那块。
  console.log('\n[2b] 录入页四个分区都在（防止漏挂区块）');
  const sectionState = await (async () => {
    const s = await openSession(CDP_PORT, `${ORIGIN}/#/import`);
    try {
      return await s.evaluate(`(() => ({
        cardTitles: [...document.querySelectorAll('.card-title')].map((e) => e.textContent.trim()),
        hasSourceName: [...document.querySelectorAll('.field-label')].some((e) => e.textContent.includes('来源名称')),
        hasPriority: [...document.querySelectorAll('.field-label')].some((e) => e.textContent.includes('优先级')),
        hasTextarea: document.querySelectorAll('textarea').length > 0,
        hasStartBtn: [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === '开始解析'),
      }))()`);
    } finally {
      await s.close();
    }
  })();

  for (const title of ['0. 预设词库', '1. 来源', '2. 输入单词文本']) {
    check(
      `分区「${title}」挂在页面上`,
      sectionState.cardTitles.some((t) => t.startsWith(title)),
      `实际分区：${sectionState.cardTitles.join(' | ')}`,
    );
  }
  check('「来源名称」输入框在', sectionState.hasSourceName);
  check('「优先级」输入框在', sectionState.hasPriority);
  check('粘贴用的文本域在', sectionState.hasTextarea);
  check('「开始解析」按钮在', sectionState.hasStartBtn);

  // —— [3] 真点一下预设按钮，走完整条链路 ——
  // 这一步才是这个文件存在的理由：验证「点击 → 下载预设 → 词表进文本栏 → 解析 → 入库」真的通。
  // 注意（R3 改动）：点预设**不再弹确认框**，而是把词表直接填进文本栏。
  //   这里用「规则解析（离线）」跑完整链路——预设的词表本身带义项，
  //   规则解析能直接切词，不需要联网、不需要 AI 密钥，CI 里最稳。
  console.log('\n[3] 点「考研」→ 词表进文本栏 → 解析 → 入库');
  const session = await openSession(CDP_PORT, `${ORIGIN}/#/import`);
  try {
    const clicked = await session.evaluate(`(() => {
      const btns = [...document.querySelectorAll('button')];
      const target = btns.find((b) => b.textContent.trim().startsWith('考研（'));
      if (!target) return { ok: false, buttons: btns.map((b) => b.textContent.trim()).slice(0, 20) };
      target.click();
      return { ok: true, label: target.textContent.trim() };
    })()`);
    check('页面上找得到「考研」预设按钮并点到了', clicked.ok === true, JSON.stringify(clicked.buttons ?? clicked));

    // —— [3a] 词表进了**本来就有的那个**文本栏，没有弹窗 ——
    await new Promise((r) => setTimeout(r, 2500));
    const filled = await session.evaluate(`(() => {
      const ta = document.querySelector('textarea');
      const lines = (ta?.value ?? '').split('\\n').filter((l) => l.trim() !== '');
      return {
        hasModal: !!document.querySelector('.modal'),
        textareas: document.querySelectorAll('textarea').length,
        lines: lines.length,
        first: lines[0] ?? '',
        // 共享的那个 textarea 在「粘贴文本」页签里，所以直接看它是不是可见的
        textareaVisible: (() => { const r = document.querySelector('textarea')?.getBoundingClientRect(); return !!r && r.width > 0 && r.height > 0; })(),
        sourceName: document.querySelector('input[type=text]')?.value ?? '',
        priorityChecked: [...document.querySelectorAll('.seg-item input[type=radio]')].filter((r) => r.checked).map((r) => r.value),
      };
    })()`);
    check('点预设**不再弹任何确认框**', filled.hasModal === false, JSON.stringify(filled));
    check('页面上仍然只有一个文本栏（没有新造一个）', filled.textareas === 1, `textareas=${filled.textareas}`);
    check('词表被填进了那个文本栏（295 行）', filled.lines === 295, `lines=${filled.lines}`);
    check('每行是「英文 + Tab + 义项」的格式', filled.first.includes('\t'), JSON.stringify(filled.first.slice(0, 60)));
    check('自动切到了「粘贴文本」页签（文本栏可见）', filled.textareaVisible === true, JSON.stringify(filled));
    check('来源名被带出来了（考研词汇）', filled.sourceName === '考研词汇', filled.sourceName);
    check('优先级带出了该档位的默认值（考研 = 4）', filled.priorityChecked.join(',') === '4', JSON.stringify(filled.priorityChecked));

    // —— [3b] 选「规则解析（离线）」并点「开始解析」 ——
    const started = await session.evaluate(`(() => {
      const radios = [...document.querySelectorAll('input[type=radio]')];
      const rule = radios.find((r) => r.name === 'parsemode' && r.parentElement.textContent.includes('规则解析'));
      if (rule) { rule.checked = true; rule.dispatchEvent(new Event('change', { bubbles: true })); }
      const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '开始解析');
      if (!btn) return { ok: false, why: '没有开始解析按钮' };
      btn.click();
      return { ok: true };
    })()`);
    check('能切到规则解析并点「开始解析」', started.ok === true, JSON.stringify(started));

    let reachedMerge = false;
    for (let i = 0; i < 120; i += 1) {
      await new Promise((r) => setTimeout(r, 250));
      const hash = await session.evaluate('window.location.hash');
      if (hash.includes('/merge')) {
        reachedMerge = true;
        break;
      }
    }
    check('解析完跳到了合并确认页', reachedMerge, await session.evaluate('window.location.hash'));

    if (reachedMerge) {
      const mergeState = await session.evaluate(`(() => ({
        hash: window.location.hash,
        stat: document.querySelector('.merge-stat')?.textContent ?? '',
        cards: document.querySelectorAll('details.merge-card').length,
        firstCards: [...document.querySelectorAll('details.merge-card summary')].slice(0, 3).map((s) => s.textContent.trim()),
        commitLabel: [...document.querySelectorAll('button')].map((b) => b.textContent.trim()).find((t) => t.startsWith('确认入库')) ?? '',
      }))()`);
      check('合并页统计里写着 295 个词', mergeState.stat.includes('295 个词'), mergeState.stat);
      check('合并页真的渲染出了卡片', mergeState.cards > 0, `cards=${mergeState.cards}`);
      check('卡片数与词数一致', mergeState.cards === 295, `cards=${mergeState.cards}`);
      check('卡片上显示的是词条英文', mergeState.firstCards.every((t) => /^[A-Za-z]/.test(t)), JSON.stringify(mergeState.firstCards));
      check('底部按钮显示「确认入库（295 词）」', mergeState.commitLabel.includes('295'), mergeState.commitLabel);
    }

    // —— [4] 真确认入库，落到 IndexedDB ——
    if (reachedMerge) {
      console.log('\n[4] 点「确认入库」，验证真的写进了 IndexedDB');
      const committed = await session.evaluate(`(() => {
        const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim().startsWith('确认入库'));
        if (!btn) return false;
        btn.click();
        return true;
      })()`);
      check('找得到并点到了「确认入库」', committed);

      let stored = null;
      for (let i = 0; i < 80; i += 1) {
        await new Promise((r) => setTimeout(r, 300));
        stored = await session.evaluate(`(async () => {
          const hash = window.location.hash;
          const req = indexedDB.open('blank-sheet-vocab');
          const db = await new Promise((res, rej) => {
            req.onsuccess = () => res(req.result);
            req.onerror = () => rej(req.error);
          });
          const readAll = (store) => new Promise((res, rej) => {
            const t = db.transaction(store, 'readonly');
            const r = t.objectStore(store).getAll();
            r.onsuccess = () => res(r.result);
            r.onerror = () => rej(r.error);
          });
          const words = await readAll('words');
          const sources = await readAll('sources');
          return {
            hash,
            words: words.length,
            sources: sources.map((s) => s.name),
            priorities: words.slice(0, 5).map((w) => w.priority),
            sample: words.slice(0, 3).map((w) => w.en + '|' + (w.senses?.[0]?.text ?? '')),
          };
        })()`);
        if (stored && stored.words === 295) break;
      }

      check('IndexedDB 里真的写进了 295 个词', stored?.words === 295, JSON.stringify(stored));
      check('来源按名字建了出来（考研词汇）', (stored?.sources ?? []).includes('考研词汇'), JSON.stringify(stored?.sources));
      check(
        '★ 文本栏旁边选的那个优先级真的落到了每个词上（4）',
        (stored?.priorities ?? []).length > 0 && stored.priorities.every((p) => p === 4),
        JSON.stringify(stored?.priorities),
      );
      check('词条带着义项一起入库', (stored?.sample ?? []).every((x) => x.includes('|') && x.split('|')[1].length > 0), JSON.stringify(stored?.sample));
      check('入库后跳到了列表页', (stored?.hash ?? '').includes('/list'), stored?.hash);

      // —— [5] 列表页：批量编辑不设数量上限 + 清空全部单词按钮 ——
      console.log('\n[5] 列表页：跨页全选与清空按钮');
      const listState = await session.evaluate(`(() => {
        const btns = [...document.querySelectorAll('button')].map((b) => b.textContent.trim());
        return {
          title: document.querySelector('.page-title')?.textContent ?? '',
          hasClearAll: btns.some((t) => t === '清空全部单词'),
          hasSelectAllHead: !!document.querySelector('.list-table thead input[type=checkbox]'),
          stats: document.querySelector('.stats-bar')?.textContent ?? '',
        };
      })()`);
      check('在列表页', listState.title.includes('单词列表'), listState.title);
      check('有「清空全部单词」按钮', listState.hasClearAll, JSON.stringify(listState));
      check('表头有全选框', listState.hasSelectAllHead);
      check('统计条显示总词数 295', listState.stats.includes('295'), listState.stats);

      await session.evaluate(`(() => {
        const box = document.querySelector('.list-table thead input[type=checkbox]');
        if (box) { box.checked = true; box.dispatchEvent(new Event('change', { bubbles: true })); }
      })()`);
      await new Promise((r) => setTimeout(r, 800));
      const batchState = await session.evaluate(`(() => {
        const bar = document.querySelector('.batch-bar');
        return {
          count: bar?.querySelector('.batch-count')?.textContent ?? '',
          buttons: [...(bar?.querySelectorAll('button') ?? [])].map((b) => b.textContent.trim()),
        };
      })()`);
      check('表头全选选中了全部 295 个（跨页，不是只选当前页）', batchState.count.includes('295'), batchState.count);
      check('批量条出现了「批量设为未背」', batchState.buttons.includes('批量设为未背'), JSON.stringify(batchState.buttons));

      await session.evaluate(`(() => {
        const b = [...document.querySelectorAll('.batch-bar button')].find((x) => x.textContent.trim() === '批量设为未背');
        if (b) b.click();
      })()`);
      await new Promise((r) => setTimeout(r, 1500));
      const afterBatch = await session.evaluate(`(async () => {
        const req = indexedDB.open('blank-sheet-vocab');
        const db = await new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
        const words = await new Promise((res, rej) => {
          const r = db.transaction('words', 'readonly').objectStore('words').getAll();
          r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
        });
        return { total: words.length, unlearned: words.filter((w) => w.status === 'unlearned').length };
      })()`);
      check('批量操作作用到了全部 295 个词', afterBatch.unlearned === 295, JSON.stringify(afterBatch));
      // —— [6] 清空全部单词（破坏性操作，要验「防误触」和「真的清干净」） ——
      console.log('\n[6] 清空全部单词');
      await session.evaluate(`(() => {
        const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '清空全部单词');
        if (b) b.click();
      })()`);
      await new Promise((r) => setTimeout(r, 500));

      // 6a. 必须先弹确认框，且要求输入「删除」
      const clearModal = await session.evaluate(`(() => {
        const m = document.querySelector('.modal');
        return m ? { title: m.querySelector('.modal-title')?.textContent ?? '', text: m.querySelector('.modal-body')?.textContent ?? '' } : null;
      })()`);
      check('点「清空全部单词」先弹确认框', clearModal !== null);
      check('确认框要求输入「删除」', (clearModal?.text ?? '').includes('删除'), (clearModal?.text ?? '').slice(0, 80));

      // 6b. 先输错一次，必须**不能**清掉任何东西（这是防误触的关键）
      await session.evaluate(`(() => {
        const m = document.querySelector('.modal');
        const input = m.querySelector('input[type=text]');
        input.value = '删';
        const ok = [...m.querySelectorAll('button')].find((b) => b.textContent.trim() === '确定');
        if (ok) ok.click();
      })()`);
      await new Promise((r) => setTimeout(r, 800));
      const afterWrong = await session.evaluate(`(async () => {
        const req = indexedDB.open('blank-sheet-vocab');
        const db = await new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
        return await new Promise((res, rej) => {
          const r = db.transaction('words', 'readonly').objectStore('words').count();
          r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
        });
      })()`);
      check('输入不正确时一个词都没删（防误触生效）', afterWrong === 295, `words=${afterWrong}`);

      // 6c. 输对「删除」，这次应该真的清空
      await session.evaluate(`(() => {
        const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '清空全部单词');
        if (b) b.click();
      })()`);
      await new Promise((r) => setTimeout(r, 400));
      await session.evaluate(`(() => {
        const m = document.querySelector('.modal');
        const input = m.querySelector('input[type=text]');
        input.value = '删除';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        const ok = [...m.querySelectorAll('button')].find((b) => b.textContent.trim() === '确定');
        if (ok) ok.click();
      })()`);
      await new Promise((r) => setTimeout(r, 1500));

      const afterClear = await session.evaluate(`(async () => {
        const req = indexedDB.open('blank-sheet-vocab');
        const db = await new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
        const readAll = (st) => new Promise((res, rej) => {
          const r = db.transaction(st, 'readonly').objectStore(st).getAll();
          r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
        });
        const words = await readAll('words');
        const sources = await readAll('sources');
        return {
          words: words.length,
          sources: sources.map((s) => s.name),
          statText: document.querySelector('.stats-bar')?.textContent ?? '',
        };
      })()`);
      check('单词真的全清掉了', afterClear.words === 0, `words=${afterClear.words}`);
      // 来源要保留：优先级是用户特意设的，清词时一起清掉等于白设
      // 来源要保留：来源是分组标签，清词时一起清掉等于白建一遍
      check('来源保留下来了（考研词汇）', (afterClear.sources ?? []).includes('考研词汇'), JSON.stringify(afterClear.sources));
      check('界面统计跟着归零', afterClear.statText.includes('0'), afterClear.statText.slice(0, 60));
    }
  } finally {
    await session.close();
  }
} catch (err) {
  console.error(`\n✗ ${err instanceof Error ? err.message : String(err)}`);
  exitCode = 1;
} finally {
  chrome?.proc.kill();
  server.kill();
}

console.log(`\n预设界面冒烟：${passed} 项通过，${failed} 项失败`);
if (failed > 0) exitCode = 1;
process.exit(exitCode);
