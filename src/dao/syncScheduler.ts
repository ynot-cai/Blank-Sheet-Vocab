/**
 * 同步调度器（阶段 02）：把「数据变动」合并成偶尔一次的后台同步。
 *
 * 用法：DAO 写入成功后调 `scheduleSync()`；界面订阅 `subscribeSyncState()` 显示状态。
 *
 * 三条纪律：
 * 1. **绝不阻断**——同步在后台跑，失败只更新状态，不弹窗、不抛异常；
 * 2. **不并发**——正在同步时再来请求，只记一个 pending 标记，跑完再补一次；
 * 3. **不打扰**——连续失败 3 次才常驻提示条（前两次只在设置页留个 error 文本）。
 */
import { SYNC, getSettings } from '../core/config';
import { syncOnce, type SyncResult } from './cloudSync';

/** 界面可见的同步状态 */
export type SyncPhase = 'idle' | 'syncing' | 'ok' | 'error';

/** 同步状态快照（订阅回调收到它） */
export interface SyncState {
  phase: SyncPhase;
  /** 最近一次结果（成功或失败） */
  last?: SyncResult;
  /** 连续失败次数 */
  failStreak: number;
  /** 是否正在同步 */
  busy: boolean;
}

/** 连续失败多少次后，提示条改成常驻 */
const PERSISTENT_FAIL_STREAK = 3;
/** 失败后多久重试一次（毫秒）：避免在断网时疯狂重试 */
const RETRY_INTERVAL_MS = 60_000;

let state: SyncState = { phase: 'idle', failStreak: 0, busy: false };
const listeners = new Set<(s: SyncState) => void>();
let debounceTimer: number | null = null;
let retryTimer: number | null = null;
let running = false;
let pendingAgain = false;

/**
 * 通知所有订阅者。
 */
function emit(): void {
  for (const fn of listeners) {
    try {
      fn(state);
    } catch (err) {
      console.warn('[syncScheduler] 监听器出错', err);
    }
  }
}

/**
 * 更新状态（浅合并）。
 * @param patch 状态补丁
 */
function setState(patch: Partial<SyncState>): void {
  state = { ...state, ...patch };
  emit();
}

/**
 * 订阅同步状态（返回取消订阅函数）。
 * @param fn 回调
 */
export function subscribeSyncState(fn: (s: SyncState) => void): () => void {
  listeners.add(fn);
  fn(state);
  return () => listeners.delete(fn);
}

/**
 * 读当前状态快照。
 */
export function getSyncState(): SyncState {
  return state;
}

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

/**
 * 失败后安排一次重试（只在断网/后端挂了时用，间隔比较长）。
 */
function scheduleRetry(): void {
  if (retryTimer !== null) return;
  retryTimer = window.setTimeout(() => {
    retryTimer = null;
    void runSync(false);
  }, RETRY_INTERVAL_MS);
}

/**
 * 真正跑一次同步。
 * @param manual 是否手动触发（手动会无视 autoSync 开关，并且一定会跑）
 */
async function runSync(manual: boolean): Promise<SyncResult | null> {
  if (!canSync(manual)) return null;
  if (running) {
    pendingAgain = true; // 跑完再补一次
    return null;
  }

  running = true;
  setState({ phase: 'syncing', busy: true });
  let result: SyncResult;
  try {
    result = await syncOnce();
  } catch (err) {
    // syncOnce 自己已经把异常吞掉了，这里只是最后的兜底
    const message = err instanceof Error ? err.message : String(err);
    console.warn('[syncScheduler] 同步异常', err);
    result = { pulled: 0, pushed: 0, conflicts: 0, error: message };
  } finally {
    running = false;
  }

  if (result.error) {
    const streak = state.failStreak + 1;
    setState({ phase: 'error', busy: false, failStreak: streak, last: result });
    scheduleRetry();
  } else {
    if (retryTimer !== null) {
      window.clearTimeout(retryTimer);
      retryTimer = null;
    }
    setState({ phase: 'ok', busy: false, failStreak: 0, last: result });
  }

  if (pendingAgain) {
    pendingAgain = false;
    void runSync(false);
  }
  return result;
}

/**
 * 数据变动后调它：防抖几秒再同步（连续操作只同步一次）。
 * 同步失败或未开启云同步时**什么都不做**，绝不影响本地功能。
 */
export function scheduleSync(): void {
  if (!canSync(false)) return;
  if (debounceTimer !== null) window.clearTimeout(debounceTimer);
  debounceTimer = window.setTimeout(() => {
    debounceTimer = null;
    void runSync(false);
  }, SYNC.debounceMs);
}

/**
 * 立即同步（设置页「立即同步」按钮用），返回结果供界面显示。
 */
export function syncNow(): Promise<SyncResult | null> {
  if (debounceTimer !== null) {
    window.clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  return runSync(true);
}

/**
 * 取消待执行的防抖同步（例如用户关掉云同步时）。
 */
export function cancelScheduled(): void {
  if (debounceTimer !== null) {
    window.clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  if (retryTimer !== null) {
    window.clearTimeout(retryTimer);
    retryTimer = null;
  }
  pendingAgain = false;
}

/**
 * 连续失败是否已经多到该「常驻提示」。
 * @param s 状态快照
 */
export function shouldShowPersistentHint(s: SyncState): boolean {
  return s.phase === 'error' && s.failStreak >= PERSISTENT_FAIL_STREAK;
}
