import { h } from '../dom';

/** Toast 类型 */
export type ToastType = 'info' | 'ok' | 'warn' | 'error';

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
 * 弹一条轻提示。
 * @param message 文本
 * @param type 类型（决定颜色）
 * @param ms 停留毫秒数
 */
export function showToast(message: string, type: ToastType = 'info', ms = 2600): void {
  const el = h('div', { class: `toast toast-${type}`, text: message });
  getContainer().appendChild(el);
  window.setTimeout(() => {
    el.classList.add('toast-out');
    window.setTimeout(() => el.remove(), 240);
  }, ms);
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
