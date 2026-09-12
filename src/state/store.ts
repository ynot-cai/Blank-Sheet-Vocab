import { DEFAULT_SETTINGS } from '../core/config';
import type { Session, Settings } from '../core/types';

/** 极简发布订阅 store 的接口 */
export interface Store<T> {
  get(): T;
  set(patch: Partial<T>): void;
  subscribe(fn: (s: T) => void): () => void;
}

/**
 * 创建一个极简 store：set 后同步通知所有订阅者。
 * @param initial 初始值
 */
export function createStore<T>(initial: T): Store<T> {
  let state: T = initial;
  const listeners = new Set<(s: T) => void>();
  return {
    get(): T {
      return state;
    },
    set(patch: Partial<T>): void {
      state = { ...state, ...patch };
      for (const fn of listeners) fn(state);
    },
    subscribe(fn: (s: T) => void): () => void {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

/** 全局应用状态：设置 + 当前会话 */
export const appStore = createStore<{ settings: Settings; session: Session | null }>({
  settings: DEFAULT_SETTINGS,
  session: null,
});

/** 数据变动事件的监听者集合 */
const dataChangedListeners = new Set<() => void>();

/**
 * 通知「数据变了」（DAO 每次写入成功后调用）。
 * 说明：这里用事件而不是让 DAO 直接 import services/localfile，
 * 是为了避免 dao → services → dao 的循环依赖；由 main.ts 把它接到本地文件夹自动备份上。
 */
export function emitDataChanged(): void {
  for (const fn of dataChangedListeners) {
    try {
      fn();
    } catch (err) {
      console.warn('[store] 数据变动监听器出错', err);
    }
  }
}

/**
 * 订阅数据变动。
 * @param fn 回调
 * @returns 取消订阅函数
 */
export function onDataChanged(fn: () => void): () => void {
  dataChangedListeners.add(fn);
  return () => dataChangedListeners.delete(fn);
}
