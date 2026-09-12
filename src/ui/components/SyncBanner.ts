/**
 * 云同步状态条（阶段 02）。
 *
 * 交互要求（来自阶段要求）：
 * - 同步失败**不弹窗、不打断**，只在顶部来一条轻提示，5 秒后自己消失；
 * - 连续失败 3 次以上改成**常驻**提示条，文案说明「数据已存本地，联网后会自动同步」；
 * - 同步中 / 同步成功都不打扰用户（成功只在设置页体现）。
 */
import { subscribeSyncState, type SyncState } from '../../dao/syncScheduler';
import { button, h } from '../dom';

/** 前几次失败：轻提示自动消失的时间（毫秒） */
const AUTO_HIDE_MS = 5_000;
/** 从第几次失败开始改成常驻 */
const PERSISTENT_FROM_STREAK = 3;

/**
 * 挂载同步状态条。
 * @param container 承载容器（App 顶栏下方的 banner-box）
 * @param onRetry 点「重试」时的回调
 */
export function mountSyncBanner(container: HTMLElement, onRetry: () => void): void {
  let hideTimer: number | null = null;

  const clearTimer = (): void => {
    if (hideTimer !== null) {
      window.clearTimeout(hideTimer);
      hideTimer = null;
    }
  };

  const dismiss = (): void => {
    clearTimer();
    container.replaceChildren();
  };

  const render = (state: SyncState): void => {
    // 同步中 / 正常状态：顶部保持干净
    if (state.phase !== 'error') {
      dismiss();
      return;
    }

    const persistent = state.failStreak >= PERSISTENT_FROM_STREAK;
    const text = persistent
      ? '云同步一直失败，数据已存本地，联网后会自动同步。'
      : '云同步失败，数据已存本地。';
    const el = h(
      'div',
      { class: persistent ? 'sync-banner sync-banner-persistent' : 'sync-banner' },
      h('span', { text }),
      state.last?.error ? h('span', { class: 'sync-banner-reason', text: state.last.error }) : null,
      button('重试', () => onRetry(), { variant: 'ghost' }),
    );

    clearTimer();
    container.replaceChildren(el);
    if (!persistent) hideTimer = window.setTimeout(dismiss, AUTO_HIDE_MS);
  };

  subscribeSyncState(render);
}
