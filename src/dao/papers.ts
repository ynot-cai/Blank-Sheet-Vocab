/**
 * 白纸存档 DAO（版本 0.0.13）。
 *
 * 一张纸 = `PaperArchive`（临时优先级表 + 分布种子 + 已出现名单 + 落点）。
 * 用户要求在「背诵选择页面 → 继续背诵」里能看到多张存档，所以这里是**多记录**读写，
 * 而不是像 `session.ts` 那样固定一条 key。
 *
 * 为什么单独一张表（`papers`）而不塞进 `sessions`：
 * `sessions` 的语义是「这台设备上**正在进行中**的那一轮」，全局只能有一条；
 * 而存档是「一张张存下来的纸」，可以有很多张（进行中的 + 已背完的）。
 * 两者混在一张表里，删一张纸就会把「当前进行中」也一起弄乱。
 */
import { STORE, tx, txRun } from '../core/db';
import type { PaperArchive } from '../core/types';

/** 读出全部存档（按 updatedAt 降序，最近动过的在前） */
export async function list(): Promise<PaperArchive[]> {
  const rows = await tx<PaperArchive[]>(STORE.papers, 'readonly', (s) => s.getAll() as IDBRequest<PaperArchive[]>);
  return (rows ?? []).sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * 只取**进行中**的存档（`继续背诵` 页签用）。
 * 已背完的（`finished`）不进这个列表——它们属于永久存档。
 */
export async function listDrafts(): Promise<PaperArchive[]> {
  return (await list()).filter((p) => p.status === 'draft');
}

/** 按 id 取一张 */
export async function get(id: string): Promise<PaperArchive | null> {
  const row = await tx<PaperArchive | undefined>(
    STORE.papers,
    'readonly',
    (s) => s.get(id) as IDBRequest<PaperArchive | undefined>,
  );
  return row ?? null;
}

/** 新增或覆盖一张 */
export async function put(paper: PaperArchive): Promise<void> {
  await txRun(STORE.papers, 'readwrite', (s) => s.put({ ...paper, updatedAt: Date.now() }));
}

/** 改名（列表页的「重命名」用） */
export async function rename(id: string, name: string): Promise<void> {
  const row = await get(id);
  if (!row) return;
  await put({ ...row, name });
}

/** 删除一张纸（「删除这张纸」用） */
export async function remove(id: string): Promise<void> {
  await txRun(STORE.papers, 'readwrite', (s) => s.delete(id));
}

/** 清空全部（清空数据时用；本轮暂未接到设置页） */
export async function clearAll(): Promise<void> {
  await txRun(STORE.papers, 'readwrite', (s) => s.clear());
}
