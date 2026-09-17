/**
 * S3 验收：桌面端布局回归修复 + 手动列数覆盖（界面端到端）：`npm run test:s3-ui`
 *
 * 为什么必须有这一层：
 *   `npm run test:mobile` 只跑 Node 里的纯函数（算得快、但没有真实 DOM），
 *   而 S3 要证的恰恰是「**屏幕上**真的是几列」——
 *   旧 bug 的表现就是「电脑上单词像手机一样只排成两列」，这只有真浏览器能证明。
 *
 * 本脚本做两件事：
 *   [1] 用 `probeLayout.mjs` 跑 S3 要求的四个场景 + 手动覆盖场景（逐个贴断言）
 *   [2] 用 CDP 打**真实背诵页**，验界面层：
 *       - 手机上词数 15~18、列数 ≥3（M2 的成果不许被搞坏）
 *       - 桌面 1280×800 列数 ≥5、大屏 ≥6、平板 ≥4（修好的回归）
 *       - 均匀散布：词在纵向铺开 ≥50% 纸高（不许全挤在顶部）
 *       - 背诵页 32×32 的 ⊞ 快捷入口：能点、弹选择条、选 6 列后**立刻重排**且**记住**
 *       - 桌面端按钮仍是右下角竖排（不被本次改动误伤）
 *
 * 前置：本机有 Chrome / Edge（脚本自己起 vite dev，无需手动开服务器）。
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findBrowser, launch, openSession } from '../../scripts/cdp.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = 4219;
const CDP_PORT = 9373;
const ORIGIN = `http://127.0.0.1:${PORT}`;

let passed = 0;
let failed = 0;

/**
 * 一条断言。
 * @param {string} name 用例名
 * @param {boolean} ok 是否通过
 * @param {string} [detail] 失败时的具体数值
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

/** 等 dev server 起来 */
async function waitForServer(url) {
  for (let i = 0; i < 80; i += 1) {
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
 * 跑一次 probeLayout.mjs（S3 的机器验收口径）。
 * @param {string} label 场景名
 * @param {string[]} args 额外参数
 * @returns {{ok: boolean, summary: string, columns: number|null, words: number|null}}
 */
function runProbe(label, args) {
  console.log(`\n  ── 场景：${label} ──`);
  let out = '';
  let code = 0;
  try {
    out = execFileSync(process.execPath, ['probeLayout.mjs', '--url', ORIGIN, ...args], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (e) {
    code = typeof e.status === 'number' ? e.status : 1;
    out = e.stdout ?? '';
  }
  const lines = out.split(/\r?\n/);
  const keep = lines.filter((l) => /^(grid|columns\/rows|wordCount|散布|✓|✗|结果)/.test(l.trim()));
  for (const l of keep) console.log(`     ${l.trim()}`);
  const cols = Number((out.match(/columns\/rows\s*:\s*(\d+)/) ?? [])[1] ?? NaN);
  const words = Number((out.match(/wordCount\s*:\s*(\d+)/) ?? [])[1] ?? NaN);
  const summary = (out.match(/结果：.*/) ?? ['（没有结果行）'])[0].trim();
  return { ok: code === 0, summary, columns: Number.isFinite(cols) ? cols : null, words: Number.isFinite(words) ? words : null };
}

/** 清空词库并写入测试词 + 一条「N 个词已上纸」的会话存档（复现用户打开背诵页的那一屏） */
function seedExpr(words, shownCount) {
  return `(() => new Promise((resolve) => {
    const seeds = ${JSON.stringify(words)};
    const shownCount = ${shownCount};
    const req = indexedDB.open('blank-sheet-vocab');
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction(['words', 'sources', 'sessions'], 'readwrite');
      const store = tx.objectStore('words');
      store.clear();
      tx.objectStore('sources').clear();
      tx.objectStore('sessions').clear();
      tx.objectStore('sources').put({ id: 'src-s3', name: 'S3 验收来源', priority: 3, createdAt: 1, updatedAt: 1, deleted: 0 });
      seeds.forEach((en, i) => {
        store.put({
          id: 'w-' + en, en, phonetic: '', example: '',
          senses: [{ id: 's-' + en + '-' + i, text: '释义' + (i + 1), aliases: [], enabled: true }],
          sourceId: 'src-s3', rawSources: [],
          attrs: { needSpell: false, failCount: 0, failCountTotal: 0, reviewCount: 0, lastReviewAt: null, learnedAt: null, reviewPriority: 0 },
          status: 'unlearned', priority: 3, learnOrder: null, createdAt: 1000 + i, updatedAt: 1, deleted: 0,
        });
      });
      const ids = seeds.map((en) => 'w-' + en);
      tx.objectStore('sessions').put({
        id: 'current', type: 'learn', wordIds: ids, placements: {},
        shownIds: ids.slice(0, shownCount), memorizeCount: {}, failedIds: [], failDeltas: {},
        lastRoundFailedIds: [], spellEnabled: false, groupId: 0, finished: false, createdAt: Date.now(),
      });
      tx.oncomplete = () => resolve(seeds.length);
    };
  }))()`;
}

/** 真实背诵页要用的词（含长词，复现「一个长词把列数夹死」的最坏情况） */
const WORDS = [
  'apple', 'river', 'orange', 'silent', 'garden', 'observe', 'grateful', 'bicycle',
  'mountain', 'discover', 'practice', 'mystery', 'language', 'umbrella', 'festival', 'cultivate',
  'photosynthesis', 'infrastructure', 'responsibility', 'pronunciation',
];

// ══════════════════════════════════════════ 主流程
console.log('\n=== S3 验收：桌面端列数回归 + 手动列数覆盖 ===\n');

const browser = findBrowser();
if (!browser) {
  console.error('✗ 找不到 Chrome / Edge，无法跑界面验收');
  process.exit(1);
}

const vite = spawn(
  process.execPath,
  [join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'dev', '--port', String(PORT), '--strictPort'],
  { cwd: ROOT, stdio: 'ignore' },
);
let chrome = null;

try {
  if (!(await waitForServer(`${ORIGIN}/`))) throw new Error(`dev server 没起来（${ORIGIN}）`);

  // ───────────────────────── [1] 四个场景 + 手动覆盖（探针口径）
  console.log('[1] 探针：四个场景 + 手动列数覆盖');
  const scenarios = [
    {
      label: '手机 390×844（preset balanced ≈ 适中档）',
      args: ['--viewport', '390x844', '--window-height', '939', '--page-args', 'dvw=390&dvh=844&tier=mobile', '--count-min', '15', '--count-max', '18', '--min-columns', '3'],
      minColumns: 3,
    },
    {
      label: '平板 820×1180',
      args: ['--viewport', '820x1180', '--window-height', '1275', '--page-args', 'dvw=820&dvh=1180&tier=tablet', '--count-min', '10', '--count-max', '40', '--min-columns', '4'],
      minColumns: 4,
    },
    {
      label: '桌面 1280×800',
      args: ['--viewport', '1280x800', '--window-height', '895', '--page-args', 'dvw=1280&dvh=800&tier=desktop', '--count-min', '10', '--count-max', '40', '--min-columns', '5'],
      minColumns: 5,
    },
    {
      label: '大屏 1920×1080',
      args: ['--viewport', '1920x1080', '--window-height', '1175', '--page-args', 'dvw=1920&dvh=1080&tier=desktop', '--count-min', '10', '--count-max', '40', '--min-columns', '6'],
      minColumns: 6,
    },
  ];
  const results = [];
  for (const sc of scenarios) {
    const r = runProbe(sc.label, sc.args);
    results.push({ ...sc, ...r });
    check(`${sc.label}：探针全绿（columns ≥ ${sc.minColumns}）`, r.ok && (r.columns ?? 0) >= sc.minColumns, `${r.summary}，columns=${r.columns}`);
  }
  const override = runProbe('桌面 1280×800 + 手动 6 列', [
    '--viewport', '1280x800', '--window-height', '895', '--page-args', 'dvw=1280&dvh=800&tier=desktop',
    '--count-min', '10', '--count-max', '40', '--min-columns', '6', '--cols-override', '6',
  ]);
  check('手动列数覆盖生效（网格 6 列，且 DOM 落点都在 6 列内）', override.ok, override.summary);

  // ───────────────────────── [2] 真实背诵页（界面层）
  chrome = await launch(browser, CDP_PORT, { windowSize: '1280,900' });

  /**
   * 打开真实背诵页并放 16 个词上纸。
   * @param {number} w 视口宽
   * @param {number} h 视口高
   */
  async function openLearn(w, h) {
    const s = await openSession(CDP_PORT, `${ORIGIN}/#/home`, { waitMs: 1500 });
    await s.goto(`${ORIGIN}/#/home`, 1200);
    await s.evaluate(seedExpr(WORDS, 16));
    await s.setViewport(w, h);
    await s.goto(`${ORIGIN}/#/learn`, 2500);
    await s.evaluate('window.dispatchEvent(new Event("resize"))');
    await new Promise((r) => setTimeout(r, 900));
    return s;
  }

  console.log('\n[2] 真实背诵页（桌面 1280×800）');
  const desk = await openLearn(1280, 800);
  try {
    const r = await desk.evaluate('window.__layoutProbe()');
    if (r.wordCount === 0) {
      // 自查：纸上一个词都没有时，把页面上的文字打出来，省得下次还要猜
      const text = await desk.evaluate('document.body.innerText.slice(0, 300)');
      console.log(`     ! 页面上没有词，正文前 300 字：${JSON.stringify(text)}`);
    }
    check('桌面上有 16 个词', r.wordCount === 16, `wordCount=${r.wordCount}`);
    check('★ 桌面列数 ≥ 5（不再是「像手机一样两列」）', r.columns >= 5, `columns=${r.columns}`);
    check('桌面用的是自然列数算法', r.layout?.algorithm === 'natural-grid', String(r.layout?.algorithm));
    check('桌面网格列数 ≥ 5', (r.layout?.cols ?? 0) >= 5, `grid=${r.layout?.cols} 列`);
    check('没有重叠 / 越界 / 压按钮', r.overlapPairs === 0 && r.outOfBounds === 0 && r.buttonOverlaps === 0, `overlap=${r.overlapPairs} out=${r.outOfBounds} btn=${r.buttonOverlaps}`);
    check(
      '★ 均匀散布：纵向铺开 ≥ 50% 纸高（不许全挤在顶部两行）',
      (r.spread?.yCoverage ?? 0) >= 0.5,
      `yCoverage=${r.spread?.yCoverage}（y ${r.spread?.yMin}~${r.spread?.yMax} / 纸高 ${r.spread?.sheetH}）`,
    );

    // ── 桌面按钮仍是右下角竖排（不许被本次改动误伤）──
    const layout = await desk.evaluate(`(() => {
      const band = document.querySelector('.paper-controls-round');
      const col = document.querySelector('.paper-controls');
      const rect = col ? col.getBoundingClientRect() : null;
      return {
        hasBand: !!band,
        hasColumn: !!col,
        right: rect ? rect.right : 0,
        top: rect ? rect.top : 0,
        inner: [window.innerWidth, window.innerHeight],
        btn: (() => { const b = document.querySelector('.paper-cols-btn'); if (!b) return null; const q = b.getBoundingClientRect(); return { w: q.width, h: q.height }; })(),
      };
    })()`);
    check('桌面没有手机版圆形按钮带', layout.hasBand === false);
    check(
      '桌面按钮仍在右下角',
      layout.hasColumn && layout.right > layout.inner[0] * 0.6 && layout.top > layout.inner[1] * 0.4,
      JSON.stringify(layout),
    );
    check('背诵页有 32×32 的 ⊞ 手动列数按钮', layout.btn !== null && Math.abs(layout.btn.w - 32) < 0.6 && Math.abs(layout.btn.h - 32) < 0.6, JSON.stringify(layout.btn));

    // ── 点开选择条 → 选 6 列 → 立刻重排 + 记住 ──
    const before = await desk.evaluate(`[...document.querySelectorAll('.paper-word-zone')].map((z) => z.style.left).sort().join('|')`);
    const opened = await desk.evaluate(`(() => { const b = document.querySelector('.paper-cols-btn'); b.click(); const bar = document.querySelector('.paper-cols-bar'); return { visible: !!bar && !bar.classList.contains('hidden'), items: [...(bar?.querySelectorAll('.paper-cols-item') ?? [])].map((i) => i.textContent) }; })()`);
    check('点 ⊞ 弹出轻量选择条（含 自动/3/4/5/6/8/10）', opened.visible && opened.items.join(',') === '自动,3,4,5,6,8,10', JSON.stringify(opened));
    const selected = await desk.evaluate(`(() => {
      const items = [...document.querySelectorAll('.paper-cols-item')];
      const six = items.find((i) => i.textContent === '6');
      if (!six) return false;
      six.click();
      return true;
    })()`);
    check('能选中「6」', selected === true);
    await new Promise((r2) => setTimeout(r2, 700));
    const after = await desk.evaluate('window.__layoutProbe()');
    const afterPlacements = await desk.evaluate(`[...document.querySelectorAll('.paper-word-zone')].map((z) => z.style.left).sort().join('|')`);
    check('★ 选完立刻重排（网格 = 6 列）', after.layout?.cols === 6 && after.layout?.colsOverridden === true, `grid=${after.layout?.cols} override=${after.layout?.colsOverridden}`);
    check('★ 词的位置真的变了（不是只改了设置）', before !== afterPlacements, '重排前后 left 完全一致');
    check('重排后仍然不重叠 / 不越界', after.overlapPairs === 0 && after.outOfBounds === 0 && after.buttonOverlaps === 0, `overlap=${after.overlapPairs} out=${after.outOfBounds}`);
    const barClosed = await desk.evaluate(`document.querySelector('.paper-cols-bar').classList.contains('hidden')`);
    check('选完自动收起选择条', barClosed === true);

    // ── 记住选择（刷新后位置还是那 6 列的一套）──
    //   说明：续跑走的是「恢复落点」分支（不重算网格），所以 `__layoutInfo` 这时是空的
    //   —— 于是这里用**渲染出来的真实位置**验证「选择被记住并复用了」，
    //   而不是去读诊断快照（那会变成在验一个不存在的东西）。
    const saved = await desk.evaluate(`JSON.parse(localStorage.getItem('blank-sheet-vocab.settings') ?? '{}').layoutColsOverride ?? null`);
    check('★ 选择写进了设置（localStorage 镜像）', saved === 6, String(saved));
    await desk.reload(2500);
    await desk.evaluate('window.dispatchEvent(new Event("resize"))');
    await new Promise((r2) => setTimeout(r2, 900));
    const reloaded = await desk.evaluate('window.__layoutProbe()');
    const reloadedPlacements = await desk.evaluate(`[...document.querySelectorAll('.paper-word-zone')].map((z) => z.style.left).sort().join('|')`);
    check('刷新后仍然放 16 个词', reloaded.wordCount === 16, `wordCount=${reloaded.wordCount}`);
    check(
      '★ 刷新后单词位置与「6 列」那一套完全一致（记住选择）',
      reloadedPlacements === afterPlacements,
      '刷新后位置变了 —— 说明选择没被复用',
    );

    // 收尾：把覆盖改回自动，避免影响后面的手机用例
    await desk.evaluate(`(() => { const b = document.querySelector('.paper-cols-btn'); b.click(); const item = [...document.querySelectorAll('.paper-cols-item')].find((i) => i.textContent === '自动'); if (item) item.click(); return true; })()`);
    await new Promise((r2) => setTimeout(r2, 500));
  } finally {
    await desk.close();
  }

  console.log('\n[3] 真实背诵页（手机 390×844，M2 的成果不许被搞坏）');
  const phone = await openLearn(390, 844);
  try {
    const r = await phone.evaluate('window.__layoutProbe()');
    check('手机词数 15~18（M2 的目标）', r.wordCount >= 15 && r.wordCount <= 18, `wordCount=${r.wordCount}`);
    check('手机列数 ≥ 3', r.columns >= 3, `columns=${r.columns}`);
    check('手机用的是自然列数算法（与桌面同一套）', r.layout?.algorithm === 'natural-grid', String(r.layout?.algorithm));
    check('手机没有重叠 / 越界 / 压按钮', r.overlapPairs === 0 && r.outOfBounds === 0 && r.buttonOverlaps === 0, `overlap=${r.overlapPairs} out=${r.outOfBounds} btn=${r.buttonOverlaps}`);
    const phoneUi = await phone.evaluate(`(() => {
      const band = document.querySelector('.paper-controls-round');
      const btn = document.querySelector('.paper-cols-btn');
      const b = btn ? btn.getBoundingClientRect() : null;
      return {
        hasBand: !!band,
        bandHeight: Number(band?.dataset.bandHeight ?? 0),
        vh: window.innerHeight,
        btn: b ? { w: b.width, h: b.height, top: b.top, bottom: b.bottom } : null,
      };
    })()`);
    check('手机上仍是底部圆形按钮带', phoneUi.hasBand === true);
    check('手机上的 ⊞ 也是 32×32', phoneUi.btn !== null && Math.abs(phoneUi.btn.w - 32) < 0.6 && Math.abs(phoneUi.btn.h - 32) < 0.6, JSON.stringify(phoneUi.btn));
    check(
      '手机的 ⊞ 落在底部按钮带里（那里是布点避让区，压不到单词）',
      phoneUi.btn !== null &&
        phoneUi.bandHeight > 0 &&
        phoneUi.btn.top >= phoneUi.vh - phoneUi.bandHeight - 0.6 &&
        phoneUi.btn.bottom <= phoneUi.vh + 0.6,
      JSON.stringify({ btn: phoneUi.btn, bandHeight: phoneUi.bandHeight, vh: phoneUi.vh }),
    );
  } finally {
    await phone.close();
  }
} finally {
  chrome?.proc.kill();
  vite.kill();
}

console.log(`\n=== S3 验收结果：通过 ${passed} 项，失败 ${failed} 项 ===\n`);
process.exit(failed === 0 ? 0 : 1);
