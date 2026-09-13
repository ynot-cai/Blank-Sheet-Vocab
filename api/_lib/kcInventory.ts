/**
 * 二期数据访问层（服务端）：**所有二期 SQL 都在这个文件里，
 * 且每一条都带 `WHERE space_key = ?`**。
 *
 * 空间隔离靠这一条纪律保证：函数签名强制要求 spaceKey，
 * 处理函数（kc-list / kc-push）只负责取参数和拼响应，绕不过去查全表。
 *
 * 与一期 inventory.ts 的关系：一期管 words/sources，二期管 knowledge_cards 等四张表，
 * 两套 SQL 互不引用（数据完全独立）。共用的只有 `getDB()` 连接单例和 spaceAuth。
 *
 * 日志纪律：**只打条数和耗时**，绝不打印卡片内容（里面可能有用户的笔记）。
 */
import { getDB } from './db.js';
import type { InValue } from '@libsql/client';

/** 知识卡片行（knowledge_cards 表；JSON 字段在库里就是字符串） */
export interface KcCardRow {
  id: string;
  title: string;
  summary: string | null;
  /** JSON 字符串：Block[] */
  blocks: string;
  /** JSON 字符串：string[] */
  exam_tags: string;
  /** JSON 字符串：{types,estMinutes} */
  exam_load: string | null;
  /** JSON 字符串：{chatId?,raw?} */
  source: string | null;
  /** JSON 字符串：KcAttrs */
  attrs: string;
  status: string;
  created_at: number;
  updated_at: number;
  deleted: number;
}

/** 待写入的一张卡片（处理函数已把 JSON 归一化成字符串） */
export interface KcCardInput {
  id: string;
  title: string;
  summary: string;
  blocks: string;
  examTags: string;
  examLoad: string;
  source: string;
  attrs: string;
  status: string;
  createdAt: number;
  updatedAt: number;
  deleted: number;
}

/** 某个数据空间里已有的 (id, updated_at) */
interface ExistingKcRow {
  id: string;
  updated_at: number;
}

/**
 * 把驱动返回的一行转成普通对象。
 * **必须做这一步**：libSQL 返回的行是 `Row` 类实例，直接 `JSON.stringify` 拿不到字段
 * （实测会得到 `{}`）——一期 inventory.ts 已经踩过，这里沿用同样的处理。
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

/** knowledge_cards 的列（顺序固定，INSERT 时复用） */
const KC_COLUMNS = [
  'id',
  'space_key',
  'title',
  'summary',
  'blocks',
  'exam_tags',
  'exam_load',
  'source',
  'attrs',
  'status',
  'created_at',
  'updated_at',
  'deleted',
] as const;

/**
 * upsert 语句：冲突目标是**复合主键 `(space_key, id)`**（理由见 kcSchema.ts 的警告）。
 */
const UPSERT_KC_SQL = (() => {
  const placeholders = KC_COLUMNS.map(() => '?').join(', ');
  const updates = KC_COLUMNS.filter((c) => c !== 'id' && c !== 'space_key')
    .map((c) => `${c} = excluded.${c}`)
    .join(', ');
  return `INSERT INTO knowledge_cards (${KC_COLUMNS.join(', ')}) VALUES (${placeholders})
          ON CONFLICT(space_key, id) DO UPDATE SET ${updates}`;
})();

/**
 * 把一条卡片输入摊平成参数数组（顺序与 KC_COLUMNS 一致）。
 * @param spaceKey 数据空间键（SHA-256）
 * @param c 卡片输入
 */
function kcArgs(spaceKey: string, c: KcCardInput): InValue[] {
  return [
    c.id,
    spaceKey,
    c.title,
    c.summary,
    c.blocks,
    c.examTags,
    c.examLoad,
    c.source,
    c.attrs,
    c.status,
    c.createdAt,
    c.updatedAt,
    c.deleted,
  ];
}

/**
 * 增量拉取知识卡片（**含 `deleted=1` 的墓碑**，客户端要靠它把删除同步到别的设备）。
 * @param spaceKey 数据空间键
 * @param since 只取 updated_at 大于这个时间戳的行（0 = 全量）
 * @param limit 单次上限
 */
export async function selectKcCardsSince(
  spaceKey: string,
  since: number,
  limit: number,
): Promise<KcCardRow[]> {
  const rs = await getDB().execute({
    sql: `SELECT id, title, summary, blocks, exam_tags, exam_load, source, attrs, status, created_at, updated_at, deleted
          FROM knowledge_cards WHERE space_key = ? AND updated_at > ?
          ORDER BY updated_at ASC, id ASC LIMIT ?`,
    args: [spaceKey, since, limit],
  });
  return rs.rows.map((row) => toPlainRow<KcCardRow>(row));
}

/**
 * 查这些 id 在**本空间**里已有的 updated_at（后写覆盖判断 + conflicts 统计用）。
 * 分块查询，避免 SQL 变量个数超限（SQLite 默认 999）。
 * @param spaceKey 数据空间键
 * @param ids 卡片 id 列表
 * @param chunkSize 每块多少个 id
 */
export async function selectExistingKcTimes(
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
      sql: `SELECT id, updated_at FROM knowledge_cards WHERE space_key = ? AND id IN (${placeholders})`,
      args: [spaceKey, ...chunk],
    });
    for (const row of rs.rows) {
      const plain = toPlainRow<ExistingKcRow>(row);
      out.set(plain.id, plain.updated_at);
    }
  }
  return out;
}

/**
 * 批量写入知识卡片（单事务）。
 * @param spaceKey 数据空间键
 * @param rows 通过冲突判断、可以落库的行
 */
export async function upsertKcCards(spaceKey: string, rows: KcCardInput[]): Promise<void> {
  if (rows.length === 0) return;
  await getDB().batch(
    rows.map((c) => ({ sql: UPSERT_KC_SQL, args: kcArgs(spaceKey, c) })),
    'write',
  );
}
