import { button, h } from '../../dom';

/** 批量操作回调 */
export interface BatchBarOptions {
  count: number;
  /** 当前筛选结果的总条数（用来判断「还能不能全选更多」） */
  matchedCount: number;
  onChop: () => void;
  onRevive: () => void;
  onSpell: (value: boolean) => void;
  onUnlearned: () => void;
  onDelete: () => void;
  /** 把当前筛选结果的**全部**词都选上（跨页，不设数量上限） */
  onSelectAllMatched: () => void;
  onClear: () => void;
}

/**
 * 批量操作条（选中 ≥1 时从底部滑出）。
 *
 * ★ 「全选筛选结果」按钮是后加的：原来的全选只选**当前页**（≤200 条），
 *   而且翻页会把选中清空，所以批量操作实际能作用的上限就是 200 条——
 *   「把 3000 个词一次性设为未背」这类需求根本做不到。
 *   现在多一个按钮可以一次选上整个筛选结果，不再有数量上限。
 *
 * @param opts 选中数量与各操作回调
 */
export function renderBatchBar(opts: BatchBarOptions): HTMLElement {
  const wrap = h(
    'div',
    { class: 'batch-bar' },
    h('span', { class: 'batch-count', text: `已选 ${opts.count} 个` }),
  );

  // 只有「还能选更多」时才显示全选按钮，避免在已经全选时给一个点了没反应的按钮
  if (opts.count < opts.matchedCount) {
    wrap.appendChild(
      button(`全选筛选结果（${opts.matchedCount} 个）`, () => opts.onSelectAllMatched(), {
        variant: 'primary',
        title: `把当前筛选出的 ${opts.matchedCount} 个词全部选中（跨页，不设数量上限）`,
      }),
    );
  }

  wrap.appendChild(button('批量斩', () => opts.onChop(), { variant: 'danger' }));
  wrap.appendChild(button('批量复活', () => opts.onRevive()));
  wrap.appendChild(button('批量标记需拼写', () => opts.onSpell(true)));
  wrap.appendChild(button('批量取消需拼写', () => opts.onSpell(false)));
  wrap.appendChild(button('批量设为未背', () => opts.onUnlearned()));
  wrap.appendChild(button('批量删除', () => opts.onDelete(), { variant: 'danger' }));
  wrap.appendChild(button('取消选择', () => opts.onClear(), { variant: 'ghost' }));
  return wrap;
}
