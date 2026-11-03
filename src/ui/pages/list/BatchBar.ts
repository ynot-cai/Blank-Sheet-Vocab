import { WORD_PRIORITY_OPTIONS } from '../../../core/types';
import { button, h } from '../../dom';

/** 批量操作回调 */
export interface BatchBarOptions {
  count: number;
  /** 当前筛选结果的总条数（用来判断「还能不能全选更多」） */
  matchedCount: number;
  onChop: () => void;
  onRevive: () => void;
  onSpell: (value: boolean) => void;
  /** ★ 1.0.2（用户）：批量标记 / 取消「仅拼写」 */
  onSpellOnly: (value: boolean) => void;
  onUnlearned: () => void;
  onDelete: () => void;
  /** ★ R3：批量设为某个词级优先级 */
  onSetPriority: (priority: number) => void;
  /** 批量收藏 / 取消收藏单词 */
  onFavorite?: (value: boolean) => void;
  /** 把当前筛选结果的**全部**词都选上（跨页，不设数量上限） */
  onSelectAllMatched: () => void;
  onClear: () => void;
}

/**
 * 批量操作条（选中 ≥1 时从底部滑出）。
 *
 * ★ 1.0.2（用户「整理单词列表的批量编辑」）：
 * - 文案统一去掉「批量」二字（斩 / 复活 / 收藏 / 删除 …）；
 * - 除「删除」保持红色危险样式外，其余全部用**统一样式**（默认按钮）；
 * - 「删除」仍走确认框（确认逻辑在 ListPage 的 batchDelete 里）。
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

  // 统一样式：除「删除」外都用默认按钮
  wrap.appendChild(button('斩', () => opts.onChop()));
  wrap.appendChild(button('复活', () => opts.onRevive()));
  // ★ R3：设优先级。用下拉（选中即执行）而不是 5 个按钮，免得把批量条撑爆。
  const prioSel = h('select', { class: 'input mini-select', title: '把选中的词设为一个词级优先级' });
  prioSel.appendChild(h('option', { value: '', text: '设为优先级…' }));
  for (const opt of WORD_PRIORITY_OPTIONS) {
    prioSel.appendChild(h('option', { value: String(opt.value), text: `P${opt.value}` }));
  }
  prioSel.addEventListener('change', () => {
    const value = prioSel.value;
    prioSel.value = '';
    if (value !== '') opts.onSetPriority(Number(value));
  });
  wrap.appendChild(prioSel);
  wrap.appendChild(button('标记需拼写', () => opts.onSpell(true)));
  wrap.appendChild(button('取消需拼写', () => opts.onSpell(false)));
  // ★ 1.0.2：仅拼写（拼写强化的入场标签）
  wrap.appendChild(button('标记仅拼写', () => opts.onSpellOnly(true)));
  wrap.appendChild(button('取消仅拼写', () => opts.onSpellOnly(false)));
  if (opts.onFavorite) {
    const onFavorite = opts.onFavorite;
    wrap.appendChild(button('收藏', () => onFavorite(true)));
    wrap.appendChild(button('取消收藏', () => onFavorite(false)));
  }
  wrap.appendChild(button('设为未背', () => opts.onUnlearned()));
  // 唯一的危险按钮：删除（红色 + 确认框）
  wrap.appendChild(button('删除', () => opts.onDelete(), { variant: 'danger' }));
  wrap.appendChild(button('取消选择', () => opts.onClear(), { variant: 'ghost' }));
  return wrap;
}
