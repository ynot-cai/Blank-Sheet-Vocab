import type { PriorityDir, Source, Word } from './types';
import { normalizeEn } from './model';

/** 冲突处理动作：新增 / 覆盖主义项 / 两者都留（新的进 rawSources） */
export type ConflictAction = 'insert' | 'replace' | 'keepBoth';

/** 入库计划 */
export interface ImportPlan {
  inserts: Word[];
  replaces: Word[];
  keeps: Word[];
  /** 给用户看的一句话统计 */
  report: string;
}

/** 来源优先级登记表（由调用方从 dao.sources 载入后写入） */
let priorityRegistry: Record<string, number> = {};

/**
 * 登记来源优先级，供 resolveConflict 查询。
 * @param sources 来源列表
 */
export function setSourcePriorities(sources: Source[]): void {
  const next: Record<string, number> = {};
  for (const s of sources) next[s.id] = s.priority;
  priorityRegistry = next;
}

/**
 * 取来源优先级，未登记过按 0 处理。
 * @param sourceId 来源 id
 */
export function getSourcePriority(sourceId: string): number {
  return priorityRegistry[sourceId] ?? 0;
}

/**
 * 按优先级方向判断 a 是否比 b 更优先。
 * @param a 优先级 a
 * @param b 优先级 b
 * @param dir desc = 数字越大越优先；asc = 数字越小越优先
 */
export function isHigherPriority(a: number, b: number, dir: PriorityDir): boolean {
  return dir === 'desc' ? a > b : a < b;
}

/**
 * 判定单个词入库时的冲突处理方式。
 * - 库里没有该 en → insert
 * - 库里有：新来源优先级更高 → replace（旧义项塞进 rawSources）
 *            否则 → keepBoth（不动 senses，新的塞进 rawSources）
 * @param existing 库里已有的词（没有则传 null）
 * @param incoming 待入库的词
 * @param priorityDir 优先级方向
 * @param priorities 来源优先级表（默认用 setSourcePriorities 登记的那份）
 */
export function resolveConflict(
  existing: Word | null,
  incoming: Word,
  priorityDir: PriorityDir,
  priorities: Record<string, number> = priorityRegistry,
): { action: ConflictAction; word: Word } {
  if (!existing) return { action: 'insert', word: incoming };

  const oldP = priorities[existing.sourceId] ?? 0;
  const newP = priorities[incoming.sourceId] ?? 0;
  const now = Date.now();

  if (isHigherPriority(newP, oldP, priorityDir)) {
    const mergedRaw = [
      ...existing.rawSources.filter((r) => r.sourceId !== existing.sourceId),
      { sourceId: existing.sourceId, senses: existing.senses },
    ];
    const word: Word = {
      ...existing,
      senses: incoming.senses,
      phonetic: incoming.phonetic || existing.phonetic,
      example: incoming.example || existing.example,
      sourceId: incoming.sourceId,
      rawSources: mergedRaw,
      updatedAt: now,
    };
    return { action: 'replace', word };
  }

  const already = existing.rawSources.some((r) => r.sourceId === incoming.sourceId);
  const rawSources = already
    ? existing.rawSources.map((r) => (r.sourceId === incoming.sourceId ? { ...r, senses: incoming.senses } : r))
    : [...existing.rawSources, { sourceId: incoming.sourceId, senses: incoming.senses }];
  const word: Word = {
    ...existing,
    phonetic: existing.phonetic || incoming.phonetic,
    example: existing.example || incoming.example,
    rawSources,
    updatedAt: now,
  };
  return { action: 'keepBoth', word };
}

/**
 * 把一批待入库的词与库中已有词做冲突规划。
 * @param incoming 待入库的词
 * @param existing 库中已有词
 * @param priorityDir 优先级方向
 */
export function planImport(
  incoming: Word[],
  existing: Word[],
  priorityDir: PriorityDir,
): ImportPlan {
  const byEn = new Map<string, Word>();
  for (const w of existing) byEn.set(normalizeEn(w.en).toLowerCase(), w);

  const inserts: Word[] = [];
  const replaces: Word[] = [];
  const keeps: Word[] = [];
  /** 同批次内重复的词也要能互相判重 */
  const batchSeen = new Map<string, Word>();

  for (const word of incoming) {
    const key = normalizeEn(word.en).toLowerCase();
    const prevInBatch = batchSeen.get(key) ?? null;
    const inDb = byEn.get(key) ?? null;
    const base = prevInBatch ?? inDb;
    const { action, word: resolved } = resolveConflict(base, word, priorityDir);
    if (action === 'insert') {
      inserts.push(resolved);
      batchSeen.set(key, resolved);
    } else if (action === 'replace') {
      if (prevInBatch) {
        const idx = inserts.findIndex((w) => w.id === prevInBatch.id);
        if (idx >= 0) {
          inserts[idx] = resolved;
          batchSeen.set(key, resolved);
          continue;
        }
      }
      replaces.push(resolved);
      batchSeen.set(key, resolved);
    } else {
      keeps.push(resolved);
      batchSeen.set(key, resolved);
    }
  }

  const existingHit = replaces.length + keeps.length;
  const report =
    existingHit === 0
      ? `${inserts.length} 个新词将入库`
      : `${existingHit} 个词已存在，其中 ${replaces.length} 个因来源优先级更高被覆盖，` +
        `${keeps.length} 个保留原义项（可在列表页手动采纳）`;

  return { inserts, replaces, keeps, report };
}
