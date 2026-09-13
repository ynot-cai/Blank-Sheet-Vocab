/**
 * 词级优先级单选控件（R1 阶段新增）。
 *
 * 为什么会有一个单独的控件而不是各处写 `<input type=radio>`：
 * 优先级出现在**三个地方**——文本录入、预设词库导入确认、列表页编辑——
 * 三处各写一遍的话，将来改文案/改取值范围必然漏一处，
 * 而漏掉的那一处用户完全看不出来（只会觉得「这个选项怎么不一样」）。
 */
import { WORD_PRIORITY_DEFAULT, WORD_PRIORITY_OPTIONS, type WordPriority } from '../../core/types';
import { h } from '../dom';

/** 优先级选择器句柄 */
export interface PrioritySelectHandle {
  el: HTMLElement;
  /** 读当前选中的优先级 */
  read: () => number;
  /** 外部改值（如选中已有来源时同步它的优先级） */
  set: (value: number) => void;
}

/**
 * 把任意数字收敛成合法的优先级选项值（越界时钳到 1~5）。
 * @param value 原值
 */
export function clampPriority(value: number): WordPriority {
  if (!Number.isFinite(value)) return WORD_PRIORITY_DEFAULT;
  const int = Math.round(value);
  if (int <= 1) return 1;
  if (int >= 5) return 5;
  return int as WordPriority;
}

/**
 * 渲染一行优先级单选：`优先级：[1 低] [2] [3 中 ✓] [4] [5 高]`。
 *
 * 说明：用**真正的 radio input**（不是按钮组）——
 * 键盘方向键切换、无障碍朗读、表单语义都是白送的，按钮组要自己实现一遍还容易漏。
 * 样式上用 `.seg` 把它画成分段控件的样子（见 global.css）。
 *
 * @param value 初始值（默认 3 中）
 * @param onChange 变化回调（可选；不传就只在 read() 时取值）
 */
export function renderPrioritySelect(
  value: number = WORD_PRIORITY_DEFAULT,
  onChange?: (v: number) => void,
): PrioritySelectHandle {
  // 每次渲染用一个独立的 name，否则同一页面上多个优先级控件会互相抢选中状态
  const groupName = `word-priority-${Math.random().toString(36).slice(2, 9)}`;
  let current: WordPriority = clampPriority(value);

  const seg = h('div', { class: 'seg' });
  const inputs: HTMLInputElement[] = [];

  for (const opt of WORD_PRIORITY_OPTIONS) {
    const input = h('input', {
      type: 'radio',
      name: groupName,
      value: String(opt.value),
      checked: opt.value === current,
    });
    input.addEventListener('change', () => {
      if (!input.checked) return;
      current = opt.value;
      onChange?.(opt.value);
    });
    inputs.push(input);
    seg.appendChild(h('label', { class: 'seg-item' }, input, h('span', { text: opt.label })));
  }

  // 刻意用 div 而不是 label 包裹：里面每个选项自己就是 label，
  // label 套 label 是非法 HTML，点上去的归属会变得不可预测。
  const el = h(
    'div',
    { class: 'field priority-field' },
    h('span', { class: 'field-label', text: '优先级' }),
    seg,
    h('span', {
      class: 'field-hint',
      text: '优先级高的词会先被「背诵」抽到（5 → 4 → 3 → 2 → 1，是绝对优先，不是概率高）',
    }),
  );

  return {
    el,
    read: () => current,
    set: (next: number) => {
      current = clampPriority(next);
      for (const input of inputs) input.checked = Number(input.value) === current;
    },
  };
}
