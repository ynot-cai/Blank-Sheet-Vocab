/**
 * 原生 IndexedDB 封装（不引第三方库）——**事务层**。
 *
 * 这个文件只负责「拿到一个可用的连接，在一个事务里发请求」。
 * 库结构（表/版本）在 `dbSchema.ts`，连接的打开与修复在 `dbOpen.ts`，
 * 「缺表怎么自愈」在 `dbStale.ts`。拆开的原因：单文件 ≤ 300 行，
 * 而且这四件事的改动频率完全不同（改表结构不该滚动事务代码）。
 *
 * 库名 blank-sheet-vocab，版本 5，9 张表：
 *   一期：words / sources / settings / sessions
 *   二期：knowledgeCards / dailyContextWords / examRecords / bankQuestions / kcSessions
 *
 * ⚠️ 这里把 `STORE` / `DB_NAME` / `StaleDbError` / `openDB` 等**再导出**一次，
 * 是为了不动几十个 DAO 的 `import ... from '../core/db'`。新代码按语义从
 * `dbSchema` / `dbStale` 直接 import 更清楚。
 */
import { STORE, DB_NAME, DB_VERSION } from './dbSchema';
import { withDbRetry, withStore, StaleDbError } from './dbStale';
import { openDB, releaseConnections, repairUpgrade } from './dbOpen';

export { STORE, DB_NAME, DB_VERSION, StaleDbError, openDB, releaseConnections, repairUpgrade };
export { withDbRetry, withStore };

/**
 * 在一个事务里发一条请求，成功返回结果，失败 reject。
 *
 * 外层套 `withDbRetry`：连接陈旧（缺表）时先自己修一次再重试，
 * 用户关掉老标签页后不用刷新就能恢复。
 * @param store 表名
 * @param mode 事务模式
 * @param fn 拿到 objectStore 后返回一个 IDBRequest
 */
export function tx<T>(
  store: string,
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return withDbRetry(() => withStore(store, (db) => new Promise<T>((resolve, reject) => {
    // ⚠️ `db.transaction()` 必须包在 try 里：它抛出的异常**不会被 Promise 接住**
    // （抛在构造器体内），会变成未捕获异常 → 错误边界把整页变成「页面渲染失败」。
    let transaction: IDBTransaction;
    let objectStore: IDBObjectStore;
    try {
      transaction = db.transaction(store, mode);
      objectStore = transaction.objectStore(store);
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
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
  })));
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
  return withDbRetry(() => withStore(store, (db) => new Promise<void>((resolve, reject) => {
    // 同 `tx()`：`db.transaction()` 的异常必须自己接住
    let transaction: IDBTransaction;
    let objectStore: IDBObjectStore;
    try {
      transaction = db.transaction(store, mode);
      objectStore = transaction.objectStore(store);
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
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
  })));
}

/**
 * 清空某张表。
 * @param store 表名
 */
export function clearStore(store: string): Promise<void> {
  return tx(store, 'readwrite', (s) => s.clear());
}
