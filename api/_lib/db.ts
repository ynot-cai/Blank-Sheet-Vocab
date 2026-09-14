/**
 * Turso（libSQL / SQLite 兼容）客户端与建表。
 *
 * 两条硬规则：
 * 1. **模块级单例**——Serverless 每次请求都新建连接会严重拖慢冷启动，所以连上就缓存住。
 * 2. **Driver 选择**——`http(s)://` 端点用 `@libsql/client/web`（纯 fetch，没有 Node 原生依赖，
 *    打包成 Serverless Function 最省事）；`libsql://` 等其余协议用默认客户端。
 *    这也让本地开发可以直接把 `TURSO_DATABASE_URL` 指向一个 `file:` 数据库，
 *    跑的是和线上**完全同一套** SQL 代码。
 *
 * 这里没有 users 表，也没有任何存密钥的表——服务器不接触 AI 密钥（方案 B）。
 */
import { createClient, type Client } from '@libsql/client';
import { requiredEnv } from './env.js';

let client: Client | null = null;
let schemaPromise: Promise<void> | null = null;

/**
 * 建表语句（幂等）。
 *
 * ⚠️ **主键必须是 `PRIMARY KEY (space_key, id)`，不能只用 `id`**：
 * 同步是「客户端生成 id（uuid）→ 上传」，两台设备各建一个词可能撞上同一个 id，
 * 两个数据空间里也可能出现同一个 id。如果主键只有 id，
 * `ON CONFLICT(id) DO UPDATE` 会把 `space_key` 一起改掉——
 * 结果是**一个空间的数据被另一个空间覆盖**，隔离直接失效。
 * 用复合主键后，id 只在各自空间内唯一，隔离由数据库本身保证。
 */
const SCHEMA_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS words (
    id TEXT NOT NULL,
    space_key TEXT NOT NULL,
    en TEXT NOT NULL,
    phonetic TEXT,
    example TEXT,
    senses TEXT NOT NULL,
    source_id TEXT,
    raw_sources TEXT,
    attrs TEXT NOT NULL,
    status TEXT NOT NULL,
    priority INTEGER DEFAULT 3,
    learn_order INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted INTEGER DEFAULT 0,
    PRIMARY KEY (space_key, id)
  )`,
  `CREATE TABLE IF NOT EXISTS sources (
    id TEXT NOT NULL,
    space_key TEXT NOT NULL,
    name TEXT NOT NULL,
    -- ⚠️ 这一列是**历史遗留**（早期版本的「来源优先级」），已经废弃：
    --    优先级只有一套、挂在词上（见 words.priority）。
    --    保留它的唯一原因是老库里有这一列且是 NOT NULL——
    --    现在的插入语句不再写它，所以必须给 DEFAULT，否则新来源会插不进去。
    priority INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted INTEGER DEFAULT 0,
    PRIMARY KEY (space_key, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_words_space ON words(space_key)`,
  `CREATE INDEX IF NOT EXISTS idx_words_updated ON words(space_key, updated_at)`,
  `CREATE INDEX IF NOT EXISTS idx_sources_space ON sources(space_key, updated_at)`,
];

/**
 * 查一张表的某一列有没有默认值（SQLite 的 `PRAGMA table_info` 第 5 列 `dflt_value`）。
 * @param table 表名
 * @param column 列名
 */
async function columnHasDefault(table: string, column: string): Promise<boolean> {
  const rs = await getDB().execute(`PRAGMA table_info(${table})`);
  for (const row of rs.rows) {
    const plain = { ...(row as { name?: unknown; dflt_value?: unknown }) };
    if (plain.name !== column) continue;
    return plain.dflt_value !== null && plain.dflt_value !== undefined && String(plain.dflt_value) !== '';
  }
  return false;
}

/**
 * 给老的 `sources.priority` 补上默认值（幂等）。
 *
 * 背景：`priority` 这一列在早期版本里是「来源优先级」，**已经废弃**——
 * 优先级收敛成一套、挂在词上（`words.priority`）。现在的插入语句不再写这一列。
 *
 * 但老库里那一列是 **`NOT NULL` 且没有默认值**，于是往老库插一个新来源会直接
 * `NOT NULL constraint failed: sources.priority`——一条和优先级完全无关的报错，
 * 排查起来很费劲。SQLite 又**改不了已有列的默认值**（`ALTER TABLE` 只支持 ADD COLUMN），
 * 所以只能用「建新表 → 搬数据 → 换名」这一套。
 *
 * 注意新表结构与 `SCHEMA_STATEMENTS` 里的一致（`priority INTEGER DEFAULT 0`），
 * 所以 `SELECT *` 能直接对齐列顺序。
 */
async function ensureSourcePriorityHasDefault(): Promise<void> {
  if (await columnHasDefault('sources', 'priority')) return;
  const db = getDB();
  const backup = 'sources_pre_priority_default';
  console.warn('[db] sources.priority 是老的无默认值结构，正在重建表补上默认值');
  await db.execute(`DROP TABLE IF EXISTS ${backup}`);
  await db.execute(`ALTER TABLE sources RENAME TO ${backup}`);
  // 第 2 条建表语句就是 sources（见 SCHEMA_STATEMENTS）
  await db.execute(SCHEMA_STATEMENTS[1] as string);
  await db.execute(`INSERT OR REPLACE INTO sources SELECT * FROM ${backup}`);
  await db.execute(`DROP TABLE ${backup}`);
  console.info('[db] sources.priority 默认值补齐完成');
}

/**
 * 老库**补列**清单（幂等）。
 *
 * 为什么需要：`CREATE TABLE IF NOT EXISTS` 对**已经存在**的表是空操作，
 * 所以往建表语句里加一个新列，对老库**完全不起作用**——线上库是早就建好的，
 * 不加这一段的话 `INSERT ... priority` 会直接报「no such column」，
 * 表现成「一同步就 500」。
 *
 * 处理方式与 `kcSchema.ts` 里那段一致：先查 `PRAGMA table_info`，缺了才 ALTER。
 * 老行的 `priority` 会被填成建表默认值 3（SQLite 的 ADD COLUMN 支持带 DEFAULT，
 * 且对已有行同样生效）。
 */
const ADDED_COLUMNS: { table: string; column: string; ddl: string }[] = [
  // R1 词级优先级：1~5，5 最高，默认 3
  { table: 'words', column: 'priority', ddl: 'ALTER TABLE words ADD COLUMN priority INTEGER DEFAULT 3' },
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
    console.info(`[db] 给 ${table} 补列 ${column}`);
    await db.execute(ddl);
  }
}

/**
 * 查一张表的主键列（按顺序）。
 * @param table 表名
 */
async function primaryKeyColumns(table: string): Promise<string[]> {
  const rs = await getDB().execute(`PRAGMA table_info(${table})`);
  const pk: { name: string; order: number }[] = [];
  for (const row of rs.rows) {
    const plain = { ...(row as { name?: unknown; pk?: unknown }) };
    const order = Number(plain.pk ?? 0);
    if (Number.isFinite(order) && order > 0 && typeof plain.name === 'string') {
      pk.push({ name: plain.name, order });
    }
  }
  return pk.sort((a, b) => a.order - b.order).map((c) => c.name);
}

/**
 * 老库升级：早期版本的 words / sources 用的是 `id TEXT PRIMARY KEY`，
 * 会让不同数据空间互相覆盖（详见 SCHEMA_STATEMENTS 的注释）。
 * 这里检测到旧主键就重建表并搬数据——**只影响主键，不动任何字段**。
 * @param table 表名
 */
async function rebuildCompositeKey(table: 'words' | 'sources'): Promise<void> {
  const pk = await primaryKeyColumns(table);
  if (pk.join(',') === 'space_key,id') return; // 已经是新结构
  const db = getDB();
  const backup = `${table}_legacy_pk`;
  console.warn(`[db] 检测到 ${table} 的旧主键（${pk.join(',') || '无'}），正在升级为 (space_key, id)`);
  await db.execute(`DROP TABLE IF EXISTS ${backup}`);
  await db.execute(`ALTER TABLE ${table} RENAME TO ${backup}`);
  // 建新表（SCHEMA_STATEMENTS 里的前两条就是 words / sources 的建表语句）
  await db.execute(SCHEMA_STATEMENTS[table === 'words' ? 0 : 1] as string);
  // 搬数据：同一 (space_key, id) 只保留最新的一条，避免旧库里已经存在的重复
  await db.execute(
    `INSERT OR REPLACE INTO ${table} SELECT * FROM ${backup}
     WHERE rowid IN (SELECT MAX(rowid) FROM ${backup} GROUP BY space_key, id)`,
  );
  await db.execute(`DROP TABLE ${backup}`);
  console.info(`[db] ${table} 主键升级完成`);
}

/**
 * 取数据库客户端（模块级单例）。
 * @throws 缺少 TURSO_DATABASE_URL 时抛出明确错误（不打印任何连接串）
 */
export function getDB(): Client {
  if (client) return client;
  const url = requiredEnv('TURSO_DATABASE_URL');
  const authToken = process.env.TURSO_AUTH_TOKEN?.trim();
  client = createClient({ url, authToken });
  return client;
}

/**
 * 幂等建表 + 建索引 + 老库主键升级。**每个需要数据库的处理函数开头调用一次**。
 * 说明：同一个进程内只真正执行一次（用 Promise 缓存，避免并发请求各建一遍表）；
 * 失败时清掉缓存，让下一次请求重试，而不是永久坏掉。
 * 索引在老表重建后可能被一起删掉，所以每次调用都补一遍 `CREATE INDEX IF NOT EXISTS`（幂等）。
 */
export function initSchema(): Promise<void> {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      const db = getDB();
      for (const sql of SCHEMA_STATEMENTS) await db.execute(sql);
      // 补列必须在 rebuildCompositeKey **之前**：重建表是 `SELECT *` 搬家，
      // 老表缺 priority 的话搬过去的行也会缺（新表虽然有默认值，但显式补过更稳）。
      await ensureColumns();
      await rebuildCompositeKey('words');
      await rebuildCompositeKey('sources');
      // 主键升级完成后 sources 的结构已经和 SCHEMA_STATEMENTS 一致，
      // 但**升级前的那些库**（已经是复合主键、只是 priority 没默认值）也要补一遍
      await ensureSourcePriorityHasDefault();
    })().catch((err: unknown) => {
      schemaPromise = null;
      throw err;
    });
  }
  return schemaPromise;
}

/**
 * 探测数据库是否连通（健康检查用）。
 * 只回「连不连得上」，绝不泄露连接串、库名、表结构。
 */
export async function pingDB(): Promise<boolean> {
  try {
    await getDB().execute('SELECT 1');
    return true;
  } catch (err) {
    console.error('[db] 健康检查失败：', err instanceof Error ? err.message : '未知错误');
    return false;
  }
}
