/**
 * 极简 DOM 工具：h() / 清空 / 事件 / 防抖。
 * 不引任何框架，页面里统一用这些函数建元素。
 */

/** h() 的子节点类型（支持嵌套数组，写 ul/li 这类列表时更顺手） */
export type DomChild = Node | string | number | null | undefined | false | readonly DomChild[];

/** h() 的属性表 */
export interface DomProps {
  class?: string;
  id?: string;
  text?: string;
  html?: string;
  style?: string | Partial<CSSStyleDeclaration>;
  dataset?: Record<string, string>;
  /** 其他属性直接写，如 type/placeholder/value/title/disabled */
  [key: string]: unknown;
}

/**
 * 创建元素。
 * @param tag 标签名
 * @param props 属性/事件（onXxx 会自动 addEventListener）
 * @param children 子节点
 */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: DomProps = {},
  ...children: DomChild[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') {
      el.className = String(value);
    } else if (key === 'text') {
      el.textContent = String(value);
    } else if (key === 'html') {
      el.innerHTML = String(value);
    } else if (key === 'style') {
      if (typeof value === 'string') el.setAttribute('style', value);
      else Object.assign(el.style, value);
    } else if (key === 'dataset') {
      for (const [dk, dv] of Object.entries(value as Record<string, string>)) el.dataset[dk] = dv;
    } else if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    } else if (key in el && typeof (el as unknown as Record<string, unknown>)[key] !== 'function') {
      (el as unknown as Record<string, unknown>)[key] = value;
    } else {
      el.setAttribute(key, String(value));
    }
  }
  append(el, ...children);
  return el;
}

/**
 * 往父节点追加子节点（自动过滤 null / false，字符串转文本节点）。
 * @param parent 父节点
 * @param children 子节点
 */
export function append(parent: Node, ...children: DomChild[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) {
      append(parent, ...child);
      continue;
    }
    // 到这里一定是字符串/数字/Node（数组和空值都已在上面处理）
    if (typeof child === 'object') parent.appendChild(child as Node);
    else parent.appendChild(document.createTextNode(String(child)));
  }
}

/**
 * 清空一个元素的子节点。
 * @param el 目标元素
 */
export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

/**
 * 用新内容替换元素内容。
 * @param el 目标元素
 * @param children 新子节点
 */
export function replace(el: Element, ...children: DomChild[]): void {
  clear(el);
  append(el, ...children);
}

/**
 * 查询单个元素（找不到直接抛错，避免后续一堆空判断）。
 * @param selector CSS 选择器
 * @param root 根节点
 */
export function qs<T extends Element = HTMLElement>(selector: string, root: ParentNode = document): T {
  const el = root.querySelector<T>(selector);
  if (!el) throw new Error(`找不到元素：${selector}`);
  return el;
}

/** 防抖函数（带 `cancel()`，用于「离开页面时别让定时器把已卸载的页面写回去」） */
export interface Debounced<A extends unknown[]> {
  (...args: A): void;
  /** 取消还没执行的那次调用 */
  cancel: () => void;
  /** 立即执行（如果有待执行的调用） */
  flush: () => void;
}

/**
 * 防抖（带 `cancel` / `flush`）。
 *
 * 为什么需要 `cancel`：二期卡片编辑页用防抖自动保存，
 * 用户可能在 1 秒内切走页面 —— 这时候必须能**取消**那次待执行的保存
 * （或者反过来 `flush` 立刻存），否则定时器会在页面已经卸载后再去写库。
 *
 * @param fn 原函数
 * @param ms 等待毫秒
 */
export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number): Debounced<A> {
  let timer: number | null = null;
  let lastArgs: A | null = null;

  const wrapped = (...args: A): void => {
    lastArgs = args;
    if (timer !== null) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      timer = null;
      const callArgs = lastArgs;
      lastArgs = null;
      if (callArgs !== null) fn(...callArgs);
    }, ms);
  };

  wrapped.cancel = (): void => {
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
    lastArgs = null;
  };

  wrapped.flush = (): void => {
    if (timer === null) return;
    window.clearTimeout(timer);
    timer = null;
    const callArgs = lastArgs;
    lastArgs = null;
    if (callArgs !== null) fn(...callArgs);
  };

  return wrapped;
}

/**
 * 转义 HTML（少数必须用 innerHTML 的场景）。
 * @param s 原始字符串
 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 生成一个带 label 的表单行。
 * @param label 文字说明
 * @param control 控件
 * @param hint 灰色小字说明（可选）
 */
export function field(label: string, control: Node, hint?: string): HTMLElement {
  return h(
    'label',
    { class: 'field' },
    h('span', { class: 'field-label', text: label }),
    control,
    hint ? h('span', { class: 'field-hint', text: hint }) : null,
  );
}

/**
 * 生成一个按钮。
 * @param text 按钮文字
 * @param onClick 点击回调
 * @param opts.variant 样式（primary/danger/ghost）
 * @param opts.title 悬浮提示
 */
export function button(
  text: string,
  onClick: (ev: MouseEvent) => void,
  opts: { variant?: 'primary' | 'danger' | 'ghost'; title?: string; class?: string } = {},
): HTMLButtonElement {
  const cls = ['btn', opts.variant ? `btn-${opts.variant}` : '', opts.class ?? ''].filter(Boolean).join(' ');
  return h('button', { class: cls, type: 'button', text, title: opts.title ?? '', onclick: onClick });
}

/**
 * 数值输入框。
 * @param value 初始值
 * @param onChange 变化回调
 * @param opts.min/opts.max/opts.step 范围
 */
export function numberInput(
  value: number,
  onChange: (v: number) => void,
  opts: { min?: number; max?: number; step?: number; class?: string } = {},
): HTMLInputElement {
  const input = h('input', {
    class: `input ${opts.class ?? ''}`.trim(),
    type: 'number',
    value: String(value),
    min: opts.min === undefined ? undefined : String(opts.min),
    max: opts.max === undefined ? undefined : String(opts.max),
    step: opts.step === undefined ? undefined : String(opts.step),
  });
  input.addEventListener('change', () => {
    const n = Number(input.value);
    if (Number.isFinite(n)) onChange(n);
  });
  return input;
}

/**
 * 文本输入框。
 * @param value 初始值
 * @param onChange 变化回调（input 事件）
 * @param opts.placeholder/opts.type/opts.class
 */
export function textInput(
  value: string,
  onChange: (v: string) => void,
  opts: { placeholder?: string; type?: string; class?: string } = {},
): HTMLInputElement {
  const input = h('input', {
    class: `input ${opts.class ?? ''}`.trim(),
    type: opts.type ?? 'text',
    value,
    placeholder: opts.placeholder ?? '',
  });
  input.addEventListener('input', () => onChange(input.value));
  return input;
}

/**
 * 下拉框。
 * @param options 选项
 * @param value 当前值
 * @param onChange 变化回调
 */
export function select<T extends string>(
  options: { value: T; label: string }[],
  value: T,
  onChange: (v: T) => void,
): HTMLSelectElement {
  const el = h('select', { class: 'input' });
  for (const opt of options) {
    const o = h('option', { value: opt.value, text: opt.label });
    if (opt.value === value) o.selected = true;
    el.appendChild(o);
  }
  el.addEventListener('change', () => onChange(el.value as T));
  return el;
}

/**
 * 复选框 + 文字。
 * @param checked 是否勾选
 * @param label 文字
 * @param onChange 变化回调
 */
export function checkbox(checked: boolean, label: string, onChange: (v: boolean) => void): HTMLElement {
  const input = h('input', { type: 'checkbox', checked });
  input.addEventListener('change', () => onChange(input.checked));
  return h('label', { class: 'check' }, input, h('span', { text: label }));
}

/**
 * 折叠分区。
 * @param summary 标题
 * @param children 内容
 * @param open 是否默认展开
 */
export function details(summary: string, children: DomChild[], open = false): HTMLDetailsElement {
  const el = h('details', { class: 'section', open });
  el.appendChild(h('summary', { text: summary }));
  const body = h('div', { class: 'section-body' });
  append(body, ...children);
  el.appendChild(body);
  return el;
}
