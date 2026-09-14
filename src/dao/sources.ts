import { clearStore, STORE, tx } from '../core/db';
import { uid } from '../core/model';
import type { Source } from '../core/types';
import { emitDataChanged } from '../state/store';

/**
 * 列出全部来源（按优先级方向排序由调用方决定，这里只按创建时间）。
 * 说明：软删除（deleted=1）的来源不出现在列表里，但在库里留着墓碑，
 * 供云同步告诉别的设备「这条被删了」。清理墓碑见 cloudSync 的说明。
 */
export async function list(): Promise<Source[]> {
  const rows = await tx<Source[]>(STORE.sources, 'readonly', (s) => s.getAll() as IDBRequest<Source[]>);
  return rows.filter((s) => s.deleted !== 1).sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * 列出全部来源**含墓碑**（云同步用：要能推到别的设备）。
 */
export async function listAll(): Promise<Source[]> {
  return tx<Source[]>(STORE.sources, 'readonly', (s) => s.getAll() as IDBRequest<Source[]>);
}

/**
 * 按 id 取来源（含墓碑，云同步合并时用）。
 * @param id 来源 id
 */
export async function getById(id: string): Promise<Source | null> {
  const row = await tx<Source | undefined>(STORE.sources, 'readonly', (s) => s.get(id) as IDBRequest<Source | undefined>);
  return row ?? null;
}

/**
 * 写入或更新一个来源（自动刷新 updatedAt，云同步按它做增量）。
 * @param source 来源对象
 */
export async function upsert(source: Source): Promise<void> {
  const next: Source = { ...source, updatedAt: Date.now(), deleted: source.deleted ?? 0 };
  await tx(STORE.sources, 'readwrite', (s) => s.put(next));
  emitDataChanged();
}

/**
 * 原样写回（不改 updatedAt）——云同步应用云端数据时用，必须保留云端版本号。
 * @param source 来源对象（已带 updatedAt / deleted）
 */
export async function putRaw(source: Source): Promise<void> {
  await tx(STORE.sources, 'readwrite', (s) => s.put(source));
  emitDataChanged();
}

/**
 * 真的从本地移除（云端已确认删除、或导入覆盖时用）。
 * @param id 来源 id
 */
export async function removePermanently(id: string): Promise<void> {
  await tx(STORE.sources, 'readwrite', (s) => s.delete(id));
  emitDataChanged();
}

/**
 * 新建来源。
 * @param name 来源名称
 */
export async function create(name: string): Promise<Source> {
  const source: Source = { id: uid(), name: name.trim(), createdAt: Date.now() };
  await upsert(source);
  return source;
}

/**
 * 按名称找来源（存在就返回，不存在就新建）。
 *
 * 说明：来源不再有优先级（优先级只有一套、挂在词上），所以这里只按名字判重。
 * @param name 来源名称
 */
export async function ensureByName(name: string): Promise<Source> {
  const key = name.trim().toLowerCase();
  const all = await list();
  const hit = all.find((s) => s.name.trim().toLowerCase() === key);
  if (hit) return hit;
  return create(name);
}

/**
 * 删除来源（不删除该来源下的词）。
 * 说明：这是**软删除**——留一条 deleted=1 的墓碑，云同步才能把删除同步到别的设备；
 * 列表里不会再看到它（见 list）。
 * @param id 来源 id
 */
export async function remove(id: string): Promise<void> {
  const row = await getById(id);
  if (!row) return;
  await putRaw({ ...row, deleted: 1, updatedAt: Date.now() });
}

/**
 * 清空来源表（含墓碑）。
 * 说明：清空是「本地重来」的动作，墓碑留着反而会把删除推到云端，
 * 所以这里直接清干净；云端数据的清理由「清空云端数据」单独负责。
 */
export async function clearAll(): Promise<void> {
  await clearStore(STORE.sources);
  emitDataChanged();
}
