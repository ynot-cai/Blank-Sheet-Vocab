/**
 * 复习模块自检（版本 0.0.24）：`npm run test:review`
 *
 * 只测**纯逻辑**（不碰 DOM、不碰库）：
 *   [1] 排序：复习优先度 → 背诵优先级 → 首字母（用户「二」的三级规则）
 *   [2] buildReviewQueue：按公式现算优先度，并按三级规则排好
 *   [3] 卡片范围：只取这张卡片「出现过的词」（用户「三」）
 *   [4] 候选词：已斩不出现在复习里（与背诵同一口径）
 *
 * 用法：node --import ./api/_dev/loader-register.mjs api/_dev/test-review.mjs
 */
import { buildReviewQueue, compareReviewEntries, reviewCandidates, wordsOfPaper } from '../../src/core/reviewSelect.ts';
import { computePriority } from '../../src/core/priority.ts';
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
      needSpell: false,
      failCount: opts.failCount ?? 0,
      failCountTotal: 0,
      reviewCount: opts.reviewCount ?? 0,
      lastReviewAt: opts.lastReviewAt ?? null,
      learnedAt: null,
      reviewPriority: opts.reviewPriority ?? 0,
      examCount: 0,
      examScore: null,
    },
    status: opts.status ?? 'learned',
    favorite: false,
    priority: opts.priority ?? 3,
    learnOrder: null,
    createdAt: 0,
    updatedAt: 0,
  };
}

const settings = { ...DEFAULT_SETTINGS };

// ─────────────────────────── [1] 三级排序规则
console.log('\n[1] 排序：复习优先度 → 背诵优先级 → 首字母');
{
  const a = { word: word('a', 'alpha', { priority: 3 }), reviewPriority: 2 };
  const b = { word: word('b', 'bravo', { priority: 3 }), reviewPriority: 5 };
  check('★ 复习优先度高的排在前', compareReviewEntries(b, a) < 0, `${b.reviewPriority} vs ${a.reviewPriority}`);

  const c = { word: word('c', 'charlie', { priority: 5 }), reviewPriority: 2 };
  check('★ 复习优先度相同 → 背诵优先级高的在前', compareReviewEntries(c, a) < 0, `P5 vs P3`);

  const d = { word: word('d', 'delta', { priority: 3 }), reviewPriority: 2 };
  check('★ 再相同 → 首字母升序', compareReviewEntries(a, d) < 0, 'alpha < delta');
  check('大小写不影响首字母比较', compareReviewEntries({ word: word('e', 'Apple'), reviewPriority: 0 }, { word: word('f', 'banana'), reviewPriority: 0 }) < 0);

  const sorted = [a, b, c, d].sort(compareReviewEntries).map((e) => e.word.en);
  check('四个一起排：bravo(5) → charlie(2/P5) → alpha(2/P3) → delta(2/P3)', sorted.join(',') === 'bravo,charlie,alpha,delta', sorted.join(','));
}

// ─────────────────────────── [2] buildReviewQueue
console.log('\n[2] buildReviewQueue：按公式现算并排序');
{
  const words = [
    word('w1', 'zulu', { failCount: 0, reviewCount: 0 }),
    word('w2', 'alpha', { failCount: 3, reviewCount: 0 }),
    word('w3', 'mike', { failCount: 0, reviewCount: 5 }),
  ];
  const now = 1_800_000_000_000;
  const queue = buildReviewQueue(words, settings, now);
  check('队列长度 = 候选词数', queue.length === 3, String(queue.length));
  check('★ reviewPriority 按当前公式现算（不是读存值）', queue.every((e) => Math.abs(e.reviewPriority - computePriority(e.word, settings, now)) < 1e-9), JSON.stringify(queue.map((e) => [e.word.en, e.reviewPriority])));
  let sortedOk = true;
  for (let i = 1; i < queue.length; i += 1) if (compareReviewEntries(queue[i - 1], queue[i]) > 0) sortedOk = false;
  check('★ 队列本身满足三级排序（相邻两项不再逆序）', sortedOk, queue.map((e) => `${e.word.en}:${e.reviewPriority}`).join(' > '));
  check('不改动传入的词对象（纯函数）', words[0].attrs.reviewPriority === 0);
}

// ─────────────────────────── [3] 卡片范围
console.log('\n[3] 卡片模式：范围 = 卡片出现过的单词');
{
  const words = [word('w1', 'alpha'), word('w2', 'bravo'), word('w3', 'charlie')];
  const paper = {
    id: 'p1',
    name: '纸',
    priorityTable: {},
    seed: 'p1',
    shownIds: ['w2', 'w1', 'ghost'],
    placements: {},
    recordScores: true,
    status: 'draft',
    createdAt: 0,
    updatedAt: 0,
  };
  const scope = wordsOfPaper(paper, words);
  check('★ 只取 shownIds 里存在的词（顺序照出现顺序）', scope.map((w) => w.en).join(',') === 'bravo,alpha', scope.map((w) => w.en).join(','));
  check('卡片里没有出现过的词不进范围', !scope.some((w) => w.en === 'charlie'));
  check('词库里已经没有的 id 被跳过', scope.length === 2);
  const queue = buildReviewQueue(scope, settings, 1_800_000_000_000).map((e) => e.word.en);
  check('卡片范围内仍按三级规则排序', queue.length === 2, queue.join(','));
}

// ─────────────────────────── [4] 候选词
console.log('\n[4] 候选词：已斩的词不进复习');
{
  const words = [word('w1', 'alpha'), word('w2', 'bravo', { status: 'chopped' }), word('w3', 'charlie', { status: 'unlearned' })];
  const candidates = reviewCandidates(words);
  check('★ 排除已斩（与背诵抽词同一口径）', candidates.map((w) => w.en).join(',') === 'alpha,charlie', candidates.map((w) => w.en).join(','));
  check('未背过的词也参与复习（用户说的是「所有单词」）', candidates.some((w) => w.status === 'unlearned'));
}

console.log(`\n复习逻辑自检：${passed} 项通过，${failed} 项失败`);
if (failed > 0) process.exit(1);
