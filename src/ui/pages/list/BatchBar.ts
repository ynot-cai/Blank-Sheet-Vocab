import { button, h } from '../../dom';

/** 批量操作回调 */
export interface BatchBarOptions {
  count: number;
  onChop: () => void;
  onRevive: () => void;
  onSpell: (value: boolean) => void;
  onUnlearned: () => void;
  onDelete: () => void;
  onClear: () => void;
}

/**
 * 批量操作条（选中 ≥1 时从底部滑出）。
 * @param opts 选中数量与各操作回调
 */
export function renderBatchBar(opts: BatchBarOptions): HTMLElement {
  return h(
    'div',
    { class: 'batch-bar' },
    h('span', { class: 'batch-count', text: `已选 ${opts.count} 个` }),
    button('批量斩', () => opts.onChop(), { variant: 'danger' }),
    button('批量复活', () => opts.onRevive()),
    button('批量标记需拼写', () => opts.onSpell(true)),
    button('批量取消需拼写', () => opts.onSpell(false)),
    button('批量设为未背', () => opts.onUnlearned()),
    button('批量删除', () => opts.onDelete(), { variant: 'danger' }),
    button('取消选择', () => opts.onClear(), { variant: 'ghost' }),
  );
}
