/**
 * 云同步的数据访问层（阶段 02）。
 *
 * 为什么单独一个文件：words.ts 已经接近「单文件 300 行」的上限了，
 * 而云同步需要的都是「含墓碑」的读法和「不改 updatedAt」的写法，
 * 集中放这里更容易一眼看清同步语义。
 *
 * 两条纪律：
 * 1. 云同步必须能读到**墓碑**（deleted=1），否则删除推不到别的设备；
 * 2. 应用云端数据时必须**原样写回 updatedAt**，不能刷新成本地时间。
 */
import { STORE, tx, txRun } from '../core/db';
import type { Source, Word } from '../core/types';

/**
 * 列出「需要推送到云端」的词：本地版本比 `since` 新的那些（含墓碑）。
 * @param since 上次推送到的 updatedAt
 * @param limit 最多返回多少条（配合每批 ≤ 500 的分批推送）
 */
/**
 * 列出「需要推送到云端」的词：本地版本**不早于** `since` 的那些（含墓碑）。
 *
 * ⚠️ 边界是 `>=` 而不是 `>`，这不是笔误：
 * 批量写入会让几百条记录共享同一个 `updatedAt`，用 `>` 会在「游标正好等于该时间戳」时
 * 把同批剩下的记录全部漏掉（实测 1100 条只推上去 500 条）。
 * 所以这里返回**候选集（允许包含已推过的）**，由调用方用「已推 id 集合」做去重，
 * 这样既不漏也不会重复推送。见 dao/cloudSync.ts 的 pushAll。
 *
 * @param since 上次推送到的 updatedAt
 * @param limit 最多返回多少条
 */
export async function listDirtyWords(since: number, limit: number): Promise<Word[]> {
  const all = await tx<Word[]>(STORE.words, 'readonly', (s) => s.getAll() as IDBRequest<Word[]>);
  return all
    .filter((w) => (w.updatedAt || 0) >= since)
    .sort((a, b) => a.updatedAt - b.updatedAt)
    .slice(0, limit);
}

/**
 * 列出「需要推送到云端」的来源（含墓碑）。
 * 边界同样是 `>=`，理由见 listDirtyWords 的注释。
 * @param since 上次推送到的 updatedAt
 * @param limit 最多返回多少条
 */
export async function listDirtySources(since: number, limit: number): Promise<Source[]> {
  const all = await tx<Source[]>(STORE.sources, 'readonly', (s) => s.getAll() as IDBRequest<Source[]>);
  return all
    .filter((s) => (s.updatedAt ?? s.createdAt) >= since)
    .sort((a, b) => (a.updatedAt ?? a.createdAt) - (b.updatedAt ?? b.createdAt))
    .slice(0, limit);
}

/**
 * 统计待推送条数（设置页显示「有 N 条待同步」用）。
 * @param since 上次推送到的 updatedAt
 */
export async function countDirty(since: number): Promise<{ words: number; sources: number }> {
  const words = await tx<Word[]>(STORE.words, 'readonly', (s) => s.getAll() as IDBRequest<Word[]>);
  const sources = await tx<Source[]>(STORE.sources, 'readonly', (s) => s.getAll() as IDBRequest<Source[]>);
  return {
    words: words.filter((w) => (w.updatedAt || 0) > since).length,
    sources: sources.filter((s) => (s.updatedAt ?? s.createdAt) > since).length,
  };
}

/**
 * 应用云端推下来的一批词（一次事务写完）。
 * @param words 已转换好的词（带云端 updatedAt / deleted）
 */
export async function applyRemoteWords(words: Word[]): Promise<void> {
  if (words.length === 0) return;
  await txRun(STORE.words, 'readwrite', (s) => {
    for (const w of words) s.put(w);
  });
}

/**
 * 应用云端推下来的一批来源（一次事务写完）。
 * @param sources 已转换好的来源
 */
export async function applyRemoteSources(sources: Source[]): Promise<void> {
  if (sources.length === 0) return;
  await txRun(STORE.sources, 'readwrite', (store) => {
    for (const source of sources) store.put(source);
  });
}

/**
 * 真的删掉若干条词（云端墓碑落地用）。
 * 说明：本地删除**不**走这里——本地删除留墓碑（见其他文件的说明）；
 * 这里只在「云端说这条已经删了」时调用，避免本地一直留着阴魂。
 * @param ids 单词 id 数组
 */
export async function removeWordsPermanently(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await txRun(STORE.words, 'readwrite', (s) => {
    for (const id of ids) s.delete(id);
  });
}

/**
 * 清空本地词库（含墓碑）与来源，供「用云端覆盖本地」使用。
 */
export async function clearAllLocal(): Promise<void> {
  await txRun(STORE.words, 'readwrite', (s) => s.clear());
  await txRun(STORE.sources, 'readwrite', (s) => s.clear());
}
