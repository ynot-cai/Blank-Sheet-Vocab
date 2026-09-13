/**
 * 二期卡片的「单调时钟」：保证写入时间戳只增不减。
 *
 * ══════════════════════════════════════════════════════════════
 * 为什么需要这个文件（这是个**会静默丢数据**的坑）
 * ══════════════════════════════════════════════════════════════
 * 云同步推送的口径是「本地 `updatedAt >= settings.kc.cloud.lastPushAt` 的都要推」。
 * 如果设备时钟**往后跳**（用户手动改时间、NTP 纠正、虚拟机/笔记本休眠后漂移），
 * 之后新建的卡片 `updatedAt` 会小于游标，于是：
 *
 * - 它**永远不会被推送**（`pushAll` 把它当成「早就推过了」）；
 * - 没有任何报错，本地看起来一切正常；
 * - 换一台设备打开 → 这张卡不存在，用户以为丢了。
 *
 * 所以凡是「本地新产生的时间戳」都走这里，它保证：
 * ```
 * 写入时间戳 = max(现在, 本进程写过的最大值, 上次同步/推送游标)
 * ```
 *
 * 第三项（落库的游标）是关键：时钟倒退如果发生在**页面关掉之后**，
 * 新进程的内存是空的，只能从设置里读回来。读的动作由
 * `setClockFloorLoader()` 注入（`main.ts` 与测试脚本各注入一次），
 * 这样本模块**不需要 import 任何 dao**，也就不会形成循环依赖。
 *
 * 注意：这里**不是**在做「跨设备强一致的时间」——那要靠服务端时间。
 * 它只是一个便宜的兜底，让时钟异常不至于变成静默丢数据。
 */
import { getSettings } from './config';

/** 本进程写过（或见过）的最大时间戳 */
let clockHigh = 0;
/** 是否已经从设置里读过一次水位 */
let floorLoaded = false;
/** 读设置水位的函数（由外部注入，见 setClockFloorLoader） */
let floorLoader: (() => Promise<number>) | null = null;

/**
 * 注入「读设置水位」的实现（在启动时调一次）。
 *
 * 为什么用注入而不是直接 import dao/settings：`core/` 层的纪律是**不碰 dao**
 * （一期 `core/priority.ts` 也是靠 `config.getSettings()` 的缓存间接拿设置），
 * 而且 `dao/kc.ts` 会 import 本模块，直接 import 回去就成环了。
 *
 * @param loader 返回「上次同步/推送游标」的函数
 */
export function setClockFloorLoader(loader: () => Promise<number>): void {
  floorLoader = loader;
}

/**
 * 直接从设置缓存里取水位（同步、零成本）。
 *
 * 用途：注入的 loader 是异步的，而 `createEmptyCard()` 是同步函数。
 * 设置在启动时就已载入内存缓存（`dao/settings.ts` 的 `setSettingsCache`），
 * 所以这里能同步拿到值——**绝大多数情况下根本不需要异步兜底**。
 */
function floorFromSettings(): number {
  try {
    const cloud = getSettings().kc?.cloud;
    if (!cloud) return 0;
    return Math.max(cloud.lastPushAt, cloud.lastSyncAt);
  } catch {
    return 0;
  }
}

/**
 * 同步取一个「只增不减」的时间戳。
 *
 * **新建卡片、改块、改属性等所有本地写入都用它**，不要直接用 `Date.now()`。
 */
export function nextUpdatedAt(): number {
  clockHigh = Math.max(clockHigh, Date.now(), floorFromSettings());
  return clockHigh;
}

/**
 * 异步把水位从落库的设置里读进来（同一个进程只读一次）。
 *
 * 什么时候需要它：`nextUpdatedAt()` 用的是**内存里的设置缓存**，
 * 如果启动早期缓存还是默认值（游标 0），就需要这一步把真实的游标捞出来。
 * 云同步开始前会调它，所以「时钟倒退发生在页面关掉之后」这条路径也被覆盖了。
 */
export async function ensureClockFloor(): Promise<void> {
  if (floorLoaded) return;
  floorLoaded = true;
  // 先用设置缓存兜一层（任何情况下都有效）
  clockHigh = Math.max(clockHigh, floorFromSettings());
  if (floorLoader === null) return;
  try {
    clockHigh = Math.max(clockHigh, await floorLoader());
  } catch (err) {
    // 读不到就当没有水位；绝不让它影响本地写入
    console.warn('[kcClock] 读取同步水位失败（不影响本地功能）', err);
  }
}

/**
 * 读当前水位（自测与排查用，不参与业务判断）。
 */
export function currentClockFloor(): number {
  return clockHigh;
}
