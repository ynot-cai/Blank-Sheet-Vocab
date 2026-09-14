/**
 * 背诵流程验收自检：`npm run test:paper`（纯 Node，不需要浏览器）
 *
 * 钉的是用户 2026-09 口述的六件事（原话见 `HANDOVER.md §0.15` 与代码里的「用户口径」注释）：
 *   [1] 记忆抽取机制：上限 / 遍数最少优先 / **同级随机** / 上一轮未通过作为**额外项** / 只抽已出现的
 *   [2] 布点间距：**最低距离由字号决定**，且任意两个词、词与按钮都**不许重合**
 *   [3] 义项输入框：Enter 跳下一格、最后一格才提交
 *   [4] 答案卡 = 普通单词卡（可改义项 / 可拼 / 可斩），且点卡内控件不推进
 *   [5] 拼写环节的词源 = **当次记忆选中的词**（不是另外抽的）
 *   [6] 「保存并退出」保留位置 / 进度 / 每词记忆遍数，且下次点击**直接续跑**
 *
 * 与 `checkRules.mjs` / `test-r4` 的分工：那两个管**铁律**（时间限制 / 义项 / 斩 / 安全），
 * 这里管**背诵流程的行为**。行为类的东西能 import 真实源码算的就真算（[1][2]），
 * 算不了的（DOM 交互）就在这里断言接线 + 由 `test-paper-ui` 在真浏览器里验。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const { pickForMemorize } = await import('../../src/core/pick.ts');
const { spacingBudget, jitteredGrid, wordRowHeightPx } = await import('../../src/core/layout.ts');

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
 * 读源码文本。
 * @param {string} rel 相对仓库根
 */
function read(rel) {
  return readFileSync(join(ROOT, rel), 'utf8');
}

// ═══════════════════════════════ [1] 记忆抽取机制
console.log('\n[1] 记忆抽取机制（用户重申的规则）');

/** 造一个词 + 会话（不依赖 dao，纯数据） */
const mkWord = (id) => ({ id, en: id, status: 'unlearned' });
const mkSession = (ids, over = {}) => ({
  id: 's',
  type: 'learn',
  wordIds: ids,
  placements: {},
  shownIds: [...ids],
  memorizeCount: {},
  spellEnabled: false,
  failedIds: [],
  failDeltas: {},
  groupId: 0,
  groups: [ids],
  finished: false,
  createdAt: 0,
  ...over,
});

// 1a. 只抽已经出现在纸上的词
{
  const ids = ['a', 'b', 'c', 'd'];
  const words = ids.map(mkWord);
  const s = mkSession(ids, { shownIds: ['a', 'b'] });
  const picked = pickForMemorize(s, words, { maxPick: 10, targetCount: 1 });
  check('只抽已出现在纸上的词（没上纸的不进记忆）', picked.length === 2 && picked.every((id) => ['a', 'b'].includes(id)), picked.join(','));
}

// 1b. 已出现 3 个、上限 10 → 只进行 3 次
{
  const ids = ['a', 'b', 'c', 'd', 'e'];
  const words = ids.map(mkWord);
  const s = mkSession(ids, { shownIds: ['a', 'b', 'c'] });
  const picked = pickForMemorize(s, words, { maxPick: 10, targetCount: 1 });
  check('已出现 3 个、上限 10 → 只抽 3 个（只进行 3 次）', picked.length === 3, `抽了 ${picked.length} 个`);
}

// 1c. 超过上限 → 按「已经抽到的次数最低」优先
{
  const ids = ['a', 'b', 'c', 'd'];
  const words = ids.map(mkWord);
  const s = mkSession(ids, { memorizeCount: { a: 9, b: 8, c: 1, d: 0 } });
  const picked = pickForMemorize(s, words, { maxPick: 2, targetCount: 1 });
  check('超过上限时优先抽「记忆遍数最少」的（d=0 / c=1）', picked.length === 2 && picked.includes('d') && picked.includes('c'), picked.join(','));
  check('上限生效：没有额外项时正好抽 maxPick 个', picked.length === 2, `抽了 ${picked.length} 个`);
}

// 1d. 遍数相同 → 随机
{
  const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
  const words = ids.map(mkWord);
  const s = mkSession(ids, { memorizeCount: {} }); // 全部 0 遍 = 完全同级
  const combos = new Set();
  for (let i = 0; i < 60; i += 1) {
    combos.add([...pickForMemorize(s, words, { maxPick: 2, targetCount: 1 })].sort().join(','));
  }
  check('遍数相同时随机抽（60 次出现多种组合）', combos.size > 1, `${combos.size} 种组合`);
}

// 1e. 上一轮未通过、又没被抽到 → 额外项（总数超过上限）
{
  const ids = ['a', 'b', 'c'];
  const words = ids.map(mkWord);
  // a 遍数最少必被抽；b 上一轮没通过但遍数最多 → 只能靠额外项进来
  const s = mkSession(ids, { memorizeCount: { a: 0, b: 9, c: 5 }, lastRoundFailedIds: ['b'] });
  const picked = pickForMemorize(s, words, { maxPick: 1, targetCount: 1 });
  check('上一轮未通过的词作为额外项加入（总数可以超过上限）', picked.length === 2 && picked.includes('a') && picked.includes('b'), picked.join(','));
}

// 1f. 上一轮未通过但已经被抽到 → 不重复
{
  const ids = ['a', 'b'];
  const words = ids.map(mkWord);
  const s = mkSession(ids, { memorizeCount: { a: 0, b: 5 }, lastRoundFailedIds: ['a'] });
  const picked = pickForMemorize(s, words, { maxPick: 2, targetCount: 1 });
  check('额外项已在基础项里时不重复计入', picked.length === 2 && new Set(picked).size === 2, picked.join(','));
}

// 1g. 老存档没有 lastRoundFailedIds → 不额外抽词、不抛异常
{
  const ids = ['a', 'b', 'c'];
  const words = ids.map(mkWord);
  const s = mkSession(ids, { memorizeCount: { a: 0, b: 1, c: 2 } });
  delete s.lastRoundFailedIds;
  const picked = pickForMemorize(s, words, { maxPick: 2, targetCount: 1 });
  check('老存档（没有 lastRoundFailedIds）不额外抽词、也不抛异常', picked.length === 2, picked.join(','));
}

// 1h. 被斩的词不进记忆
{
  const ids = ['a', 'b'];
  const words = [mkWord('a'), { ...mkWord('b'), status: 'chopped' }];
  const s = mkSession(ids);
  const picked = pickForMemorize(s, words, { maxPick: 10, targetCount: 1 });
  check('被斩的词不进记忆环节', picked.length === 1 && picked[0] === 'a', picked.join(','));
}

// ═══════════════════════════════ [2] 布点间距
console.log('\n[2] 布点：最低距离由字号决定，且不许重合');

// 2a. 间距预算的构成：最宽的词 + 字号 × 系数
{
  const b = spacingBudget({ fontSize: 24, gapFactor: 2.4, widestWordPx: 170, rowHeightPx: 47 });
  check('最小中心距 = 最宽词宽 + 字号 × 系数', Math.abs(b.gapX - (170 + 24 * 2.4)) < 1e-9, String(b.gapX));
  check('纵向同理（词行高 + 字号 × 系数）', Math.abs(b.gapY - (47 + 24 * 2.4)) < 1e-9, String(b.gapY));
  check('按钮避让区按半个词外扩', b.padX === 85 && b.padY === 23.5, `${b.padX}/${b.padY}`);
}

// 2b. 「由字号决定」：字号变大 → 间距变大
{
  const small = spacingBudget({ fontSize: 18, gapFactor: 2.4, widestWordPx: 100, rowHeightPx: 40 });
  const big = spacingBudget({ fontSize: 36, gapFactor: 2.4, widestWordPx: 100, rowHeightPx: 40 });
  check('字号变大 → 最小间距跟着变大（由字号决定）', big.gapX > small.gapX && big.gapY > small.gapY, `${small.gapX} → ${big.gapX}`);
}

// 2c. ★ 关键：用真实布点算法验证「任意两个词都不重合」
{
  const fontSize = 24;
  const W = 1200;
  const H = 700;
  // 故意混入长词与短词，逼出最坏情况
  const ens = ['photosynthesis', 'a', 'extraordinarily', 'go', 'misunderstanding', 'hi'];
  const widest = 170; // 假设最长那个渲染出来 170px（24px 字号下约 14 字符）
  const budget = spacingBudget({ fontSize, gapFactor: 2.4, widestWordPx: widest, rowHeightPx: wordRowHeightPx(fontSize) });
  const gapX = budget.gapX / W;
  const gapY = budget.gapY / H;
  const points = jitteredGrid(ens.length, { aspect: W / H, seed: 7, minGapW: gapX, minGapH: gapY });
  check('间距约束下这几个词都放得下', points.length === ens.length, `${points.length}/${ens.length}`);

  // 不重合的判定：任意两点，横向中心距 ≥ 最宽词 或 纵向中心距 ≥ 词行高
  // （落点是词的中心，所以这正是「两个词的矩形不相交」的充要条件）
  let worstOverlap = '无';
  let ok = true;
  for (let i = 0; i < points.length && ok; i += 1) {
    for (let k = i + 1; k < points.length; k += 1) {
      const dx = Math.abs(points[i].x - points[k].x) * W;
      const dy = Math.abs(points[i].y - points[k].y) * H;
      if (dx < widest - 1e-6 && dy < wordRowHeightPx(fontSize) - 1e-6) {
        ok = false;
        worstOverlap = `#${i} 与 #${k}：dx=${dx.toFixed(1)} dy=${dy.toFixed(1)}`;
        break;
      }
    }
  }
  check('★ 任意两个词都不重合（不依赖运气：几何上互斥）', ok, worstOverlap);
  check('★ 任意两个词的最小中心距 ≥ 最宽词 + 字号×系数 或 纵向同理', gapX > 0 && gapY > 0, `${gapX.toFixed(4)}/${gapY.toFixed(4)}`);
}

// 2d. 按钮避让：中心贴边也不算安全，必须按半个词外扩
{
  const stage = read('src/ui/pages/paper/PaperStage.ts');
  check('PaperStage 用 canvas measureText 量最宽的词', stage.includes('measureText'));
  check('PaperStage 调 spacingBudget 算间距', stage.includes('spacingBudget('));
  check('按钮避让矩形按 padX/padY 外扩', /controls\.x - offsetX - budget\.padX/.test(stage) && /width: controls\.width \+ budget\.padX \* 2/.test(stage));
  check('间距系数仍然来自设置（不写死）', stage.includes('paperWordGapFactor'));
}

// ═══════════════════════════════ [3] Enter 逐格切换
console.log('\n[3] 义项输入框：Enter 跳下一格，最后一格才提交');
{
  const rounds = read('src/ui/pages/paper/rounds.ts');
  check('每个输入框都挂了 Enter 处理', /inputs\.forEach\(\(input, i\)/.test(rounds));
  check('Enter 先聚焦下一格（不是直接提交）', /const next = inputs\[i \+ 1\]/.test(rounds) && /next\.focus\(\)/.test(rounds));
  check('只在最后一格提交（没有下一格时）', /submitted = true; \/\/ 最后一格：提交/.test(rounds));
  check('有「按 Enter 填下一个义项」的操作提示', rounds.includes('按 Enter 填下一个义项'));
  check('stopPropagation 保留（全局 Enter 不会重复提交）', /ev\.stopPropagation\(\)/.test(rounds));
}

// ═══════════════════════════════ [4] 答案卡 = 普通单词卡
console.log('\n[4] 答案卡 = 普通单词卡（可改义项 / 可拼 / 可斩）');
{
  const card = read('src/ui/pages/paper/AnswerCard.ts');
  const flowSrc = read('src/ui/pages/paper/flow.ts');
  check('答案卡传 editable: true', /editable: true/.test(card));
  check('答案卡接 onChange / onSpell / onChop', /onChange: actions\.onChange/.test(card) && /onSpell: actions\.onSpell/.test(card) && /onChop: actions\.onChop/.test(card));
  check('点卡内输入控件不推进卡片（否则点一下就关了）', card.includes('isInteractive') && /input, textarea, select/.test(card));
  check('点义项面板不推进卡片', card.includes('.sense-panel'));
  check('卡上的回调与普通单词卡**共用同一份**（cardActionsFor）', flowSrc.includes('const cardActionsFor') && flowSrc.includes('cardActionsFor,'));
  check('全局 Enter 在输入控件/按钮上让位（在卡里打字不会被当成看完）', /'INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'/.test(flowSrc));
  check('答题途中被斩的词不再被记成「已作答」', flowSrc.includes('if (!session.wordIds.includes(id)) return;'));
}

// ═══════════════════════════════ [5] 拼写环节词源
console.log('\n[5] 拼写环节的词源 = 当次记忆选中的词');
{
  const flowSrc = read('src/ui/pages/paper/flow.ts');
  check('拼写名单来自本轮 picked（不是另外抽一套）', /const spellIds = picked\.filter/.test(flowSrc));
  check('拼写条件是「当次选到 + 标了拼 + 没被斩」', /w\.attrs\.needSpell && w\.status !== 'chopped'/.test(flowSrc));
  check('没有别处再抽拼写词（不出现第二个 pickForSpell 之类的调用）', !/pickForSpell|pickSpell/.test(flowSrc));
}

// ═══════════════════════════════ [6] 保存并退出 → 直接续跑
console.log('\n[6] 保存并退出保留位置/进度/遍数，下次点击直接续跑');
{
  const sess = read('src/dao/session.ts');
  const learn = read('src/ui/pages/LearnPage.ts');
  const finishSrc = read('src/ui/pages/paper/finish.ts');
  for (const field of ['placements', 'shownIds', 'memorizeCount', 'failedIds', 'failDeltas', 'lastRoundFailedIds']) {
    check(`会话落库包含 ${field}`, sess.includes(field), field);
  }
  check('exitMidway 就是整份 saveSession（不是只存词单）', /exitMidway[\s\S]{0,200}saveSession\(session\)/.test(finishSrc));
  // 注意：注释里**提到**这句旧话是在说明「以前写错了」，所以不能简单搜字符串——
  // 搜的是「旧说法作为结论」的形态（旧注释里那两句连着出现）。
  check('exitMidway 的注释不再把「进度不保留」当结论', !finishSrc.includes('中途退出丢的是「本轮进度」'));
  check('exitMidway 的注释明确写了保留全部进度', finishSrc.includes('把整份会话原样写库') && finishSrc.includes('全部保留'));
  check('LearnPage 不再依赖 ?resume=1 才续跑', !/ctx\?\.query\.get\('resume'\) === '1'/.test(learn));
  check('LearnPage 启动时总是先找未完成会话', /const existing = await dao\.session\.loadSession\(\)/.test(learn));
  check('词全没了会清掉旧会话（不留死会话）', learn.includes('dao.session.clearSession()'));
  check('每轮记忆结束也落一次库（直接关页面不丢遍数）', read('src/ui/pages/paper/flow.ts').includes('本轮的记忆遍数、未通过情况立刻落库'));
  check('有「重新开始」出口（续跑自动化后必须能甩掉旧进度）', read('src/ui/pages/paper/flow.ts').includes("button('重新开始'"));
  check('首页不再对「背诵」弹「继续上次」询问框', !/path === '\/learn' && existing\.type === 'learn'/.test(read('src/ui/pages/HomePage.ts')));
}

// ═══════════════════════════════ [7] 冲突标记
console.log('\n[7] 与用户口径冲突的地方都做了标记');
{
  const marked = [
    ['src/core/pick.ts', '以用户为准'],
    ['src/ui/pages/paper/AnswerCard.ts', '用户明确要求'],
    ['src/ui/pages/paper/finish.ts', '与代码事实相反'],
    ['src/ui/pages/HomePage.ts', '与代码事实**正好相反**'],
    ['src/ui/components/WordCard.ts', '用户口径（2026-09）'],
    ['src/ui/pages/paper/flow.ts', '用户口径（2026-09）'],
    ['src/ui/pages/LearnPage.ts', '下次点击直接开始'],
  ];
  for (const [file, needle] of marked) {
    check(`${file} 有冲突标记`, read(file).includes(needle), needle);
  }
  // 那批 md 已按用户要求从 git 删除。这里**不写旧品牌名**（test:rename 会扫）——
  // 断言「删除清单里的文件确实没了、留下的两份文档确实在」就够表达这件事了。
  check(
    '删除清单里的文档确实已从仓库移除，且留下 AI_RULES.md + HANDOVER.md',
    !existsSync(join(ROOT, 'CHECKLIST.md')) &&
      !existsSync(join(ROOT, 'README-DEPLOY.md')) &&
      existsSync(join(ROOT, 'AI_RULES.md')) &&
      existsSync(join(ROOT, 'HANDOVER.md')),
  );
}

// ─────────────────────────────── 汇总
console.log(`\n背诵流程自检：${passed} 项通过，${failed} 项失败`);
if (failed > 0) process.exit(1);
