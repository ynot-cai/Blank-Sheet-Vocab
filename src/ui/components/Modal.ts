import { append, button, h, type DomChild } from '../dom';

/** 弹窗底部按钮 */
export interface ModalAction {
  text: string;
  variant?: 'primary' | 'danger' | 'ghost';
  onClick?: (close: () => void) => void;
}

/** 弹窗参数 */
export interface ModalOptions {
  title: string;
  body: DomChild | DomChild[];
  actions?: ModalAction[];
  /** 宽度，如 '520px' */
  width?: string;
  /** 关闭时回调 */
  onClose?: () => void;
}

/** 打开中的弹窗句柄 */
export interface ModalHandle {
  close: () => void;
  root: HTMLElement;
}

/**
 * 打开一个弹窗（点遮罩、按 Esc、点关闭按钮都能关）。
 * @param opts 弹窗参数
 */
export function openModal(opts: ModalOptions): ModalHandle {
  const content = h('div', { class: 'modal' });
  if (opts.width) content.style.width = opts.width;

  const close = (): void => {
    mask.remove();
    document.removeEventListener('keydown', onKey);
    opts.onClose?.();
  };

  const onKey = (ev: KeyboardEvent): void => {
    if (ev.key === 'Escape') close();
  };

  const head = h(
    'div',
    { class: 'modal-head' },
    h('h3', { class: 'modal-title', text: opts.title }),
    button('✕', () => close(), { variant: 'ghost', class: 'modal-close', title: '关闭' }),
  );

  const body = h('div', { class: 'modal-body' });
  append(body, ...(Array.isArray(opts.body) ? opts.body : [opts.body]));

  content.appendChild(head);
  content.appendChild(body);

  const actions = opts.actions ?? [{ text: '关闭', variant: 'ghost', onClick: (c) => c() }];
  const foot = h('div', { class: 'modal-foot' });
  for (const action of actions) {
    foot.appendChild(button(action.text, () => action.onClick?.(close), { variant: action.variant ?? 'ghost' }));
  }
  content.appendChild(foot);

  const mask = h('div', { class: 'modal-mask' }, content);
  mask.addEventListener('click', (ev) => {
    if (ev.target === mask) close();
  });
  document.addEventListener('keydown', onKey);
  document.body.appendChild(mask);
  return { close, root: content };
}

/**
 * 二次确认弹窗。
 * @param title 标题
 * @param message 正文
 * @param confirmText 确认按钮文字
 * @param danger 确认按钮是否为危险样式
 */
export function confirmModal(
  title: string,
  message: string,
  confirmText = '确认',
  danger = false,
): Promise<boolean> {
  return new Promise((resolve) => {
    let answered = false;
    const handle = openModal({
      title,
      body: h('p', { class: 'modal-text', text: message }),
      actions: [
        { text: '取消', variant: 'ghost', onClick: (close) => close() },
        {
          text: confirmText,
          variant: danger ? 'danger' : 'primary',
          onClick: (close) => {
            answered = true;
            resolve(true);
            close();
          },
        },
      ],
      onClose: () => {
        if (!answered) resolve(false);
      },
    });
    void handle;
  });
}

/**
 * 输入框弹窗（用于「加近义词」「输入删除二字确认」这类场景）。
 * @param title 标题
 * @param label 输入框说明
 * @param defaultValue 默认值
 */
export function promptModal(title: string, label: string, defaultValue = ''): Promise<string | null> {
  return new Promise((resolve) => {
    let answered = false;
    const input = h('input', { class: 'input', type: 'text', value: defaultValue });
    openModal({
      title,
      body: h('div', {}, h('p', { class: 'modal-text', text: label }), input),
      actions: [
        { text: '取消', variant: 'ghost', onClick: (close) => close() },
        {
          text: '确定',
          variant: 'primary',
          onClick: (close) => {
            answered = true;
            resolve(input.value.trim());
            close();
          },
        },
      ],
      onClose: () => {
        if (!answered) resolve(null);
      },
    });
    // RULES-R1: 纯 UI 延迟（等弹窗渲染完再把光标放进输入框），与动画/过渡同类，不是答题计时
    window.setTimeout(() => input.focus(), 30);
  });
}
