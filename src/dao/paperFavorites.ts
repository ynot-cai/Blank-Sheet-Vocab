/**
 * 白纸存档收藏 DAO（版本 1.0.0）。
 *
 * ★ 用户 1.0.0：「『卡片』界面移除单词卡浏览功能，并改名为『白纸』，仅用于浏览白纸存档；
 *   搜索、收藏等功能同样针对白纸存档生效，但不要删除『单词』界面中的对应功能。」
 *
 * 所以这里单开一张表存「收藏的**白纸存档**」：
 * - 主键 = 存档 id（`PaperArchive.id`）；
 * - 与 `cardFavorites`（单词收藏，主键 = 词 id）**互不影响**；
 * - 存档被删掉后残留的记录不影响任何计算（列表页按"存档还在不在"过滤）。
 */
import { STORE, tx, txRun } from '../core/db';

/** 一条收藏记录 */
export interface PaperFavorite {
  id: string;
  at: number;
}

/** 读出全部收藏（按收藏时间升序） */
export async function list(): Promise<PaperFavorite[]> {
  const rows = await tx<PaperFavorite[]>(STORE.paperFavorites, 'readonly', (s) => s.getAll() as IDBRequest<PaperFavorite[]>);
  return (rows ?? []).sort((a, b) => a.at - b.at);
}

/** 读出全部被收藏的存档 id */
export async function ids(): Promise<Set<string>> {
  return new Set((await list()).map((r) => r.id));
}

/**
 * 收藏 / 取消收藏一张白纸存档。
 * @param id 存档 id
 * @param value true = 收藏
 */
export async function set(id: string, value: boolean): Promise<void> {
  if (value) {
    await txRun(STORE.paperFavorites, 'readwrite', (s) => s.put({ id, at: Date.now() } satisfies PaperFavorite));
    return;
  }
  await txRun(STORE.paperFavorites, 'readwrite', (s) => s.delete(id));
}

/** 清空全部收藏（清空数据时用） */
export async function clearAll(): Promise<void> {
  await txRun(STORE.paperFavorites, 'readwrite', (s) => s.clear());
}
