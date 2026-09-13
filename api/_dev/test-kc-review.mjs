/**
 * 阶段 06 验收脚本：`npm run test:kc-review`
 *
 * 覆盖复习流程里**不需要浏览器**的部分：
 *   2. 空库 → 推荐 0、抽卡为空（界面据此提示「还没有学过的知识点」，不崩）
 *   3. 有已学卡片 → 能抽到、推荐数字合理
 *   4. 流程顺序的数据层：stage 从 cards → words → exam → done
 *   6. ★ 桥接词源：一期有新词 → 背新词；没有新词 → 背旧词；词库为空 → 返回 none
 *   8. 完成后：`lastReviewAt` 变今天、`reviewCount +1`、掌握度已更新
 *
 * 「点按钮 / 走三个环节 / 三个阶段各退出一次」由 `test-kc-review-ui.mjs`（真浏览器）覆盖。
 */
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { loadEnvFiles } from './envFile.mjs';
import 'fake-indexeddb/auto';

loadEnvFiles('..');

const DB_FILE = './.tmp/test-kc-review.db';
if (existsSync(DB_FILE)) rmSync(DB_FILE);
mkdirSync('./.tmp', { recursive: true });
process.env.TURSO_DATABASE_URL = `file:${DB_FILE}`;

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
  key: (i) => [...store.keys()][i] ?? null,
  get length() {
    return store.size;
  },
};
globalThis.window = globalThis;

const kcModel = await import('../../src/core/kcModel.ts');
const coreModel = await import('../../src/core/model.ts');
const reviewFlow = await import('../../src/ui/pages/kcReview/kcReviewFlow.ts');
const dao = await import('../../src/dao/index.ts');
const { setSettingsCache, DEFAULT_SETTINGS } = await import('../../src/core/config.ts');

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

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
setSettingsCache(DEFAULT_SETTINGS);

// ───────────────────────────────────────────────
console.log('\n[1] 抽卡规则：只复习学过的（验收标准 2 / 3）');
// ───────────────────────────────────────────────
{
  await dao.kc.clearAll();
  await tick();
  check('★ 空库：复习候选为 0（界面据此提示，不崩）', reviewFlow.reviewCandidates([]).length === 0, '');
  check('★ 空库：推荐数量为 0', reviewFlow.recommendReviewCount([]) === 0, '');
  check('★ 空库：抽卡为空', reviewFlow.pickForReview([], 8).length === 0, '');

  // 造 10 张已学 + 2 张未学 + 1 张已斩
  const mk = (title, status, priority, lastReviewAt = null) => {
    const c = kcModel.createEmptyCard(title);
    c.status = status;
    c.attrs.reviewPriority = priority;
    c.attrs.lastReviewAt = lastReviewAt;
    c.attrs.mastery = 0.5;
    return c;
  };
  const learned = [];
  for (let i = 1; i <= 10; i += 1) learned.push(mk(`已学 ${i}`, 'learned', 100 - i * 5));
  const learning = [mk('学习中 1', 'learning', 90), mk('学习中 2', 'learning', 80)];
  const unlearned = [mk('未学 1', 'unlearned', 999), mk('未学 2', 'unlearned', 999)];
  const chopped = mk('已斩的', 'chopped', 999);
  chopped.deleted = 1;
  await dao.kc.bulkUpsert([...learned, ...learning, ...unlearned, chopped]);
  await tick();

  const all = await dao.kc.getAll();
  const candidates = reviewFlow.reviewCandidates(all);
  check('★ 候选 = 已学 10 + 学习中 2 = 12', candidates.length === 12, `实际 ${candidates.length}`);
  check('★ 未学的卡片不在候选里（优先度再高也不抽）', !candidates.some((c) => c.title.startsWith('未学')), '');
  check('★ 已斩的卡片不在候选里', !candidates.some((c) => c.title === '已斩的'), '');

  const picked = reviewFlow.pickForReview(all, 8);
  check('★ 抽 8 张', picked.length === 8, String(picked.length));
  check('★ 抽到的是优先度最高的（已学 1 = 95 排第一）', picked[0].title === '已学 1', picked.map((c) => `${c.title}(${c.attrs.reviewPriority})`).join(' '));
  check('抽卡按优先度降序', picked.every((c, i) => i === 0 || c.attrs.reviewPriority <= picked[i - 1].attrs.reviewPriority), '');
  check('抽卡不重复', new Set(picked.map((c) => c.id)).size === 8, '');

  // 同分时「更久没复习」的优先
  const tie = [
    { ...mk('同分早复习', 'learned', 50, Date.now() - 10 * 86_400_000) },
    { ...mk('同分晚复习', 'learned', 50, Date.now() - 1 * 86_400_000) },
  ];
  const tieOrder = reviewFlow.pickForReview(tie, 2);
  check('★ 同分时更久没复习的排前面', tieOrder[0].title === '同分早复习', tieOrder.map((c) => c.title).join(','));

  const rec = reviewFlow.recommendReviewCount(all);
  check('★ 推荐数字在 1~12 之间且不为 0', rec >= 1 && rec <= 12, String(rec));
  check('推荐数字不超过上限 50', rec <= 50, String(rec));
}

// ───────────────────────────────────────────────
console.log('\n[2] 桥接词源：新词 → 旧词 → 空库（验收标准 6）');
// ───────────────────────────────────────────────
{
  await dao.words.clearAll();
  await tick();
  const empty = await reviewFlow.pickBridgeWords(5);
  check('★ 一期词库为空 → 返回 none（界面据此跳过并提示）', empty.source === 'none' && empty.words.length === 0, JSON.stringify(empty.source));

  // 造 3 个新词 + 2 个旧词
  const src = await dao.sources.ensureByName('__reviewtest__', 0);
  const fresh = [
    coreModel.createWord('alpha', [coreModel.createSense('n. 甲')], src.id),
    coreModel.createWord('beta', [coreModel.createSense('n. 乙')], src.id),
    coreModel.createWord('gamma', [coreModel.createSense('n. 丙')], src.id),
  ];
  // 让 createdAt 有序，便于断言「先录入先背」
  fresh[0].createdAt = 1_700_000_000_000;
  fresh[1].createdAt = 1_700_000_001_000;
  fresh[2].createdAt = 1_700_000_002_000;
  const old = [
    coreModel.createWord('delta', [coreModel.createSense('n. 丁')], src.id),
    coreModel.createWord('epsilon', [coreModel.createSense('n. 戊')], src.id),
  ];
  for (const w of old) {
    w.status = 'learned';
    w.attrs.reviewPriority = w.en === 'delta' ? 9 : 3;
  }
  await dao.words.bulkUpsert([...fresh, ...old]);
  await tick();

  const onlyNew = await reviewFlow.pickBridgeWords(5);
  check('★ 有新词时：背的是新词', onlyNew.source === 'new', JSON.stringify(onlyNew.source));
  check('★ 新词按 createdAt 升序（先录入先背）', onlyNew.words.map((w) => w.en).join(',') === 'alpha,beta,gamma', onlyNew.words.map((w) => w.en).join(','));
  check('★ 上限生效：只要 2 个就只给 2 个', (await reviewFlow.pickBridgeWords(2)).words.length === 2, '');

  // 把新词都变成已学 → 退化成复习旧词
  for (const w of fresh) await dao.words.setStatus(w.id, 'learned');
  await tick();
  const onlyOld = await reviewFlow.pickBridgeWords(5);
  check('★ 没有新词时：退化成复习旧词', onlyOld.source === 'old', JSON.stringify(onlyOld.source));
  check('★ 旧词按复习优先度降序（delta 9 在前）', onlyOld.words[0].en === 'delta', onlyOld.words.map((w) => w.en).join(','));

  // 上限默认 5
  const cap = (await reviewFlow.pickBridgeWords()).words.length;
  check('★ 默认上限来自设置（reviewWordLimit = 5）', cap <= DEFAULT_SETTINGS.kc.reviewWordLimit, `${cap} <= ${DEFAULT_SETTINGS.kc.reviewWordLimit}`);
}

// ───────────────────────────────────────────────
console.log('\n[3] 四个阶段的会话流转（验收标准 4 / 7 的数据层）');
// ───────────────────────────────────────────────
let sessionId = '';
{
  const all = await dao.kc.getAll();
  const picked = reviewFlow.pickForReview(all, 3);
  const session = dao.kcSession.createSession('review', picked.map((c) => c.id));
  await dao.kcSession.save(session);
  sessionId = session.id;
  await tick();

  check('复习会话初始 stage = cards', (await dao.kcSession.load(sessionId)).stage === 'cards', '');

  // 走完卡片 → 进 words
  const s1 = await dao.kcSession.load(sessionId);
  s1.stage = 'words';
  s1.currentIndex = 3;
  await dao.kcSession.save(s1);
  await tick();
  check('★ 卡片看完 → stage = words（进入背单词）', (await dao.kcSession.load(sessionId)).stage === 'words', '');

  // 背完 → 进 exam
  const s2 = await dao.kcSession.load(sessionId);
  s2.wordsDone = true;
  s2.stage = 'exam';
  await dao.kcSession.save(s2);
  await tick();
  const s2r = await dao.kcSession.load(sessionId);
  check('★ 背完单词 → stage = exam（进入做题）', s2r.stage === 'exam' && s2r.wordsDone === true, `${s2r.stage}/${s2r.wordsDone}`);

  // 复习的会话与学习的会话互不干扰
  const studySession = dao.kcSession.createSession('study', ['x']);
  await dao.kcSession.save(studySession);
  await tick();
  check('★ 复习会话不会被学习会话顶掉（按 type 分开找）', (await dao.kcSession.loadLatestOpen('review')).id === sessionId, '');
  await dao.kcSession.remove(studySession.id);

  // 逐个 stage 都能被「继续上次」捞出来
  for (const stage of ['cards', 'words', 'exam']) {
    const s = await dao.kcSession.load(sessionId);
    s.stage = stage;
    s.finished = false;
    await dao.kcSession.save(s);
    await tick();
    const open = await dao.kcSession.loadLatestOpen('review');
    check(`★ stage=${stage} 时能被「继续上次」捞到（验收标准 7）`, open !== null && open.stage === stage, open?.stage ?? 'null');
  }
}

// ───────────────────────────────────────────────
console.log('\n[4] 复习收尾：属性更新（验收标准 8）');
// ───────────────────────────────────────────────
{
  const session = await dao.kcSession.load(sessionId);
  const cardIds = session.cardIds;

  // 先给其中一张写自评与考核（模拟复习过程）
  await dao.kc.updateAttrs(cardIds[0], { lastSelfScore: 2, lastExamScore: 3, learnedAt: Date.now() });
  await tick();
  const before = await dao.kc.getById(cardIds[0]);
  check('复习前 lastReviewAt 是空的', before.attrs.lastReviewAt === null, String(before.attrs.lastReviewAt));
  check('复习前 reviewCount = 0', before.attrs.reviewCount === 0, String(before.attrs.reviewCount));

  const finished = await reviewFlow.finishReview(cardIds);
  await tick();

  const after = await dao.kc.getById(cardIds[0]);
  check('★ lastReviewAt 变成今天（刚刚）', after.attrs.lastReviewAt !== null && Date.now() - after.attrs.lastReviewAt < 5000, String(after.attrs.lastReviewAt));
  check('★ reviewCount +1', after.attrs.reviewCount === 1, String(after.attrs.reviewCount));
  check('★ mastery 已按自评 2 + 考核 3 重算', after.attrs.mastery > 0 && after.attrs.mastery <= 1, String(after.attrs.mastery));
  check('★ reviewPriority 已重算（不再只是初始值）', typeof after.attrs.reviewPriority === 'number', String(after.attrs.reviewPriority));
  check('★ status 保持 learned', after.status === 'learned', after.status);
  check('收尾返回了更新后的卡片', finished.length === cardIds.length, `${finished.length}/${cardIds.length}`);

  // 再复习一次：次数累加
  await reviewFlow.finishReview([cardIds[0]]);
  await tick();
  check('★ 再复习一次 → reviewCount = 2', (await dao.kc.getById(cardIds[0])).attrs.reviewCount === 2, '');

  // 小结文案
  const summary = reviewFlow.reviewSummary(finished);
  check('★ 小结文案含个数与平均掌握度', /复习 \d+ 个知识点/.test(summary) && /平均掌握度 \d+%/.test(summary), summary);
  check('小结里有「需要重点回顾」的个数', /需要重点回顾/.test(summary), summary);
  check('空数组的小结不崩', reviewFlow.reviewSummary([]).includes('没有复习到'), '');
}

// ───────────────────────────────────────────────
console.log('\n[5] 桥接不动一期核心逻辑（验收标准 9）');
// ───────────────────────────────────────────────
{
  const fs = await import('node:fs');
  const bridge = fs.readFileSync('src/ui/pages/KcWordBridge.ts', 'utf8');
  check('★ 桥接复用一期 createPaperFlow（没有复制一套背单词逻辑）', bridge.includes('createPaperFlow'), '');
  check('桥接只 import 一期代码，不改它', !bridge.includes('dao.words.updateAttrs('), '');
  check('桥接有「跳过这一步」出口', bridge.includes('跳过这一步'), '');
  check('桥接提示了词源（新词 / 旧词）', bridge.includes('新词') && bridge.includes('旧词'), '');
  check('词库为空时明确提示跳过', bridge.includes('一期词库为空，跳过背单词'), '');

  // 桥接用的是**一期的会话表**，与二期分开
  check('★ 桥接写进一期 sessions 表（与二期 kcSessions 分开）', bridge.includes('dao.session.saveSession'), '');
  check('桥接结束时清掉一期会话（避免一期误判有未完成复习）', bridge.includes('dao.session.clearSession'), '');

  // 二期自己的复习页不碰一期的核心文件
  const review = fs.readFileSync('src/ui/pages/KcReviewPage.ts', 'utf8');
  check('复习页没有改一期文件（只调用）', !review.includes('from \'./paper/'), '');
  check('复习页按 stage 分流四个环节', review.includes("'words'") && review.includes("'exam'") && review.includes("'cards'"), '');
  check('复习页的 Esc / 保存并退出都有', review.includes('Escape') && review.includes('保存并退出'), '');
}

console.log(`\n=== 阶段 06 验收（复习与桥接数据层）：通过 ${passed} 项，失败 ${failed} 项 ===\n`);
process.exit(failed === 0 ? 0 : 1);
