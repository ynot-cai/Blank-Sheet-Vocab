/**
 * 二期「三张小表」的数据访问层：**语境词 / 题目历史 / 题库**。
 *
 * 为什么与 `kcInventory.ts`（卡片）分开：单文件 ≤ 300 行；
 * 而且这三张表都是「**只增不改**的记录型数据」（语境词按天、题目历史按次、题库按条），
 * 与卡片的「频繁编辑」是两种使用方式。
 *
 * ⚠️ **所有 SQL 都带 `WHERE space_key = ?`**（空间隔离靠这条纪律）。
 * 日志只打条数，绝不打印内容。
 */
import { getDB } from './db.js';
import { KC_SMALL_TABLES, type KcSmallTableKey, type SyncRow } from './kcSmallTables.js';

/** 语境词行 */
export interface ContextWordRow {
  id: string;
  date: string;
  words: string;
  source: string;
  confirmed: number;
  created_at: number;
  updated_at: number;
  deleted: number;
}

/** 题目历史行 */
export interface ExamRecordRow {
  id: string;
  card_id: string;
  date: string;
  type: string;
  question: string;
  user_answer: string | null;
  ai_score: number | null;
  ai_reason: string | null;
  context_word: string | null;
  created_at: number;
  updated_at: number;
  deleted: number;
}

/** 题库行 */
export interface BankQuestionRow {
  id: string;
  type: string;
  content: string;
  source: string | null;
  created_at: number;
  updated_at: number;
  deleted: number;
}

/**
 * 把驱动返回的行转成普通对象（libSQL 的 Row 类直接展开拿不到字段）。
 * @param row 驱动返回的行
 */
function toPlainRow<T>(row: unknown): T {
  const withRaw = row as { raw?: () => unknown };
  if (typeof withRaw.raw === 'function') {
    const raw = withRaw.raw();
    if (typeof raw === 'object' && raw !== null) return raw as T;
  }
  return { ...(row as T) };
}

/**
 * 生成 upsert 语句（冲突目标是复合主键 `(space_key, id)`，理由见 kcSchema.ts）。
 * @param tableKey 表的键名
 */
function buildUpsert(tableKey: KcSmallTableKey): string {
  const { table, columns } = KC_SMALL_TABLES[tableKey];
  const placeholders = columns.map(() => '?').join(', ');
  const updates = columns
    .filter((c) => c !== 'id' && c !== 'space_key')
    .map((c) => `${c} = excluded.${c}`)
    .join(', ');
  return `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders}) ON CONFLICT(space_key, id) DO UPDATE SET ${updates}`;
}

/** 三张表的 upsert SQL（预先算好） */
const UPSERT_SQL: Record<KcSmallTableKey, string> = {
  contextWords: buildUpsert('contextWords'),
  examRecords: buildUpsert('examRecords'),
  bankQuestions: buildUpsert('bankQuestions'),
};

/**
 * 增量拉取一张小表（含墓碑）。
 * @param tableKey 表
 * @param spaceKey 数据空间
 * @param since 只取 updated_at 大于它的行
 * @param limit 单次上限
 */
export async function selectSmallTableSince(
  tableKey: KcSmallTableKey,
  spaceKey: string,
  since: number,
  limit: number,
): Promise<Record<string, unknown>[]> {
  const { table, columns } = KC_SMALL_TABLES[tableKey];
  const rs = await getDB().execute({
    sql: `SELECT ${columns.filter((c) => c !== 'space_key').join(', ')} FROM ${table}
          WHERE space_key = ? AND updated_at > ?
          ORDER BY updated_at ASC, id ASC LIMIT ?`,
    args: [spaceKey, since, limit],
  });
  return rs.rows.map((row) => toPlainRow<Record<string, unknown>>(row));
}

/**
 * 查这些 id 在本空间里已有的 `updated_at`（后写覆盖判断用）。
 * @param tableKey 表
 * @param spaceKey 数据空间
 * @param ids id 列表
 * @param chunkSize 每块多少个 id（SQLite 变量上限 999）
 */
export async function selectExistingSmallTimes(
  tableKey: KcSmallTableKey,
  spaceKey: string,
  ids: string[],
  chunkSize = 200,
): Promise<Map<string, number>> {
  const { table } = KC_SMALL_TABLES[tableKey];
  const out = new Map<string, number>();
  const db = getDB();
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    const placeholders = chunk.map(() => '?').join(', ');
    const rs = await db.execute({
      sql: `SELECT id, updated_at FROM ${table} WHERE space_key = ? AND id IN (${placeholders})`,
      args: [spaceKey, ...chunk],
    });
    for (const row of rs.rows) {
      const plain = toPlainRow<{ id: string; updated_at: number }>(row);
      out.set(plain.id, plain.updated_at);
    }
  }
  return out;
}

/**
 * 批量 upsert 一张小表（单事务）。
 * @param tableKey 表
 * @param spaceKey 数据空间
 * @param rows 已归一化的行
 */
export async function upsertSmallTable(
  tableKey: KcSmallTableKey,
  spaceKey: string,
  rows: SyncRow[],
): Promise<void> {
  if (rows.length === 0) return;
  const { columns } = KC_SMALL_TABLES[tableKey];
  const sql = UPSERT_SQL[tableKey];
  await getDB().batch(
    rows.map((row) => ({
      sql,
      args: columns.map((c) => (c === 'id' ? row.id : c === 'space_key' ? spaceKey : (row.values[c] ?? null))),
    })),
    'write',
  );
}

/**
 * 查某个空间里最近若干天的题目历史（出题防重复用）。
 *
 * 这是**唯一一个「不是同步」的查询**：前端的出题流程需要「近 N 天的题干」，
 * 光靠本地拿不到别的设备出过的题。
 *
 * @param spaceKey 数据空间
 * @param sinceTs 只取 created_at 大于它的
 * @param limit 最多几条
 */
export async function selectRecentExamQuestions(
  spaceKey: string,
  sinceTs: number,
  limit: number,
): Promise<{ question: string }[]> {
  const rs = await getDB().execute({
    sql: `SELECT question FROM exam_records
          WHERE space_key = ? AND created_at > ? AND deleted = 0
          ORDER BY created_at DESC LIMIT ?`,
    args: [spaceKey, sinceTs, limit],
  });
  return rs.rows.map((row) => toPlainRow<{ question: string }>(row));
}
