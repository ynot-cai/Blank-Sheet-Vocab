/**
 * 单词列表页顶部工具栏（版本 1.0.2）。
 *
 * ★ 用户 1.0.2：「顶部白色区域仅保留『搜索』『筛选』『排序』三个按钮，点击后展开对应的详细界面。
 *   批量编辑界面仍在点击『全选』后出现。」
 *
 * 所以这里把原来一长排筛选控件收成三个可折叠按钮：
 * - 搜索：关键词输入框；
 * - 筛选：状态 / 来源 / 词级优先级 / 只看需拼写 / 只看收藏 / 含已斩 / 未通过次数 / 优先度，
 *   并在面板底部提供「全选」（一项全选整个筛选结果 → 底部批量条出现）与「取消全选」；
 * - 排序：排序键 + 升/降序。
 * 同一时间只展开一个面板；再点同一按钮收起。
 */
import type { Source, WordQuery, WordStatus } from '../../../core/types';
import { WORD_PRIORITY_OPTIONS } from '../../../core/types';
import { button, checkbox, h, numberInput, select, textInput } from '../../dom';
import type { ListFilterState } from './ListFilters';

/** 当前展开的面板 */
type PanelKey = 'search' | 'filter' | 'sort' | null;

/** 工具栏参数 */
export interface ListToolbarOptions {
  state: ListFilterState;
  sources: Source[];
  /** 已选数量（>0 时「筛选」面板显示取消全选） */
  selectedCount: number;
  /** 当前筛选结果总数 */
  matchedCount: number;
  onKeyword: (v: string) => void;
  onChange: (patch: Partial<ListFilterState>) => void;
  onReset: () => void;
  /** 全选整个筛选结果（批量条随后出现） */
  onSelectAllMatched: () => void;
  /** 取消选择 */
  onClearSelection: () => void;
}

/** 状态多选里的各项 */
const STATUS_ITEMS: { value: WordStatus; label: string }[] = [
  { value: 'unlearned', label: '未背' },
  { value: 'learning', label: '学习中' },
  { value: 'learned', label: '已背' },
  { value: 'chopped', label: '已斩' },
];

/**
 * 渲染顶部工具栏。
 * @param opts 状态与回调
 */
export function renderListToolbar(opts: ListToolbarOptions): HTMLElement {
  const { state } = opts;
  let open: PanelKey = null;

  const wrap = h('div', { class: 'list-toolbar', dataset: { role: 'list-toolbar' } });
  const bar = h('div', { class: 'list-toolbar-buttons' });
  const panel = h('div', { class: 'list-toolbar-panel' });

  /** 三个按钮（带是否生效的小标记） */
  const tabs: { key: Exclude<PanelKey, null>; label: string; isActive: () => boolean }[] = [
    { key: 'search', label: '搜索', isActive: () => state.keyword.trim() !== '' },
    {
      key: 'filter',
      label: '筛选',
      isActive: () =>
        state.statuses.length > 0 ||
        state.sourceId !== '' ||
        state.wordPriority !== null ||
        state.needSpellOnly ||
        state.favoriteOnly ||
        state.includeChopped ||
        state.minFailCount !== null ||
        state.minPriority !== null,
    },
    { key: 'sort', label: '排序', isActive: () => state.sort !== 'createdAt' || state.order !== 'desc' },
  ];

  const paint = (): void => {
    bar.replaceChildren();
    for (const tab of tabs) {
      const btn = button(`${tab.label}${tab.isActive() ? ' ·' : ''}${open === tab.key ? ' ▴' : ' ▾'}`, () => {
        open = open === tab.key ? null : tab.key;
        paint();
      }, {
        variant: open === tab.key ? 'primary' : 'ghost',
        class: `list-tool-button${tab.isActive() ? ' has-value' : ''}`,
      });
      btn.dataset['panel'] = tab.key;
      btn.setAttribute('aria-expanded', open === tab.key ? 'true' : 'false');
      bar.appendChild(btn);
    }
    if (opts.matchedCount > 0 && opts.selectedCount === 0) {
      bar.appendChild(h('span', { class: 'list-toolbar-hint', text: `共 ${opts.matchedCount} 个` }));
    } else if (opts.selectedCount > 0) {
      bar.appendChild(h('span', { class: 'list-toolbar-hint', text: `已选 ${opts.selectedCount} / 共 ${opts.matchedCount} 个` }));
    }
    panel.replaceChildren();
    if (open === 'search') panel.appendChild(buildSearch());
    if (open === 'filter') panel.appendChild(buildFilter());
    if (open === 'sort') panel.appendChild(buildSort());
    panel.classList.toggle('hidden', open === null);
  };

  /** 搜索面板 */
  const buildSearch = (): HTMLElement => {
    const box = h('div', { class: 'list-toolbar-row' });
    box.appendChild(
      h(
        'div',
        { class: 'ct-search' },
        textInput(state.keyword, opts.onKeyword, { placeholder: '搜索英文或中文义项（含近义词）' }),
      ),
    );
    return box;
  };

  /** 筛选面板 */
  const buildFilter = (): HTMLElement => {
    const box = h('div', { class: 'list-filter-panel' });

    // 状态（多选）
    const statusRow = h('div', { class: 'list-toolbar-row' }, h('span', { class: 'ct-label', text: '状态' }));
    for (const item of STATUS_ITEMS) {
      const on = state.statuses.includes(item.value);
      statusRow.appendChild(
        checkbox(on, item.label, (v) => {
          const next = v ? [...state.statuses, item.value] : state.statuses.filter((s) => s !== item.value);
          opts.onChange({ statuses: next });
        }),
      );
    }
    box.appendChild(statusRow);

    // 来源 / 词级优先级
    const row2 = h('div', { class: 'list-toolbar-row' });
    row2.appendChild(
      h(
        'div',
        { class: 'ct-field' },
        h('span', { class: 'ct-label', text: '来源' }),
        select(
          [{ value: '', label: '全部来源' }, ...opts.sources.map((s) => ({ value: s.id, label: s.name }))],
          state.sourceId,
          (v) => opts.onChange({ sourceId: v }),
        ),
      ),
    );
    row2.appendChild(
      h(
        'div',
        { class: 'ct-field' },
        h('span', { class: 'ct-label', text: '词优先级' }),
        select(
          [
            { value: '', label: '全部优先级' },
            ...WORD_PRIORITY_OPTIONS.slice().reverse().map((o) => ({ value: String(o.value), label: `P${o.value}` })),
          ],
          state.wordPriority === null ? '' : String(state.wordPriority),
          (v) => opts.onChange({ wordPriority: v === '' ? null : Number(v) }),
        ),
      ),
    );
    box.appendChild(row2);

    // 开关
    const row3 = h('div', { class: 'list-toolbar-row' });
    row3.appendChild(checkbox(state.needSpellOnly, '只看需拼写', (v) => opts.onChange({ needSpellOnly: v })));
    row3.appendChild(checkbox(state.favoriteOnly, '只看收藏', (v) => opts.onChange({ favoriteOnly: v })));
    row3.appendChild(checkbox(state.includeChopped, '含已斩', (v) => opts.onChange({ includeChopped: v })));
    box.appendChild(row3);

    // 数值下限
    const row4 = h('div', { class: 'list-toolbar-row' });
    row4.appendChild(
      h(
        'div',
        { class: 'ct-field' },
        h('span', { class: 'ct-label', text: '未通过 ≥' }),
        numberInput(state.minFailCount ?? 0, (v) => opts.onChange({ minFailCount: v <= 0 ? null : v }), { min: 0, max: 999 }),
      ),
    );
    row4.appendChild(
      h(
        'div',
        { class: 'ct-field' },
        h('span', { class: 'ct-label', text: '优先度 ≥' }),
        numberInput(state.minPriority ?? 0, (v) => opts.onChange({ minPriority: v <= 0 ? null : v }), { min: 0, max: 999 }),
      ),
    );
    box.appendChild(row4);

    // 底部：全选 / 取消全选 / 重置
    const foot = h('div', { class: 'list-toolbar-row list-toolbar-foot' });
    foot.appendChild(button('重置筛选', () => opts.onReset(), { variant: 'ghost', class: 'mini' }));
    foot.appendChild(
      button(`全选（${opts.matchedCount} 个）`, () => opts.onSelectAllMatched(), {
        variant: 'primary',
        class: 'mini',
        title: '把当前筛选结果全部选中，底部会出现批量编辑条',
      }),
    );
    if (opts.selectedCount > 0) {
      foot.appendChild(button('取消全选', () => opts.onClearSelection(), { class: 'mini' }));
    }
    box.appendChild(foot);
    return box;
  };

  /** 排序面板 */
  const buildSort = (): HTMLElement => {
    const box = h('div', { class: 'list-toolbar-row' });
    box.appendChild(
      h(
        'div',
        { class: 'ct-field' },
        h('span', { class: 'ct-label', text: '排序' }),
        select(
          [
            { value: 'priority', label: '词优先级' },
            { value: 'learnOrder', label: '背诵顺序' },
            { value: 'reviewPriority', label: '复习优先度' },
            { value: 'createdAt', label: '创建时间' },
            { value: 'en', label: '字母序' },
          ],
          state.sort,
          (v) => opts.onChange({ sort: v as NonNullable<WordQuery['sort']> }),
        ),
      ),
    );
    box.appendChild(
      h(
        'div',
        { class: 'ct-field' },
        h('span', { class: 'ct-label', text: '方向' }),
        select(
          [
            { value: 'desc', label: '降序' },
            { value: 'asc', label: '升序' },
          ],
          state.order,
          (v) => opts.onChange({ order: v as 'asc' | 'desc' }),
        ),
      ),
    );
    return box;
  };

  wrap.appendChild(bar);
  wrap.appendChild(panel);
  paint();
  return wrap;
}
