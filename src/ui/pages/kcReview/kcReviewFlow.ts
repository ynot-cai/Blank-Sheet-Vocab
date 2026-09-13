/**
 * 复习流程的两套「抽卡 / 抽词」规则（阶段 06）。
 *
 * 从页面里拆出来的原因：单文件 ≤ 300 行；而且这两套规则**可以在 Node 里测**
 * （不碰 DOM），是验收标准 2（空库不崩）与 6（词源优先级）的落点。
 */
import type { KcSession, KnowledgeCard } from '../../../core/kcTypes';
import type { Word } from '../../../core/types';
import * as dao from '../../../dao';
import { resumeSession } from '../kcExam/kcExamFlow';
import { KC, getSettings } from '../../../core/config';

/**
 * 复习的候选卡片：**学过或学完的**（`learning` / `learned`），不含未学与已斩。
 * @param all 全部卡片
 */
export function reviewCandidates(all: KnowledgeCard[]): KnowledgeCard[] {
  return all.filter((c) => c.deleted !== 1 && (c.status === 'learning' || c.status === 'learned'));
}

/**
 * 按复习优先度降序抽卡（同分时 `lastReviewAt` 更早的优先）。
 *
 * 这个排序规则与一期 `core/pick.ts` 的 `pickForReview` **同一个口径**
 * （那边是单词），但对象不同所以实现分开 —— 一二期数据独立是主提示词的硬约束。
 *
 * @param all 全部卡片
 * @param count 抽几张
 */
export function pickForReview(all: KnowledgeCard[], count: number): KnowledgeCard[] {
  const candidates = reviewCandidates(all);
  candidates.sort((a, b) => {
    if (b.attrs.reviewPriority !== a.attrs.reviewPriority) {
      return b.attrs.reviewPriority - a.attrs.reviewPriority;
    }
    // 都没复习过（null）算「很久以前」，排最前
    const ta = a.attrs.lastReviewAt ?? 0;
    const tb = b.attrs.lastReviewAt ?? 0;
    return ta - tb;
  });
  return candidates.slice(0, Math.max(0, count));
}

/**
 * 推荐复习数量：按复习优先度的 **75 百分位**估算（复用一期的思路）。
 *
 * 做法：先按优先度降序，取第 25% 位置那张卡的优先度当阈值，
 * 数出「优先度 ≥ 阈值」的卡片数量 —— 也就是「最该复习的那一批」。
 * 这样推荐值会随复习进度自然变化（复习完的掉下去，新的冒上来）。
 *
 * @param all 全部卡片
 * @returns 推荐数量（至少 1，最多 `KC.maxStudyCount`）
 */
export function recommendReviewCount(all: KnowledgeCard[]): number {
  const candidates = reviewCandidates(all);
  if (candidates.length === 0) return 0;
  const sorted = [...candidates].sort((a, b) => b.attrs.reviewPriority - a.attrs.reviewPriority);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.25));
  const threshold = (sorted[idx] as KnowledgeCard).attrs.reviewPriority;
  const strong = sorted.filter((c) => c.attrs.reviewPriority >= threshold).length;
  return Math.min(KC.maxStudyCount, Math.max(1, strong));
}

/**
 * 桥接用的词源：**优先未背过的新词，没有新词就复习旧词**（用户明确要求）。
 *
 * 与一期「背诵」页同一个口径：
 * - 新词 = `status === 'unlearned'`，按 `createdAt` 升序（先录入先背）；
 * - 旧词 = 还没斩的其它词，按复习优先度降序（`dao.words.applyPriorities` 算过的值）。
 *
 * @param limit 上限（默认取设置里的 `kc.reviewWordLimit`，即 5）
 * @returns 词 + 词源类型（界面提示用）
 */
export async function pickBridgeWords(limit?: number): Promise<{ words: Word[]; source: 'new' | 'old' | 'none' }> {
  const cap = limit ?? getSettings().kc?.reviewWordLimit ?? 5;
  const all = (await dao.words.getAll()).filter((w) => w.deleted !== 1 && w.status !== 'chopped');
  if (all.length === 0) return { words: [], source: 'none' };

  const fresh = all.filter((w) => w.status === 'unlearned').sort((a, b) => a.createdAt - b.createdAt);
  if (fresh.length > 0) return { words: fresh.slice(0, cap), source: 'new' };

  // 没有新词：退化成复习旧词（按一期算好的优先度降序）
  const old = all
    .filter((w) => w.status !== 'unlearned')
    .sort((a, b) => b.attrs.reviewPriority - a.attrs.reviewPriority);
  if (old.length === 0) return { words: [], source: 'none' };
  return { words: old.slice(0, cap), source: 'old' };
}

/**
 * 复习完成后的收尾：对每张卡片更新复习属性（阶段 06 §5）。
 *
 * - `lastReviewAt = now`
 * - `reviewCount += 1`
 * - 重算 `mastery`（用最新的自评 + 考核）与 `reviewPriority`
 * - `status` 保持 `learned`
 *
 * 说明：`mastery` 的重算在 `dao.kc.updateAttrs` 里自动发生
 * （它用卡片上最新的两个分数算），所以这里只要把两个时间/次数写进去。
 *
 * @param cardIds 本轮复习的卡片
 * @returns 更新后的卡片（用于显示小结）
 */
export async function finishReview(cardIds: string[]): Promise<KnowledgeCard[]> {
  const now = Date.now();
  const out: KnowledgeCard[] = [];
  for (const id of cardIds) {
    const card = await dao.kc.getById(id);
    if (card === null) continue;
    await dao.kc.updateAttrs(id, {
      lastReviewAt: now,
      reviewCount: card.attrs.reviewCount + 1,
    });
    await dao.kc.updateMeta(id, { status: 'learned' });
    const after = await dao.kc.getById(id);
    if (after !== null) out.push(after);
  }
  return out;
}

/**
 * 本次复习的小结文案（阶段 06 §5 要求显示）。
 * @param cards 复习完的卡片
 */
export function reviewSummary(cards: KnowledgeCard[]): string {
  if (cards.length === 0) return '本次没有复习到卡片。';
  const avg = cards.reduce((sum, c) => sum + c.attrs.mastery, 0) / cards.length;
  // 「需要重点回顾」= 掌握度低于 0.34（三档里的最低档）
  const weak = cards.filter((c) => c.attrs.mastery < 0.34).length;
  return `复习 ${cards.length} 个知识点，平均掌握度 ${Math.round(avg * 100)}%，其中 ${weak} 个需要重点回顾。`;
}

/**
 * 复习流程的续跑：取回卡片 + 修正下标（实现复用出题流程那份）。
 *
 * 包一层的理由：复习页读起来更直白（它不关心里面怎么修下标的），
 * 而且两个流程共用一份实现，行为不会分叉。
 *
 * @param open 保存过的会话
 */
export async function resumeSessionCards(open: KcSession): Promise<{ cards: KnowledgeCard[]; session: KcSession }> {
  const r = await resumeSession(open);
  return { cards: r.cards, session: r.session };
}
