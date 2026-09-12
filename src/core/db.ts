/**
 * 原生 IndexedDB 封装（不引第三方库）。
 * 库名 blank-sheet-vocab，版本 2，4 张表：words / sources / settings / sessions。
 */

/** 库名 */
export const DB_NAME = 'blank-sheet-vocab';
/** 库版本：v2 给 words / sources 补云同步用的字段（见 migrateToV2） */
export const DB_VERSION = 2;

/** 表名常量，避免各处写错字符串 */
export const STORE = {
  words: 'words',
  sources: 'sources',
  settings: 'settings',
  sessions: 'sessions',
} as const;

let dbPromise: Promise<IDBDatabase> | null = null;

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
 * 在 onupgradeneeded 里建表建索引，并做版本迁移。
 * @param db 数据库实例
 * @param oldVersion 升级前的版本号（首次创建是 0）
 * @param transaction 升级事务
 */
function createSchema(db: IDBDatabase, oldVersion: number, transaction: IDBTransaction): void {
  if (!db.objectStoreNames.contains(STORE.words)) {
    const words = db.createObjectStore(STORE.words, { keyPath: 'id' });
    words.createIndex('en', 'en', { unique: false });
    words.createIndex('status', 'status', { unique: false });
    words.createIndex('sourceId', 'sourceId', { unique: false });
    words.createIndex('learnOrder', 'learnOrder', { unique: false });
    words.createIndex('attrs.reviewPriority', 'attrs.reviewPriority', { unique: false });
    words.createIndex('updatedAt', 'updatedAt', { unique: false });
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
  if (oldVersion > 0 && oldVersion < 2) migrateToV2(transaction);
}

/**
 * 打开数据库（单例：重复调用返回同一个 Promise）。
 * blocked / error 都会 reject，并把错误打到 console。
 */
export function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('当前环境不支持 IndexedDB，无法使用本应用'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (ev) => {
      const transaction = (ev.target as IDBOpenDBRequest).transaction;
      if (!transaction) {
        reject(new Error('数据库升级失败：拿不到升级事务'));
        return;
      }
      createSchema(req.result, ev.oldVersion, transaction);
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => {
      console.error('[db] 打开数据库失败', req.error);
      reject(req.error ?? new Error('打开数据库失败'));
    };
    req.onblocked = () => {
      console.error('[db] 数据库被其他标签页占用，请关闭其他标签页后重试');
      reject(new Error('数据库被其他标签页占用，请关闭其他标签页后重试'));
    };
  });
  return dbPromise;
}

/**
 * 在一个事务里发一条请求，成功返回结果，失败 reject。
 * @param store 表名
 * @param mode 事务模式
 * @param fn 拿到 objectStore 后返回一个 IDBRequest
 */
export function tx<T>(
  store: string,
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDB().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(store, mode);
        const objectStore = transaction.objectStore(store);
        let request: IDBRequest<T>;
        try {
          request = fn(objectStore);
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
          return;
        }
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => {
          console.error(`[db] ${store} 操作失败`, request.error);
          reject(request.error ?? new Error(`${store} 操作失败`));
        };
        transaction.onabort = () => {
          console.error(`[db] ${store} 事务被中止`, transaction.error);
          reject(transaction.error ?? new Error(`${store} 事务被中止`));
        };
      }),
  );
}

/**
 * 在同一个事务里连续执行多个操作（用于批量写入）。
 * @param store 表名
 * @param mode 事务模式
 * @param fn 拿到 objectStore 后自行发请求，函数返回时事务自动提交
 */
export function txRun(
  store: string,
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => void,
): Promise<void> {
  return openDB().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(store, mode);
        const objectStore = transaction.objectStore(store);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => {
          console.error(`[db] ${store} 事务失败`, transaction.error);
          reject(transaction.error ?? new Error(`${store} 事务失败`));
        };
        transaction.onabort = () => {
          console.error(`[db] ${store} 事务被中止`, transaction.error);
          reject(transaction.error ?? new Error(`${store} 事务被中止`));
        };
        try {
          fn(objectStore);
        } catch (err) {
          try {
            transaction.abort();
          } catch {
            /* 事务可能已结束，忽略 */
          }
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      }),
  );
}

/**
 * 清空某张表。
 * @param store 表名
 */
export function clearStore(store: string): Promise<void> {
  return tx(store, 'readwrite', (s) => s.clear());
}
