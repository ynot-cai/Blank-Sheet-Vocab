/**
 * 同步调度器：把「数据变动」合并成偶尔一次的后台同步。
 *
 * 用法：DAO 写入成功后调 `scheduleSync()`；界面订阅 `subscribeSyncState()` 显示状态。
 *
 * 三条纪律：
 * 1. **绝不阻断**——同步在后台跑，失败只更新状态，不弹窗、不抛异常；
 * 2. **不并发**——正在同步时再来请求，只记一个 pending 标记，跑完再补一次；
 * 3. **不打扰**——连续失败 3 次才常驻提示条（前两次只在设置页留个 error 文本）。
 *
 * ══════════════════════════════════════════════════════════════
 * 为什么做成「工厂」而不是写死一个单例
 * ══════════════════════════════════════════════════════════════
 * 一期同步（words/sources）与二期同步（knowledge_cards）走**同一个通道**，
 * 但游标、失败重试、状态显示都应该各自独立：二期后端抽风不该让一期也进
 * 「连续失败 3 次」的常驻提示；反之亦然。
 *
 * 所以这里提供 `createSyncScheduler()`：一期在 `syncScheduler` 里建一个实例
 * （对外 API 一字不改），二期在 `kcScheduler` 里另建一个实例。
 * 这样也顺便把「调度器不该反向依赖具体的同步实现」这件事摆正了——
 * 调度器只认「一个返回 `{error?}` 的异步函数」，不认 cloudSync 还是 kcCloud。
 */
import type { SyncResult } from './cloudSync';

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

/** 建一个调度器需要的参数 */
export interface SyncSchedulerOptions {
  /** 防抖间隔（毫秒）：数据变动后等多久再同步 */
  debounceMs: number;
  /** 真正执行同步的函数（**必须自己吞掉异常**，只返回带 error 的结果） */
  run: () => Promise<SyncResult>;
  /** 现在允许同步吗（未开启云同步 / 配置不全 / 关了自动同步时为 false） */
  enabled: (manual: boolean) => boolean;
  /** 失败重试间隔（毫秒），默认 1 分钟 */
  retryIntervalMs?: number;
}

/** 调度器实例（一期与二期各持有一个） */
export interface SyncScheduler {
  /** 数据变动后调它：防抖几秒再同步 */
  scheduleSync: () => void;
  /** 立即同步（手动触发，无视 autoSync 开关） */
  syncNow: () => Promise<SyncResult | null>;
  /** 取消待执行的防抖/重试 */
  cancelScheduled: () => void;
  /** 订阅状态（返回取消订阅函数） */
  subscribeSyncState: (fn: (s: SyncState) => void) => () => void;
  /** 读当前状态快照 */
  getSyncState: () => SyncState;
  /** 连续失败是否已经多到该「常驻提示」 */
  shouldShowPersistentHint: (s: SyncState) => boolean;
}

/**
 * 建一个同步调度器。
 * @param opts 参数（见 SyncSchedulerOptions）
 */
export function createSyncScheduler(opts: SyncSchedulerOptions): SyncScheduler {
  const retryInterval = opts.retryIntervalMs ?? RETRY_INTERVAL_MS;

  let state: SyncState = { phase: 'idle', failStreak: 0, busy: false };
  const listeners = new Set<(s: SyncState) => void>();
  let debounceTimer: number | null = null;
  let retryTimer: number | null = null;
  let running = false;
  let pendingAgain = false;

  /** 通知所有订阅者 */
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

  /** 失败后安排一次重试（只在断网/后端挂了时用，间隔比较长） */
  function scheduleRetry(): void {
    if (retryTimer !== null) return;
    retryTimer = window.setTimeout(() => {
      retryTimer = null;
      void runSync(false);
    }, retryInterval);
  }

  /**
   * 真正跑一次同步。
   * @param manual 是否手动触发（手动会无视 autoSync 开关，并且一定会跑）
   */
  async function runSync(manual: boolean): Promise<SyncResult | null> {
    if (!opts.enabled(manual)) return null;
    if (running) {
      pendingAgain = true; // 跑完再补一次
      return null;
    }

    running = true;
    setState({ phase: 'syncing', busy: true });
    let result: SyncResult;
    try {
      result = await opts.run();
    } catch (err) {
      // run() 自己应该已经把异常吞掉了，这里只是最后的兜底
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

  return {
    scheduleSync(): void {
      if (!opts.enabled(false)) return;
      if (debounceTimer !== null) window.clearTimeout(debounceTimer);
      debounceTimer = window.setTimeout(() => {
        debounceTimer = null;
        void runSync(false);
      }, opts.debounceMs);
    },

    syncNow(): Promise<SyncResult | null> {
      if (debounceTimer !== null) {
        window.clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      return runSync(true);
    },

    cancelScheduled(): void {
      if (debounceTimer !== null) {
        window.clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      if (retryTimer !== null) {
        window.clearTimeout(retryTimer);
        retryTimer = null;
      }
      pendingAgain = false;
    },

    subscribeSyncState(fn: (s: SyncState) => void): () => void {
      listeners.add(fn);
      fn(state);
      return () => listeners.delete(fn);
    },

    getSyncState(): SyncState {
      return state;
    },

    shouldShowPersistentHint(s: SyncState): boolean {
      return s.phase === 'error' && s.failStreak >= PERSISTENT_FAIL_STREAK;
    },
  };
}
