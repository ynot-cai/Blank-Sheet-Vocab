import type { Source, WordQuery, WordStatus } from '../../../core/types';
import { WORD_PRIORITY_OPTIONS } from '../../../core/types';
import { checkbox, h, numberInput, select, textInput } from '../../dom';

/** 列表页筛选状态 */
export interface ListFilterState {
  keyword: string;
  statuses: WordStatus[];
  sourceId: string;
  needSpellOnly: boolean;
  /** 是否把「已斩」的词也算进来（默认不算：斩掉的词从默认视图消失） */
  includeChopped: boolean;
  minFailCount: number | null;
  minPriority: number | null;
  /** ★ R3：按**词级**优先级精确筛选（null = 全部） */
  wordPriority: number | null;
  sort: NonNullable<WordQuery['sort']>;
  order: 'asc' | 'desc';
  page: number;
  pageSize: number;
}

/** 默认筛选状态（默认不含已斩） */
export function defaultFilterState(): ListFilterState {
  return {
    keyword: '',
    statuses: [],
    sourceId: '',
    needSpellOnly: false,
    includeChopped: false,
    minFailCount: null,
    minPriority: null,
    wordPriority: null,
    sort: 'createdAt',
    order: 'desc',
    page: 1,
    pageSize: 50,
  };
}

/**
 * 算出真正要查的状态集合。
 * 规则：用户明确勾了状态就按勾的查；没勾时默认「未背 + 学习中 + 已背」（即不含已斩）。
 * @param state 筛选状态
 */
export function effectiveStatuses(state: ListFilterState): WordStatus[] | undefined {
  if (state.statuses.length > 0) return state.statuses;
  if (state.includeChopped) return undefined; // 不限制 = 全部
  return ['unlearned', 'learning', 'learned'];
}

/** 筛选区参数 */
export interface ListFiltersOptions {
  state: ListFilterState;
  sources: Source[];
  /** 关键词变化（已做 300ms 防抖） */
  onKeyword: (v: string) => void;
  onChange: (patch: Partial<ListFilterState>) => void;
  onReset: () => void;
}

/** 状态中文名 */
const STATUS_LABEL: Record<WordStatus, string> = {
  unlearned: '未背',
  learning: '学习中',
  learned: '已背',
  chopped: '已斩',
};

/**
 * 渲染筛选区（一行排开，可换行）。
 * @param opts 状态与回调
 */
export function renderListFilters(opts: ListFiltersOptions): HTMLElement {
  const { state } = opts;
  const wrap = h('div', { class: 'filters' });

  // 搜索框（防抖 300ms 由调用方处理）
  const search = textInput(state.keyword, opts.onKeyword, { placeholder: '搜英文或中文义项（含近义词）' });
  wrap.appendChild(h('div', { class: 'filter-item grow' }, h('span', { class: 'filter-label', text: '搜索' }), search));

  // 状态多选
  const statusBox = h('div', { class: 'filter-item' }, h('span', { class: 'filter-label', text: '状态' }));
  const statusRow = h('div', { class: 'row' });
  (Object.keys(STATUS_LABEL) as WordStatus[]).forEach((status) => {
    statusRow.appendChild(
      checkbox(state.statuses.includes(status), STATUS_LABEL[status], (checked) => {
        const next = checked ? [...state.statuses, status] : state.statuses.filter((s) => s !== status);
        opts.onChange({ statuses: next });
      }),
    );
  });
  statusBox.appendChild(statusRow);
  wrap.appendChild(statusBox);

  // 来源
  wrap.appendChild(
    h(
      'div',
      { class: 'filter-item' },
      h('span', { class: 'filter-label', text: '来源' }),
      select(
        [{ value: '', label: '全部来源' }, ...opts.sources.map((s) => ({ value: s.id, label: `${s.name}（优先级 ${s.priority}）` }))],
        state.sourceId,
        (v) => opts.onChange({ sourceId: v }),
      ),
    ),
  );

  // 只看需拼写
  wrap.appendChild(
    h(
      'div',
      { class: 'filter-item' },
      checkbox(state.needSpellOnly, '只看需拼写', (v) => opts.onChange({ needSpellOnly: v })),
    ),
  );

  // 含已斩（默认不含：被斩的词从默认视图消失）
  wrap.appendChild(
    h(
      'div',
      { class: 'filter-item' },
      checkbox(state.includeChopped, '含已斩', (v) => opts.onChange({ includeChopped: v })),
      h('span', { class: 'field-hint', text: '默认不显示被斩的词' }),
    ),
  );

  // 未通过次数 ≥
  wrap.appendChild(
    h(
      'div',
      { class: 'filter-item' },
      h('span', { class: 'filter-label', text: '未通过 ≥' }),
      numberInput(state.minFailCount ?? 0, (v) => opts.onChange({ minFailCount: v > 0 ? v : null }), { min: 0, max: 99 }),
    ),
  );

  // 复习优先度 ≥
  wrap.appendChild(
    h(
      'div',
      { class: 'filter-item' },
      h('span', { class: 'filter-label', text: '优先度 ≥' }),
      numberInput(state.minPriority ?? 0, (v) => opts.onChange({ minPriority: v > 0 ? v : null }), {
        min: 0,
        step: 1,
      }),
      h('span', { class: 'field-hint', text: '配合「优先度」排序 = 该复习了' }),
    ),
  );

  // ★ R3：词级优先级筛选（与上面的「复习优先度」是两回事，标签写清楚）
  wrap.appendChild(
    h(
      'div',
      { class: 'filter-item' },
      h('span', { class: 'filter-label', text: '词优先级' }),
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
      h('span', { class: 'field-hint', text: '背诵先抽高优先级（绝对优先）' }),
    ),
  );

  // 排序 + 升降序
  wrap.appendChild(
    h(
      'div',
      { class: 'filter-item' },
      h('span', { class: 'filter-label', text: '排序' }),
      h(
        'div',
        { class: 'row' },
        select(
          [
            { value: 'priority', label: '词优先级（高→低）' },
            { value: 'learnOrder', label: '背诵顺序' },
            { value: 'reviewPriority', label: '复习优先度' },
            { value: 'createdAt', label: '创建时间' },
            { value: 'en', label: '字母序' },
          ],
          state.sort,
          (v) => opts.onChange({ sort: v as ListFilterState['sort'] }),
        ),
        select(
          [
            { value: 'desc', label: '降序' },
            { value: 'asc', label: '升序' },
          ],
          state.order,
          (v) => opts.onChange({ order: v as 'asc' | 'desc' }),
        ),
      ),
    ),
  );

  wrap.appendChild(h('div', { class: 'filter-item' }, h('button', { class: 'btn', type: 'button', text: '重置筛选', onclick: opts.onReset })));

  return wrap;
}
