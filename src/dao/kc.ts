/**
 * 二期卡片本地 DAO（IndexedDB）。
 *
 * 三条纪律：
 * 1. **所有写操作最后都要 `scheduleKcSync()`**——本地先落库，云端后台慢慢跟；
 * 2. 写操作**必须刷新 `updatedAt`**（云同步的增量是按它比的），
 *    唯一的例外是「应用云端数据」（那时要原样写回云端的 updatedAt，见 kcCloud）；
 * 3. 删除是**软删除**（`deleted=1` 墓碑），否则「A 设备斩了、B 设备还留着」
 *    会在下次同步时被 B 复活。
 *
 * 分工：查询在 `kcQuery.ts`（纯函数、可单测），批量操作在 `kcBatch.ts`，
 * 本文件只做**单卡的读写**。
 */
import { STORE, clearStore, tx, txRun } from '../core/db';
import { ensureClockFloor, nextUpdatedAt as clockNextUpdatedAt } from '../core/kcClock';
import { coerceCard } from '../core/kcModel';
import { recomputeAttrs } from '../core/kcPriority';
import type { Block, KcAttrs, KcQuery, KcStatus, KnowledgeCard } from '../core/kcTypes';
import { emitDataChanged } from '../state/store';
import { countStats, runQuery } from './kcQuery';
import { scheduleKcSync } from './kcScheduler';

/**
 * 取一个「只增不减」的写入时间戳：实现与完整理由见 `core/kcClock.ts`
 * （设备时钟倒退会让卡片永远推不上云，而且是静默的）。这里只是转发，方便 DAO 统一调用。
 */
export async function nextUpdatedAt(): Promise<number> {
  await ensureClockFloor();
  return clockNextUpdatedAt();
}

/**
 * 读全部卡片（**含墓碑**，同步层需要；界面查询请用 `query`）。
 */
export async function getAll(): Promise<KnowledgeCard[]> {
  const rows = await tx<unknown[]>(STORE.knowledgeCards, 'readonly', (s) => s.getAll() as IDBRequest<unknown[]>);
  const out: KnowledgeCard[] = [];
  for (const row of rows) {
    const card = coerceCard(row);
    if (card !== null) out.push(card);
  }
  return out;
}

/**
 * 按 id 取一张卡（取不到返回 null）。
 * @param id 卡片 id
 */
export async function getById(id: string): Promise<KnowledgeCard | null> {
  const row = await tx<unknown>(STORE.knowledgeCards, 'readonly', (s) => s.get(id) as IDBRequest<unknown>);
  if (row === undefined || row === null) return null;
  return coerceCard(row);
}

/**
 * 批量写入（新建 + 更新都走这里）。
 *
 * 说明：`updatedAt` 由调用方给（同步层要原样写回云端时间），
 * 所以这里**不**统一刷时间戳——需要刷时间的写操作（改块/改属性/斩）各自负责。
 * @param cards 卡片数组
 * @returns 新插入 / 被更新的条数
 */
export async function bulkUpsert(cards: KnowledgeCard[]): Promise<{ inserted: number; updated: number }> {
  if (cards.length === 0) return { inserted: 0, updated: 0 };
  const ids = cards.map((c) => c.id);
  // 先看清哪些本来就存在（决定 inserted/updated 的归属），再一次性写回
  const existing = await existingIds(ids);

  await txRun(STORE.knowledgeCards, 'readwrite', (s) => {
    for (const card of cards) s.put(card);
  });

  let inserted = 0;
  let updated = 0;
  for (const id of ids) {
    if (existing.has(id)) updated += 1;
    else inserted += 1;
  }
  emitDataChanged();
  scheduleKcSync();
  return { inserted, updated };
}

/**
 * 查这批 id 里本地已经存在的（用来区分「新插入」和「被更新」）。
 * @param ids 卡片 id 数组
 */
async function existingIds(ids: string[]): Promise<Set<string>> {
  const all = await tx<unknown[]>(STORE.knowledgeCards, 'readonly', (s) => s.getAll() as IDBRequest<unknown[]>);
  const wanted = new Set(ids);
  const out = new Set<string>();
  for (const row of all) {
    const id = (row as { id?: unknown }).id;
    if (typeof id === 'string' && wanted.has(id)) out.add(id);
  }
  return out;
}

/**
 * 换掉一张卡的块（块编辑器保存时用）。
 * @param id 卡片 id
 * @param blocks 新的块数组
 * @returns 是否写成功（卡片不存在返回 false）
 */
export async function updateBlocks(id: string, blocks: Block[]): Promise<boolean> {
  const card = await getById(id);
  if (card === null) return false;
  const next: KnowledgeCard = { ...card, blocks, updatedAt: await nextUpdatedAt() };
  await tx(STORE.knowledgeCards, 'readwrite', (s) => s.put(next));
  emitDataChanged();
  scheduleKcSync();
  return true;
}

/**
 * 局部更新属性。
 *
 * **会自动重算 `mastery` 与 `reviewPriority`**：属性一变，掌握度就该跟着变，
 * 否则列表排序会停在旧值上（用户在设置页改了公式参数也一样要重算）。
 * @param id 卡片 id
 * @param patch 属性补丁
 * @returns 更新后的属性（卡片不存在返回 null）
 */
export async function updateAttrs(id: string, patch: Partial<KcAttrs>): Promise<KcAttrs | null> {
  const card = await getById(id);
  if (card === null) return null;
  const merged: KcAttrs = { ...card.attrs, ...patch };
  const recomputed = recomputeAttrs(merged, {});
  const next: KnowledgeCard = { ...card, attrs: recomputed, updatedAt: await nextUpdatedAt() };
  await tx(STORE.knowledgeCards, 'readwrite', (s) => s.put(next));
  emitDataChanged();
  scheduleKcSync();
  return recomputed;
}

/**
 * 换掉考核方式标签。
 * @param id 卡片 id
 * @param tags 题型 id 数组
 */
export async function updateExamTags(id: string, tags: string[]): Promise<boolean> {
  return updateMeta(id, { examTags: [...tags] });
}

/** 卡片上「可以直接改」的元信息字段（不含 attrs / blocks，那两个各有专用方法） */
export interface KcMetaPatch {
  title?: string;
  summary?: string;
  examTags?: string[];
  examLoad?: KnowledgeCard['examLoad'];
  status?: KcStatus;
}

/**
 * 局部更新卡片的元信息（标题 / 摘要 / 标签 / 出题量 / 状态）。
 *
 * 为什么要一个「通用补丁」方法：卡片编辑页要**一次性保存**标题+摘要+标签+出题量，
 * 拆成四次调用会写四次库、刷四次 `updatedAt`、触发四次同步调度（纯浪费）。
 *
 * @param id 卡片 id
 * @param patch 要改的字段
 * @returns 卡片不存在返回 false
 */
export async function updateMeta(id: string, patch: KcMetaPatch): Promise<boolean> {
  const card = await getById(id);
  if (card === null) return false;
  const next: KnowledgeCard = {
    ...card,
    ...(patch.title !== undefined ? { title: patch.title } : {}),
    ...(patch.summary !== undefined ? { summary: patch.summary } : {}),
    ...(patch.examTags !== undefined ? { examTags: [...patch.examTags] } : {}),
    ...(patch.examLoad !== undefined ? { examLoad: patch.examLoad } : {}),
    ...(patch.status !== undefined ? { status: patch.status } : {}),
    updatedAt: await nextUpdatedAt(),
  };
  await tx(STORE.knowledgeCards, 'readwrite', (s) => s.put(next));
  emitDataChanged();
  scheduleKcSync();
  return true;
}
// ── 删除语义：**实现搬到了 `kcBatch.ts`**（斩/复活/永久删除与批量版住一起），
//    这里保留同名转发，保证 `dao.kc.chop()` 这类既有调用点不用改。
export { chop, revive, removePermanently } from './kcBatch';

/**
 * 查询卡片（列表页用）。
 *
 * 过滤/排序/分页的实现在 `dao/kcQuery.ts`（纯函数，可单测）。
 * 默认**不含墓碑**（斩掉的卡片不该出现在学习/复习队列里）；
 * 要看「已斩」列表就把 `status: ['chopped']` 传进来。
 * @param q 查询条件
 */
export async function query(q: KcQuery): Promise<{ total: number; items: KnowledgeCard[] }> {
  return runQuery(await getAll(), q);
}

/**
 * 统计各状态条数（首页/列表页顶部用）。
 * @param includeChopped 是否把墓碑计入 total（默认不计）
 */
export async function stats(includeChopped = false): Promise<{
  total: number;
  unlearned: number;
  learning: number;
  learned: number;
  chopped: number;
}> {
  return countStats(await getAll(), includeChopped);
}

/**
 * 清空二期四张表（设置页「清空知识点」用）。
 *
 * 说明：这是**真的**清空（连墓碑一起），只用于用户明确要求清库的场景。
 * 日常「斩」走 `chop()`，留墓碑。
 */
export async function clearAll(): Promise<void> {
  await clearStore(STORE.knowledgeCards);
  await clearStore(STORE.dailyContextWords);
  await clearStore(STORE.examRecords);
  await clearStore(STORE.bankQuestions);
  emitDataChanged();
  scheduleKcSync();
}

/**
 * 列出「需要推送」的卡片（本地版本**不早于** `since`，含墓碑）。
 *
 * 边界是 `>=` 而不是 `>`，这不是笔误：批量写入会让几百张卡片共享同一个
 * `updatedAt`，用 `>` 会在「游标正好等于该时间戳」时把同批剩下的全部漏掉
 * （一期实测 1100 条只推上去 500 条）。所以这里返回**候选集**，
 * 由调用方用「已推 id 集合」去重，既不漏也不重复。见 `kcCloud.pushAll`。
 *
 * @param since 上次推送到的 updatedAt
 * @param limit 最多返回多少张
 */
export async function listDirty(since: number, limit: number): Promise<KnowledgeCard[]> {
  const all = await getAll();
  return all
    .filter((c) => (c.updatedAt || 0) >= since)
    .sort((a, b) => a.updatedAt - b.updatedAt)
    .slice(0, limit);
}
