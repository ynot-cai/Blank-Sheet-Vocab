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
 *
 * 现象四（0.0.26 修）：
 *   `The requested version (11) is less than the existing version (12)`
 *   `repairUpgrade()` 当年的目标版本固定写成 `DB_VERSION + 1`。修过一次之后，
 *   浏览器里的库就停在 N+1，而**下一次正常打开还在请求 N** → 直接被浏览器拒绝，
 *   整页变成「数据库打不开」，用户什么都没做错。
 *   修法：`openDB()` 认这个错误 —— 先按**现有版本**打开（不指定 version 绝不触发升级），
 *   校验表齐了就正常用；缺表才以「现有版本 + 1」再修一次。
 *   `repairUpgrade()` 的目标版本也改成「先读现有版本，再取 max(代码版本, 现有)+1」，
 *   永不请求比库里更低的版本。
 */
import { DB } from './config';
import { createSchema, DB_NAME, DB_VERSION, STORE } from './dbSchema';

/** 连接单例 */
let dbPromise: Promise<IDBDatabase> | null = null;
/** 本页当前持有的连接（修复时要主动放开，否则会被自己挡住） */
let liveDb: IDBDatabase | null = null;
/** 正在进行的修复（并发调用共用同一个） */
let repairPromise: Promise<IDBDatabase> | null = null;

/** 判定「要的版本比库里低」这个浏览器错误 */
function isVersionError(err: unknown): boolean {
  if (err instanceof Error) {
    if (err.name === 'VersionError') return true;
    return /less than the existing version/i.test(err.message);
  }
  return false;
}

/** 代码里声明需要的全部表 */
function requiredStores(): string[] {
  return Object.values(STORE);
}

/** 连上之后缺哪几张表 */
function missingStores(db: IDBDatabase): string[] {
  return requiredStores().filter((name) => !db.objectStoreNames.contains(name));
}

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

/** 收下这个连接：挂监听、记成当前连接 */
function adopt(db: IDBDatabase): IDBDatabase {
  attachVersionChange(db);
  liveDb = db;
  return db;
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
 * 原样打开一次（内部用）。
 *
 * @param version 目标版本；**不传 = 打开现有版本**（绝不触发升级，也就不会报
 *   「要的版本比库低」——这是 0.0.26 修那类故障的关键）
 */
function openRaw(version?: number): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
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

    const req = version === undefined ? indexedDB.open(DB_NAME) : indexedDB.open(DB_NAME, version);
    req.onupgradeneeded = (ev) => {
      const transaction = (ev.target as IDBOpenDBRequest).transaction;
      if (!transaction) {
        done();
        reject(new Error('数据库升级失败：拿不到升级事务'));
        return;
      }
      console.warn(`[db] 正在建表/升级（v${ev.oldVersion} → v${String(version ?? DB_VERSION)}）`);
      createSchema(req.result, ev.oldVersion, transaction);
    };
    req.onsuccess = () => {
      if (settled) {
        // 超时后才成功：这个连接已经很晚了，关掉别让它占着库
        req.result.close();
        return;
      }
      done();
      resolve(req.result);
    };
    req.onerror = () => {
      if (settled) return;
      done();
      // 这里是底层那一次尝试的结果：版本比库低是可恢复的（openDB 会按现有版本重开），
      // 所以只 warn，不刷红；真正的失败由 openDB 统一打 error。
      console.warn('[db] 这一次打开没有成功', req.error);
      reject(req.error ?? new Error('打开数据库失败'));
    };
    req.onblocked = () => {
      // blocked 之后 open 请求**还会继续挂着**，所以这里只提示 + 交给超时兜底
      console.error('[db] 数据库升级被阻塞：另一个标签页占着旧版本');
    };
  });
}

/**
 * 打开数据库（单例：重复调用返回同一个 Promise）。
 *
 * ⚠️ **失败不缓存**：老版本标签页占着库时升级会被阻塞，
 * 如果把这个「失败」缓存住，用户关掉老标签页后这个页面**再也不会重试**，只能刷新。
 */
export function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  const attempt = (async (): Promise<IDBDatabase> => {
    try {
      return adopt(await openRaw(DB_VERSION));
    } catch (err) {
      if (!isVersionError(err)) {
        console.error('[db] 打开数据库失败', err);
        throw err;
      }
      /**
       * ★ 0.0.26：库比代码新（历史「缺表自愈」抬过版本号）。
       * 先按现有版本打开（不指定 version → 不触发升级、不会被浏览器拒绝），
       * 表齐了就直接用；缺表才抬到「现有版本 + 1」修一次。
       */
      const db = await openRaw();
      console.warn(`[db] 浏览器里的库是 v${db.version}，比代码声明的 v${DB_VERSION} 新：按现有版本打开`);
      const missing = missingStores(db);
      if (missing.length === 0) return adopt(db);
      db.close();
      console.warn(`[db] 现有版本缺表 ${missing.join('、')}，抬版本号补建`);
      return adopt(await repairUpgrade(db.version + 1));
    }
  })();
  const guarded = attempt.catch((err: unknown) => {
    dbPromise = null;
    throw err;
  });
  dbPromise = guarded;
  return guarded;
}

/**
 * **自愈修复**：把库升到一个更高的版本号，强制重跑一次建表。
 *
 * 什么时候用：`openDB()` 成功了，但连接里**仍然缺表**。这只能是
 * 「库的版本号已经是当前版本，但建表没跑成」——版本号相同就永远不再触发
 * `onupgradeneeded`，所以必须抬版本号才能补表。
 *
 * ★ 0.0.26：目标版本不再写死 `DB_VERSION + 1`（那会把库抬到一个以后再也不敢请求的版本）。
 * 现在是「先读现有版本，再取 max(代码版本, 现有) + 1」，**永不请求比库里更低的版本**。
 *
 * 安全说明：`createSchema` 里每一句都是 `if (!contains) create`，
 * 所以**已有的表和所有数据一条都不会动**，只是把缺的建出来。
 *
 * @param targetVersion 指定目标版本（一般不用传）
 */
export function repairUpgrade(targetVersion?: number): Promise<IDBDatabase> {
  if (repairPromise !== null) return repairPromise;
  const job = (async (): Promise<IDBDatabase> => {
    // 先放开本页的连接：不放的话这次升级会被自己挡住
    releaseConnections();
    let target = targetVersion;
    if (target === undefined) {
      const probe = await openRaw();
      const current = probe.version;
      probe.close();
      target = Math.max(DB_VERSION, current) + 1;
    }
    console.warn(`[db] 正在修复数据库结构（目标 v${target}，只补缺失的表）`);
    const db = await openRaw(target);
    return adopt(db);
  })();
  repairPromise = job
    .then((db) => {
      repairPromise = null;
      dbPromise = Promise.resolve(db);
      return db;
    })
    .catch((err: unknown) => {
      repairPromise = null;
      dbPromise = null;
      throw err;
    });
  return repairPromise;
}
