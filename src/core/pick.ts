/**
 * 抽词算法：记忆环节必抽规则 / 复习推荐值 / 复习抽词 / 分组 / ★ 背诵抽词（绝对优先）。
 */
import type { Session, Settings, Word } from './types';
import { computePriority } from './priority';
import { wordPriorityOf } from './model';
import { mulberry32, seedFromString } from './layout';

/**
 * Fisher–Yates 随机打乱（返回新数组）。
 * @param items 原数组
 */
export function shuffle<T>(items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const a = out[i];
    const b = out[j];
    if (a !== undefined && b !== undefined) {
      out[i] = b;
      out[j] = a;
    }
  }
  return out;
}

/**
 * 记忆环节抽词。规则按顺序：
 * 1. 候选池 = session.wordIds 里未被斩、**且已经在纸上出现过**（shownIds）的词——
 *    还没出现在纸上的词不进记忆环节（用户要求：已出现不满 maxPick 个时，就按已出现数量来）；
 * 2. 必抽：session.failedIds（本次会话内记过未通过的词）；
 * 3. 其余按记忆次数从少到多补位；
 * 4. 上限 maxPick；必抽词超过 maxPick 时允许突破上限全部纳入；
 * 5. 抽出后随机打乱顺序。
 * @param session 当前会话
 * @param allWords 词库全量（按 wordIds 找词）
 * @param cfg maxPick = 单次最多抽几个；targetCount = 每词至少记忆几次
 */
export function pickForMemorize(
  session: Session,
  allWords: Word[],
  cfg: { maxPick: number; targetCount: number },
): string[] {
  void cfg.targetCount; // 结束条件在页面层用，抽词本身不需要它
  const byId = new Map(allWords.map((w) => [w.id, w]));
  const shown = new Set(session.shownIds);
  const candidates = session.wordIds.filter((id) => {
    const w = byId.get(id);
    return w !== undefined && w.status !== 'chopped' && shown.has(id);
  });

  const mandatorySet = new Set(session.failedIds.filter((id) => candidates.includes(id)));
  const mandatory = candidates.filter((id) => mandatorySet.has(id));
  const rest = candidates.filter((id) => !mandatorySet.has(id));
  rest.sort((a, b) => (session.memorizeCount[a] ?? 0) - (session.memorizeCount[b] ?? 0));

  const ordered = [...mandatory, ...rest];
  return shuffle(ordered.slice(0, Math.max(cfg.maxPick, mandatory.length)));
}

/**
 * 复习推荐值：
 * 候选 = 非 chopped 且非 unlearned 的词；
 * 现算每个词的复习优先度，取第 75 百分位为 threshold；
 * count = 优先度 ≥ threshold 的词数，clamp 到 [1, reviewGroupSize * 3]；
 * 词库为空或全未背时返回 { count: 0, threshold: 0 }。
 * @param words 词库全量
 * @param settings 设置（读预设/自定义表达式）
 * @param now 当前时间戳
 */
export function recommendReviewCount(
  words: Word[],
  settings: Settings,
  now: number = Date.now(),
): { count: number; threshold: number } {
  const candidates = words.filter((w) => w.status !== 'chopped' && w.status !== 'unlearned');
  if (candidates.length === 0) return { count: 0, threshold: 0 };

  const priorities = candidates.map((w) => computePriority(w, settings, now)).sort((a, b) => a - b);
  const index = Math.max(0, Math.ceil(priorities.length * 0.75) - 1);
  const threshold = priorities[index] ?? 0;
  const count = priorities.filter((p) => p >= threshold).length;
  const max = settings.reviewGroupSize * 3;
  return { count: Math.min(max, Math.max(1, count)), threshold };
}

/**
 * 复习抽词：排除 chopped 和 unlearned；
 * 按 reviewPriority 降序，同分时 lastReviewAt 更早（含从未复习）的优先；取前 count 个。
 * @param words 词库全量
 * @param count 要抽的数量
 * @param settings 设置
 * @param now 当前时间戳
 */
export function pickForReview(words: Word[], count: number, settings: Settings, now: number = Date.now()): string[] {
  const candidates = words.filter((w) => w.status !== 'chopped' && w.status !== 'unlearned');
  candidates.sort((a, b) => {
    const pa = computePriority(a, settings, now);
    const pb = computePriority(b, settings, now);
    if (pb !== pa) return pb - pa;
    const ta = a.attrs.lastReviewAt ?? 0;
    const tb = b.attrs.lastReviewAt ?? 0;
    return ta - tb;
  });
  return candidates.slice(0, Math.max(0, count)).map((w) => w.id);
}

/**
 * 分组：每组不超过 size 个，最后一组可以少。
 * 这里选择「顺序切分」而不是蛇形分配，原因：验收标准要求 65 个 → 3 组（30/30/5），
 * 蛇形分配会把词摊成 size 个小组，破坏「每组 ≤ reviewGroupSize」的分组模型；
 * 组间强度不均的问题由「每次复习按优先度重新抽词」来缓解（每次复习的排序都会随
 * 时间/设置变化）。若以后想组间更均匀，把这里换成蛇形即可，调用方不用改。
 * @param ids 已按优先度排序的词 id
 * @param size 每组上限
 */
export function groupWords(ids: string[], size: number): string[][] {
  const n = Math.max(1, Math.floor(size));
  if (ids.length === 0) return [];
  const groups: string[][] = [];
  for (let i = 0; i < ids.length; i += n) {
    groups.push(ids.slice(i, i + n));
  }
  return groups;
}

// ══════════════════════════════════════════ R3：背诵抽词（绝对优先）

/**
 * ★ 背诵抽词的排序规则（R3 第一关键字是**绝对**优先）。
 *
 * 为什么单独抽成导出的函数，而不是在两个地方各写一遍：
 *   1. 「开始背诵」（LearnPage 取全部未背词）和「再背一个」（pickNextForLearn 取下一个）
 *      必须是**同一套顺序**——两处各写一遍的话，会出现「词单顺序 A、再背一个顺序 B」，
 *      用户看到的现象是「我自己点的顺序和它给我的不一样」，很难查；
 *   2. 顺序规则是这一阶段的核心验收项（连续抽 10 次：前 5 次必须全是 priority=5），
 *      抽成纯函数才能被自检直接断言。
 *
 * 排序：
 *   1. `priority` **降序**（5 → 1）—— 它是第一关键字，**绝对优先不掺概率**；
 *   2. 同级内按 `samePriorityOrder`：
 *      · `'createdAt'`（默认）：先录入的先背，可预测、可复核；
 *      · `'random'`：把同级词用**确定性**随机打乱（种子来自 sessionId + 词 id），
 *        所以同一次会话里反复算的结果一致（不会「点了下一步又跳回上一个词」），
 *        而不同会话的顺序不同。
 *
 * @param words 候选词（调用方已经过滤过状态与 appearedIds）
 * @param samePriorityOrder 同级内的顺序（来自设置）
 * @param seedText 随机模式的种子文本（用 sessionId 即可）
 */
export function sortForLearn(
  words: Word[],
  samePriorityOrder: 'createdAt' | 'random' = 'createdAt',
  seedText = 'learn',
): Word[] {
  if (samePriorityOrder === 'random') {
    // 给每个词算一个稳定的随机权重，再按（优先级降序，权重升序）排。
    // 用确定性随机而不是 Math.random()：同一个词在**同一次会话**里的权重必须一样，
    // 否则每次重算顺序都会变，用户会看到「同一个词被抽中两次、或者上一个词又回来了」。
    const weighted = words.map((w) => ({
      word: w,
      weight: mulberry32(seedFromString(`${seedText}#${w.id}`))(),
    }));
    weighted.sort((a, b) => {
      const pd = wordPriorityOf(b.word) - wordPriorityOf(a.word);
      if (pd !== 0) return pd;
      return a.weight - b.weight;
    });
    return weighted.map((x) => x.word);
  }
  return [...words].sort((a, b) => {
    const pd = wordPriorityOf(b) - wordPriorityOf(a);
    if (pd !== 0) return pd;
    return a.createdAt - b.createdAt;
  });
}

/**
 * ★ 背诵抽词：取「下一个该背的词」。
 *
 * 候选池（提示词 2.2 节）：`status` 为未背 / 学习中、**未被斩**、**不在 appearedIds 里**。
 * 顺序：见 `sortForLearn` —— 优先级降序是**绝对优先**（5 的词没抽完不会抽 4 的）。
 *
 * @param words 词库全量（内部自己过滤候选池）
 * @param appearedIds 本次会话已经出现过的词 id
 * @param opts.samePriorityOrder 同级内的顺序（默认按 createdAt）
 * @param opts.seedText 随机模式的种子（传 session.id）
 * @returns 下一个词；没有候选时返回 null
 */
export function pickNextForLearn(
  words: Word[],
  appearedIds: Set<string>,
  opts: { samePriorityOrder?: 'createdAt' | 'random'; seedText?: string } = {},
): Word | null {
  const candidates = words.filter(
    (w) =>
      w.deleted !== 1 &&
      w.status !== 'chopped' &&
      (w.status === 'unlearned' || w.status === 'learning') &&
      !appearedIds.has(w.id),
  );
  if (candidates.length === 0) return null;
  const ordered = sortForLearn(candidates, opts.samePriorityOrder ?? 'createdAt', opts.seedText ?? 'learn');
  return ordered[0] ?? null;
}
