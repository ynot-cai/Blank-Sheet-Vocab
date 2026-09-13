/**
 * 「表缺失」这类**连接陈旧**故障的判定与自愈。
 *
 * 拆成独立文件的原因：单文件 ≤ 300 行；而且这段逻辑回答的是同一个问题 ——
 * 「拿到的这个连接还能不能用，不能用怎么办」，与建表（`dbSchema`）、
 * 开连接（`dbOpen`）不是同一件事。
 *
 * ══════════════════════════════════════════════════════════════
 * 这里解决的真实故障（别删这些逻辑）
 * ══════════════════════════════════════════════════════════════
 * 现象：`One of the specified object stores was not found`
 *   页面手里是**旧版本**的连接（库从 v3 升到 v4 时，老标签页或热更新前的
 *   老页面手里还是 v3，里边没有 `kcSessions`）。
 *   ⚠️ 而且 `db.transaction()` 抛在 `new Promise` 构造器里**不会被 reject 接住**，
 *   会变成未捕获异常 → 界面错误边界把整页替换成「页面渲染失败」。
 *   这就是「二期的设置界面渲染失败」这一类故障的根因。
 *
 * 三级处理，从便宜到贵：
 * 1. 连接里没有这张表 → 丢掉本页连接、重新 open（版本低就会走升级）；
 * 2. 重开还是同一版本、还是缺表 → `repairUpgrade()` **抬版本号重跑建表**；
 * 3. 还不行 → 抛 `StaleDbError`，让界面告诉用户「关掉其它标签页」。
 */
import { openDB, releaseConnections, repairUpgrade } from './dbOpen';

/**
 * 数据库被旧连接占住 / 缺表时的错误标记。
 *
 * 为什么要单独一个类型：调用方（或 `withDbRetry`）需要判断
 * 「这是不是我修一下就能好」，而不是把登录失败、配额超限之类的错误也重试一遍。
 */
export class StaleDbError extends Error {
  /** 缺哪张表 */
  readonly store: string;

  /**
   * @param store 缺的表名
   */
  constructor(store: string) {
    super(`数据库连接里没有表「${store}」（可能是版本升级还没完成或被其他标签页占用）`);
    this.name = 'StaleDbError';
    this.store = store;
  }
}

/** 拿到连接后执行一次事务的通用实现 */
type TxRunner<T> = (db: IDBDatabase) => Promise<T>;

/**
 * 拿到连接后执行事务，**缺表时自动修复**（这是真实故障的根因，逻辑别删）。
 *
 * 前两级修复都是**幂等**的：`createSchema` 里每一句都是 `if (!contains) create`，
 * 所以既有表和全部数据一条都不会动，只是把缺的补出来。
 * @param store 表名
 * @param run 拿到可用连接后要做的事
 */
export async function withStore<T>(store: string, run: TxRunner<T>): Promise<T> {
  let db = await openDB();
  if (!db.objectStoreNames.contains(store)) {
    console.warn(`[db] 当前连接里没有「${store}」，先重连一次（可能是版本升级未完成）`);
    releaseConnections();
    db = await openDB();
  }
  if (!db.objectStoreNames.contains(store)) {
    console.warn(`[db] 重连后仍缺「${store}」，尝试抬版本号修复库结构`);
    db = await repairUpgrade();
  }
  if (!db.objectStoreNames.contains(store)) {
    // 走到这里说明连修复升级都没能建出表，多半是别的标签页一直占着
    throw new StaleDbError(store);
  }
  return run(db);
}

/**
 * 包一层「遇到陈旧连接就修一次再重试」。
 *
 * 为什么需要它：`withStore` 内部已经会重连 + 抬版本号修复，但**修复本身也可能失败**
 * （另一个标签页一直占着）。这时直接抛 `StaleDbError` 会让**每一个** DAO 调用都失败
 * —— 界面上一片红。包一层的意义：失败后清掉连接、**再修一次**，
 * 给「用户刚关掉老标签页」这种情况一个不用刷新就能自愈的机会。
 *
 * ⚠️ 界面侧的调用**仍然必须自己 catch**：重试不是万能的，
 * 最终失败时要给用户一句提示，而不是把异常抛成「页面渲染失败」。
 *
 * @param fn 真正要做的事
 * @param attempts 最多尝试几次（默认 2：正常一次 + 修复后一次）
 */
export async function withDbRetry<T>(fn: () => Promise<T>, attempts = 2): Promise<T> {
  let lastErr: unknown = null;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!(err instanceof StaleDbError)) throw err;
      console.warn(`[db] 操作因连接陈旧失败（第 ${i + 1} 次），尝试重新打开数据库后重试`);
      releaseConnections();
      try {
        await openDB();
      } catch (openErr) {
        // 连打开都失败：把更具体的错误抛出去（通常是「关掉其它标签页」）
        throw openErr instanceof Error ? openErr : new Error(String(openErr));
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
