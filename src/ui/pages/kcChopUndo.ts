/**
 * 二期「斩 → 撤销」的共用手册（★ RULES-R3 的执行点）。
 *
 * 学习流程（`KcStudyPage`）与复习流程（`KcReviewPage`）的斩**必须是同一套行为**
 * ——用户在学习里斩一张卡和在复习里斩一张卡，看到的东西不该有两样。
 * 所以实现只写一份，两个页面都调这里。
 *
 * ══════════════════════════════════════════════════════════════
 * 为什么不能只调 `dao.kc.revive()`
 * ══════════════════════════════════════════════════════════════
 * `revive()` 会把状态一律写成 `unlearned`，而且**只管库、不管本轮流程**：
 * 一张原本 `learned` 的卡撤销后悔掉回「未学」，而且虽然活了，
 * 却不在这一轮学习的队伍里（`session.cardIds` 里没有它）——
 * 用户点完撤销看到的是「卡片回来了，但这一轮再也没有它」。
 *
 * 铁律要的是「**完全恢复**（包括它原本在学习/复习流程里的位置）」，所以这里
 * 同时还原三样东西：库里的 `deleted` + `status`、卡片数组、会话（id 队列 /
 * 自评分 / 当前下标）。
 *
 * ══════════════════════════════════════════════════════════════
 * 一个刻意的取舍：撤销后它插回哪里
 * ══════════════════════════════════════════════════════════════
 * 插回 `max(原下标, 当前下标)`：
 * - 用户**立刻就撤销**（最常见）→ 原下标 = 当前下标，卡片重新变成「当前这张」；
 * - 用户先评了几张再撤销 → 插到当前下标处，于是它**接着就会被看到**。
 *   若硬按原下标插回去，它落在「已经翻过去」的位置，用户会以为撤销没生效；
 *   而把下标往回拨又会让他重复看已经评过的卡片。两种都不行。
 */
import type { KcSession, KnowledgeCard } from '../../core/kcTypes';
import * as dao from '../../dao';
import { showUndoToast } from '../components/Toast';

/** `chopKcCardUndoable` 的参数 */
export interface ChopKcCardOptions {
  /** 要斩的卡片 */
  card: KnowledgeCard;
  /** 本轮卡片数组（**会被原地修改**，调用方的引用继续有效） */
  cards: KnowledgeCard[];
  /** 本轮会话（会被原地修改） */
  session: KcSession;
  /** 每次状态变化（斩完 / 撤销完）之后要做的事：重画界面 + 存会话 */
  onChanged: () => void | Promise<void>;
}

/**
 * 斩掉一张卡：**立即生效、不弹确认**，并给出一条 ≥8 秒的撤销入口。
 *
 * ★ RULES-R3: 斩不弹确认，但必须提供 ≥8 秒的撤销 Toast。
 *
 * @param opts 卡片 / 本轮数组 / 会话 / 变化回调
 */
export async function chopKcCardUndoable(opts: ChopKcCardOptions): Promise<void> {
  const { card, cards, session, onChanged } = opts;

  // 斩之前把「怎么恢复」需要的东西全记下来
  const prevDeleted: 0 | 1 = card.deleted ?? 0;
  const prevStatus = card.status;
  const prevIndex = cards.findIndex((c) => c.id === card.id);
  const prevIdIndex = session.cardIds.indexOf(card.id);
  const hadScore = Object.prototype.hasOwnProperty.call(session.selfScores, card.id);
  const prevScore = session.selfScores[card.id];

  // ── 斩：立即生效 ──
  await dao.kc.chop(card.id);
  const at = prevIndex >= 0 ? prevIndex : cards.length;
  cards.splice(at, 1);
  session.cardIds = session.cardIds.filter((id) => id !== card.id);
  delete session.selfScores[card.id];
  // currentIndex 不前进：数组短了一位，当前位置自然就是下一张
  session.currentIndex = Math.min(session.currentIndex, cards.length);
  await onChanged();

  // ── 撤销入口（≥8 秒）──
  showUndoToast(`已斩 ${card.title}`, async () => {
    // 1) 库：把 deleted 与 status 都还原（不是 revive 的「一律未学」）
    await dao.kc.restoreChopState(card.id, { deleted: prevDeleted, status: prevStatus });
    // 2) 本轮数组 + 会话：插回「原下标与当前下标里靠后的那个」（见文件头注释）
    const restored: KnowledgeCard = { ...card, deleted: prevDeleted, status: prevStatus };
    const insertAt = Math.max(prevIndex, session.currentIndex);
    cards.splice(Math.min(insertAt, cards.length), 0, restored);
    const idAt = Math.max(prevIdIndex, insertAt);
    session.cardIds.splice(Math.min(idAt, session.cardIds.length), 0, card.id);
    if (hadScore) session.selfScores[card.id] = prevScore;
    await onChanged();
  });
}
