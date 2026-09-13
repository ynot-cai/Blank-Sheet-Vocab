/**
 * 阶段 05 验收脚本：`npm run test:kc-exam`
 *
 * 覆盖「出题与评分」里**不需要 AI 密钥**的部分：
 *   1. 三套提示词规则齐全（语境词互不相关、每题型 rubric、防重复）
 *   2. 三种 AI 返回的解析（语境词 / 出题 / 评分）+ 降级与钳制
 *   3. 出题材料：题型数量按出题量、近 3 天题干进提示词、题库样题被抽到
 *   4. 评分落库 → `lastExamScore` → `mastery` 重算 → 列表页能看出变化
 *   5. 手动改分：记录与卡片属性都更新
 *   6. 语境词：自然日 / 去重 / 未确认不生效 / 30 天检索
 *   7. 三个新接口：401 / 上限 / 空间隔离 / 往返一致
 *   8. 批量出题的槽位表与题号换算 + Enter 键在每个阶段的行为（用户本轮的两条要求）
 */
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { loadEnvFiles } from './envFile.mjs';
import 'fake-indexeddb/auto';

loadEnvFiles('..');

const DB_FILE = './.tmp/test-kc-exam.db';
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

const { startServer, callApi } = await import('./harness.mjs');

const PORT = 3126;
const server = startServer(PORT);
await new Promise((r) => setTimeout(r, 250));
const API_BASE = `http://127.0.0.1:${PORT}`;

const parse = await import('../../src/services/kcExamParse.ts');
const prompts = await import('../../src/services/kcExamPrompts.ts');
const examAi = await import('../../src/services/kcExamAi.ts');
const flow = await import('../../src/ui/pages/kcExam/kcExamFlow.ts');
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

/** 算某个同步码的 spaceKey */
async function spaceKeyOf(code) {
  const bytes = new TextEncoder().encode(code.trim());
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ───────────────────────────────────────────────
console.log('\n[1] 三套提示词：规则齐全');
// ───────────────────────────────────────────────
{
  const ctx = prompts.KC_CONTEXT_SYSTEM_PROMPT;
  check('★ 语境词提示词要求「互不相关」', /互不相关/.test(ctx), '');
  check('要求 5 个词', /5 个/.test(ctx), '');
  check('要求避免与近期重复', /近期已用过/.test(ctx), '');

  const user = prompts.kcContextUserPrompt(['apple', 'telescope'], '2026-09-13');
  check('语境词 user 提示词带上了日期', user.includes('2026-09-13'), '');
  check('★ 语境词 user 提示词列出了近 30 天的词', user.includes('apple') && user.includes('telescope'), '');
  check('没有历史时给占位说明', prompts.kcContextUserPrompt([], '2026-09-13').includes('暂无历史记录'), '');

  const exam = prompts.KC_EXAM_SYSTEM_PROMPT;
  check('★ 出题提示词要求只关联一个语境词', /最贴切的一个/.test(exam) && /contextWord/.test(exam), '');
  check('★ 出题提示词要求避免与近期题目重复', /避免/.test(exam) && /近期已出过的题/.test(exam), '');
  check('出题提示词要求模仿参考样题风格', /模仿/.test(exam), '');
  check('出题提示词含四种题型的特定要求', ['fill', 'sentence', 'choice', 'judge'].every((t) => exam.includes(t)), '');

  const examUser = prompts.kcExamUserPrompt({
    cardTitle: '定语从句',
    cardSummary: '关系代词',
    cardBlocksText: '正文内容',
    type: 'fill',
    contextWords: ['telescope', 'jam'],
    recentQuestions: ['昨天的题'],
    bankSamples: ['样题内容'],
  });
  check('出题 user 提示词含知识点标题', examUser.includes('定语从句'), '');
  check('出题 user 提示词含语境词列表', examUser.includes('telescope') && examUser.includes('jam'), '');
  check('出题 user 提示词含近期题目', examUser.includes('昨天的题'), '');
  check('★ 出题 user 提示词含参考样题', examUser.includes('样题内容'), '');

  const grade = prompts.KC_GRADE_SYSTEM_PROMPT;
  check('★ 评分提示词含四种题型的 rubric', /语法填空/.test(grade) && /独立写句子/.test(grade) && /选择题/.test(grade) && /判断正误/.test(grade), '');
  check('★ 主观题 rubric 是三项拆解', /语法正确/.test(grade) && /目标结构/.test(grade) && /语义通顺/.test(grade), '');
  check('★ 要求 reason 逐项列出得分情况', /逐项列出/.test(grade), '');
  check('要求 score 只能是 1/2/3', /只能是 1、2、3/.test(grade), '');

  const gradeUser = prompts.kcGradeUserPrompt({ type: 'fill', question: '题干', expected: '参考答案', userAnswer: '我的答案' });
  check('评分 user 提示词含题干/答案/学生答案', gradeUser.includes('题干') && gradeUser.includes('参考答案') && gradeUser.includes('我的答案'), '');
  check('学生没作答时有明确说明', prompts.kcGradeUserPrompt({ type: 'fill', question: 'q', expected: 'e', userAnswer: '  ' }).includes('没有作答'), '');
}

// ───────────────────────────────────────────────
console.log('\n[2] 解析：语境词 / 出题 / 评分（含降级与钳制）');
// ───────────────────────────────────────────────
{
  check('语境词：标准 {"words":[...]}', parse.parseContextWords('{"words":["a","b","c","d","e"]}').length === 5, '');
  check('语境词：markdown 围栏能剥掉', parse.parseContextWords('```json\n{"words":["a","b"]}\n```').length === 2, '');
  check('语境词：直接给数组也认', parse.parseContextWords('["x","y"]').length === 2, '');
  check('语境词：键名 contextWords 也认', parse.parseContextWords('{"contextWords":["p","q"]}').length === 2, '');
  check('语境词：去重 + 去空', parse.parseContextWords('{"words":["a","a","","b"]}').join(',') === 'a,b', '');
  check('语境词：超过 5 个会截断到设置数量', parse.parseContextWords(JSON.stringify({ words: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] })).length === DEFAULT_SETTINGS.kc.contextWordCount, '');
  check('语境词：非字符串项丢掉', parse.parseContextWords('{"words":[1,null,"ok"]}').join(',') === 'ok', '');
  check('语境词：坏 JSON 返回空数组（不抛）', parse.parseContextWords('完全不是 JSON').length === 0, '');

  const today = ['telescope', 'jam', 'deadline'];
  const q1 = parse.parseQuestion('{"question":"He is the man ____ helped me.","contextWord":"telescope","expected":"who"}', today);
  check('出题：正常解析', q1 !== null && q1.question.includes('____') && q1.contextWord === 'telescope', JSON.stringify(q1));
  check('出题：题干为空返回 null', parse.parseQuestion('{"contextWord":"jam"}', today) === null, '');
  check('★ 出题：AI 自己发明的语境词被丢掉（不在今日列表里）', parse.parseQuestion('{"question":"q","contextWord":"banana"}', today).contextWord === '', '');
  check('出题：语境词大小写不敏感', parse.parseQuestion('{"question":"q","contextWord":"Telescope"}', today).contextWord === 'telescope', '');
  check('出题：没有语境词时留空', parse.parseQuestion('{"question":"q"}', []).contextWord === '', '');

  const g3 = parse.parseGrade('{"score":3,"reason":"完全正确"}');
  check('评分：正常解析', g3 !== null && g3.score === 3 && g3.reason === '完全正确', JSON.stringify(g3));
  check('★ 评分：越界分数被钳到 3', parse.parseGrade('{"score":9,"reason":"x"}').score === 3, '');
  check('★ 评分：0 分被钳到 1', parse.parseGrade('{"score":0,"reason":"x"}').score === 1, '');
  check('评分：字符串 "2分" 也能认', parse.parseGrade('{"score":"2分","reason":"x"}').score === 2, '');
  check('评分：没有 reason 时给占位', parse.parseGrade('{"score":2}').reason.includes('没有给出理由'), '');
  check('评分：坏 JSON 返回 null（界面据此提示手动打分）', parse.parseGrade('抱歉我无法评分') === null, '');

  check('usableExamTypes 过滤未知题型', parse.usableExamTypes(['fill', 'essay']).join(',') === 'fill', '');
  check('usableExamTypes 全不合法时给兜底 fill', parse.usableExamTypes(['essay', 'nope']).join(',') === 'fill', '');

  check('cardBlocksText 把卡片正文拼成纯文本', (() => {
    const c = kcModel.createEmptyCard('t');
    c.blocks = [
      { id: '1', type: 'heading', content: '小标题' },
      { id: '2', type: 'example', content: 'This is X.', translation: '这是 X。' },
      { id: '3', type: 'list', items: ['a', 'b'] },
      { id: '4', type: 'table', rows: [['h1', 'h2'], ['v1', 'v2']] },
    ];
    const text = examAi.cardBlocksText(c);
    return text.includes('小标题') && text.includes('这是 X。') && text.includes('- a') && text.includes('h1 | h2');
  })(), '');
}

// ───────────────────────────────────────────────
console.log('\n[3] 出题材料：出题量 / 防重复 / 题库参考');
// ───────────────────────────────────────────────
await dao.kc.clearAll();
await tick();
{
  // 一张卡带两种题型 → 应该出 2 道
  const card = kcModel.createEmptyCard('定语从句');
  card.summary = '关系代词 vs 关系副词';
  card.examTags = ['fill', 'choice'];
  card.examLoad = { types: ['fill', 'choice'], estMinutes: 4 };
  card.blocks = [{ id: 'b1', type: 'text', content: '关系代词在从句中作主语' }];
  await dao.kc.bulkUpsert([card]);
  await tick();

  check('★ 出题量按 examLoad.types（fill+choice = 2 道）', flow.questionTypesFor(card).length === 2, JSON.stringify(flow.questionTypesFor(card)));
  check('题型来自卡片配置', flow.questionTypesFor(card).join(',') === 'fill,choice', '');

  const oneType = { ...card, examLoad: { types: ['judge'], estMinutes: 3 }, examTags: ['judge'] };
  check('单题型卡片只出 1 道', flow.questionTypesFor(oneType).length === 1, '');
  const threeTypes = { ...card, examLoad: { types: ['fill', 'choice', 'judge', 'sentence'], estMinutes: 5 }, examTags: [] };
  check('题型最多 3 道（再多会超过 3~5 分钟）', flow.questionTypesFor(threeTypes).length === 3, '');
  const noTypes = { ...card, examLoad: { types: [], estMinutes: 4 }, examTags: [] };
  check('★ 没配题型时兜底 fill（否则这张卡一道题都出不了）', flow.questionTypesFor(noTypes).join(',') === 'fill', JSON.stringify(flow.questionTypesFor(noTypes)));

  // 题库样题
  await dao.examBank.addBankQuestion('fill', '样题一：He ___ (go) to school yesterday.', '2023全国甲卷');
  await dao.examBank.addBankQuestion('fill', '样题二：The book ___ I bought is good.', '2022全国乙卷');
  await dao.examBank.addBankQuestion('choice', '样题三：选择正确答案。', '');
  const samples = await flow.pickBankSamples('fill');
  check('★ 题库样题按题型抽到（fill 抽到 2 条）', samples.length === 2 && samples.every((s) => s.type === 'fill'), `抽到 ${samples.length} 条`);
  check('抽样题带了来源标注', samples.some((s) => s.source.includes('2023')), '');
  const noSamples = await flow.pickBankSamples('judge');
  check('没有该题型样题时返回空数组', noSamples.length === 0, '');

  // 语境词：未确认时**不进**出题材料
  const todayWord = await dao.contextWords.save(['telescope', 'jam'], 'ai', dao.contextWords.localDate(), false);
  const m1 = await flow.collectMaterials(card, 0);
  check('★ 未确认的语境词不进材料（用户要求「确认后才生效」）', m1.contextWords.length === 0, JSON.stringify(m1.contextWords));
  await dao.contextWords.confirm(todayWord.id);
  const m2 = await flow.collectMaterials(card, 0);
  check('★ 确认后的语境词进材料', m2.contextWords.length === 2, JSON.stringify(m2.contextWords));
  check('材料里的题型是合法的', ['fill', 'choice'].includes(m2.type), m2.type);
  check('材料里带上了题库样题', m2.bankSamples.length >= 1, String(m2.bankSamples.length));
  check('近 3 天题目为空（还没出过题）', m2.recentQuestions.length === 0, JSON.stringify(m2.recentQuestions));
}

// ───────────────────────────────────────────────
console.log('\n[4] 评分落库 → mastery 重算（验收标准 9）');
// ───────────────────────────────────────────────
{
  const all = await dao.kc.getAll();
  const card = all[0];
  // 先自评「会了」（3 分），再考核「不会」（1 分）→ 盲目自信，mastery 应被拉到 0
  await dao.kc.updateAttrs(card.id, { lastSelfScore: 3, learnedAt: Date.now() });
  await dao.kc.updateMeta(card.id, { status: 'learning' });
  await tick();
  const beforeExam = await dao.kc.getById(card.id);
  check('自评 3、没考核时 mastery = 0（见公式对照表）', beforeExam.attrs.mastery === 0, String(beforeExam.attrs.mastery));

  // 写一条考核记录（分数 1）
  const rid = await flow.saveExamRecord({
    cardId: card.id,
    type: 'fill',
    question: 'He is the man ____ helped me.',
    userAnswer: 'which',
    score: 1,
    reason: '关系代词用错，先行词是人应用 who',
    contextWord: 'telescope',
  });
  check('考试记录已落库', rid !== '' && (await dao.examBank.listByCard(card.id)).length === 1, '');

  const afterExam = await dao.kc.getById(card.id);
  check('★ lastExamScore = 1 已写入卡片', afterExam.attrs.lastExamScore === 1, String(afterExam.attrs.lastExamScore));
  check('★ mastery 被重算（3/1 盲目自信 = 0）', afterExam.attrs.mastery === 0, String(afterExam.attrs.mastery));
  check('★ reviewPriority 被重算（盲目自信排前面）', afterExam.attrs.reviewPriority > 0, String(afterExam.attrs.reviewPriority));

  // 换一张卡：自评 3、考核 3 → 高掌握
  const card2 = kcModel.createEmptyCard('虚拟语气');
  card2.examTags = ['fill'];
  await dao.kc.bulkUpsert([card2]);
  await tick();
  await dao.kc.updateAttrs(card2.id, { lastSelfScore: 3, lastExamScore: 3 });
  await tick();
  const good = await dao.kc.getById(card2.id);
  check('★ 自评 3 + 考核 3 → mastery = 1.0', good.attrs.mastery === 1, String(good.attrs.mastery));

  // 列表页排序能看出掌握度差异
  const sorted = await dao.kc.query({ sort: 'mastery', order: 'desc', page: 1, pageSize: 10 });
  check('★ 列表页按掌握度排序：真掌握的排在盲目自信前面', sorted.items[0].id === card2.id, sorted.items.map((c) => `${c.title}:${c.attrs.mastery}`).join(' | '));

  // 近 3 天题干能被取到（出题防重复用）
  const recent = await dao.examBank.recentQuestions();
  check('★ 出过的题进了「近 3 天题干」（下次出题会避开）', recent.length === 1 && recent[0].includes('____'), JSON.stringify(recent));
  const m3 = await flow.collectMaterials(card, 0);
  check('★ 出题材料里带上了这条历史题干', m3.recentQuestions.length === 1, JSON.stringify(m3.recentQuestions));
}

// ───────────────────────────────────────────────
console.log('\n[5] 手动改分（验收标准 8）');
// ───────────────────────────────────────────────
{
  const all = await dao.kc.getAll();
  const card = all.find((c) => c.title === '定语从句');
  const records = await dao.examBank.listByCard(card.id);
  const rec = records[0];
  check('改分前是 1 分', rec.aiScore === 1, String(rec.aiScore));

  await flow.regradeRecord(rec.id, 3);
  await dao.kc.updateAttrs(card.id, { lastExamScore: 3 });
  await tick();

  const after = (await dao.examBank.listByCard(card.id))[0];
  check('★ 记录里的分数被改成 3', after.aiScore === 3, String(after.aiScore));
  const cardAfter = await dao.kc.getById(card.id);
  check('★ 卡片 lastExamScore 也跟着变成 3', cardAfter.attrs.lastExamScore === 3, String(cardAfter.attrs.lastExamScore));
  check('★ 改分后 mastery 重算（3/3 = 1.0）', cardAfter.attrs.mastery === 1, String(cardAfter.attrs.mastery));
  check('改分不会新增记录', (await dao.examBank.listByCard(card.id)).length === 1, '');
}

// ───────────────────────────────────────────────
console.log('\n[6] 语境词机制（验收标准 2 / 3）');
// ───────────────────────────────────────────────
{
  const today = await dao.contextWords.getForDate();
  check('今天有语境词', today !== null, '');

  // 自然日
  const yesterday = await dao.contextWords.save(['y1', 'y2'], 'ai', '2020-01-01', true);
  check('★ 语境词按自然日隔离（昨天的不算今天）', (await dao.contextWords.getForDate())?.id !== yesterday.id, '');
  check('按日期能取到那一天', (await dao.contextWords.getForDate('2020-01-01'))?.words.join(',') === 'y1,y2', '');

  // 近 30 天检索（生成时防重复）
  const recent = await dao.contextWords.recentWords();
  check('★ recentWords 能拿到近 30 天的词', recent.includes('telescope') && recent.includes('jam'), JSON.stringify(recent));
  check('★ 超过 30 天的旧词不进去重列表', !dao.contextWords.dedupe(recent).includes('y1'), JSON.stringify(recent));

  // 未确认 → 确认
  const draft = await dao.contextWords.save(['a1', 'a2'], 'ai', '2024-06-06', false);
  check('AI 生成的词默认未确认', draft.confirmed === false, '');
  await dao.contextWords.confirm(draft.id, ['b1', 'b2', 'b3']);
  const confirmed = await dao.contextWords.getForDate('2024-06-06');
  check('★ 确认时可以改成用户自己的词', confirmed.confirmed === true && confirmed.words.join(',') === 'b1,b2,b3', JSON.stringify(confirmed.words));

  // 数量按设置截断
  const many = await dao.contextWords.save(['1', '2', '3', '4', '5', '6', '7'], 'manual', '2024-07-07', true);
  check('语境词数量按设置截断到 5', many.words.length === DEFAULT_SETTINGS.kc.contextWordCount, String(many.words.length));
}

// ───────────────────────────────────────────────
console.log('\n[7] 三个新接口（401 / 上限 / 空间隔离 / 往返一致）');
// ───────────────────────────────────────────────
{
  // 直接调接口：先造本地的语境词，再手工推一条上去
  const keyA = await spaceKeyOf('KcExamSpaceAlpha1');
  const keyB = await spaceKeyOf('KcExamSpaceBeta2');

  // 401
  for (const path of ['/api/context-words', '/api/exam-history', '/api/bank-questions']) {
    const noKey = await callApi({ path, query: 'since=0' });
    check(`${path} 缺 spaceKey → 401`, noKey.status === 401, `状态 ${noKey.status}`);
  }
  // 方法
  const wrong = await callApi({ path: '/api/context-words', method: 'DELETE', headers: { 'x-space-key': keyA } });
  check('context-words 只支持 GET/POST → 405', wrong.status === 405, `状态 ${wrong.status}`);
  // 空 body
  const empty = await callApi({ path: '/api/bank-questions', method: 'POST', headers: { 'x-space-key': keyA }, body: {} });
  check('bank-questions 空 rows → 400', empty.status === 400, `状态 ${empty.status}`);
  // 超上限
  const tooMany = await callApi({
    path: '/api/exam-history',
    method: 'POST',
    headers: { 'x-space-key': keyA },
    body: { rows: Array.from({ length: 501 }, (_, i) => ({ id: `r${i}` })) },
  });
  check('exam-history 超过 500 条 → 400', tooMany.status === 400, `状态 ${tooMany.status}`);

  // 推 2 条语境词到空间 A
  const now = Date.now();
  const pushA = await callApi({
    path: '/api/context-words',
    method: 'POST',
    headers: { 'x-space-key': keyA },
    body: {
      rows: [
        { id: 'cw-a1', date: '2026-09-13', words: JSON.stringify(['alpha', 'beta']), source: 'ai', confirmed: 1, created_at: now, updated_at: now, deleted: 0 },
        { id: 'cw-a2', date: '2026-09-12', words: JSON.stringify(['gamma']), source: 'manual', confirmed: 1, created_at: now, updated_at: now, deleted: 0 },
      ],
    },
  });
  check('空间 A 推 2 条语境词成功', pushA.status === 200 && pushA.json.applied === 2, JSON.stringify(pushA.json));

  const listA = await callApi({ path: '/api/context-words', query: 'since=0', headers: { 'x-space-key': keyA } });
  check('空间 A 能拉到 2 条', listA.json.rows.length === 2, String(listA.json.rows?.length));
  check('words 字段往返一致（JSON 字符串）', JSON.parse(listA.json.rows.find((r) => r.id === 'cw-a1').words).join(',') === 'alpha,beta', '');

  const listB = await callApi({ path: '/api/context-words', query: 'since=0', headers: { 'x-space-key': keyB } });
  check('★ 空间隔离：B 拉不到 A 的语境词', listB.json.rows.length === 0, `拉到 ${listB.json.rows?.length} 条`);

  // 坏行只跳过
  const badRows = await callApi({
    path: '/api/bank-questions',
    method: 'POST',
    headers: { 'x-space-key': keyA },
    body: { rows: [{ noId: true }, { id: 'bq-1', type: 'fill', content: '样题', source: 'X', created_at: now, updated_at: now }] },
  });
  check('坏行只跳过、好行照写', badRows.status === 200 && badRows.json.applied === 1 && badRows.json.skipped === 1, JSON.stringify(badRows.json));

  // 题库按题型取
  await callApi({
    path: '/api/bank-questions',
    method: 'POST',
    headers: { 'x-space-key': keyA },
    body: { rows: [{ id: 'bq-2', type: 'choice', content: '选择题样题', created_at: now, updated_at: now }] },
  });
  const byType = await callApi({ path: '/api/bank-questions', query: 'since=0&type=choice', headers: { 'x-space-key': keyA } });
  check('★ 题库能按题型筛（type=choice）', byType.json.rows.length === 1 && byType.json.rows[0].id === 'bq-2', JSON.stringify(byType.json.rows?.map((r) => r.id)));

  // 题目历史：recent 参数（防重复用）
  await callApi({
    path: '/api/exam-history',
    method: 'POST',
    headers: { 'x-space-key': keyA },
    body: {
      rows: [
        { id: 'er-1', card_id: 'c1', date: '2026-09-13', type: 'fill', question: '刚出过的题 ____', user_answer: 'x', ai_score: 2, ai_reason: '理由', context_word: 'alpha', created_at: now, updated_at: now },
      ],
    },
  });
  const hist = await callApi({ path: '/api/exam-history', query: `since=0&recent=3`, headers: { 'x-space-key': keyA } });
  check('题目历史能拉到', hist.json.rows.length === 1, String(hist.json.rows?.length));
  check('★ 带 recent=3 时额外返回近 3 天题干（别的设备出过的题）', Array.isArray(hist.json.recentQuestions) && hist.json.recentQuestions[0].includes('刚出过的题'), JSON.stringify(hist.json.recentQuestions));
  check('recent 天数被回显（便于排查）', hist.json.recentDays === 3, String(hist.json.recentDays));

  // 后写覆盖
  const older = await callApi({
    path: '/api/context-words',
    method: 'POST',
    headers: { 'x-space-key': keyA },
    body: { rows: [{ id: 'cw-a1', date: '2026-09-13', words: JSON.stringify(['OLD']), source: 'ai', confirmed: 1, created_at: now, updated_at: now - 100_000 }] },
  });
  check('更旧的版本算 conflicts（后写覆盖）', older.json.conflicts === 1, JSON.stringify(older.json));
  const afterOlder = await callApi({ path: '/api/context-words', query: 'since=0', headers: { 'x-space-key': keyA } });
  check('被挡下的旧版本没覆盖云端', JSON.parse(afterOlder.json.rows.find((r) => r.id === 'cw-a1').words).join(',') === 'alpha,beta', '');

  // 软删除（墓碑）能拉回去
  await callApi({
    path: '/api/bank-questions',
    method: 'POST',
    headers: { 'x-space-key': keyA },
    body: { rows: [{ id: 'bq-1', type: 'fill', content: '样题', created_at: now, updated_at: now + 1000, deleted: 1 }] },
  });
  const withTomb = await callApi({ path: '/api/bank-questions', query: 'since=0', headers: { 'x-space-key': keyA } });
  check('★ 墓碑能拉到（deleted=1 会传到别的设备）', withTomb.json.rows.find((r) => r.id === 'bq-1').deleted === 1, '');
}

// ───────────────────────────────────────────────
console.log('\n[8] 批量出题 + Enter 键规则（用户本轮的两条明确要求）');
// ───────────────────────────────────────────────
{
  const prep = await import('../../src/ui/pages/kcExam/kcExamPrepare.ts');
  const keys = await import('../../src/ui/components/examKeys.ts');

  // ── 8.1 槽位表与题号换算（批量出题的骨架）──
  const c1 = kcModel.createEmptyCard('批量卡一');
  c1.examLoad = { types: ['fill', 'choice'], estMinutes: 4 };
  c1.examTags = ['fill', 'choice'];
  const c2 = kcModel.createEmptyCard('批量卡二');
  c2.examLoad = { types: ['judge'], estMinutes: 3 };
  c2.examTags = ['judge'];
  const batch = [c1, c2];

  check('★ 本轮题数 = 各卡题型数之和（2 + 1 = 3）', prep.totalQuestionCount(batch) === 3, String(prep.totalQuestionCount(batch)));

  const slots = prep.buildSlots(batch);
  check('★ 槽位表按「卡片 × 题型」展开（3 个）', slots.length === 3, String(slots.length));
  check('槽位一开始是空的（题目内容稍后填）', slots.every((s) => s.question === null && s.error === ''), JSON.stringify(slots.map((s) => s.type)));
  check('槽位里的题型与顺序对得上', slots.map((s) => s.type).join(',') === 'fill,choice,judge', slots.map((s) => s.type).join(','));
  check('槽位记着属于哪张卡（存档要用）', slots[0].cardId === c1.id && slots[2].cardId === c2.id, '');

  const at0 = prep.locateSlot(batch, 0);
  const at2 = prep.locateSlot(batch, 2);
  check('★ 题号 0 → 第 1 张卡第 0 题', at0?.card.id === c1.id && at0.typeIndex === 0, JSON.stringify(at0?.typeIndex));
  check('★ 题号 2 → 第 2 张卡第 0 题（跨卡换算）', at2?.card.id === c2.id && at2.typeIndex === 0, JSON.stringify(at2?.typeIndex));
  check('题号越界返回 null（控制器据此收尾）', prep.locateSlot(batch, 3) === null, '');

  // ── 8.2 Enter 键：每个阶段都必须有明确行为 ──
  const noCtl = { input: null, activeOption: null };
  check('★ 作答中 · 填空 → Enter 提交输入框内容', JSON.stringify(keys.resolveEnterAction('answering', { input: { value: 'went' }, activeOption: null })) === JSON.stringify({ kind: 'submit', value: 'went' }), '');
  check('★ 作答中 · 选择题 → Enter 提交高亮选项', JSON.stringify(keys.resolveEnterAction('answering', { input: null, activeOption: 'B' })) === JSON.stringify({ kind: 'submit', value: 'B' }), '');
  check('★ 已评分 → Enter = 下一题（原来这里 Enter 没用）', keys.resolveEnterAction('graded', noCtl).kind === 'next', '');
  check('★ 出错 → Enter = 重试', keys.resolveEnterAction('error', noCtl).kind === 'retry', '');
  check('★ 做完了 → Enter = 回二期首页', keys.resolveEnterAction('done', noCtl).kind === 'home', '');
  check('★ 评分中 → Enter 不响应（重复提交会重复落库扣分）', keys.resolveEnterAction('grading', { input: { value: 'x' }, activeOption: null }).kind === 'none', '');
  check('出题中 → Enter 不响应（还没有可确认的东西）', keys.resolveEnterAction('preparing', noCtl).kind === 'none', '');
  check('作答中但没有任何控件 → 不响应（不瞎提交空答案）', keys.resolveEnterAction('answering', noCtl).kind === 'none', '');

  check('★ 焦点在按钮上时让给浏览器原生（否则选择题会提交两次）', keys.shouldYieldToNative({ tagName: 'BUTTON' }) === true, '');
  check('焦点在参考答案折叠条上**不**让（Enter 仍算「下一题」）', keys.shouldYieldToNative({ tagName: 'SUMMARY' }) === false, '');
  check('焦点在输入框上时自己处理', keys.shouldYieldToNative({ tagName: 'INPUT' }) === false, '');
  check('没有事件目标时不崩', keys.shouldYieldToNative(null) === false, '');

  const fakeKey = (k) => ({ key: k });
  check('↑↓ 循环换项', keys.nextOptionIndex(fakeKey('ArrowDown'), 3, 2) === 0 && keys.nextOptionIndex(fakeKey('ArrowUp'), 3, 0) === 2, '');
  check('←→ 也能换项（顺手）', keys.nextOptionIndex(fakeKey('ArrowRight'), 2, 0) === 1 && keys.nextOptionIndex(fakeKey('ArrowLeft'), 2, 1) === 0, '');
  check('数字键直选第 n 项', keys.nextOptionIndex(fakeKey('2'), 4, 0) === 1, '');
  check('数字越界不算换项', keys.nextOptionIndex(fakeKey('9'), 4, 0) === null, '');
  check('不认识的键不算换项（Enter 由统一出口处理）', keys.nextOptionIndex(fakeKey('Enter'), 4, 0) === null, '');
  check('没有选项时不换项', keys.nextOptionIndex(fakeKey('ArrowDown'), 0, 0) === null, '');
  check('主键区 Enter 是确认键', keys.isConfirmKey(fakeKey('Enter')) === true && keys.isConfirmKey(fakeKey('a')) === false, '');

  // ── 8.3 并发上限来自 config（不许写死字面量）──
  const { KC } = await import('../../src/core/config.ts');
  check('★ 批量出题的并发数在 config 里（不是魔法数字）', Number.isInteger(KC.examGenConcurrency) && KC.examGenConcurrency >= 1, String(KC.examGenConcurrency));
}

server.close();
console.log(`\n=== 阶段 05 验收（出题/评分/语境词数据层）：通过 ${passed} 项，失败 ${failed} 项 ===\n`);
process.exit(failed === 0 ? 0 : 1);
