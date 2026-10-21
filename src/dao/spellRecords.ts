/**
 * 拼写强化的单词记录 DAO（版本 0.0.25）。
 *
 * ★ 用户「六、数据要求」：「本功能复用主程序的单词数据模型与存储层，不新建数据字段。
 *   需要持久化的内容：每个单词在本功能中的历史得分、出现次数」。
 *   所以记录**不进 `words` 表**，单独存在 `spellRecords`（主键 = 词 id）。
 *
 * 记录在**提交拼写、进入单词卡之前**写入（用户「三」：本题成绩必须在离开单词卡之前写入记录），
 * 由 `SpellPage` 负责；本文件只做存取。
 *
 * RULES-R1: 本文件只存取成绩，不参与作答判定，也没有任何时间限制 / 倒计时。
 */
import { STORE, tx, txRun } from '../core/db';
import type { SpellRecord } from '../core/types';

/** 读全部记录（拼写强化的词量很小，一次全读） */
export async function list(): Promise<SpellRecord[]> {
  return (await tx<SpellRecord[]>(STORE.spellRecords, 'readonly', (s) => s.getAll() as IDBRequest<SpellRecord[]>)) ?? [];
}

/** 读成 id → 记录 的 Map（算优先级时用） */
export async function map(): Promise<Map<string, SpellRecord>> {
  const rows = await list();
  return new Map(rows.map((r) => [r.id, r]));
}

/**
 * 记一次成绩（出现次数 +1，累加总分，更新最近/最高分）。
 * @param id 词 id
 * @param score 本题得分（0~5）
 * @param now 当前时间
 * @returns 写回后的记录
 */
export async function recordScore(id: string, score: number, now: number = Date.now()): Promise<SpellRecord> {
  const rows = await tx<SpellRecord[]>(STORE.spellRecords, 'readonly', (s) => s.getAll() as IDBRequest<SpellRecord[]>);
  const old = (rows ?? []).find((r) => r.id === id);
  const next: SpellRecord = {
    id,
    attempts: (old?.attempts ?? 0) + 1,
    lastScore: score,
    bestScore: Math.max(old?.bestScore ?? 0, score),
    totalScore: (old?.totalScore ?? 0) + score,
    lastAt: now,
  };
  await txRun(STORE.spellRecords, 'readwrite', (s) => s.put(next));
  return next;
}

/** 清空全部记录（清空数据时用） */
export async function clearAll(): Promise<void> {
  await txRun(STORE.spellRecords, 'readwrite', (s) => s.clear());
}
