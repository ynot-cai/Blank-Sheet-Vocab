/**
 * 一期同步调度器（words / sources）。
 *
 * **对外 API 与重构前完全一致**（`scheduleSync` / `syncNow` / `cancelScheduled` /
 * `subscribeSyncState` / `getSyncState` / `shouldShowPersistentHint`），
 * 所以一期的界面代码（SyncBanner、CloudSection、App、main）一行都不用改。
 *
 * 内部实现搬到了 `syncSchedulerFactory`：二期需要**另一个互不干扰的**调度器
 * （二期后端抽风不该让一期也进「连续失败」常驻提示），所以把逻辑抽成了工厂，
 * 一期在这里建一个实例，二期在 `kcScheduler` 里建另一个。
 */
import { SYNC, getSettings } from '../core/config';
import { syncOnce, type SyncResult } from './cloudSync';
import {
  createSyncScheduler,
  type SyncState,
  type SyncScheduler,
} from './syncSchedulerFactory';

export type { SyncPhase, SyncState } from './syncSchedulerFactory';

/**
 * 现在能不能同步：开启了云同步、配置齐全、且开了自动同步（手动同步不受 autoSync 限制）。
 * @param manual 是否手动触发
 */
function canSync(manual: boolean): boolean {
  const cloud = getSettings().cloud;
  if (!cloud.enabled) return false;
  if (cloud.apiBase.trim() === '' || cloud.syncCode.trim() === '') return false;
  if (!manual && !cloud.autoSync) return false;
  return true;
}

/** 一期的调度器实例 */
const scheduler: SyncScheduler = createSyncScheduler({
  debounceMs: SYNC.debounceMs,
  enabled: canSync,
  run: (): Promise<SyncResult> => syncOnce(),
});

/**
 * 订阅同步状态（返回取消订阅函数）。
 * @param fn 回调
 */
export function subscribeSyncState(fn: (s: SyncState) => void): () => void {
  return scheduler.subscribeSyncState(fn);
}

/**
 * 读当前状态快照。
 */
export function getSyncState(): SyncState {
  return scheduler.getSyncState();
}

/**
 * 数据变动后调它：防抖几秒再同步（连续操作只同步一次）。
 * 同步失败或未开启云同步时**什么都不做**，绝不影响本地功能。
 */
export function scheduleSync(): void {
  scheduler.scheduleSync();
}

/**
 * 立即同步（设置页「立即同步」按钮用），返回结果供界面显示。
 */
export function syncNow(): Promise<SyncResult | null> {
  return scheduler.syncNow();
}

/**
 * 取消待执行的防抖同步（例如用户关掉云同步时）。
 */
export function cancelScheduled(): void {
  scheduler.cancelScheduled();
}

/**
 * 连续失败是否已经多到该「常驻提示」。
 * @param s 状态快照
 */
export function shouldShowPersistentHint(s: SyncState): boolean {
  return scheduler.shouldShowPersistentHint(s);
}
