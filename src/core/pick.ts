/**
 * 抽词算法：记忆环节必抽规则 / 复习推荐值 / 复习抽词 / 分组。
 */
import type { Session, Settings, Word } from './types';
import { computePriority } from './priority';

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
