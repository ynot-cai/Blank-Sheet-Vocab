/**
 * 二期（知识点）Turso 建表。
 *
 * 和一期 `_lib/db.ts` 的分工：
 * - `_lib/db.ts`：连接单例 + 一期 words/sources 的建表与老库主键升级；
 * - **这个文件**：二期四张表的建表（幂等），由二期各 Function 调 `initKcSchema()`。
 *
 * ⚠️ **主键必须是 `PRIMARY KEY (space_key, id)`，不能只用 `id`**：
 * 同步是「客户端生成 id（uuid）→ 上传」，不同数据空间里完全可能出现同一个 id
 * （比如同一份备份导入到两个空间，或者 uuid 撞车）。
 * 如果主键只有 id，`ON CONFLICT(id) DO UPDATE` 会把 `space_key` 一起改掉，
 * 结果是**一个空间的数据被另一个空间覆盖**，隔离直接失效——
 * 一期 words/sources 就是踩过这个坑才改成复合主键的（见 _lib/db.ts 的注释）。
 *
 * 另外：**这里没有、也永远不会有存 AI 密钥的表**（方案 B 的安全底线）。
 */
import { getDB } from './db.js';

/** 二期建表语句（幂等，顺序固定） */
const KC_SCHEMA_STATEMENTS: string[] = [
  // ── 知识卡片 ──
  `CREATE TABLE IF NOT EXISTS knowledge_cards (
    id TEXT NOT NULL,
    space_key TEXT NOT NULL,
    title TEXT NOT NULL,
    summary TEXT,
    blocks TEXT NOT NULL,
    exam_tags TEXT NOT NULL,
    exam_load TEXT,
    source TEXT,
    attrs TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted INTEGER DEFAULT 0,
    PRIMARY KEY (space_key, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_kc_space ON knowledge_cards(space_key, updated_at)`,
  `CREATE INDEX IF NOT EXISTS idx_kc_status ON knowledge_cards(space_key, status)`,

  // ── 每日语境词 ──
  `CREATE TABLE IF NOT EXISTS daily_context_words (
    id TEXT NOT NULL,
    space_key TEXT NOT NULL,
    date TEXT NOT NULL,
    words TEXT NOT NULL,
    source TEXT NOT NULL,
    confirmed INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER DEFAULT 0,
    deleted INTEGER DEFAULT 0,
    PRIMARY KEY (space_key, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_dcw ON daily_context_words(space_key, date)`,

  // ── 题目历史 ──
  `CREATE TABLE IF NOT EXISTS exam_records (
    id TEXT NOT NULL,
    space_key TEXT NOT NULL,
    card_id TEXT NOT NULL,
    date TEXT NOT NULL,
    type TEXT NOT NULL,
    question TEXT NOT NULL,
    user_answer TEXT,
    ai_score INTEGER,
    ai_reason TEXT,
    context_word TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER DEFAULT 0,
    deleted INTEGER DEFAULT 0,
    PRIMARY KEY (space_key, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_exam ON exam_records(space_key, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_exam_card ON exam_records(space_key, card_id)`,

  // ── 题库（参考样题） ──
  `CREATE TABLE IF NOT EXISTS bank_questions (
    id TEXT NOT NULL,
    space_key TEXT NOT NULL,
    type TEXT NOT NULL,
    content TEXT NOT NULL,
    source TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER DEFAULT 0,
    deleted INTEGER DEFAULT 0,
    PRIMARY KEY (space_key, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_bank ON bank_questions(space_key, type)`,
];

/**
 * 老库补列（幂等）。
 *
 * 背景：阶段 01 按主提示词建表时，`daily_context_words` / `exam_records` / `bank_questions`
 * 这三张表**没有 `updated_at` 与 `deleted`** —— 因为主提示词的建表语句里就没写。
 * 但阶段 05 要给它们做云同步，而「后写覆盖」必须靠 `updated_at` 比较版本、
 * 「删除能传到别的设备」必须靠 `deleted` 墓碑。
 *
 * 处理方式：`ALTER TABLE ... ADD COLUMN` 对已有表补上，**不改动已有数据**
 * （老行的 `updated_at` 默认 0，会在第一次推送时被覆盖成新值）。
 * 加过之后再执行会因为「列已存在」报错，所以这里**先查 PRAGMA 再加**，保证幂等。
 */
const ADDED_COLUMNS: { table: string; column: string; ddl: string }[] = [
  { table: 'daily_context_words', column: 'updated_at', ddl: 'ALTER TABLE daily_context_words ADD COLUMN updated_at INTEGER DEFAULT 0' },
  { table: 'daily_context_words', column: 'deleted', ddl: 'ALTER TABLE daily_context_words ADD COLUMN deleted INTEGER DEFAULT 0' },
  { table: 'exam_records', column: 'updated_at', ddl: 'ALTER TABLE exam_records ADD COLUMN updated_at INTEGER DEFAULT 0' },
  { table: 'exam_records', column: 'deleted', ddl: 'ALTER TABLE exam_records ADD COLUMN deleted INTEGER DEFAULT 0' },
  { table: 'bank_questions', column: 'updated_at', ddl: 'ALTER TABLE bank_questions ADD COLUMN updated_at INTEGER DEFAULT 0' },
  { table: 'bank_questions', column: 'deleted', ddl: 'ALTER TABLE bank_questions ADD COLUMN deleted INTEGER DEFAULT 0' },
];

/**
 * 查一张表有哪些列。
 * @param table 表名
 */
async function columnNames(table: string): Promise<Set<string>> {
  const rs = await getDB().execute(`PRAGMA table_info(${table})`);
  const out = new Set<string>();
  for (const row of rs.rows) {
    const plain = { ...(row as { name?: unknown }) };
    if (typeof plain.name === 'string') out.add(plain.name);
  }
  return out;
}

/**
 * 给老库补上缺的列（幂等，且只在缺的时候执行 ALTER）。
 */
async function ensureColumns(): Promise<void> {
  const db = getDB();
  const cache = new Map<string, Set<string>>();
  for (const { table, column, ddl } of ADDED_COLUMNS) {
    let cols = cache.get(table);
    if (cols === undefined) {
      cols = await columnNames(table);
      cache.set(table, cols);
    }
    if (cols.has(column)) continue;
    await db.execute(ddl);
    cols.add(column);
    console.info(`[kcSchema] 已给 ${table} 补列 ${column}`);
  }
}

let kcSchemaPromise: Promise<void> | null = null;

/**
 * 幂等建二期四张表 + 补列。**每个二期处理函数开头调用一次**。
 *
 * 与一期 `initSchema()` 同样的策略：同进程内只真正执行一次（Promise 缓存，
 * 避免并发请求各建一遍表），失败时清掉缓存让下次请求重试。
 */
export function initKcSchema(): Promise<void> {
  if (!kcSchemaPromise) {
    kcSchemaPromise = (async () => {
      const db = getDB();
      for (const sql of KC_SCHEMA_STATEMENTS) await db.execute(sql);
      await ensureColumns();
    })().catch((err: unknown) => {
      kcSchemaPromise = null;
      throw err;
    });
  }
  return kcSchemaPromise;
}
