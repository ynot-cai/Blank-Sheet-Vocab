/**
 * 「本次学多少个知识点」选择器（学习与复习共用）。
 *
 * 从 `KcStudyPage` 拆出来：单文件 ≤ 300 行；而且阶段 06 的复习流程要**一模一样**的
 * 这个界面（只是候选卡片不同），共用一份比复制一份好。
 */
import { KC } from '../../core/config';
import { button, h } from '../dom';

/** 选择器的候选项 */
export interface KcPickerOptions {
  /** 候选数量（未学或待复习的卡片数） */
  candidateCount: number;
  /**
   * 候选的名称（写进提示文案，让人一眼知道在数什么）。
   * 学习流程传「未学」，复习流程传「可复习」。
   */
  candidateLabel: string;
  /** 额外的说明（例如「另有 3 张学习中」） */
  extraHint?: string;
  /** 建议数量的上限（默认取 KC.maxStudyCount） */
  maxSuggest?: number;
  /** 点「开始」 */
  onStart: (count: number) => void;
  /** 候选为空时显示的两个出口 */
  emptyActions: { label: string; onClick: () => void }[];
  /** 空状态的标题与说明 */
  emptyTitle: string;
  emptyHint: string;
}

/**
 * 渲染「学几个」选择器。
 * @param opts 选项
 */
export function renderKcCountPicker(opts: KcPickerOptions): HTMLElement {
  const box = h('div', { class: 'kc-picker' });

  if (opts.candidateCount === 0) {
    box.appendChild(h('p', { class: 'kc-empty-title', text: opts.emptyTitle }));
    box.appendChild(h('p', { class: 'kc-hint-dim', text: opts.emptyHint }));
    for (const action of opts.emptyActions) {
      box.appendChild(button(action.label, action.onClick, { variant: 'primary' }));
    }
    return box;
  }

  const cap = opts.maxSuggest ?? KC.maxStudyCount;
  const suggested = Math.max(1, Math.min(opts.candidateCount, cap));
  box.appendChild(h('p', { class: 'kc-picker-title', text: '本次学多少个知识点？' }));

  const input = h('input', {
    class: 'input kc-picker-input',
    type: 'number',
    min: '1',
    max: String(Math.min(opts.candidateCount, KC.maxStudyCount)),
    value: String(suggested),
  });
  box.appendChild(input);
  box.appendChild(
    h('p', {
      class: 'kc-hint-dim',
      text: `当前${opts.candidateLabel} ${opts.candidateCount} 个${opts.extraHint ?? ''}；建议每次 5~10 个。`,
    }),
  );

  const start = (): void => {
    const n = Math.max(1, Math.min(opts.candidateCount, Math.trunc(Number(input.value) || suggested)));
    opts.onStart(n);
  };
  box.appendChild(button('开始', start, { variant: 'primary', class: 'kc-picker-start' }));
  input.addEventListener('keydown', (ev: Event) => {
    if ((ev as KeyboardEvent).key === 'Enter') start();
  });
  // RULES-R1: 纯 UI 延迟（等渲染完再把光标放进输入框），与动画/过渡同类，不是答题计时
  window.setTimeout(() => input.focus(), 30);
  return box;
}
