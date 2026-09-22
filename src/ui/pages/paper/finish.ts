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
 * 背诵正常结束（用户点「背完了」）：
 * - 把本次累计的 failCountTotal / failCount 写回词库（这两个是属性，属于真实学习结果）；
 * - ★ T2：把本次累计的 `examCount`（总考核次数）也一并写回 —— 背诵里的默写与拼写
 *   都是考核，答对的题以前一点痕迹都不留，失败率就没法算；
 * - **只归档「本次真正上过纸的词」**（`session.shownIds`）：status = 'learned'、
 *   learnOrder 从当前最大 +1 递增、learnedAt = now；
 * - 清掉会话。
 *
 * ★★ 用户报的严重 bug（2026-09）：只点了 4 个词上纸、记忆完点「背完了」，
 *    结果**整个词库的词全被标成已背**。
 *    原因就是这里原来遍历的是 `session.wordIds`（= 开始背诵时把**全部未背词**
 *    都塞进去的「待背队列」，可能几百个），而不是「这次真的背了的词」。
 *    用户的模型是「点下一个就 +1 个」——本轮就是上过纸的那些；
 *    队列里没轮到的不该被动。
 *
 * 注意区分：中途退出保留整份进度（`exitMidway`），正常结束才写回属性并清会话。
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
  const examDeltas = session.examDeltas ?? {};

  // ★ 只算「上过纸的词」。顺序按 wordIds（= 上纸顺序）走，保证 learnOrder 稳定。
  const shown = new Set(session.shownIds);
  for (const id of session.wordIds) {
    if (!shown.has(id)) continue;
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
        // ★ T2：总考核次数按本次实际判分次数累加（老词 examCount 为 null 时从 0 起算）
        examCount: (typeof w.attrs.examCount === 'number' && Number.isFinite(w.attrs.examCount) ? w.attrs.examCount : 0) + (examDeltas[id] ?? 0),
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
 *
 * ★ T2：同时把本次的 `examCount` 增量写回，并用**新的失败率**重算 reviewPriority ——
 *   优先度公式现在读 failRate，如果先算优先度再写 examCount，算出来的就是旧失败率
 *   （本轮的结果要下一轮才生效，用户会觉得「这轮白考了」）。
 *
 * ★ T2 的收窄：只有 `shownIds` 里**真的上过纸**的词才算「复习过一次」。
 *   以前是 `wordIds` 全算 —— T2 之前的复习是「一次抽 N 个、全部必须走完」，
 *   两者差别不大；但 T2 改成「点一下多复习一个」之后，用户随时可以在只复习了
 *   3 个词的时候结束（剩下的词在词单里但从没上纸），
 *   那时如果照样给它们 +1，等于「没复习也算复习过」，`lastReviewAt` 还会被刷成今天
 *   —— 这些词的优先度会被凭空压低，用户再也不会被提醒复习它们。
 * @param session 会话
 * @param settings 设置（重算优先度用）
 * @returns 完成复习的词数
 */
export async function finishReview(session: Session, settings: Settings): Promise<number> {
  const words = await dao.words.getAll();
  const byId = new Map(words.map((w) => [w.id, w]));
  const now = Date.now();
  const updates: Word[] = [];
  const examDeltas = session.examDeltas ?? {};
  const shown = new Set(session.shownIds);

  for (const id of session.wordIds) {
    if (!shown.has(id)) continue;
    const w = byId.get(id);
    if (!w || w.status === 'chopped') continue;
    const next = { ...w, attrs: { ...w.attrs } };
    next.attrs.lastReviewAt = now;
    next.attrs.reviewCount += 1;
    // ★ T2：先把本次的总考核次数写进属性，再用它算优先度（顺序不能反）
    next.attrs.examCount =
      (typeof w.attrs.examCount === 'number' && Number.isFinite(w.attrs.examCount) ? w.attrs.examCount : 0) +
      (examDeltas[id] ?? 0);
    next.attrs.reviewPriority = computePriority(next, settings, now);
    next.updatedAt = now;
    updates.push(next);
  }
  if (updates.length > 0) await dao.words.bulkUpsert(updates);
  await dao.session.clearSession();
  return updates.length;
}
