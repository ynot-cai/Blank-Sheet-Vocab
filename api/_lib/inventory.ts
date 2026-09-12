/**
 * 数据访问层（DAO）：**所有 SQL 都在这个文件里，且每条都带 `WHERE space_key = ?`**。
 *
 * 空间隔离靠这一条纪律保证：函数签名强制要求 spaceKey，
 * 处理函数（sync-pull / sync-push）只负责取参数和拼响应，没法绕过去查全表。
 *
 * 这里也**绝不存明文同步码**：传进来的 spaceKey 本身就是 SHA-256 哈希（见 spaceAuth.ts）。
 */
import { getDB } from './db.ts';
import type { InValue } from '@libsql/client';

/** 单词行（words 表） */
export interface WordRow {
  id: string;
  en: string;
  phonetic: string | null;
  example: string | null;
  senses: string;
  source_id: string | null;
  raw_sources: string | null;
  attrs: string;
  status: string;
  learn_order: number | null;
  created_at: number;
  updated_at: number;
  deleted: number;
}

/** 来源行（sources 表） */
export interface SourceRow {
  id: string;
  name: string;
  priority: number;
  created_at: number;
  updated_at: number;
  deleted: number;
}

/** 待写入的一条单词（已校验、已归一化） */
export interface WordInput {
  id: string;
  en: string;
  phonetic: string;
  example: string;
  /** JSON 字符串 */
  senses: string;
  sourceId: string;
  /** JSON 字符串 */
  rawSources: string;
  /** JSON 字符串 */
  attrs: string;
  status: string;
  learnOrder: number | null;
  createdAt: number;
  updatedAt: number;
  deleted: number;
}

/** 待写入的一条来源（已校验、已归一化） */
export interface SourceInput {
  id: string;
  name: string;
  priority: number;
  createdAt: number;
  updatedAt: number;
  deleted: number;
}

/** 某个数据空间里已有的 (id, updated_at) */
export interface ExistingRow {
  id: string;
  updated_at: number;
}

/**
 * 把驱动返回的一行转成普通对象。
 *
 * **必须做这一步**：libSQL 返回的行是 `Row` 类实例，字段挂在内部实现上，
 * 直接 `JSON.stringify` 不保证拿到完整字段（实测会得到 `{}`）。
 * 这里优先用行自带的 `raw()`（libSQL 提供的"原始对象"视图），
 * 没有就退化成展开——两条路都保证返回**纯普通对象**。
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

/** words 表的列（按固定顺序，INSERT 时复用） */
const WORD_COLUMNS = [
  'id',
  'space_key',
  'en',
  'phonetic',
  'example',
  'senses',
  'source_id',
  'raw_sources',
  'attrs',
  'status',
  'learn_order',
  'created_at',
  'updated_at',
  'deleted',
] as const;

/** sources 表的列 */
const SOURCE_COLUMNS = ['id', 'space_key', 'name', 'priority', 'created_at', 'updated_at', 'deleted'] as const;

/**
 * 生成 `INSERT ... ON CONFLICT DO UPDATE SET ...` 语句。
 *
 * 说明：
 * - 冲突目标是**复合主键 `(space_key, id)`**，不是单独的 id——
 *   否则跨空间同 id 会互相覆盖（见 db.ts 里的警告注释）；
 * - 不用 `INSERT OR REPLACE`：那样会先删后插，语义上更接近「覆盖」，
 *   但更新路径不透明；显式 upsert 也方便将来加冲突处理。
 * @param table 表名
 * @param columns 列名
 */
function buildUpsertSql(table: 'words' | 'sources', columns: readonly string[]): string {
  const placeholders = columns.map(() => '?').join(', ');
  const updates = columns
    .filter((c) => c !== 'id' && c !== 'space_key')
    .map((c) => `${c} = excluded.${c}`)
    .join(', ');
  return `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders}) ON CONFLICT(space_key, id) DO UPDATE SET ${updates}`;
}

/** words 的 upsert 语句 */
const UPSERT_WORD_SQL = buildUpsertSql('words', WORD_COLUMNS);
/** sources 的 upsert 语句 */
const UPSERT_SOURCE_SQL = buildUpsertSql('sources', SOURCE_COLUMNS);

/**
 * 把一条单词输入摊平成参数数组（顺序与 WORD_COLUMNS 一致）。
 * @param spaceKey 数据空间键（SHA-256）
 * @param w 单词输入
 */
function wordArgs(spaceKey: string, w: WordInput): InValue[] {
  return [
    w.id,
    spaceKey,
    w.en,
    w.phonetic,
    w.example,
    w.senses,
    w.sourceId,
    w.rawSources,
    w.attrs,
    w.status,
    w.learnOrder,
    w.createdAt,
    w.updatedAt,
    w.deleted,
  ];
}

/**
 * 把一条来源输入摊平成参数数组（顺序与 SOURCE_COLUMNS 一致）。
 * @param spaceKey 数据空间键（SHA-256）
 * @param s 来源输入
 */
function sourceArgs(spaceKey: string, s: SourceInput): InValue[] {
  return [s.id, spaceKey, s.name, s.priority, s.createdAt, s.updatedAt, s.deleted];
}

/**
 * 增量拉取单词（含 `deleted=1` 的软删除记录，客户端要靠它同步删除）。
 * @param spaceKey 数据空间键
 * @param since 只取 updated_at 大于这个时间戳的行（0 = 全量）
 * @param limit 单次上限
 */
export async function selectWordsSince(spaceKey: string, since: number, limit: number): Promise<WordRow[]> {
  const rs = await getDB().execute({
    sql: `SELECT id, en, phonetic, example, senses, source_id, raw_sources, attrs, status, learn_order, created_at, updated_at, deleted
          FROM words WHERE space_key = ? AND updated_at > ?
          ORDER BY updated_at ASC, id ASC LIMIT ?`,
    args: [spaceKey, since, limit],
  });
  return rs.rows.map((row) => toPlainRow<WordRow>(row));
}

/**
 * 增量拉取来源。
 * @param spaceKey 数据空间键
 * @param since 只取 updated_at 大于这个时间戳的行
 * @param limit 单次上限
 */
export async function selectSourcesSince(spaceKey: string, since: number, limit: number): Promise<SourceRow[]> {
  const rs = await getDB().execute({
    sql: `SELECT id, name, priority, created_at, updated_at, deleted
          FROM sources WHERE space_key = ? AND updated_at > ?
          ORDER BY updated_at ASC, id ASC LIMIT ?`,
    args: [spaceKey, since, limit],
  });
  return rs.rows.map((row) => toPlainRow<SourceRow>(row));
}

/** 空表时取最大 updated_at 用，避免「一条都没有」时把 since 推到 0 反复全量拉 */
export interface MaxUpdated {
  max_updated: number | null;
}

/**
 * 取某个空间里单词的最大 updated_at（用于服务器时间基准）。
 * @param spaceKey 数据空间键
 */
export async function maxWordUpdatedAt(spaceKey: string): Promise<number | null> {
  const rs = await getDB().execute({
    sql: 'SELECT MAX(updated_at) AS max_updated FROM words WHERE space_key = ?',
    args: [spaceKey],
  });
  const row = rs.rows[0];
  if (row === undefined) return null;
  return toPlainRow<MaxUpdated>(row).max_updated ?? null;
}

/**
 * 查这些 id 在**本空间**里已有的 updated_at（用于后写覆盖判断与 conflicts 统计）。
 * 分块查询，避免 SQL 变量数量超限（SQLite 默认上限 999）。
 * @param spaceKey 数据空间键
 * @param ids 单词 id 列表
 * @param chunkSize 每块多少个 id
 */
export async function selectExistingWordTimes(
  spaceKey: string,
  ids: string[],
  chunkSize = 200,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const db = getDB();
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    const placeholders = chunk.map(() => '?').join(', ');
    const rs = await db.execute({
      sql: `SELECT id, updated_at FROM words WHERE space_key = ? AND id IN (${placeholders})`,
      args: [spaceKey, ...chunk],
    });
    for (const row of rs.rows) {
      const plain = toPlainRow<ExistingRow>(row);
      out.set(plain.id, plain.updated_at);
    }
  }
  return out;
}

/**
 * 查这些 id 在本空间里已有的 updated_at（sources 表）。
 * @param spaceKey 数据空间键
 * @param ids 来源 id 列表
 * @param chunkSize 每块多少个 id
 */
export async function selectExistingSourceTimes(
  spaceKey: string,
  ids: string[],
  chunkSize = 200,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const db = getDB();
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    const placeholders = chunk.map(() => '?').join(', ');
    const rs = await db.execute({
      sql: `SELECT id, updated_at FROM sources WHERE space_key = ? AND id IN (${placeholders})`,
      args: [spaceKey, ...chunk],
    });
    for (const row of rs.rows) {
      const plain = toPlainRow<ExistingRow>(row);
      out.set(plain.id, plain.updated_at);
    }
  }
  return out;
}

/**
 * 批量写入单词（单事务）。
 * @param spaceKey 数据空间键
 * @param rows 通过冲突判断、可以落库的行
 */
export async function upsertWords(spaceKey: string, rows: WordInput[]): Promise<void> {
  if (rows.length === 0) return;
  await getDB().batch(
    rows.map((w) => ({ sql: UPSERT_WORD_SQL, args: wordArgs(spaceKey, w) })),
    'write',
  );
}

/**
 * 批量写入来源（单事务）。
 * @param spaceKey 数据空间键
 * @param rows 通过冲突判断、可以落库的行
 */
export async function upsertSources(spaceKey: string, rows: SourceInput[]): Promise<void> {
  if (rows.length === 0) return;
  await getDB().batch(
    rows.map((s) => ({ sql: UPSERT_SOURCE_SQL, args: sourceArgs(spaceKey, s) })),
    'write',
  );
}

/**
 * 清空一个数据空间（设置页「清空云端数据」用；只影响自己的空间）。
 * 说明：这里是真的 DELETE，不是软删除——用户明确要求删掉，就不该留残影。
 * @param spaceKey 数据空间键
 * @returns 被删掉的词条数与来源数
 */
export async function purgeSpace(spaceKey: string): Promise<{ words: number; sources: number }> {
  const db = getDB();
  const before = await db.execute({
    sql: 'SELECT (SELECT COUNT(*) FROM words WHERE space_key = ?) AS w, (SELECT COUNT(*) FROM sources WHERE space_key = ?) AS s',
    args: [spaceKey, spaceKey],
  });
  const row = before.rows[0];
  const counts = row === undefined ? { w: 0, s: 0 } : toPlainRow<{ w: number; s: number }>(row);
  await db.batch(
    [
      { sql: 'DELETE FROM words WHERE space_key = ?', args: [spaceKey] },
      { sql: 'DELETE FROM sources WHERE space_key = ?', args: [spaceKey] },
    ],
    'write',
  );
  return { words: Number(counts.w ?? 0), sources: Number(counts.s ?? 0) };
}
