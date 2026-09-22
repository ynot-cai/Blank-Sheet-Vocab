/**
 * IndexedDB 的**库结构与版本**定义。
 *
 * 从 `db.ts` 拆出来的原因：单文件 ≤ 300 行；而且「建表」（schema/版本）
 * 与「发事务」（tx/txRun）是两件事，改一个不该滚动另一个。
 *
 * 这个文件**不 import 任何自己的模块**（零运行时依赖），所以它没有任何
 * 循环依赖风险，可以被 `dbOpen` 与 `db` 同时安全引用。
 *
 * 库名 blank-sheet-vocab，**版本 6**，9 张表：
 *   一期：words / sources / settings / sessions
 *   二期：knowledgeCards / dailyContextWords / examRecords / bankQuestions / kcSessions
 */

/**
 * 老词迁移时补上的词级优先级默认值（=「3 中」）。
 *
 * ⚠️ 必须与 `core/types.ts` 的 `WORD_PRIORITY_DEFAULT` 保持一致。
 * 两处各写一份是**刻意的**：本文件被 `dbOpen` 引用，而 `dbOpen` 是最底层的一环，
 * 保持它零运行时依赖，能让「数据库打不开」这类问题永远不可能是别的模块引起的。
 * 下面那行赋值同时充当编译期校验——两边的类型/取值不一致时 tsc 会直接报错。
 */
const WORD_PRIORITY_DEFAULT = 3;
const WORD_PRIORITY_DEFAULT_CHECK: 3 = WORD_PRIORITY_DEFAULT;
void WORD_PRIORITY_DEFAULT_CHECK;

/** 库名 */
export const DB_NAME = 'blank-sheet-vocab';
/**
 * 库版本：
 * - v2 给 words / sources 补云同步用的字段（见 migrateToV2）
 * - v3 新增二期四张表（知识点卡片 / 语境词 / 题目历史 / 题库），**不动一期任何数据**
 * - v4 新增二期的学习/复习会话表（阶段 04 的「保存并退出」要用），同样**纯加法**
 * - v5 **不是新功能，是修复**：有些库的版本号已经是 4 但 `kcSessions` 没建出来
 *   （升级被旧版本标签页占住 / 事务中途失败）。版本号相同就**永远不会再触发
 *   `onupgradeneeded`**，那张表永远补不上。抬到 5 能给这类库一次「重跑建表」的机会
 *   （对正常库来说是空操作）。
 * - v6 R1 阶段的词级优先级：给老词补上 `priority`（见 migrateToV3Priority）。
 *   同样是「抬版本号逼一次升级」，对已经是 v6 的库是空操作。
 * - v7 T2：给老词补上 `attrs.examCount`（总考核次数，见 migrateToV7ExamCount）。
 *   和 v5/v6 同一套思路 —— 抬版本号逼一次升级，对已经是 v7 的库是空操作。
 */
export const DB_VERSION = 7;

/** 表名常量，避免各处写错字符串 */
export const STORE = {  // ── 一期 ──
  words: 'words',
  sources: 'sources',
  settings: 'settings',
  sessions: 'sessions',
  // ── 二期 ──
  knowledgeCards: 'knowledgeCards',
  dailyContextWords: 'dailyContextWords',
  examRecords: 'examRecords',
  bankQuestions: 'bankQuestions',
  kcSessions: 'kcSessions',
} as const;

/**
 * v1 → v2 迁移：给老数据补上云同步要用的字段。
 *
 * - `sources.updatedAt`：老数据没有，用 `createdAt` 兜底（不然老来源永远进不了同步）；
 * - `words.updatedAt` 本来就一直有，这里只是顺手保证不缺；
 * - `deleted` 保持缺省（读的时候按 0 处理），没必要给整库写上 0。
 *
 * 注意：用 `index('…')` 打开游标会把没有该字段的老记录**漏掉**，
 * 所以这里用 `getAll()` 一次读出来再补——词库规模几千条，够用且不会漏。
 * @param transaction 升级中的事务
 */
function migrateToV2(transaction: IDBTransaction): void {
  const sources = transaction.objectStore(STORE.sources);
  const sourceReq = sources.getAll() as IDBRequest<Record<string, unknown>[]>;
  sourceReq.onsuccess = () => {
    for (const row of sourceReq.result) {
      if (typeof row.updatedAt !== 'number') {
        row.updatedAt = typeof row.createdAt === 'number' ? row.createdAt : Date.now();
        sources.put(row);
      }
    }
  };

  const words = transaction.objectStore(STORE.words);
  const wordReq = words.getAll() as IDBRequest<Record<string, unknown>[]>;
  wordReq.onsuccess = () => {
    for (const row of wordReq.result) {
      if (typeof row.updatedAt !== 'number') {
        row.updatedAt = typeof row.createdAt === 'number' ? row.createdAt : Date.now();
        words.put(row);
      }
    }
  };
}

/**
 * ★ 词表的数据迁移：**一次读取、一份共享的行对象、一次写回**。
 *
 * ── 为什么必须合成一个函数（T2 修的真实 bug）──
 * 原来每个迁移各自 `getAll()` + 各自 `put({...row, 补丁})`。这在
 * **同一事务里注册多个 `getAll()` 回调**时是错的：两次 `getAll()` 的结果是
 * 同一个时刻的**两份独立快照**，谁后跑谁就用「原始行 + 自己的补丁」覆盖掉
 * 前一个迁移刚写进去的字段。
 *
 * 实测（v5 老库 → v7）：`migrateToV6Priority` 先补好 `priority = 3`，
 * 紧接着 `migrateToV7ExamCount` 基于**它自己那份没有 priority 的快照**写回
 * → `priority` 当场被抹掉。既有验收 `test-r1` 抓到了这个回归
 * （「老词的 priority 被补成 3」失败，实测 `legacyword=undefined`）。
 *
 * 现在：**读一次**，把每一行的**同一个对象引用**依次交给各个迁移函数改，
 * 最后统一 `put` 一次。既不会互相覆盖，也只写一遍（省一半 IO）。
 *
 * ⚠️ 新增迁移时：写在这里，直接改 `row`（不要自己 `getAll`/`put`）。
 * @param transaction 升级中的事务
 * @param oldVersion 升级前的版本号
 */
function migrateWordRows(transaction: IDBTransaction, oldVersion: number): void {
  const words = transaction.objectStore(STORE.words);
  const req = words.getAll() as IDBRequest<Record<string, unknown>[]>;
  req.onsuccess = () => {
    const now = Date.now();
    for (const row of req.result) {
      // ★ 关键：全程只有这一个行对象，各迁移依次改它（不是各改各的快照）
      const before = JSON.stringify(row);
      if (oldVersion < 6) applyV6Priority(row, now);
      if (oldVersion < 7) backfillExamCountRow(row);
      // 没有任何迁移改动这一行就不写（省 IO，也避免无意义地刷新 updatedAt）
      if (JSON.stringify(row) !== before) words.put(row);
    }
  };
  req.onerror = () => console.warn('[db] 读取词表做数据迁移失败', req.error);
}

/**
 * v5 → v6（**R1 阶段的词级优先级**）：给老词补上 `word.priority`。
 *
 * 为什么需要一次真正的数据迁移而不是「读的时候兜底」：
 * 云同步是按 `updatedAt` 做增量的，**缺字段的行不会被重新推上去**。
 * 如果只靠读取时兜底成 3，那么别的设备拉到的老行里仍然没有 `priority`，
 * 两台设备各自兜底看似一致，但列表页的「按优先级筛选」和服务端都拿不到真实值。
 * 补一次是最省事且可验证的做法。
 *
 * 默认值 3 = 「中」，与 `WORD_PRIORITY_DEFAULT` 一致（老词没选过优先级，给中间值）。
 * 同时刷新 `updatedAt`，让补好的行能被云同步推到别的设备——不刷的话
 * 本机补好了、别的设备拉到的还是缺字段的旧版本，两台设备的列表会不一致。
 *
 * ⚠️ 边界：这里**不能**用 `index('priority')` 开游标——
 * 没有该字段的老记录不会被任何索引覆盖到（而它们正是要补的那一批）。
 * 所以用 `getAll()` 一次读出来再补（见 {@link migrateWordRows}）。
 *
 * @param row 词记录（**就地修改**）
 * @param now 统一的时间戳
 */
function applyV6Priority(row: Record<string, unknown>, now: number): void {
  if (typeof row.priority === 'number' && Number.isFinite(row.priority)) return;
  row.priority = WORD_PRIORITY_DEFAULT;
  row.updatedAt = now;
}

/**
 * ★ T2（v7）：给老词补上 `attrs.examCount`（总考核次数）。
 *
 * ── 为什么要补 ──
 * T2 把复习优先度从「未通过次数（绝对值）」改成「失败率 = 失败次数 / 总考核次数」。
 * 老词根本没有「总考核次数」这个记录，分母缺失就没法算比率，只能全部按默认值走
 * —— 那等于对所有老用户的历史数据视而不见。用户明确要求回填：
 * **给这些词默认正确率 50%**，即 `examCount = 失败次数 × 2`。
 *
 * ── 回填规则（见下面的 {@link backfillExamCountRow}）──
 * · `failCountTotal > 0` → `examCount = failCountTotal × 2`（失败率 0.5，默认正确率 50%）
 * · `failCountTotal = 0` → `examCount = 0`（保持「从没考过」的语义，不做除法）
 * 分母用 `failCountTotal`（真实累计、不封顶）而不是 `failCount`（封顶值）——
 * 封顶值会把失败率算小，老词反而被降权，与改动的初衷相反。
 *
 * ⚠️ **幂等**：只处理「没有 examCount」的行。`repairUpgrade()` 会再次调用
 * 同一段迁移（见 createSchema 的注释），不幂等的话用户每触发一次自愈，次数就被翻一倍。
 *
 * 执行位置：由 {@link migrateWordRows} 统一读一次、依次改、统一写回
 * （**不要**在这里自己 `getAll`/`put` —— 那正是 T2 修掉的那个覆盖 bug）。
 */

/**
 * ★ T2：单条词记录的 `examCount` 回填（**迁移逻辑的唯一实现**）。
 *
 * 放在 `dbSchema.ts` 而不是 `core/model.ts` 的原因：本文件刻意**零运行时依赖**
 * （连自己的模块都不 import，见文件头注释），而 model.ts 会拉进 senseRules 等一串东西。
 * 为了一个纯函数破坏这条约定不划算。
 *
 * 为什么必须只有一份实现：真实升级（{@link migrateWordRows} 调它）与测试入口
 * （`dev/t2Migrate.ts`）都调同一个函数。各写一份的下场是「测试说回填对了、
 * 真实升级却没做」—— 这种偏差在界面上看不出来，只会表现为「老词的失败率一直是默认值」。
 *
 * 规则（用户明确要求）：
 * - 已有数字（含 0）→ 不动（**幂等**的关键：0 是「确实没考过」的真实值）；
 * - `failCountTotal > 0` → `examCount = failCountTotal × 2`（默认正确率 50% → 失败率 0.5）；
 * - `failCountTotal = 0` → `examCount = 0`（保持「从没考过」的语义，不做除法）。
 *
 * 分母用 `failCountTotal`（真实累计、不封顶）而不是 `failCount`（封顶值）：
 * 封顶值会把失败率算小，老词反而被降权，与「用真实失败率」的初衷相反。
 *
 * @param row 一条词记录（**会被就地修改** `attrs.examCount`）
 * @returns 'backfilled' 补了具体次数 / 'kept-unlearned' 保持没考过 / 'skipped' 本来就有记录
 */
export function backfillExamCountRow(row: Record<string, unknown>): 'backfilled' | 'kept-unlearned' | 'skipped' {
  const attrsRaw = row['attrs'];
  if (typeof attrsRaw !== 'object' || attrsRaw === null) return 'skipped';
  const attrs = attrsRaw as Record<string, unknown>;
  const current = attrs['examCount'];
  if (typeof current === 'number' && Number.isFinite(current)) return 'skipped';
  const failsRaw = attrs['failCountTotal'];
  const fails = typeof failsRaw === 'number' && Number.isFinite(failsRaw) ? Math.max(0, failsRaw) : 0;
  attrs['examCount'] = fails > 0 ? fails * 2 : 0;
  return fails > 0 ? 'backfilled' : 'kept-unlearned';
}

/**
 * 建二期的表（v3 的四张 + v4 的会话表）。
 *
 * 为什么单独一个函数：一期那张表已经够长，而且二期表和一期表**没有任何数据关系**，
 * 分开写以后要改二期结构一眼就能找到地方。
 * @param db 数据库实例
 */
function createKcStores(db: IDBDatabase): void {
  if (!db.objectStoreNames.contains(STORE.knowledgeCards)) {
    const cards = db.createObjectStore(STORE.knowledgeCards, { keyPath: 'id' });
    cards.createIndex('status', 'status', { unique: false });
    cards.createIndex('updatedAt', 'updatedAt', { unique: false });
    cards.createIndex('createdAt', 'createdAt', { unique: false });
    cards.createIndex('attrs.reviewPriority', 'attrs.reviewPriority', { unique: false });
  }
  if (!db.objectStoreNames.contains(STORE.dailyContextWords)) {
    const words = db.createObjectStore(STORE.dailyContextWords, { keyPath: 'id' });
    words.createIndex('date', 'date', { unique: false });
    words.createIndex('spaceKey', 'spaceKey', { unique: false });
  }
  if (!db.objectStoreNames.contains(STORE.examRecords)) {
    const records = db.createObjectStore(STORE.examRecords, { keyPath: 'id' });
    records.createIndex('cardId', 'cardId', { unique: false });
    records.createIndex('date', 'date', { unique: false });
    records.createIndex('createdAt', 'createdAt', { unique: false });
  }
  if (!db.objectStoreNames.contains(STORE.bankQuestions)) {
    const bank = db.createObjectStore(STORE.bankQuestions, { keyPath: 'id' });
    bank.createIndex('type', 'type', { unique: false });
    bank.createIndex('createdAt', 'createdAt', { unique: false });
  }
  if (!db.objectStoreNames.contains(STORE.kcSessions)) {
    const kcSessions = db.createObjectStore(STORE.kcSessions, { keyPath: 'id' });
    kcSessions.createIndex('type', 'type', { unique: false });
    kcSessions.createIndex('updatedAt', 'updatedAt', { unique: false });
  }
}

/**
 * 在 onupgradeneeded 里建表建索引，并做版本迁移。
 *
 * 说明：所有 `createObjectStore` 都先 `contains()` 判断，
 * 所以 v1 → v6、v3 → v6 都会把缺的表补齐，**老数据一条都不动**。
 * 这也是「修复升级」能安全复用的原因。
 *
 * ⚠️ 注意 `repairUpgrade()`（dbOpen.ts）也会调到这里，用的版本号是
 * `DB_VERSION + 1`，和正常升级走的**是同一段迁移代码**。所以每一段迁移
 * 都必须**幂等**：
 *   · migrateToV2 靠「字段不是 number 才补」保证幂等；
 *   · migrateToV6Priority 靠「priority 不是 number 才补」保证幂等。
 * 不幂等的话，用户每触发一次自愈修复，数据就会被改写一遍。
 * @param db 数据库实例
 * @param oldVersion 升级前的版本号（首次创建是 0）
 * @param transaction 升级事务
 */
export function createSchema(db: IDBDatabase, oldVersion: number, transaction: IDBTransaction): void {
  if (!db.objectStoreNames.contains(STORE.words)) {
    const words = db.createObjectStore(STORE.words, { keyPath: 'id' });
    words.createIndex('en', 'en', { unique: false });
    words.createIndex('status', 'status', { unique: false });
    words.createIndex('sourceId', 'sourceId', { unique: false });
    words.createIndex('learnOrder', 'learnOrder', { unique: false });
    words.createIndex('attrs.reviewPriority', 'attrs.reviewPriority', { unique: false });
    words.createIndex('updatedAt', 'updatedAt', { unique: false });
  } else {
    // ★ 老库补索引：`words` 已经存在时上面那段整个跳过，
    //   而**老库的 words 表是没有 priority 索引的**（它是 R1 才加的）。
    //   不补的话「新库有索引、老库没有」，两台设备的结构就不一致了；
    //   更实际的问题是：以后谁想按优先级开游标查词，老设备上会直接报错。
    //   索引是纯附加结构，补建不会动任何数据。
    const words = transaction.objectStore(STORE.words);
    if (!words.indexNames.contains('priority')) words.createIndex('priority', 'priority', { unique: false });
  }
  if (!db.objectStoreNames.contains(STORE.sources)) {
    const sources = db.createObjectStore(STORE.sources, { keyPath: 'id' });
    sources.createIndex('priority', 'priority', { unique: false });
    sources.createIndex('updatedAt', 'updatedAt', { unique: false });
  }
  if (!db.objectStoreNames.contains(STORE.settings)) {
    db.createObjectStore(STORE.settings, { keyPath: 'key' });
  }
  if (!db.objectStoreNames.contains(STORE.sessions)) {
    db.createObjectStore(STORE.sessions, { keyPath: 'id' });
  }
  // 二期：只新增表，不动一期数据
  createKcStores(db);
  // v1 → v2：给来源补 updatedAt（只动 sources，与词表迁移互不干扰）
  if (oldVersion > 0 && oldVersion < 2) migrateToV2(transaction);
  /**
   * 词表的数据迁移：**一次读取、依次改、一次写回**。
   *
   * ⚠️ 不要拆回「一个迁移一个 getAll/put」—— 那样后跑的迁移会用自己那份快照
   * 覆盖前一个刚写进去的字段（T2 实测把老词的 priority 抹掉了，见 migrateWordRows 注释）。
   * 条件用「任何一段词表迁移需要跑」：
   *   oldVersion < 6 → 补 priority；oldVersion < 7 → 补 examCount。
   */
  if (oldVersion > 0 && oldVersion < 7) migrateWordRows(transaction, oldVersion);
}
