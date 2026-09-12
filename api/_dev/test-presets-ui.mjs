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

  // —— [3] 真点一下按钮，走完整条链路 ——
  // 这一步才是这个文件存在的理由：验证「点击 → 下载预设 → 建来源 → 进合并页」真的通。
  // 前面的 [1][2] 只证明「文件在」和「按钮画出来了」，证明不了接线是对的。
  console.log('\n[3] 点击预设按钮，走完整条导入链路');
  const session = await openSession(CDP_PORT, `${ORIGIN}/#/import`);
  try {
    // 找一个预设按钮并点它。用 textContent 匹配，避免依赖 DOM 结构。
    const clicked = await session.evaluate(`(() => {
      const btns = [...document.querySelectorAll('button')];
      const target = btns.find((b) => b.textContent.trim().startsWith('考研（'));
      if (!target) return { ok: false, buttons: btns.map((b) => b.textContent.trim()).slice(0, 20) };
      target.click();
      return { ok: true, label: target.textContent.trim() };
    })()`);
    check('页面上找得到「考研」预设按钮并点到了', clicked.ok === true, JSON.stringify(clicked.buttons ?? clicked));

    // 等它下载 + 建来源 + 跳转（考研最小，只有 295 词，够验证链路）
    let reachedMerge = false;
    for (let i = 0; i < 40; i += 1) {
      await new Promise((r) => setTimeout(r, 250));
      const hash = await session.evaluate('window.location.hash');
      if (hash.includes('/merge')) {
        reachedMerge = true;
        break;
      }
    }
    check('点完按钮自动跳到了合并确认页', reachedMerge);

    if (reachedMerge) {
      // 合并页必须真的把 295 个词渲染成卡片，并显示正确的统计
      const mergeState = await session.evaluate(`(() => ({
        hash: window.location.hash,
        stat: document.querySelector('.note')?.textContent ?? '',
        cards: document.querySelectorAll('details.merge-card').length,
        firstCards: [...document.querySelectorAll('details.merge-card summary')].slice(0, 3).map((s) => s.textContent.trim()),
        commitLabel: [...document.querySelectorAll('button')].map((b) => b.textContent.trim()).find((t) => t.startsWith('确认入库')) ?? '',
      }))()`);

      check('合并页统计里写着 295 个词', mergeState.stat.includes('295 个词'), mergeState.stat);
      check('合并页真的渲染出了卡片', mergeState.cards > 0, `cards=${mergeState.cards}`);
      // 每张卡片是 details.merge-card，但有可能是筛选后的数量；只要等于总数即可
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

      // 等入库完成（会跳转到列表页），然后直接开 IndexedDB 数一遍
      let stored = null;
      for (let i = 0; i < 60; i += 1) {
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
            sources: sources.map((s) => s.name + '/' + s.priority),
            sample: words.slice(0, 3).map((w) => w.en + '|' + (w.senses?.[0]?.text ?? '')),
            hashCount: words.filter((w) => w.uniqueHash !== undefined).length,
          };
        })()`);
        if (stored && stored.words === 295) break;
      }

      check('IndexedDB 里真的写进了 295 个词', stored?.words === 295, JSON.stringify(stored));
      check('建出了「考研词汇」来源（优先级 4）', (stored?.sources ?? []).includes('考研词汇/4'), JSON.stringify(stored?.sources));
      check('词条带着义项一起入库', (stored?.sample ?? []).every((s) => s.includes('|') && s.split('|')[1].length > 0), JSON.stringify(stored?.sample));
      check('入库后跳到了列表页', (stored?.hash ?? '').includes('/list'), stored?.hash);
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
