import { clearStore, STORE, tx, txRun } from '../core/db';
import { normalizeEn, normalizeForCompare, uid } from '../core/model';
import type { Attrs, Sense, Word, WordQuery, WordStats, WordStatus } from '../core/types';
import { emitDataChanged } from '../state/store';

/**
 * 取全部单词（含墓碑）。
 * 说明：刻意**不在这一层过滤 deleted=1**——云同步必须能读到墓碑才能把删除推到别的设备。
 * 页面要的是「活词」，请用 `listAlive()`。
 */
export async function getAll(): Promise<Word[]> {
  return tx<Word[]>(STORE.words, 'readonly', (s) => s.getAll() as IDBRequest<Word[]>);
}

/**
 * 取全部「活词」（不含已删除的墓碑）。
 * 页面与业务逻辑统一用这个：统计、搜索、筛选、抽词都不会再看到被删的词。
 *
 * 向后兼容说明：当前版本的删除走「斩」（status='chopped'），
 * `deleted` 只在云同步时由别的设备写入，所以老数据里没有这个字段，按 0 处理。
 */
export async function listAlive(): Promise<Word[]> {
  const all = await getAll();
  return all.filter((w) => w.deleted !== 1);
}

/**
 * 按 id 取词。
 * @param id 单词 id
 */
export async function getById(id: string): Promise<Word | null> {
  const row = await tx<Word | undefined>(STORE.words, 'readonly', (s) => s.get(id) as IDBRequest<Word | undefined>);
  return row ?? null;
}

/**
 * 按英文取词（归一化后不区分大小写）。
 * @param en 英文单词
 */
export async function getByEn(en: string): Promise<Word | null> {
  const key = normalizeEn(en).toLowerCase();
  if (!key) return null;
  const all = await listAlive();
  return all.find((w) => normalizeEn(w.en).toLowerCase() === key) ?? null;
}

/**
 * 整词写回（编辑音标/例句/义项/来源等用）。
 * @param word 单词对象
 */
export async function put(word: Word): Promise<void> {
  // 注意：这里写回时把 deleted 归零——「编辑一个词」的语义就是把它当成活词。
  const next: Word = { ...word, updatedAt: Date.now(), deleted: 0 };
  await tx(STORE.words, 'readwrite', (s) => s.put(next));
  emitDataChanged();
}

/**
 * 批量写入（新增或覆盖，按 id 判重）。
 * @param words 单词数组
 */
export async function bulkUpsert(words: Word[]): Promise<{ inserted: number; updated: number }> {
  if (words.length === 0) return { inserted: 0, updated: 0 };
  const existing = await getAll();
  const ids = new Set(existing.map((w) => w.id));
  let inserted = 0;
  let updated = 0;
  const now = Date.now();
  await txRun(STORE.words, 'readwrite', (s) => {
    for (const w of words) {
      if (ids.has(w.id)) updated += 1;
      else inserted += 1;
      s.put({ ...w, updatedAt: now, deleted: 0 });
    }
  });
  emitDataChanged();
  return { inserted, updated };
}

/**
 * 原样写回一条词（**不改 updatedAt**）——云同步应用云端数据时用。
 * 必须保留云端的版本号，否则会把「云端已改」判成「本地又改了」来回打架。
 * @param word 单词对象
 * @param touch 是否刷新本地 updatedAt（默认 false）
 */
export async function putRaw(word: Word, touch = false): Promise<void> {
  const next: Word = touch ? { ...word, updatedAt: Date.now() } : word;
  await tx(STORE.words, 'readwrite', (s) => s.put(next));
}

/**
 * 批量原样写回（一次事务），云同步应用增量时用。
 * @param words 单词数组
 */
export async function putRawMany(words: Word[]): Promise<void> {
  if (words.length === 0) return;
  await txRun(STORE.words, 'readwrite', (s) => {
    for (const w of words) s.put(w);
  });
}

/**
 * 覆盖某词的义项。
 * @param id 单词 id
 * @param senses 新义项列表
 */
export async function updateSenses(id: string, senses: Sense[]): Promise<void> {
  const word = await getById(id);
  if (!word) return;
  await put({ ...word, senses });
}

/**
 * 局部更新属性（属性①~⑥）。
 * @param id 单词 id
 * @param patch 属性补丁
 */
export async function updateAttrs(id: string, patch: Partial<Attrs>): Promise<void> {
  const word = await getById(id);
  if (!word) return;
  await put({ ...word, attrs: { ...word.attrs, ...patch } });
}

/**
 * 斩掉某词（背诵/复习/记忆/推荐数字中均不再出现）。
 * @param id 单词 id
 */
export async function chop(id: string): Promise<void> {
  const word = await getById(id);
  if (!word) return;
  await put({ ...word, status: 'chopped' });
}

/**
 * 复活某词（列表页用）。
 * @param id 单词 id
 */
export async function revive(id: string): Promise<void> {
  const word = await getById(id);
  if (!word) return;
  const status: WordStatus = word.attrs.learnedAt !== null ? 'learned' : 'unlearned';
  await put({ ...word, status });
}

/**
 * 切换单词状态（chopped 请走 chop/revive）。
 * @param id 单词 id
 * @param status 目标状态
 */
export async function setStatus(id: string, status: WordStatus): Promise<void> {
  const word = await getById(id);
  if (!word) return;
  await put({ ...word, status });
}

/**
 * 删除一个词。
 * @param id 单词 id
 */
export async function remove(id: string): Promise<void> {
  await tx(STORE.words, 'readwrite', (s) => s.delete(id));
  emitDataChanged();
}

/**
 * 批量删除。
 * @param ids 单词 id 数组
 */
export async function removeMany(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await txRun(STORE.words, 'readwrite', (s) => {
    for (const id of ids) s.delete(id);
  });
  emitDataChanged();
}

/**
 * 批量改属性（批量操作条用）。
 * @param ids 单词 id 数组
 * @param patch 属性补丁
 */
export async function updateAttrsMany(ids: string[], patch: Partial<Attrs>): Promise<void> {
  if (ids.length === 0) return;
  const all = await listAlive();
  const target = new Set(ids);
  const now = Date.now();
  await txRun(STORE.words, 'readwrite', (s) => {
    for (const w of all) {
      if (!target.has(w.id)) continue;
      s.put({ ...w, deleted: 0, attrs: { ...w.attrs, ...patch }, updatedAt: now });
    }
  });
  emitDataChanged();
}

/**
 * 批量改状态。
 * @param ids 单词 id 数组
 * @param status 目标状态（null = 复活到合理状态）
 */
export async function setStatusMany(ids: string[], status: WordStatus | null): Promise<void> {
  if (ids.length === 0) return;
  const all = await listAlive();
  const target = new Set(ids);
  const now = Date.now();
  await txRun(STORE.words, 'readwrite', (s) => {
    for (const w of all) {
      if (!target.has(w.id)) continue;
      const next: WordStatus = status ?? (w.attrs.learnedAt !== null ? 'learned' : 'unlearned');
      s.put({ ...w, deleted: 0, status: next, updatedAt: now });
    }
  });
  emitDataChanged();
}

/**
 * 判断一个词是否符合查询条件（只看筛选，不看排序与分页）。
 *
 * ★ 抽出来是必须的：`query()` 和 `queryIds()` 都要用同一套筛选。
 *   两处各写一遍的话，出现分歧时表现是
 *   「页面显示 3000 条，一键全选却只选中 2800 条」——这种错很难发现，
 *   而且用户做批量操作时根本不会去核对条数。
 *
 * @param w 词条
 * @param q 查询条件
 */
function matchesQuery(w: Word, q: WordQuery): boolean {
  if (q.status && q.status.length > 0 && !q.status.includes(w.status)) return false;
  if (q.sourceId && w.sourceId !== q.sourceId) return false;
  if (q.needSpell === true && !w.attrs.needSpell) return false;
  if (q.needSpell === false && w.attrs.needSpell) return false;
  if (typeof q.minFailCount === 'number' && w.attrs.failCount < q.minFailCount) return false;
  if (typeof q.minPriority === 'number' && w.attrs.reviewPriority < q.minPriority) return false;
  if (q.keyword) {
    const keyword = normalizeForCompare(q.keyword);
    const haystack = [w.en, ...w.senses.flatMap((s) => [s.text, ...s.aliases])]
      .map(normalizeForCompare)
      .join('\u0000');
    if (!haystack.includes(keyword)) return false;
  }
  return true;
}

/**
 * 只查「符合条件的词 id」，不分页。
 *
 * ★ 为什么需要它：列表页的「全选」原来只选当前页（≤200 条），
 *   想做「把几千个词一次性批量改」根本做不到。
 *   这个函数让页面能拿到**整个筛选结果**的 id 集合，从而支持跨页全选。
 *
 * 与 `query()` 共用同一套筛选逻辑（下面抽成了 `matchesQuery`），
 * 避免两处判断不一致导致「看到的条数」和「选中的条数」对不上。
 *
 * @param q 查询条件（page / pageSize / sort / order 会被忽略）
 */
export async function queryIds(q: WordQuery): Promise<{ total: number; ids: string[] }> {
  const all = await listAlive();
  const ids = all.filter((w) => matchesQuery(w, q)).map((w) => w.id);
  return { total: ids.length, ids };
}

/**
 * 查询：筛选 + 排序 + 分页（全部在内存里算）。
 * @param q 查询条件
 */
export async function query(q: WordQuery): Promise<{ total: number; items: Word[] }> {
  const all = await listAlive();
  const list = all.filter((w) => matchesQuery(w, q));

  const sort = q.sort ?? 'createdAt';
  const dir = q.order === 'asc' ? 1 : -1;
  list.sort((a, b) => {
    if (sort === 'en') return a.en.toLowerCase().localeCompare(b.en.toLowerCase()) * dir;
    if (sort === 'learnOrder') {
      // learnOrder 为 null 的排最后（不论升降序）
      if (a.learnOrder === null && b.learnOrder === null) return 0;
      if (a.learnOrder === null) return 1;
      if (b.learnOrder === null) return -1;
      return (a.learnOrder - b.learnOrder) * dir;
    }
    if (sort === 'reviewPriority') return (a.attrs.reviewPriority - b.attrs.reviewPriority) * dir;
    return (a.createdAt - b.createdAt) * dir;
  });

  const pageSize = Math.max(1, q.pageSize);
  const pageCount = Math.max(1, Math.ceil(list.length / pageSize));
  const page = Math.min(Math.max(1, q.page), pageCount);
  const start = (page - 1) * pageSize;
  return { total: list.length, items: list.slice(start, start + pageSize) };
}

/**
 * 词库统计。
 */
export async function stats(): Promise<WordStats> {
  const all = await listAlive();
  const out: WordStats = { total: all.length, unlearned: 0, learning: 0, learned: 0, chopped: 0 };
  for (const w of all) out[w.status] += 1;
  return out;
}

/**
 * 把整库优先度写回（「重算优先度」按钮用）。
 * @param entries id → 新优先度
 */
export async function applyPriorities(entries: { id: string; priority: number }[]): Promise<void> {
  if (entries.length === 0) return;
  const map = new Map(entries.map((e) => [e.id, e.priority]));
  const all = await listAlive();
  const now = Date.now();
  await txRun(STORE.words, 'readwrite', (s) => {
    for (const w of all) {
      const p = map.get(w.id);
      if (p === undefined) continue;
      s.put({ ...w, deleted: 0, attrs: { ...w.attrs, reviewPriority: p }, updatedAt: now });
    }
  });
  emitDataChanged();
}

/**
 * 生成背诵顺序序号（阶段 05 会用；这里先给最大序号工具）。
 */
export async function maxLearnOrder(): Promise<number> {
  const all = await listAlive();
  return all.reduce((max, w) => (w.learnOrder !== null && w.learnOrder > max ? w.learnOrder : max), 0);
}

/**
 * 清空所有单词。
 */
export async function clearAll(): Promise<void> {
  await clearStore(STORE.words);
  emitDataChanged();
}

/** 生成一个新的单词 id（页面构造新词时用，避免各处 import uid） */
export function newId(): string {
  return uid();
}
