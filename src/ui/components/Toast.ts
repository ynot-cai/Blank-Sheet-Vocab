import { h } from '../dom';

/** Toast 类型 */
export type ToastType = 'info' | 'ok' | 'warn' | 'error';

/**
 * 斩之后的可撤销窗口（毫秒）。
 *
 * ★ RULES-R3: 斩不弹确认，但必须提供 ≥8 秒的撤销 Toast。
 *   铁律（AI_RULES.md 第 3 节）要求**撤销窗口 ≥ 8 秒**，所以这个常量
 *   **只许调大、不许调小**；`npm run test:r4` 会断言它 ≥ 8000。
 */
export const UNDO_WINDOW_MS = 8000;

/** Toast 淡出动画时长（与 global.css 的 .toast-out 过渡一致） */
const FADE_OUT_MS = 240;

let container: HTMLElement | null = null;

/**
 * 取（或创建）Toast 容器。
 */
function getContainer(): HTMLElement {
  if (!container || !document.body.contains(container)) {
    container = h('div', { class: 'toast-container' });
    document.body.appendChild(container);
  }
  return container;
}

/**
 * 让一条 toast 淡出并移除。
 * @param el toast 元素
 */
function fadeOut(el: HTMLElement): void {
  el.classList.add('toast-out');
  window.setTimeout(() => el.remove(), FADE_OUT_MS);
}

/**
 * 弹一条轻提示。
 * @param message 文本
 * @param type 类型（决定颜色）
 * @param ms 停留毫秒数
 */
export function showToast(message: string, type: ToastType = 'info', ms = 2600): void {
  const el = h('div', { class: `toast toast-${type}`, text: message });
  getContainer().appendChild(el);
  window.setTimeout(() => fadeOut(el), ms);
}

/**
 * 成功提示。
 * @param message 文本
 */
export function toastOk(message: string): void {
  showToast(message, 'ok');
}

/**
 * 警告提示。
 * @param message 文本
 */
export function toastWarn(message: string): void {
  showToast(message, 'warn', 3600);
}

/**
 * 错误提示（停留久一点，方便看清）。
 * @param message 文本
 */
export function toastError(message: string): void {
  showToast(message, 'error', 5000);
}

/** `showUndoToast` 的可选参数 */
export interface UndoToastOptions {
  /** 停留毫秒数。默认 {@link UNDO_WINDOW_MS}（8000）。铁律要求 ≥ 8 秒，不许调小 */
  ms?: number;
  /** 撤销成功后那条提示的文案 */
  undoneMessage?: string;
  /** 撤销失败时的兜底提示（默认指向「已斩」分区） */
  failedMessage?: string;
}

/**
 * 弹一条**带「撤销」按钮**的提示（斩专用）。
 *
 * ★ RULES-R3: 斩不弹确认，但必须提供 ≥8 秒的撤销 Toast。
 *
 * 为什么做成通用函数而不是各页面自己拼：
 * 1. 窗口时长只写一份（{@link UNDO_WINDOW_MS}），不会这处 8 秒、那处 3 秒；
 * 2. 按钮的竞态只处理一份 —— 撤销按钮与超时移除会**同时**可能发生，
 *    点了撤销之后超时回调不能再把已经生效的撤销重复执行一次。
 *
 * @param message 提示文案（形如「已斩 abandon」）
 * @param onUndo 点了「撤销」之后要做的事（恢复数据 + 恢复界面状态）
 * @param opts 可选参数
 */
export function showUndoToast(
  message: string,
  onUndo: () => void | Promise<void>,
  opts: UndoToastOptions = {},
): void {
  /** 已经了结（点过撤销，或被超时移除）——防止两条路径都跑一遍 */
  let settled = false;

  const el = h('div', { class: 'toast toast-ok toast-undo' });
  el.appendChild(h('span', { class: 'toast-text', text: message }));

  const btn = h('button', { class: 'toast-undo-btn', type: 'button', text: '撤销', title: '撤销这次斩' });
  btn.addEventListener('click', () => {
    if (settled) return;
    settled = true;
    el.remove();
    void Promise.resolve()
      .then(onUndo)
      .then(() => showToast(opts.undoneMessage ?? '已撤销', 'ok'))
      .catch((err: unknown) => {
        console.error('[toast] 撤销失败', err);
        toastError(opts.failedMessage ?? '撤销失败，请到列表页的「已斩」里复活');
      });
  });
  el.appendChild(btn);

  getContainer().appendChild(el);
  window.setTimeout(() => {
    if (settled) return;
    settled = true;
    fadeOut(el);
  }, opts.ms ?? UNDO_WINDOW_MS);
}
