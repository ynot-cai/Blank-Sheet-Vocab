/**
 * 二期同步调度器（knowledge_cards）。
 *
 * 为什么单独一个实例：二期同步走的是**同一个通道**（同一个库、同一套 spaceKey），
 * 但游标与失败计数必须独立——二期后端抽风不该让一期也进「连续失败 3 次」的常驻提示。
 *
 * ══════════════════════════════════════════════════════════════
 * 循环依赖的处理（这个设计是有意的，别改回去）
 * ══════════════════════════════════════════════════════════════
 * 依赖关系本来是：
 *   `kc.ts`（DAO 写完要触发同步） → `kcCloud.ts`（同步要读写卡片） → `kc.ts`
 * 这是**真的**循环。ESM 下 `import` 会被提升，靠「把 import 写在文件末尾」是解决不了的，
 * 运行时会随机拿到 undefined（取决于谁先被加载），表现为「同步莫名其妙不触发」。
 *
 * 所以这里反过来：**调度器不 import 同步实现**，而是留一个注册口
 * `registerKcSyncRunner()`，由 `main.ts` 启动时注入 `kcCloud.kcSyncOnce`。
 * 这样依赖是单向的：main → kcCloud → kc → kcScheduler（无回边）。
 *
 * 没注册时（比如在 Node 测试脚本里直接调 DAO）`scheduleKcSync()` **静默什么都不做**，
 * 本地功能一点不受影响。
 */
import { SYNC, getSettings } from '../core/config';
import type { SyncResult } from './cloudSync';
import {
  createSyncScheduler,
  type SyncScheduler,
  type SyncState,
} from './syncSchedulerFactory';

export type { SyncPhase, SyncState } from './syncSchedulerFactory';

/** 真正的同步实现（由 main.ts 注入，见文件头说明） */
type KcSyncRunner = () => Promise<SyncResult>;

let runner: KcSyncRunner | null = null;

/**
 * 注册二期同步实现（在 main.ts 启动时调一次）。
 *
 * ⚠️ 传进来的函数必须自己吞异常、只返回 `{error?}`（与一期 `syncOnce` 同约定）。
 * @param fn 同步函数
 */
export function registerKcSyncRunner(fn: KcSyncRunner): void {
  runner = fn;
}

/**
 * 现在能不能同步：开启了云同步、配置齐全、且开了自动同步（手动同步不受 autoSync 限制）。
 * 说明：**复用一期的后端地址与同步码**（二期不另设一套凭据），
 * 所以判断条件与一期 `syncScheduler.canSync` 完全一致。
 * @param manual 是否手动触发
 */
function canSync(manual: boolean): boolean {
  const cloud = getSettings().cloud;
  if (!cloud.enabled) return false;
  if (cloud.apiBase.trim() === '' || cloud.syncCode.trim() === '') return false;
  if (!manual && !cloud.autoSync) return false;
  return runner !== null;
}

/** 二期的调度器实例 */
const scheduler: SyncScheduler = createSyncScheduler({
  debounceMs: SYNC.debounceMs,
  enabled: canSync,
  run: async (): Promise<SyncResult> => {
    if (runner === null) return { pulled: 0, pushed: 0, conflicts: 0 };
    return runner();
  },
});

/**
 * 卡片数据变动后调它：防抖几秒再同步。
 * 未开启云同步 / 没注册同步实现时**什么都不做**，绝不影响本地功能。
 */
export function scheduleKcSync(): void {
  scheduler.scheduleSync();
}

/**
 * 立即同步二期数据（返回结果供界面显示）。
 */
export function kcSyncNow(): Promise<SyncResult | null> {
  return scheduler.syncNow();
}

/**
 * 取消待执行的防抖同步。
 */
export function cancelKcScheduled(): void {
  scheduler.cancelScheduled();
}

/**
 * 订阅二期同步状态（返回取消订阅函数）。
 * @param fn 回调
 */
export function subscribeKcSyncState(fn: (s: SyncState) => void): () => void {
  return scheduler.subscribeSyncState(fn);
}

/**
 * 读二期同步状态快照。
 */
export function getKcSyncState(): SyncState {
  return scheduler.getSyncState();
}

/**
 * 二期连续失败是否多到该常驻提示。
 * @param s 状态快照
 */
export function shouldShowKcPersistentHint(s: SyncState): boolean {
  return scheduler.shouldShowPersistentHint(s);
}
