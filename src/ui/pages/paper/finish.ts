import * as dao from '../../../dao';
import { computePriority } from '../../../core/priority';
import type { Session, Settings, Word } from '../../../core/types';

/**
 * 中途退出（「保存并退出」）：
 * **把整份会话原样写库** —— 词单、每个词在白纸上的落点、已出现的词、
 * 每词已记忆的遍数、未通过情况、组号，全部保留，下次点「背诵」直接接着来。
 *
 * ⚠️ 这份注释以前写的是「进度一律不保留」，与代码事实相反（下面就是整份 saveSession）——
 * 用户 2026-09 明确要求「连同单词位置、背诵进度、每个单词进行了多少遍记忆都保持」，
 * 所以按**代码事实 + 用户口径**改正：中途退出**保留**全部进度。
 * 只有「正常背完」（`finishLearn`）才会写回词库属性并清掉会话。
 * @param session 会话
 */
export async function exitMidway(session: Session): Promise<void> {
  session.finished = false;
  await dao.session.saveSession(session);
}

/**
 * 背诵正常结束：
 * - 把本次累计的 failCountTotal / failCount 写回词库（这两个是属性，属于真实学习结果）；
 * - 所有词 status = 'learned'，learnOrder 从当前最大 +1 递增，learnedAt = now；
 * - 清掉会话。
 * 注意区分：中途退出丢进度，正常结束保留「未通过次数」这类属性。
 * @param session 会话
 * @param failCap 未通过次数上限
 * @returns 被标记为已背的词数（被斩的词不计）
 */
export async function finishLearn(session: Session, failCap: number): Promise<number> {
  const words = await dao.words.getAll();
  const byId = new Map(words.map((w) => [w.id, w]));
  let order = words.reduce((max, w) => (w.learnOrder !== null && w.learnOrder > max ? w.learnOrder : max), 0);
  const now = Date.now();
  const updates: Word[] = [];

  for (const id of session.wordIds) {
    const w = byId.get(id);
    if (!w || w.status === 'chopped') continue;
    const delta = session.failDeltas[id] ?? 0;
    order += 1;
    updates.push({
      ...w,
      attrs: {
        ...w.attrs,
        failCount: Math.min(w.attrs.failCount + delta, failCap),
        failCountTotal: w.attrs.failCountTotal + delta,
        learnedAt: now,
      },
      status: 'learned',
      learnOrder: order,
      updatedAt: now,
    });
  }
  if (updates.length > 0) await dao.words.bulkUpsert(updates);
  await dao.session.clearSession();
  return updates.length;
}

/**
 * 复习全部组正常完成：
 * lastReviewAt = now、reviewCount +1、learnedAt 不变、status 保持 learned，并重算 reviewPriority。
 * @param session 会话
 * @param settings 设置（重算优先度用）
 * @returns 完成复习的词数
 */
export async function finishReview(session: Session, settings: Settings): Promise<number> {
  const words = await dao.words.getAll();
  const byId = new Map(words.map((w) => [w.id, w]));
  const now = Date.now();
  const updates: Word[] = [];

  for (const id of session.wordIds) {
    const w = byId.get(id);
    if (!w || w.status === 'chopped') continue;
    const next = { ...w, attrs: { ...w.attrs } };
    next.attrs.lastReviewAt = now;
    next.attrs.reviewCount += 1;
    next.attrs.reviewPriority = computePriority(next, settings, now);
    next.updatedAt = now;
    updates.push(next);
  }
  if (updates.length > 0) await dao.words.bulkUpsert(updates);
  await dao.session.clearSession();
  return updates.length;
}
