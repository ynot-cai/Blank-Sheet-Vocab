/**
 * 拼写强化自检（版本 0.0.25）：`npm run test:spell`
 *
 * 只测**纯逻辑**（不碰 DOM、不碰库）：
 *   [1] 计分：满分 5，小喇叭 −1、提示 −1，下限 0
 *   [2] 提示字母：第一次首字母，之后逐个追加
 *   [3] 专属优先级：加权公式（权重可配置）+ 排序
 *   [4] 选词：只取标记了「拼写易错」的词、按优先级降序、队列长度可配置
 *   [5] 重排：未满分 → 间隔 5 个单词后插回；剩余不足 5 个 → 追加到末尾
 *
 * 用法：node --import ./api/_dev/loader-register.mjs api/_dev/test-spell.mjs
 */
import {
  SPELL_MAX_SCORE,
  SPELL_NEVER_PASSED_BONUS,
  buildSpellQueue,
  sortSpellCandidates,
  takeCycleBatch,
  computeSpellPriority,
  hintLetters,
  reinsertEntry,
  repeatInsertIndex,
  spellScore,
} from '../../src/core/spellSelect.ts';
import { DEFAULT_SETTINGS } from '../../src/core/config.ts';

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

function word(id, en, opts = {}) {
  return {
    id,
    en,
    phonetic: '',
    example: '',
    senses: [{ id: `${id}-s0`, text: 'n. 测试', aliases: [], example: '暂无', enabled: true }],
    sourceId: 's',
    rawSources: [],
    attrs: {
      needSpell: opts.needSpell !== false,
      failCount: opts.failCount ?? 0,
      failCountTotal: opts.failCountTotal ?? 0,
      examCount: opts.examCount ?? 10,
      reviewCount: opts.reviewCount ?? 0,
      lastReviewAt: opts.lastReviewAt ?? null,
      learnedAt: null,
      reviewPriority: 0,
      examScore: null,
    },
    status: opts.status ?? 'learned',
    // ★ 0.0.27：拼写强化的入场标签改成「仅拼写」（spellOnly）
    spellOnly: opts.spellOnly !== false,
    priority: opts.priority ?? 3,
    learnOrder: null,
    createdAt: 0,
    updatedAt: 0,
  };
}

const settings = DEFAULT_SETTINGS.spell;

// ─────────────────────────── [1] 计分
console.log('\n[1] 计分：满分 5，小喇叭 / 提示各扣 1，下限 0');
{
  check('★ 没点任何按钮 = 5 分', spellScore(0, 0) === SPELL_MAX_SCORE, String(spellScore(0, 0)));
  check('★ 点一次小喇叭 = 4 分', spellScore(0, 1) === 4, String(spellScore(0, 1)));
  check('★ 点一次提示 = 4 分', spellScore(1, 0) === 4, String(spellScore(1, 0)));
  check('各点一次 = 3 分', spellScore(1, 1) === 3, String(spellScore(1, 1)));
  check('★ 扣分有下限，不会变负', spellScore(9, 9) === 0, String(spellScore(9, 9)));
}

// ─────────────────────────── [2] 提示字母
console.log('\n[2] 提示：第一次首字母，之后逐个追加');
{
  check('点 1 次 → 首字母 a', hintLetters('abandon', 1) === 'a', hintLetters('abandon', 1));
  check('★ 点 3 次 → aba（逐个追加）', hintLetters('abandon', 3) === 'aba', hintLetters('abandon', 3));
  check('点 0 次 → 空', hintLetters('abandon', 0) === '');
  check('不会超过单词长度', hintLetters('cat', 9) === 'cat', hintLetters('cat', 9));
}

// ─────────────────────────── [3] 专属优先级
console.log('\n[3] 专属优先级：加权公式，权重可配置');
{
  const now = 1_800_000_000_000;
  const w = word('w1', 'alpha', { failCount: 5, failCountTotal: 5, examCount: 10, lastReviewAt: now - 10 * 86_400_000, priority: 4 });
  const rec = { id: 'w1', attempts: 3, lastScore: 2, bestScore: 4, totalScore: 8, lastAt: now - 86_400_000 };
  const p = computeSpellPriority(w, rec, settings, now);
  // 手算：失败率 0.5 → 6×0.5=3；天数 10 → 1×10=10；次数 3 → 2.5×3=7.5；低分 (5-2)=3 → 4×3=12；词级 P4 → 0.4×4=1.6
  // ★ 1.0.3：从未通过过（passes 缺省 0）额外加 SPELL_NEVER_PASSED_BONUS
  // 手算：失败率 0.5→3；天数按 record.lastAt（1 天）→1；次数 3→7.5；低分 3→12；P4→1.6 = 25.1\n  check('★ 按公式加权求和（含「从未通过」加分）', Math.abs(p - (SPELL_NEVER_PASSED_BONUS + 25.1)) < 1e-6, String(p));

  const rec0 = null;
  const pNoRec = computeSpellPriority(word('w2', 'bravo'), rec0, settings, now);
  check('没练过的词按「上次 0 分」算（更该练）', pNoRec > computeSpellPriority(word('w2', 'bravo'), { ...rec, lastScore: 5 }, settings, now), String(pNoRec));

  const doubled = { ...settings, weights: { ...settings.weights, failRate: settings.weights.failRate * 2 } };
  check('★ 改权重后结果随之变化（可调参）', computeSpellPriority(w, rec, doubled, now) > p, String(computeSpellPriority(w, rec, doubled, now)));

  // 排序
  const words = [
    word('a', 'aaa', { failCount: 1, failCountTotal: 1, examCount: 10 }),
    word('b', 'bbb', { failCount: 9, failCountTotal: 9, examCount: 10 }),
    word('c', 'ccc', { failCount: 1, failCountTotal: 1, examCount: 10 }),
  ];
  const queue = buildSpellQueue(words, new Map(), settings, now);
  check('★ 队列按优先级从高到低', queue[0].word.id === 'b', queue.map((e) => `${e.word.en}:${Math.round(e.priority)}`).join(' > '));
  check('同优先级按首字母升序', queue.slice(1).map((e) => e.word.en).join(',') === 'aaa,ccc', queue.slice(1).map((e) => e.word.en).join(','));
  check('条目里带着本功能记录（没有记录时为 null）', queue[0].record === null);
}

// ─────────────────────────── [4] 选词
console.log('\n[4] 选词：只取标记过的词，队列长度可配置');
{
  const now = 1_800_000_000_000;
  const words = [
    word('w1', 'alpha', { failCount: 9, failCountTotal: 9, examCount: 10 }),
    word('w2', 'bravo', { failCount: 1, failCountTotal: 1, examCount: 10 }),
    word('w3', 'charlie', { failCount: 5, failCountTotal: 5, examCount: 10 }),
    word('w4', 'delta', { spellOnly: false, failCount: 9, failCountTotal: 10 }),
    word('w5', 'echo', { failCount: 9, failCountTotal: 10, status: 'chopped' }),
  ];
  const all = buildSpellQueue(words, new Map(), { ...settings, count: 10 }, now);
  check('★ 只取被标记的词（去掉未标记的 delta）', !all.some((e) => e.word.en === 'delta'), all.map((e) => e.word.en).join(','));
  check('已斩的词不进队列', !all.some((e) => e.word.en === 'echo'), all.map((e) => e.word.en).join(','));
  check('★ 词库不足时取实际数量（3 个）', all.length === 3, String(all.length));
  const capped = buildSpellQueue(words, new Map(), { ...settings, count: 2 }, now);
  check('★ 队列长度可配置（count=2 → 2 个）', capped.length === 2, String(capped.length));
  check('取的是优先级最高的两个', capped.map((e) => e.word.en).join(',') === 'alpha,charlie', capped.map((e) => e.word.en).join(','));
}

// ─────────────────────────── [5] 重排
console.log('\n[5] 未满分重排：间隔 5 个单词后出现');
{
  // 队列 10 题，当前是第 0 题 → 剩余 9 个，足够间隔 5 → 插到下标 6（中间隔着 5 个词）
  check('★ 剩余足够 → 插到当前题之后第 6 位（间隔 5 个词）', repeatInsertIndex(10, 0) === 6, String(repeatInsertIndex(10, 0)));
  check('第 3 题时同理', repeatInsertIndex(10, 3) === 9, String(repeatInsertIndex(10, 3)));
  // 剩余不足 5 个 → 追加到末尾
  check('★ 剩余不足 5 个 → 追加到末尾', repeatInsertIndex(5, 2) === 5, String(repeatInsertIndex(5, 2)));
  check('最后一题 → 末尾', repeatInsertIndex(3, 2) === 3, String(repeatInsertIndex(3, 2)));

  const q = [
    { word: word('a', 'a'), priority: 1, record: null },
    { word: word('b', 'b'), priority: 1, record: null },
    { word: word('c', 'c'), priority: 1, record: null },
    { word: word('d', 'd'), priority: 1, record: null },
    { word: word('e', 'e'), priority: 1, record: null },
    { word: word('f', 'f'), priority: 1, record: null },
    { word: word('g', 'g'), priority: 1, record: null },
  ];
  const next = reinsertEntry(q, 0, q[0]);
  check('★ 插回后顺序：a b c d e f a g（a 隔了 5 个词再现）', next.map((e) => e.word.en).join('') === 'abcdefag', next.map((e) => e.word.en).join(''));
  check('原队列不被修改（纯函数）', q.length === 7);
  const tail = reinsertEntry(q, 4, q[4]);
  check('剩余只有 2 个 → 追加到末尾', tail.map((e) => e.word.en).join('') === 'abcdefge'.slice(0, 8), tail.map((e) => e.word.en).join(''));
}

// ─────────────────────────── [6] 1.0.3：炒饭式循环与通过次数衰减
console.log('\n[6] 1.0.3：通过次数衰减 / 优先级排序 / 循环取词');
{
  const now = 1_800_000_000_000;
  const settingsNew = { ...settings, weights: { ...settings.weights, passDecay: 1 } };
  const w = word('w1', 'alpha', { failCount: 0, failCountTotal: 0, examCount: 10, lastReviewAt: now - 86_400_000 });
  const rec0 = { id: 'w1', attempts: 3, lastScore: 2, bestScore: 4, totalScore: 8, lastAt: now - 86_400_000 };
  const rec3 = { ...rec0, passes: 3 };
  const p0 = computeSpellPriority(w, rec0, settingsNew, now);
  const p3 = computeSpellPriority(w, rec3, settingsNew, now);
  check('★ 通过次数越多，优先级越低（权重衰减）', p3 < p0, `${p0} vs ${p3}`);
  check('从未通过过（passes=0）的词带固定加分', p0 >= SPELL_NEVER_PASSED_BONUS, String(p0));
  const decayOff = computeSpellPriority(w, { ...rec3, passes: 0 }, { ...settingsNew, weights: { ...settingsNew.weights, passDecay: 0 } }, now);
  // failRate 0、天数 1、次数 7.5、低分 12、P3 1.2 = 21.7\n  check('passDecay=0 时不衰减', Math.abs(decayOff - (SPELL_NEVER_PASSED_BONUS + 21.7)) < 1e-6, String(decayOff));

  const words3 = [word('a', 'aaa'), word('b', 'bbb'), word('c', 'ccc')];
  const records = new Map([
    ['a', { id: 'a', attempts: 2, lastScore: 5, bestScore: 5, totalScore: 10, lastAt: now, passes: 5 }],
    ['c', { id: 'c', attempts: 1, lastScore: 3, bestScore: 5, totalScore: 3, lastAt: now, passes: 1 }],
  ]);
  const sorted = sortSpellCandidates(words3, records, settingsNew, now);
  check('★ 从未通过过的词排最前（b）', sorted[0].word.id === 'b', sorted.map((x) => x.word.id).join(','));
  check('通过多次的词排最后（a）', sorted[sorted.length - 1].word.id === 'a', sorted.map((x) => x.word.id).join(','));

  const b1 = takeCycleBatch(sorted, 0, 2);
  check('第一批取前 2 个、游标 = 2', b1.batch.length === 2 && b1.nextOffset === 2, JSON.stringify({ n: b1.batch.length, off: b1.nextOffset }));
  const b2 = takeCycleBatch(sorted, 2, 2);
  check('★ 取到末尾后绕回开头（循环）', b2.batch.length === 2 && b2.batch[0].word.id === sorted[2].word.id && b2.batch[1].word.id === sorted[0].word.id, b2.batch.map((x) => x.word.id).join(','));
  check('游标越界自动取模', takeCycleBatch(sorted, 5, 2).nextOffset >= 0);
  check('空候选返回空批', takeCycleBatch([], 0, 3).batch.length === 0);
  check('buildSpellQueue 仍只取第一轮的量', buildSpellQueue(words3, records, settingsNew, now).length === Math.min(settingsNew.count, 3));
}

console.log(`\n拼写强化自检：${passed} 项通过，${failed} 项失败`);
if (failed > 0) process.exit(1);
