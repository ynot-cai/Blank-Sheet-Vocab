/**
 * 入库时的「同一个词已存在」处理。
 *
 * ★ 关于优先级（R1 之后收敛成**一套**，别再引入第二套）：
 *   优先级只有一个，挂在词上（`Word.priority`，1~5）。
 *   它决定两件事：
 *     1. 背诵先抽谁（绝对优先）；
 *     2. 重复录入时**要不要弹确认框**——库里那条的 priority 和本次不同才问
 *        （见 `ui/pages/MergePage.ts` 的 collectPriorityConflicts）。
 *
 *   所以**义项的取舍不再由任何「来源优先级」决定**：
 *   · 用户选「覆盖」→ 本次的义项与优先级都写进去；
 *   · 用户选「保留」→ 库里那条一个字都不动，本次的义项留档到 rawSources，
 *     用户在列表页可以手动采纳（`adoptRawSource`）。
 *
 *   这样「覆盖 / 保留」只有一个出口——那个确认框——行为可预测、可解释。
 */
import type { Word } from './types';
import { normalizeEn } from './model';

/** 冲突处理动作：新增 / 覆盖已有词 / 保留已有词（本次义项进 rawSources 留档） */
export type ConflictAction = 'insert' | 'replace' | 'keepBoth';

/** 入库计划 */
export interface ImportPlan {
  inserts: Word[];
  replaces: Word[];
  keeps: Word[];
  /** 给用户看的一句话统计 */
  report: string;
}

/**
 * 判定单个词入库时的处理方式。
 *
 * - 库里没有该 en → insert
 * - 库里有：
 *   · `overwrite === true`（用户在那个单独的确认框里选了「覆盖」）→ replace，
 *     旧义项塞进 rawSources 留档；
 *   · 否则 → keepBoth（不动库里那条，本次义项塞进 rawSources）。
 *
 * @param existing 库里已有的词（没有则传 null）
 * @param incoming 待入库的词
 * @param overwrite 用户是否明确要求覆盖这个已存在的词
 */
export function resolveConflict(
  existing: Word | null,
  incoming: Word,
  overwrite = false,
): { action: ConflictAction; word: Word } {
  if (!existing) return { action: 'insert', word: incoming };

  const now = Date.now();

  if (overwrite) {
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
      priority: incoming.priority,
      // 用户选了覆盖：库里那条的旧义项留档，方便列表页回看/采纳
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
 *
 * @param incoming 待入库的词
 * @param existing 库中已有词
 * @param overwriteIds 用户在那个单独的确认框里选了「覆盖」的词 id（库里那条的 id）
 */
export function planImport(incoming: Word[], existing: Word[], overwriteIds: Set<string> = new Set()): ImportPlan {
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
    const overwrite = base !== null && overwriteIds.has(base.id);
    const { action, word: resolved } = resolveConflict(base, word, overwrite);
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
      : `${existingHit} 个词已存在，其中 ${replaces.length} 个按你的选择被覆盖，` +
        `${keeps.length} 个保留原义项（本次的义项已留档，可在列表页手动采纳）`;

  return { inserts, replaces, keeps, report };
}
