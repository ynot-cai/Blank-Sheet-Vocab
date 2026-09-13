/**
 * 卡片列表的**筛选栏 + 批量操作栏**（阶段 03）。
 *
 * 与页面分开的原因：筛选栏有十来个控件、批量栏有一排按钮，
 * 塞进列表页会让那一页超出行数硬约束，也会让「筛选条件怎么改」这件事埋在长文件里。
 */
import { EXAM_TYPES, type KcStatus } from '../../../core/kcTypes';
import { button, h } from '../../dom';

/** 列表页的查询状态（页面持有，这里只读） */
export interface KcListQuery {
  keyword: string;
  status: KcStatus[];
  examTag: string;
  sort: 'reviewPriority' | 'createdAt' | 'mastery' | 'title';
  order: 'asc' | 'desc';
  page: number;
  pageSize: number;
}

/** 筛选栏回调 */
export interface KcFilterHandlers {
  onChange: (patch: Partial<KcListQuery>) => void;
  /** 点统计数字直接筛某个状态 */
  onPickStatus: (status: KcStatus[] | null) => void;
}

/** 排序选项（value 与 `KcQuery.sort` 对齐） */
const SORTS: { value: KcListQuery['sort']; label: string }[] = [
  { value: 'reviewPriority', label: '复习优先度' },
  { value: 'mastery', label: '掌握度' },
  { value: 'createdAt', label: '创建时间' },
  { value: 'title', label: '标题' },
];

/** 状态筛选项（值 + 中文 + 对应的统计键） */
const STATUS_OPTIONS: { value: KcStatus; label: string }[] = [
  { value: 'unlearned', label: '未学' },
  { value: 'learning', label: '学习中' },
  { value: 'learned', label: '已学' },
  { value: 'chopped', label: '已斩' },
];

/**
 * 渲染顶部统计条（数字可点，点了直接按该状态筛选）。
 * @param stats 统计
 * @param active 当前筛选的状态（null = 不筛）
 * @param handlers 回调
 */
export function renderKcStatsBar(
  stats: { total: number; unlearned: number; learning: number; learned: number; chopped: number },
  active: KcStatus[] | null,
  handlers: KcFilterHandlers,
): HTMLElement {
  const box = h('div', { class: 'kc-statsbar' });
  /** 造一个可点的统计格 */
  const cell = (label: string, value: number, status: KcStatus[] | null): HTMLElement => {
    const isActive =
      active === null ? status === null : status !== null && status.length === active.length && status.every((s) => active.includes(s));
    const btn = h('button', {
      class: `kc-statcell${isActive ? ' kc-statcell--active' : ''}`,
      type: 'button',
      title: status === null ? '显示全部' : `只看「${label}」`,
    });
    btn.appendChild(h('span', { class: 'kc-statcell-num', text: String(value) }));
    btn.appendChild(h('span', { class: 'kc-statcell-label', text: label }));
    btn.addEventListener('click', () => handlers.onPickStatus(status));
    return btn;
  };
  box.appendChild(cell('全部', stats.total, null));
  box.appendChild(cell('未学', stats.unlearned, ['unlearned']));
  box.appendChild(cell('学习中', stats.learning, ['learning']));
  box.appendChild(cell('已学', stats.learned, ['learned']));
  box.appendChild(cell('已斩', stats.chopped, ['chopped']));
  return box;
}

/**
 * 渲染筛选区（搜索 / 状态 / 考核方式 / 排序 / 每页条数）。
 * @param q 当前查询
 * @param handlers 回调
 */
export function renderKcFilters(q: KcListQuery, handlers: KcFilterHandlers): HTMLElement {
  const box = h('div', { class: 'kc-filters' });

  // 搜索（输入即筛，由页面对 keyword 做防抖）
  const search = h('input', {
    class: 'input kc-search',
    type: 'search',
    placeholder: '搜索标题 / 摘要 / 卡片正文…',
    value: q.keyword,
  });
  search.addEventListener('input', () => handlers.onChange({ keyword: search.value, page: 1 }));
  box.appendChild(search);

  // 状态多选（按钮态，比 select 多选好用）
  const statusRow = h('div', { class: 'kc-filter-group' });
  statusRow.appendChild(h('span', { class: 'kc-filter-label', text: '状态' }));
  for (const opt of STATUS_OPTIONS) {
    const on = q.status.includes(opt.value);
    const btn = button(opt.label, () => {
      const next = on ? q.status.filter((s) => s !== opt.value) : [...q.status, opt.value];
      handlers.onChange({ status: next, page: 1 });
    }, { variant: on ? 'primary' : 'ghost', class: 'kc-filter-btn' });
    statusRow.appendChild(btn);
  }
  box.appendChild(statusRow);

  // 考核方式
  const tagRow = h('div', { class: 'kc-filter-group' });
  tagRow.appendChild(h('span', { class: 'kc-filter-label', text: '考法' }));
  const tagSelect = h('select', { class: 'input kc-filter-select' });
  for (const opt of [{ value: '', label: '全部' }, ...EXAM_OPTIONS]) {    const o = h('option', { value: opt.value, text: opt.label });
    if (opt.value === q.examTag) o.selected = true;
    tagSelect.appendChild(o);
  }
  tagSelect.addEventListener('change', () => handlers.onChange({ examTag: tagSelect.value, page: 1 }));
  tagRow.appendChild(tagSelect);
  box.appendChild(tagRow);

  // 排序 + 方向
  const sortRow = h('div', { class: 'kc-filter-group' });
  sortRow.appendChild(h('span', { class: 'kc-filter-label', text: '排序' }));
  const sortSelect = h('select', { class: 'input kc-filter-select' });
  for (const s of SORTS) {
    const o = h('option', { value: s.value, text: s.label });
    if (s.value === q.sort) o.selected = true;
    sortSelect.appendChild(o);
  }
  sortSelect.addEventListener('change', () => handlers.onChange({ sort: sortSelect.value as KcListQuery['sort'], page: 1 }));
  sortRow.appendChild(sortSelect);
  sortRow.appendChild(
    button(q.order === 'desc' ? '降序 ↓' : '升序 ↑', () => {
      handlers.onChange({ order: q.order === 'desc' ? 'asc' : 'desc', page: 1 });
    }, { variant: 'ghost', class: 'kc-filter-btn' }),
  );
  box.appendChild(sortRow);

  return box;
}

/** 考核方式的选项（从 `EXAM_TYPES` 生成，这里不写死四种） */
const EXAM_OPTIONS: { value: string; label: string }[] = EXAM_TYPES.map((t) => ({ value: t.id, label: t.name }));

/**
 * 渲染批量操作栏（选中 ≥1 时显示）。
 * @param count 选中数量
 * @param handlers 各批量操作
 */
export function renderKcBatchBar(
  count: number,
  handlers: {
    onChop: () => void;
    onRevive: () => void;
    onAddTag: (tag: string) => void;
    onRemove: () => void;
    onClear: () => void;
  },
): HTMLElement {
  const box = h('div', { class: 'kc-batchbar' });
  box.appendChild(h('span', { class: 'kc-batch-count', text: `已选 ${count} 张` }));
  box.appendChild(button('批量斩', handlers.onChop, { variant: 'ghost', class: 'kc-batch-btn' }));
  box.appendChild(button('批量复活', handlers.onRevive, { variant: 'ghost', class: 'kc-batch-btn' }));

  // 批量加标签：一个下拉选题型
  const select = h('select', { class: 'input kc-batch-select', title: '选一个考法加给选中的卡片' });
  select.appendChild(h('option', { value: '', text: '批量加考法…' }));
  for (const opt of EXAM_OPTIONS) select.appendChild(h('option', { value: opt.value, text: opt.label }));
  select.addEventListener('change', () => {
    if (select.value !== '') handlers.onAddTag(select.value);
    select.value = '';
  });
  box.appendChild(select);

  box.appendChild(button('批量删除', handlers.onRemove, { variant: 'danger', class: 'kc-batch-btn' }));
  box.appendChild(button('取消选择', handlers.onClear, { variant: 'ghost', class: 'kc-batch-btn' }));
  return box;
}
