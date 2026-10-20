/**
 * 卡片收藏 DAO（版本 0.0.22）。
 *
 * ★ 用户要求：「将收藏对象从『单词』改为『卡片』，并删除原有的单词收藏功能。」
 *   所以收藏**不再是**词的属性（`Word.favorite` 已删除），而是单开一张表
 *   `cardFavorites` 记录「哪些卡片被收藏了」：主键是卡片 id（= 卡片所对应的词 id），
 *   值是 `{ id, at }`（`at` = 收藏时间，方便以后按收藏时间排序/展示）。
 *
 * 与词表的关系：**没有外键**。词被删掉之后这里可能留一条孤儿记录，
 * 列表页每次读卡片时会用「词还在不在」把孤儿过滤掉（见 ListPage 的 loadFavorites）。
 */
import { STORE, tx, txRun } from '../core/db';

/** 一条收藏记录 */
export interface CardFavorite {
  /** 卡片 id（= 该卡片对应的词 id） */
  id: string;
  /** 收藏时间（毫秒时间戳） */
  at: number;
}

/** 读出全部收藏记录（按收藏时间升序） */
export async function list(): Promise<CardFavorite[]> {
  const rows = await tx<CardFavorite[]>(
    STORE.cardFavorites,
    'readonly',
    (s) => s.getAll() as IDBRequest<CardFavorite[]>,
  );
  return (rows ?? []).sort((a, b) => a.at - b.at);
}

/** 读出全部被收藏的卡片 id（列表页筛选用） */
export async function ids(): Promise<Set<string>> {
  return new Set((await list()).map((r) => r.id));
}

/**
 * 收藏 / 取消收藏一张卡片。
 * @param id 卡片 id
 * @param value true = 收藏，false = 取消
 */
export async function set(id: string, value: boolean): Promise<void> {
  if (value) {
    await txRun(STORE.cardFavorites, 'readwrite', (s) => s.put({ id, at: Date.now() } satisfies CardFavorite));
    return;
  }
  await txRun(STORE.cardFavorites, 'readwrite', (s) => s.delete(id));
}

/**
 * 批量收藏 / 取消收藏（卡片视图的批量编辑用）。
 * @param ids 卡片 id 数组
 * @param value true = 收藏，false = 取消
 */
export async function setMany(ids: string[], value: boolean): Promise<void> {
  if (ids.length === 0) return;
  const now = Date.now();
  await txRun(STORE.cardFavorites, 'readwrite', (s) => {
    for (const id of ids) {
      if (value) s.put({ id, at: now } satisfies CardFavorite);
      else s.delete(id);
    }
  });
}

/** 清空全部卡片收藏（清空数据时用） */
export async function clearAll(): Promise<void> {
  await txRun(STORE.cardFavorites, 'readwrite', (s) => s.clear());
}
