/**
 * 卡片视图的**工具栏**（版本 0.0.22）。
 *
 * 用户（对话 2026-10-20 / 2026-10-22）：「卡片界面中完善功能，需包含筛选、搜索、排序、
 * 批量编辑，收藏等等功能」；「我之前要求的卡片筛选、排序等功能目前尚未实现，
 * 请按开发必读文档中的具体要求补齐这些功能」。
 *
 * 所以卡片视图现在有**属于它自己的**一条工具栏（不再借用单词视图那一排筛选项）：
 * 1. 搜索：英文 / 中文义项（含近义词）；
 * 2. 筛选：状态（全部 / 未背 / 学习中 / 已背 / 已斩）、来源、词优先级、
 *    **只看收藏（收藏的是卡片）**、只看需拼写；
 * 3. 排序：词优先级 / 背诵顺序 / 复习优先度 / 创建时间 / 字母序 + 升/降序；
 * 4. 批量编辑：结果计数、已选数、全选本页、清空勾选（选中后的批量操作在底部批量条上）。
 *
 * 两个视图共用同一份 `ListFilterState`，切视图时筛选条件不丢。
 */
import type { Source, WordQuery } from '../../../core/types';
import { WORD_PRIORITY_OPTIONS } from '../../../core/types';
import { button, h, select, textInput } from '../../dom';
import type { ListFilterState } from './ListFilters';

/** 状态筛选的一档（只改状态，不动「含已斩」） */
interface StatusChip {
  key: string;
  label: string;
  /** 选中后写进 state 的状态集合 */
  statuses: ListFilterState['statuses'];
  /** 当前 state 是否命中这一档 */
  match: (state: ListFilterState) => boolean;
}

/**
 * 状态快捷筛选。
 *
 * ★ 「全部」= 不限状态（但仍然遵守下面那颗独立的「含已斩」开关），
 *   这样初始状态（不含已斩）下也一定有一颗是亮的，不会出现「五颗都不亮」。
 */
const STATUS_CHIPS: StatusChip[] = [
  {
    key: 'all',
    label: '全部',
    statuses: [],
    match: (s) => s.statuses.length === 0,
  },
  {
    key: 'unlearned',
    label: '未背',
    statuses: ['unlearned'],
    match: (s) => s.statuses.length === 1 && s.statuses[0] === 'unlearned',
  },
  {
    key: 'learning',
    label: '学习中',
    statuses: ['learning'],
    match: (s) => s.statuses.length === 1 && s.statuses[0] === 'learning',
  },
  {
    key: 'learned',
    label: '已背',
    statuses: ['learned'],
    match: (s) => s.statuses.length === 1 && s.statuses[0] === 'learned',
  },
  {
    key: 'chopped',
    label: '已斩',
    statuses: ['chopped'],
    match: (s) => s.statuses.length === 1 && s.statuses[0] === 'chopped',
  },
];

/** 排序选项（与 WordQuery['sort'] 一一对应） */
const SORT_OPTIONS: { value: NonNullable<WordQuery['sort']>; label: string }[] = [
  { value: 'priority', label: '词优先级（高→低）' },
  { value: 'learnOrder', label: '背诵顺序' },
  { value: 'reviewPriority', label: '复习优先度' },
  { value: 'createdAt', label: '创建时间' },
  { value: 'en', label: '字母序' },
];

/** 工具栏参数 */
export interface CardToolbarOptions {
  state: ListFilterState;
  sources: Source[];
  /** 当前页已选中的卡片数 */
  selectedCount: number;
  /** 当前筛选结果的总数 */
  matchedCount: number;
  /** 关键词变化（300ms 防抖由调用方做） */
  onKeyword: (v: string) => void;
  onChange: (patch: Partial<ListFilterState>) => void;
  onReset: () => void;
  /** 全选本页（批量编辑） */
  onSelectPage: () => void;
  /** 清空勾选 */
  onClearSelect: () => void;
}

/**
 * 渲染卡片视图的工具栏。
 * @param opts 状态与回调
 */
export function renderCardToolbar(opts: CardToolbarOptions): HTMLElement {
  const { state } = opts;
  const bar = h('div', { class: 'card-toolbar', dataset: { role: 'card-toolbar' } });

  // ── 第一行：搜索 + 排序 + 重置 ──
  const row1 = h('div', { class: 'card-toolbar-row' });
  row1.appendChild(
    h(
      'div',
      { class: 'ct-search' },
      textInput(state.keyword, opts.onKeyword, { placeholder: '搜索英文或中文义项（含近义词）' }),
    ),
  );
  row1.appendChild(
    h(
      'div',
      { class: 'ct-field' },
      h('span', { class: 'ct-label', text: '排序' }),
      select(SORT_OPTIONS, state.sort, (v) => opts.onChange({ sort: v as ListFilterState['sort'] })),
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
  row1.appendChild(button('重置筛选', () => opts.onReset(), { variant: 'ghost', class: 'ct-reset' }));
  bar.appendChild(row1);

  // ── 第二行：状态 chips + 来源 + 词优先级 + 只看收藏 / 只看需拼写 ──
  const row2 = h('div', { class: 'card-toolbar-row' });
  const chips = h('div', { class: 'ct-chips' });
  for (const chip of STATUS_CHIPS) {
    const active = chip.match(state);
    const btn = h('button', {
      class: `ct-chip${active ? ' is-active' : ''}`,
      type: 'button',
      text: chip.label,
      'aria-pressed': active ? 'true' : 'false',
    });
    btn.addEventListener('click', () => opts.onChange({ statuses: chip.statuses.slice() }));
    chips.appendChild(btn);
  }
  // 「含已斩」是独立开关（与单词视图那颗勾选框同一语义）
  const choppedChip = h('button', {
    class: `ct-chip${state.includeChopped ? ' is-active' : ''}`,
    type: 'button',
    text: '含已斩',
    title: '默认不显示被斩的词',
    'aria-pressed': state.includeChopped ? 'true' : 'false',
  });
  choppedChip.addEventListener('click', () => opts.onChange({ includeChopped: !state.includeChopped }));
  chips.appendChild(choppedChip);
  row2.appendChild(chips);

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
          ...WORD_PRIORITY_OPTIONS.slice()
            .reverse()
            .map((o) => ({ value: String(o.value), label: `P${o.value}` })),
        ],
        state.wordPriority === null ? '' : String(state.wordPriority),
        (v) => opts.onChange({ wordPriority: v === '' ? null : Number(v) }),
      ),
    ),
  );

  // 只看收藏（收藏对象是**卡片**）
  const favChip = h('button', {
    class: `ct-chip ct-chip-fav${state.favoriteOnly ? ' is-active' : ''}`,
    type: 'button',
    text: '★ 只看收藏',
    title: '只显示已收藏的卡片',
    'aria-pressed': state.favoriteOnly ? 'true' : 'false',
  });
  favChip.addEventListener('click', () => opts.onChange({ favoriteOnly: !state.favoriteOnly }));
  row2.appendChild(favChip);

  const spellChip = h('button', {
    class: `ct-chip${state.needSpellOnly ? ' is-active' : ''}`,
    type: 'button',
    text: '只看需拼写',
    'aria-pressed': state.needSpellOnly ? 'true' : 'false',
  });
  spellChip.addEventListener('click', () => opts.onChange({ needSpellOnly: !state.needSpellOnly }));
  row2.appendChild(spellChip);
  bar.appendChild(row2);

  // ── 第三行：结果计数 + 批量编辑入口 ──
  const row3 = h('div', { class: 'card-toolbar-row ct-foot' });
  row3.appendChild(
    h('span', {
      class: 'ct-count',
      text: `共 ${opts.matchedCount} 张卡片 · 已选 ${opts.selectedCount} 张`,
    }),
  );
  row3.appendChild(button('全选本页', () => opts.onSelectPage(), { variant: 'ghost', class: 'mini' }));
  row3.appendChild(button('清空勾选', () => opts.onClearSelect(), { variant: 'ghost', class: 'mini' }));
  bar.appendChild(row3);

  return bar;
}
