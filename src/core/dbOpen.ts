/**
 * IndexedDB 的**连接管理**：打开、让位、修复。
 *
 * 从 `db.ts` 拆出来的原因：单文件 ≤ 300 行；而且「连接怎么拿、怎么修」
 * 与「怎么发事务」是两件事，混在一起会让那段最需要看懂的修复逻辑被淹没。
 *
 * ══════════════════════════════════════════════════════════════
 * 这里解决的真实故障（别删这些逻辑）
 * ══════════════════════════════════════════════════════════════
 * 现象一：`One of the specified object stores was not found`
 *   页面持有**旧版本**的连接（库从 v3 升到 v4 时，老标签页/热更新前的老页面
 *   手里还是 v3，里边没有 `kcSessions`）。用它开事务就报这一句，
 *   而且 `db.transaction()` 抛在 `new Promise` 构造器里**不会被 reject 接住**
 *   （变成未捕获异常 → 错误边界把整页变成「页面渲染失败」）。
 *
 * 现象二：点了没反应（一直挂着）
 *   只要还有连接开着且版本更旧，更高版本的 `open` 请求就**既不会成功也不会失败**。
 *   所以必须有超时兜底。
 *
 * 现象三：表永远补不上
 *   库的版本号已经是当前版本，但建表当年没跑成（升级被占住 / 事务中途失败）。
 *   版本号相同就**永远不会再触发 `onupgradeneeded`**，那张表永远缺。
 *   唯一的办法是**抬版本号**强制重跑一次建表（见 `repairUpgrade`）。
 */
import { DB } from './config';
import { createSchema, DB_NAME, DB_VERSION } from './dbSchema';

/** 触发「重跑建表」时用的版本号（比正常版本高一点，只用于修复） */
const REPAIR_VERSION = DB_VERSION + 1;

/** 连接单例 */
let dbPromise: Promise<IDBDatabase> | null = null;
/** 本页当前持有的连接（修复时要主动放开，否则会被自己挡住） */
let liveDb: IDBDatabase | null = null;
/** 正在进行的修复（并发调用共用同一个） */
let repairPromise: Promise<IDBDatabase> | null = null;

/**
 * 给连接挂上「别人要升级版本」的监听。
 *
 * `onversionchange` 是浏览器给**旧连接**的通知：另一个标签页要升级了，请你让位。
 * 这里除了 `close()` **还必须清掉 `dbPromise` 缓存** ——
 * 否则本页后面拿到的还是那个已经关掉的连接，用它开事务就会报
 * 「object stores was not found」（这是原来最致命的一处遗漏）。
 * @param db 刚打开的连接
 */
function attachVersionChange(db: IDBDatabase): void {
  db.onversionchange = () => {
    console.warn('[db] 另一个标签页要升级数据库，本页主动让位（关连接 + 清缓存）');
    try {
      db.close();
    } catch {
      /* 已经关了就忽略 */
    }
    if (liveDb === db) liveDb = null;
    dbPromise = null;
  };
}

/**
 * 关掉本页持有的连接，让被阻塞的版本升级能继续。
 */
export function releaseConnections(): void {
  if (liveDb !== null) {
    try {
      liveDb.close();
    } catch (err) {
      console.warn('[db] 关连接时出错', err);
    }
    liveDb = null;
  }
  dbPromise = null;
  repairPromise = null;
}

/**
 * 打开数据库（单例：重复调用返回同一个 Promise）。
 *
 * ⚠️ **失败不缓存**：老版本标签页占着库时升级会被阻塞，
 * 如果把这个「失败」缓存住，用户关掉老标签页后这个页面**再也不会重试**，只能刷新。
 */
export function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  const attempt: Promise<IDBDatabase> = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('当前环境不支持 IndexedDB，无法使用本应用'));
      return;
    }
    /** 是否已经给出结果（超时后浏览器回调仍会到达，靠它忽略） */
    let settled = false;
    // RULES-R1: 打开数据库的超时兜底（与网络超时同等性质），不是答题计时
    const timer = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      dbPromise = null;
      console.error('[db] 打开数据库超时：多半是别的标签页占着旧版本');
      reject(
        new Error(
          '打开数据库超时：另一个标签页可能还开着这个应用（旧版本占着数据库）。关掉其它标签页后点「重试」。',
        ),
      );
    }, DB.openTimeoutMs);
    const done = (): void => {
      settled = true;
      window.clearTimeout(timer);
    };

    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (ev) => {
      const transaction = (ev.target as IDBOpenDBRequest).transaction;
      if (!transaction) {
        done();
        reject(new Error('数据库升级失败：拿不到升级事务'));
        return;
      }
      createSchema(req.result, ev.oldVersion, transaction);
    };
    req.onsuccess = () => {
      if (settled) {
        // 超时后才成功：这个连接已经很晚了，关掉别让它占着库
        req.result.close();
        return;
      }
      done();
      attachVersionChange(req.result);
      liveDb = req.result;
      resolve(req.result);
    };
    req.onerror = () => {
      if (settled) return;
      done();
      console.error('[db] 打开数据库失败', req.error);
      dbPromise = null;
      reject(req.error ?? new Error('打开数据库失败'));
    };
    req.onblocked = () => {
      // blocked 之后 open 请求**还会继续挂着**，所以这里只提示 + 交给超时兜底
      console.error('[db] 数据库升级被阻塞：另一个标签页占着旧版本');
    };
  });
  dbPromise = attempt;
  return attempt;
}

/**
 * **自愈修复**：把库升到一个更高的版本号，强制重跑一次建表。
 *
 * 什么时候用：`openDB()` 成功了，但连接里**仍然缺表**。这只能是
 * 「库的版本号已经是当前版本，但建表没跑成」——版本号相同就永远不再触发
 * `onupgradeneeded`，所以必须抬版本号才能补表。
 *
 * 安全说明：`createSchema` 里每一句都是 `if (!contains) create`，
 * 所以**已有的表和所有数据一条都不会动**，只是把缺的建出来。
 */
export function repairUpgrade(): Promise<IDBDatabase> {
  if (repairPromise !== null) return repairPromise;
  repairPromise = new Promise<IDBDatabase>((resolve, reject) => {
    // 先放开本页的连接：不放的话这次升级会被自己挡住
    releaseConnections();
    // RULES-R1: 重建表被别的标签页挡住时的超时兜底（与网络超时同等性质），不是答题计时
    const timer = window.setTimeout(() => {
      repairPromise = null;
      reject(
        new Error('修复数据库失败：另一个标签页还开着这个应用（占着旧版本）。关掉其它标签页后点「重试」。'),
      );
    }, DB.openTimeoutMs);
    try {
      const req = indexedDB.open(DB_NAME, REPAIR_VERSION);
      req.onupgradeneeded = (ev) => {
        const transaction = (ev.target as IDBOpenDBRequest).transaction;
        if (transaction === null) return;
        console.warn(`[db] 正在修复数据库结构（v${ev.oldVersion} → v${REPAIR_VERSION}，只补缺失的表）`);
        createSchema(req.result, ev.oldVersion, transaction);
      };
      req.onsuccess = () => {
        window.clearTimeout(timer);
        attachVersionChange(req.result);
        liveDb = req.result;
        repairPromise = null;
        dbPromise = Promise.resolve(req.result);
        resolve(req.result);
      };
      req.onerror = () => {
        window.clearTimeout(timer);
        repairPromise = null;
        reject(req.error ?? new Error('修复数据库失败'));
      };
      // 被人占住时 onblocked 只打日志，真正的失败由上面的超时给出
    } catch (err) {
      window.clearTimeout(timer);
      repairPromise = null;
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
  return repairPromise;
}
