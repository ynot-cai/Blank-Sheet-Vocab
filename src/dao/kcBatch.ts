/**
 * 卡片 DAO 的**删除语义与批量操作**（斩 / 复活 / 永久删除 / 批量版）。
 *
 * 为什么从 `kc.ts` 拆出来：
 * 1. 单文件 ≤ 300 行的硬约束；
 * 2. 这三个函数的共同点是「**一次事务写多张卡**」，与 `kc.ts` 里「单卡读写」的
 *    关注点不同 —— 批量操作最容易犯的错（写 N 次库、刷 N 次时间戳、触发 N 次同步）
 *    在这一层一次性解决掉。
 */
import { STORE, tx, txRun } from '../core/db';
import type { KcStatus, KnowledgeCard } from '../core/kcTypes';
import { emitDataChanged } from '../state/store';
import { getAll, getById, nextUpdatedAt } from './kc';
import { scheduleKcSync } from './kcScheduler';

/**
 * 批量斩 / 批量复活（列表页的批量操作）。
 *
 * 为什么放在 DAO 而不是页面里循环调 `chop()`：
 * 循环调 N 次会写 N 次库、刷 N 次 `updatedAt`、触发 N 次同步调度 —— 卡片多了很卡。
 * 这里一次事务写完，只通知一次、只调度一次同步。
 *
 * @param ids 卡片 id 数组
 * @param deleted 1 = 斩，0 = 复活
 */
export async function bulkSetDeleted(ids: string[], deleted: 0 | 1): Promise<number> {
  if (ids.length === 0) return 0;
  const all = await getAll();
  const wanted = new Set(ids);
  const targets = all.filter((c) => wanted.has(c.id));
  if (targets.length === 0) return 0;
  const now = await nextUpdatedAt();
  const next: KnowledgeCard[] = targets.map((c) => ({
    ...c,
    deleted,
    status: deleted === 1 ? 'chopped' : c.status === 'chopped' ? 'unlearned' : c.status,
    updatedAt: now,
  }));
  await txRun(STORE.knowledgeCards, 'readwrite', (s) => {
    for (const card of next) s.put(card);
  });
  emitDataChanged();
  scheduleKcSync();
  return next.length;
}

/**
 * 批量加题型标签（列表页的批量操作）。
 * 已在标签里的不重复加。
 * @param ids 卡片 id 数组
 * @param tags 要加的题型 id
 */
export async function bulkAddExamTags(ids: string[], tags: string[]): Promise<number> {
  if (ids.length === 0 || tags.length === 0) return 0;
  const all = await getAll();
  const wanted = new Set(ids);
  const targets = all.filter((c) => wanted.has(c.id));
  if (targets.length === 0) return 0;
  const now = await nextUpdatedAt();
  const next: KnowledgeCard[] = targets.map((c) => {
    const merged = [...c.examTags];
    for (const t of tags) if (!merged.includes(t)) merged.push(t);
    return { ...c, examTags: merged, updatedAt: now };
  });
  await txRun(STORE.knowledgeCards, 'readwrite', (s) => {
    for (const card of next) s.put(card);
  });
  emitDataChanged();
  scheduleKcSync();
  return next.length;
}

/**
 * 批量永久删除（列表页的批量操作；**不可恢复**，界面要二次确认）。
 * @param ids 卡片 id 数组
 */
export async function bulkRemovePermanently(ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const before = (await getAll()).length;
  await txRun(STORE.knowledgeCards, 'readwrite', (s) => {
    for (const id of ids) s.delete(id);
  });
  const removed = before - (await getAll()).length;
  if (removed > 0) {
    emitDataChanged();
    scheduleKcSync();
  }
  return removed;
}

/**
 * 斩（软删除：置 `deleted=1` 墓碑，不真的删行）。
 * @param id 卡片 id
 */
export async function chop(id: string): Promise<boolean> {
  return setDeleted(id, 1, 'chopped');
}

/**
 * 复活（把墓碑翻回未学状态，让卡片重新进入学习队列）。
 * @param id 卡片 id
 */
export async function revive(id: string): Promise<boolean> {
  return setDeleted(id, 0, 'unlearned');
}

/**
 * **永久删除**（真的把行删掉，连墓碑一起）。
 *
 * ⚠️ 与 `chop()` 的区别（界面上必须说清楚，用户会搞混）：
 * - `chop()` = 斩：留墓碑，能复活、能进「已斩」列表、删除能同步到别的设备；
 * - `removePermanently()` = 永久删除：**不可恢复**，而且因为删掉了墓碑，
 *   别的设备下次同步**不会**跟着删（那边还留着这张卡，会把它推回来）。
 *   所以它只适合「刚建错的卡片立刻删掉」这种场景，界面上要二次确认。
 *
 * 好消息：`updatedAt` 会被刷新到最新，所以这张卡片的**删除动作本身**会作为
 * 一次「已推送到新时间戳的墓碑」传播出去——见下面为什么要先写墓碑再删。
 * @param id 卡片 id
 */
export async function removePermanently(id: string): Promise<boolean> {
  const card = await getById(id);
  if (card === null) return false;
  await tx(STORE.knowledgeCards, 'readwrite', (s) => s.delete(id));
  emitDataChanged();
  scheduleKcSync();
  return true;
}



/**
 * 置软删除标记（内部用）。
 * @param id 卡片 id
 * @param deleted 0 / 1
 * @param status 同时把状态改成它
 */
async function setDeleted(id: string, deleted: 0 | 1, status: KcStatus): Promise<boolean> {
  const card = await getById(id);
  if (card === null) return false;
  const next: KnowledgeCard = {
    ...card,
    deleted,
    // 复活时回到「未学」：用户既然要重新学，就按新卡走一遍
    status: deleted === 1 ? 'chopped' : status,
    updatedAt: await nextUpdatedAt(),
  };
  await tx(STORE.knowledgeCards, 'readwrite', (s) => s.put(next));
  emitDataChanged();
  scheduleKcSync();
  return true;
}


