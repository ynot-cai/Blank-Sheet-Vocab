/**
 * 考核逻辑自检（版本 0.0.21）：`npm run test:exam`
 *
 * 只测**纯逻辑**（不碰 DOM、不联网）：
 *   [1] 抽词：固定个数 / 不足全选 / 记忆次数低者优先 / 并列随机
 *   [2] 抽词：拼写标记 → 额外拼写考察；仅拼写词单独排队
 *   [3] 抽词：分数低于阈值且未被抽到 → 强制加考
 *   [4] 评分：解析 AI 返回（夹分、补齐逐格对错、非法返回）
 *   [5] 评分：本地兜底判分（AI 不可用时的口径）
 *
 * 用法：node --import ./api/_dev/loader-register.mjs api/_dev/test-exam.mjs
 */
import { selectExamWords, examScoreOf, memorizeCountOf } from '../../src/core/examSelect.ts';
import { buildScorePrompt, buildScoreSystemPrompt, localScore, parseScoreResponse, EXAM_MAX_SCORE } from '../../src/services/aiScore.ts';
import { DEFAULT_SCORE_RUBRIC } from '../../src/core/config.ts';

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`);
  }
}

/** 造一个词 */
function word(id, en, opts = {}) {
  return {
    id,
    en,
    phonetic: '',
    example: '',
    senses: [
      { id: `${id}-s0`, text: 'n. 测试1', aliases: [], example: '暂无', enabled: true },
      { id: `${id}-s1`, text: 'v. 测试2', aliases: [], example: '暂无', enabled: true },
    ],
    sourceId: 's',
    rawSources: [],
    attrs: {
      needSpell: opts.needSpell === true,
      failCount: 0,
      failCountTotal: 0,
      reviewCount: 0,
      lastReviewAt: null,
      learnedAt: null,
      reviewPriority: 0,
      examCount: 0,
      examScore: typeof opts.examScore === 'number' ? opts.examScore : null,
    },
    status: opts.status ?? 'unlearned',
    spellOnly: opts.spellOnly === true,
    favorite: false,
    priority: 3,
    learnOrder: null,
    createdAt: 0,
    updatedAt: 0,
  };
}

/** 固定序列的随机源（可重复） */
function seededRandom(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

// ─────────────────────────── [1] 固定个数 / 记忆次数优先 / 并列随机
console.log('\n[1] 抽词：固定个数、不足全选、记忆次数低者优先、并列随机');
{
  const pool = [word('a', 'alpha'), word('b', 'bravo'), word('c', 'charlie'), word('d', 'delta')];
  const picked3 = selectExamWords({ pool, memorizeCount: {}, count: 3, scoreThreshold: 3, random: seededRandom(1) });
  check('count=3 → 正好抽 3 个', picked3.picked.length === 3, String(picked3.picked.length));

  const pickedAll = selectExamWords({ pool, memorizeCount: {}, count: 99, scoreThreshold: 3, random: seededRandom(1) });
  check('★ 单词总数小于单次记忆数 → 全部选中', pickedAll.picked.length === 4, String(pickedAll.picked.length));

  // 记忆次数：a=0、b=5、c=0、d=1，抽 2 个 → 必须来自 {a,c}（次数 0）
  const memorizeCount = { a: 0, b: 5, c: 0, d: 1 };
  const low = selectExamWords({ pool, memorizeCount, count: 2, scoreThreshold: 3, random: seededRandom(7) });
  const ids = low.picked.map((w) => w.id).sort().join(',');
  check('★ 优先抽「记忆次数」低的词（a/c 次数 0，b=5、d=1）', ids === 'a,c', ids);

  // 并列随机：同一批同次数的词，不同随机源 → 顺序不同但集合相同
  const r1 = selectExamWords({ pool, memorizeCount: {}, count: 2, scoreThreshold: 3, random: seededRandom(1) }).picked.map((w) => w.id);
  const r2 = selectExamWords({ pool, memorizeCount: {}, count: 2, scoreThreshold: 3, random: seededRandom(99) }).picked.map((w) => w.id);
  check('并列时随机挑选（两次结果集合相同、顺序可不同）', r1.length === 2 && r2.length === 2, `${r1.join(',')} / ${r2.join(',')}`);

  check('memorizeCountOf：没有记录按 0', memorizeCountOf({}, 'x') === 0 && memorizeCountOf({ x: 3 }, 'x') === 3);
  check('examScoreOf：没有记录返回 null', examScoreOf(word('x', 'x')) === null && examScoreOf(word('y', 'y', { examScore: 4 })) === 4);
}

// ─────────────────────────── [2] 拼写标记 / 仅拼写
console.log('\n[2] 拼写标记 → 额外拼写考察；仅拼写词单独排队');
{
  const pool = [word('a', 'alpha', { needSpell: true }), word('b', 'bravo'), word('c', 'charlie', { needSpell: true })];
  const sel = selectExamWords({ pool, memorizeCount: {}, count: 3, scoreThreshold: 3, random: seededRandom(3) });
  check('★ 被选中且标记「拼写」的词进入拼写名单', sel.spellIds.length === 2 && sel.spellIds.includes('a') && sel.spellIds.includes('c'), sel.spellIds.join(','));

  const spellOnlyWords = [word('z', 'zulu', { spellOnly: true }), word('q', 'quebec')];
  const sel2 = selectExamWords({ pool, memorizeCount: {}, count: 1, scoreThreshold: 3, spellOnlyWords, random: seededRandom(3) });
  check('★ 仅拼写的词单独交给拼写环节', sel2.spellOnly.length === 1 && sel2.spellOnly[0].id === 'z', sel2.spellOnly.map((w) => w.id).join(','));
  const sel3 = selectExamWords({
    pool,
    memorizeCount: {},
    count: 1,
    scoreThreshold: 3,
    spellOnlyWords: [word('y', 'yankee', { spellOnly: true, status: 'chopped' })],
    random: seededRandom(3),
  });
  check('已斩的仅拼写词不再进考核', sel3.spellOnly.length === 0, String(sel3.spellOnly.length));
}

// ─────────────────────────── [3] 分数低于阈值 → 强制加考
console.log('\n[3] 分数低于阈值且未被抽到 → 无视记忆次数强制加考');
{
  // a/c 记忆次数 0，b 记忆次数 9（最低优先被排到最后）、分数 1（低于阈值 3）
  const pool = [word('a', 'alpha'), word('b', 'bravo', { examScore: 1 }), word('c', 'charlie')];
  const sel = selectExamWords({ pool, memorizeCount: { a: 0, b: 9, c: 0 }, count: 2, scoreThreshold: 3, random: seededRandom(5) });
  const ids = sel.picked.map((w) => w.id).sort().join(',');
  check('★ 低分词即使没被抽到也加进本轮', ids === 'a,b,c' && sel.picked.length === 3, ids);
  check('被标记为 forced 的只有那个低分词', sel.forced.length === 1 && sel.forced[0].id === 'b', sel.forced.map((w) => w.id).join(','));

  const highScore = [word('a', 'alpha', { examScore: 5 }), word('b', 'bravo', { examScore: 4 })];
  const sel2 = selectExamWords({ pool: highScore, memorizeCount: {}, count: 1, scoreThreshold: 3, random: seededRandom(5) });
  check('分数不低于阈值的词不会被强制加考', sel2.picked.length === 1 && sel2.forced.length === 0, `${sel2.picked.length}/${sel2.forced.length}`);

  const noScore = [word('a', 'alpha'), word('b', 'bravo')];
  const sel3 = selectExamWords({ pool: noScore, memorizeCount: {}, count: 1, scoreThreshold: 3, random: seededRandom(5) });
  check('还没考过（没有分数）的词不会被当成「低分」', sel3.picked.length === 1, String(sel3.picked.length));
}

// ─────────────────────────── [4] 解析 AI 评分
console.log('\n[4] 评分：解析 AI 返回（不可信输入的边界）');
{
  const ok = parseScoreResponse('{"score":4,"inputs":[true,false],"comment":"漏了第二个义项"}', 2);
  check('正常 JSON 能解析', ok !== null && ok.score === 4 && ok.inputs.join(',') === 'true,false' && ok.comment.includes('漏'), JSON.stringify(ok));

  const fenced = parseScoreResponse('```json\n{"score":5,"inputs":[true,true],"comment":"全部义项都答对了"}\n```', 2);
  check('带 markdown 围栏也能解析', fenced !== null && fenced.score === 5, JSON.stringify(fenced));

  const clamped = parseScoreResponse('{"score":99,"inputs":[true,true,true],"comment":""}', 2);
  check('★ 分数被夹到 0~5，inputs 长度对齐义项个数', clamped !== null && clamped.score === EXAM_MAX_SCORE && clamped.inputs.length === 2, JSON.stringify(clamped));

  const padded = parseScoreResponse('{"score":3}', 3);
  check('缺 inputs 时按 false 补齐', padded !== null && padded.inputs.length === 3 && padded.inputs.every((v) => v === false), JSON.stringify(padded));

  check('非法 JSON → null', parseScoreResponse('不是 JSON', 2) === null);
  check('缺 score → null', parseScoreResponse('{"inputs":[true]}', 1) === null);

  const prompt = buildScorePrompt(word('a', 'abandon'), ['放弃', '']);
  check('评分提示里带上了单词与义项', prompt.includes('abandon') && prompt.includes('义项代表'), prompt.slice(0, 60));
  check('评分提示里带上用户答案（空格标成「空着没填」）', prompt.includes('放弃') && prompt.includes('空着没填'), prompt.slice(-80));

  // ★ 0.0.23：评分标准改成设置项，可编辑并原样进提示词
  const custom = buildScoreSystemPrompt('【我的标准】\n只答对一个义项也给 5 分。');
  check('★ 自定义「考核评分标准」被原样拼进 system prompt', custom.includes('【我的标准】') && custom.includes('只答对一个义项也给 5 分。'), custom.slice(-80));
  check('system prompt 仍带有 JSON 输出骨架（用户标准不能覆盖格式）', custom.includes('"score"') && custom.includes('"inputs"'), custom.slice(0, 60));
  const fallback = buildScoreSystemPrompt('   ');
  check('★ 评分标准留空时回落到内置默认标准', fallback.includes(DEFAULT_SCORE_RUBRIC.slice(0, 12)), fallback.slice(-80));
  check('默认标准是一份完整的 5 分制标准（含分档）', DEFAULT_SCORE_RUBRIC.includes('5 分') && DEFAULT_SCORE_RUBRIC.includes('0 分'), DEFAULT_SCORE_RUBRIC.slice(0, 40));
}

// ─────────────────────────── [5] 本地兜底判分
console.log('\n[5] 评分：AI 不可用时的本地兜底（与旧版判分口径一致）');
{
  const w = word('a', 'bank');
  w.senses = [
    { id: 's0', text: 'n. 银行', aliases: ['储蓄所'], example: '暂无', enabled: true },
    { id: 's1', text: 'n. 河岸', aliases: ['岸边'], example: '暂无', enabled: true },
  ];
  const full = localScore(w, ['银行', '河岸']);
  check('★ 两个义项都答对 → 5 分', full.score === 5 && full.inputs.every(Boolean), JSON.stringify(full));
  const half = localScore(w, ['银行', '大海']);
  check('★ 答对一个 → 按比例 3 分（四舍五入）', half.score === 3 && half.inputs[0] === true && half.inputs[1] === false, JSON.stringify(half));
  const alias = localScore(w, ['储蓄所', '岸边']);
  check('答近义词算对（沿用旧版 senseMatch）', alias.score === 5, JSON.stringify(alias));
  const empty = localScore(w, ['', '']);
  check('空答案 → 0 分', empty.score === 0, JSON.stringify(empty));
  check('兜底点评写明了是本地判分', full.comment.includes('本地判分'), full.comment);
}

console.log(`\n考核逻辑自检：${passed} 项通过，${failed} 项失败`);
if (failed > 0) process.exit(1);
