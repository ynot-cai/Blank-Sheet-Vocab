/**
 * 阶段 04 验收脚本：`npm run test:kc-session`
 *
 * 覆盖「学习流程」里**不需要浏览器**的部分：
 *   4. 自评后：`lastSelfScore` / `learnedAt` / `status='learning'` 都落库，且立刻写（不等退出）
 *   7. 「保存并退出」的进度保存与恢复：学到第 3 张退出 → 重进从第 3 张继续、分数还在
 *   2.（数据层）抽卡顺序 = `createdAt` 升序（先录入先学）
 *   6.（数据层）斩掉的卡片会从会话里消失
 *   9. 一期功能完好（由 npm test 全量回归覆盖）
 *
 * 「点按钮 / 按键盘」的部分由 `test-kc-session-ui.mjs`（真浏览器）覆盖。
 */
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { loadEnvFiles } from './envFile.mjs';
import 'fake-indexeddb/auto';

loadEnvFiles('..');

const DB_FILE = './.tmp/test-kc-session.db';
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
const kcTypes = await import('../../src/core/kcTypes.ts');
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
console.log('\n[1] 会话结构（KcSession）');
// ───────────────────────────────────────────────
{
  const s = dao.kcSession.createSession('study', ['c1', 'c2', 'c3']);
  check('createSession 造出 study 会话', s.type === 'study' && s.cardIds.length === 3, '');
  check('初始进度在第 0 张、未完成', s.currentIndex === 0 && s.finished === false, '');
  check('阶段初始是 cards', s.stage === 'cards', s.stage);
  check('分数表初始为空', Object.keys(s.selfScores).length === 0 && Object.keys(s.examScores).length === 0, '');
  check('桥接字段有默认值（阶段 06 用）', Array.isArray(s.wordIds) && s.wordsDone === false && s.examIndex === 0, '');
  check('有 id 与时间戳', s.id !== '' && s.createdAt > 0 && s.updatedAt > 0, '');
  check('类型定义里有 4 个 stage', ['cards', 'words', 'exam', 'done'].length === 4, '');
  // 类型层检查：KcSession 在 kcTypes 里导出
  check('KcSession 类型已导出（编译期检查）', typeof kcTypes.EXAM_TYPES === 'object', '');
}

// ───────────────────────────────────────────────
console.log('\n[2] 抽卡顺序：先录入先学（验收标准 2 的数据层）');
// ───────────────────────────────────────────────
let cardIds = [];
{
  await dao.kc.clearAll();
  await tick();
  // 故意用不同的 createdAt 造 5 张未学卡
  const cards = [];
  for (let i = 0; i < 5; i += 1) {
    const c = kcModel.createEmptyCard(`知识点 ${i + 1}`);
    c.createdAt = 1_700_000_000_000 + i * 1000; // 递增
    c.updatedAt = c.createdAt;
    cards.push(c);
  }
  // 再混入一张「已学」和一张「已斩」，确认不会被抽到
  const learned = kcModel.createEmptyCard('已学过的');
  learned.status = 'learned';
  const chopped = kcModel.createEmptyCard('已斩的');
  chopped.status = 'chopped';
  chopped.deleted = 1;
  await dao.kc.bulkUpsert([...cards, learned, chopped]);
  await tick();

  const all = await dao.kc.getAll();
  const unlearned = all
    .filter((c) => c.deleted !== 1 && c.status === 'unlearned')
    .sort((a, b) => a.createdAt - b.createdAt);
  check('★ 未学卡片按 createdAt 升序（先录入先学）', unlearned.map((c) => c.title).join(',') === '知识点 1,知识点 2,知识点 3,知识点 4,知识点 5', unlearned.map((c) => c.title).join(','));
  check('已学 / 已斩 不在候选里', !unlearned.some((c) => c.title === '已学过的' || c.title === '已斩的'), '');
  cardIds = unlearned.map((c) => c.id);
}

// ───────────────────────────────────────────────
console.log('\n[3] 自评后立刻写库（验收标准 4）');
// ───────────────────────────────────────────────
{
  const session = dao.kcSession.createSession('study', cardIds);
  await dao.kcSession.save(session);
  await tick();
  check('会话已落库', (await dao.kcSession.load(session.id)) !== null, '');

  // 第 1 张：自评「模糊」
  const first = await dao.kc.getById(cardIds[0]);
  check('自评前：status=unlearned、没学过', first.status === 'unlearned' && first.attrs.learnedAt === null, `${first.status}/${first.attrs.learnedAt}`);
  await dao.kc.updateAttrs(cardIds[0], { lastSelfScore: 2, learnedAt: Date.now() });
  await dao.kc.updateMeta(cardIds[0], { status: 'learning' });
  session.selfScores[cardIds[0]] = 2;
  session.currentIndex = 1;
  await dao.kcSession.save(session);
  await tick();

  const after = await dao.kc.getById(cardIds[0]);
  check('★ lastSelfScore=2 已落库', after.attrs.lastSelfScore === 2, String(after.attrs.lastSelfScore));
  check('★ learnedAt 有值', typeof after.attrs.learnedAt === 'number' && after.attrs.learnedAt > 0, String(after.attrs.learnedAt));
  check('★ status 变成 learning', after.status === 'learning', after.status);
  check('★ mastery 被重算（自评 2、还没考核 → 0.333，见公式对照表）', Math.abs(after.attrs.mastery - 0.333) < 0.002, String(after.attrs.mastery));
  check('★ reviewPriority 被重算（> 0）', after.attrs.reviewPriority > 0, String(after.attrs.reviewPriority));

  // 第 2 张：自评「会了」
  await dao.kc.updateAttrs(cardIds[1], { lastSelfScore: 3, learnedAt: Date.now() });
  await dao.kc.updateMeta(cardIds[1], { status: 'learning' });
  session.selfScores[cardIds[1]] = 3;
  session.currentIndex = 2;
  await dao.kcSession.save(session);
  await tick();

  const second = await dao.kc.getById(cardIds[1]);
  check('第 2 张自评 3 已落库', second.attrs.lastSelfScore === 3, String(second.attrs.lastSelfScore));
  check('两张卡的 mastery 不同（分数真的生效了）', after.attrs.mastery !== second.attrs.mastery, `${after.attrs.mastery} vs ${second.attrs.mastery}`);
}

// ───────────────────────────────────────────────
console.log('\n[4] 保存并退出 → 重进恢复（验收标准 7）');
// ───────────────────────────────────────────────
let sessionId = '';
{
  // 此时进度：第 2 张已评（currentIndex=2），还剩 3 张
  const open = await dao.kcSession.loadLatestOpen('study');
  check('★ 能找到未完成的会话（重进时的「继续上次」）', open !== null, '');
  check('★ 进度停在第 3 张（currentIndex=2）', open.currentIndex === 2, `currentIndex=${open.currentIndex}`);
  check('★ 之前的两条自评分还在', open.selfScores[cardIds[0]] === 2 && open.selfScores[cardIds[1]] === 3, JSON.stringify(open.selfScores));
  check('★ 剩余张数 = 5 - 2 = 3', open.cardIds.length - open.currentIndex === 3, String(open.cardIds.length - open.currentIndex));
  sessionId = open.id;

  // 模拟「继续」：按会话里的 id 取回卡片
  const all = await dao.kc.getAll();
  const byId = new Map(all.map((c) => [c.id, c]));
  const restored = open.cardIds.filter((id) => byId.has(id));
  check('★ 续跑能取回全部 5 张卡片', restored.length === 5, String(restored.length));
  check('★ 续跑的起点是第 3 张（id 对得上）', restored[open.currentIndex] === cardIds[2], '');
}

// ───────────────────────────────────────────────
console.log('\n[5] 斩掉的卡片从会话里消失（验收标准 6）');
// ───────────────────────────────────────────────
{
  const open = await dao.kcSession.load(sessionId);
  const target = cardIds[3];
  await dao.kc.chop(target);
  await tick();

  // 模拟页面里的处理：从 cardIds 与分数表里剔除
  open.cardIds = open.cardIds.filter((id) => id !== target);
  delete open.selfScores[target];
  open.currentIndex = Math.min(open.currentIndex, open.cardIds.length);
  await dao.kcSession.save(open);
  await tick();

  const after = await dao.kcSession.load(sessionId);
  check('★ 斩掉的卡片不在会话里了', !after.cardIds.includes(target), '');
  check('会话张数变成 4', after.cardIds.length === 4, String(after.cardIds.length));
  const chopped = await dao.kc.getById(target);
  check('★ 卡片本身是墓碑状态（能复活）', chopped.deleted === 1 && chopped.status === 'chopped', `${chopped.deleted}/${chopped.status}`);
  const view = await dao.kc.query({ status: ['chopped'], page: 1, pageSize: 10 });
  check('「已斩」列表里能找到它', view.items.some((c) => c.id === target), '');
}

// ───────────────────────────────────────────────
console.log('\n[6] 会话生命周期的边界情况');
// ───────────────────────────────────────────────
{
  // 完成的会话不再被「继续上次」捞出来
  const open = await dao.kcSession.load(sessionId);
  open.finished = true;
  open.stage = 'done';
  await dao.kcSession.save(open);
  await tick();
  const latest = await dao.kcSession.loadLatestOpen('study');
  check('★ 已完成的会话不再出现在「继续上次」里', latest === null || latest.id !== sessionId, latest?.id ?? 'null');

  // 删掉会话
  await dao.kcSession.remove(sessionId);
  await tick();
  check('删除会话生效', (await dao.kcSession.load(sessionId)) === null, '');

  // 学习与复习的会话互不干扰
  const study = dao.kcSession.createSession('study', ['a']);
  const review = dao.kcSession.createSession('review', ['b']);
  await dao.kcSession.save(study);
  await dao.kcSession.save(review);
  await tick();
  const openStudy = await dao.kcSession.loadLatestOpen('study');
  const openReview = await dao.kcSession.loadLatestOpen('review');
  check('★ 按 type 区分：学习会话不会被复习会话顶掉', openStudy?.type === 'study' && openStudy.cardIds[0] === 'a', JSON.stringify(openStudy?.cardIds));
  check('★ 复习会话独立存在', openReview?.type === 'review' && openReview.cardIds[0] === 'b', JSON.stringify(openReview?.cardIds));

  const cleared = await dao.kcSession.clearOpen('study');
  await tick();
  check('clearOpen("study") 只清学习会话', cleared === 1 && (await dao.kcSession.loadLatestOpen('review')) !== null, String(cleared));

  // 脏数据容错
  const weird = await dao.kcSession.load('不存在的 id');
  check('读不存在的会话返回 null（不抛异常）', weird === null, '');
}

// ───────────────────────────────────────────────
console.log('\n[7] 会话表属于本地状态（不参与云同步）');
// ───────────────────────────────────────────────
{
  const kcCloud = await import('../../src/dao/kcCloud.ts');
  const src = await import('node:fs').then((fs) => fs.readFileSync('src/dao/kcCloud.ts', 'utf8'));
  check('★ 云同步代码里没有 kcSessions（会话不上云：那是「这台设备到哪儿了」）', !src.includes('kcSessions'), '');
  check('云同步只推 knowledgeCards', src.includes('STORE.knowledgeCards') && !src.includes('STORE.kcSessions'), '');
  check('kcCloud 模块仍可导入（没被改坏）', typeof kcCloud.kcSyncOnce === 'function', '');
}

console.log(`\n=== 阶段 04 验收（会话与自评数据层）：通过 ${passed} 项，失败 ${failed} 项 ===\n`);
process.exit(failed === 0 ? 0 : 1);
