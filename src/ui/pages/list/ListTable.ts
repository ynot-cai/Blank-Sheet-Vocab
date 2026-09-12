import { humanizeDays } from '../../../core/model';
import type { Attrs, Source, Word, WordStatus } from '../../../core/types';
import { button, h } from '../../dom';

/** 表格操作回调 */
export interface ListTableHandlers {
  onToggleSelect: (id: string, checked: boolean) => void;
  onToggleSelectAll: (checked: boolean) => void;
  onOpenDetail: (word: Word) => void;
  onEditNumber: (word: Word, field: 'failCount' | 'reviewCount') => void;
  onNeedSpell: (word: Word, value: boolean) => void;
  onStatus: (word: Word, status: WordStatus) => void;
  onChop: (word: Word) => void;
  onRevive: (word: Word) => void;
  onDelete: (word: Word) => void;
  onRawSources: (word: Word) => void;
  onAdoptRaw: (word: Word) => void;
}

/** 状态标签颜色 */
const STATUS_CLASS: Record<WordStatus, string> = {
  unlearned: 'st-unlearned',
  learning: 'st-learning',
  learned: 'st-learned',
  chopped: 'st-chopped',
};

/** 状态中文名 */
const STATUS_LABEL: Record<WordStatus, string> = {
  unlearned: '未背',
  learning: '学习中',
  learned: '已背',
  chopped: '已斩',
};

/**
 * 渲染单词表格。
 * @param items 当前页的词
 * @param sources 来源列表（显示名字用）
 * @param selected 已选中的 id 集合（可能包含**不在当前页**的，因为支持跨页全选）
 * @param handlers 操作回调
 * @param failCap 未通过次数上限（达到上限用红字标出）
 * @param selectState 选中统计，用来决定表头勾选框的勾选/半选状态
 */
export function renderListTable(
  items: Word[],
  sources: Source[],
  selected: Set<string>,
  handlers: ListTableHandlers,
  failCap: number,
  selectState: { selectedCount: number; matchedCount: number },
): HTMLElement {
  const sourceName = (id: string): { name: string; priority: number } => {
    const hit = sources.find((s) => s.id === id);
    return { name: hit?.name ?? '（未知来源）', priority: hit?.priority ?? 0 };
  };

  const table = h('table', { class: 'table list-table' });
  const headCheck = h('input', { type: 'checkbox', title: '全选/取消整个筛选结果（跨页）' });
  // 选中数 ≥ 筛选结果数 = 全选；选中数 > 0 但不满 = 半选（indeterminate）
  const fullySelected = selectState.matchedCount > 0 && selectState.selectedCount >= selectState.matchedCount;
  headCheck.checked = fullySelected;
  headCheck.indeterminate = !fullySelected && selectState.selectedCount > 0;
  headCheck.addEventListener('change', () => handlers.onToggleSelectAll(headCheck.checked));

  table.appendChild(
    h(
      'thead',
      {},
      h(
        'tr',
        {},
        h('th', {}, headCheck),
        h('th', { text: '单词' }),
        h('th', { text: '义项' }),
        h('th', { text: '来源' }),
        h('th', { text: '①拼' }),
        h('th', { text: '②未通过' }),
        h('th', { text: '③复习次数' }),
        h('th', { text: '④距上次复习' }),
        h('th', { text: '⑤距背诵' }),
        h('th', { text: '⑥优先度' }),
        h('th', { text: '状态' }),
        h('th', { text: '操作' }),
      ),
    ),
  );

  const tbody = h('tbody');

  for (const word of items) {
    const tr = h('tr', { class: selected.has(word.id) ? 'row-selected' : '' });

    // ☐ 选择
    const check = h('input', { type: 'checkbox', checked: selected.has(word.id) });
    check.addEventListener('change', () => handlers.onToggleSelect(word.id, check.checked));
    tr.appendChild(h('td', {}, check));

    // 单词（点击 → 详情）
    const enCell = h('td', {});
    const enBtn = h('button', { class: 'link-btn', type: 'button', text: word.en, title: '点击查看/编辑详情' });
    enBtn.addEventListener('click', () => handlers.onOpenDetail(word));
    enCell.appendChild(enBtn);
    if (word.phonetic) enCell.appendChild(h('div', { class: 'sub', text: word.phonetic }));
    tr.appendChild(enCell);

    // 义项（前 2 个 + 「+n」展开）
    const senseCell = h('td', { class: 'sense-cell' });
    const activeAll = word.senses;
    const shown = activeAll.slice(0, 2);
    const renderSenseLine = (text: string, enabled: boolean): HTMLElement =>
      h('div', { class: enabled ? 'sense-line' : 'sense-line chopped', text });
    for (const s of shown) senseCell.appendChild(renderSenseLine(s.text || '（空）', s.enabled));
    if (activeAll.length > 2) {
      const rest = h('div', { class: 'hidden' });
      for (const s of activeAll.slice(2)) rest.appendChild(renderSenseLine(s.text || '（空）', s.enabled));
      const more = h('button', { class: 'link-btn', type: 'button', text: `+${activeAll.length - 2}` });
      more.addEventListener('click', () => {
        const hidden = rest.classList.toggle('hidden');
        more.textContent = hidden ? `+${activeAll.length - 2}` : '收起';
      });
      senseCell.appendChild(rest);
      senseCell.appendChild(more);
    }
    tr.appendChild(senseCell);

    // 来源
    const src = sourceName(word.sourceId);
    tr.appendChild(h('td', { class: 'sub' }, h('div', { text: src.name }), h('div', { class: 'sub', text: `优先级 ${src.priority}` })));

    // ① 拼
    const spell = h('input', { type: 'checkbox', checked: word.attrs.needSpell });
    spell.addEventListener('change', () => handlers.onNeedSpell(word, spell.checked));
    tr.appendChild(h('td', {}, spell));

    // ② 未通过
    const failCell = h('td', {});
    const failBtn = h('button', {
      class: `link-btn${word.attrs.failCount >= failCap ? ' danger' : ''}`,
      type: 'button',
      text: String(word.attrs.failCount),
      title: '点击修改未通过次数',
    });
    failBtn.addEventListener('click', () => handlers.onEditNumber(word, 'failCount'));
    failCell.appendChild(failBtn);
    failCell.appendChild(h('div', { class: 'sub', text: `累计 ${word.attrs.failCountTotal}` }));
    tr.appendChild(failCell);

    // ③ 复习次数
    const reviewBtn = h('button', {
      class: 'link-btn',
      type: 'button',
      text: String(word.attrs.reviewCount),
      title: '点击修改复习次数',
    });
    reviewBtn.addEventListener('click', () => handlers.onEditNumber(word, 'reviewCount'));
    tr.appendChild(h('td', {}, reviewBtn));

    // ④ ⑤ 只读
    tr.appendChild(h('td', { class: 'sub', text: humanizeDays(word.attrs.lastReviewAt) }));
    tr.appendChild(h('td', { class: 'sub', text: humanizeDays(word.attrs.learnedAt, Date.now(), '未背') }));

    // ⑥ 优先度
    tr.appendChild(h('td', { class: 'sub', text: word.attrs.reviewPriority.toFixed(2) }));

    // 状态
    const statusCell = h('td', {});
    statusCell.appendChild(h('span', { class: `tag ${STATUS_CLASS[word.status]}`, text: STATUS_LABEL[word.status] }));
    if (word.status !== 'chopped') {
      const sel = h('select', { class: 'input mini-select' });
      (['unlearned', 'learning', 'learned'] as WordStatus[]).forEach((st) => {
        const opt = h('option', { value: st, text: STATUS_LABEL[st] });
        if (st === word.status) opt.selected = true;
        sel.appendChild(opt);
      });
      sel.addEventListener('change', () => handlers.onStatus(word, sel.value as WordStatus));
      statusCell.appendChild(sel);
    }
    tr.appendChild(statusCell);

    // 操作
    const opCell = h('td', { class: 'op-cell' });
    opCell.appendChild(button('详情', () => handlers.onOpenDetail(word), { variant: 'ghost', class: 'mini' }));
    if (word.status === 'chopped') {
      opCell.appendChild(button('复活', () => handlers.onRevive(word), { variant: 'ghost', class: 'mini' }));
    } else {
      opCell.appendChild(button('斩', () => handlers.onChop(word), { variant: 'danger', class: 'mini' }));
    }
    const more = h('select', { class: 'input mini-select' });
    more.appendChild(h('option', { value: '', text: '更多…' }));
    more.appendChild(h('option', { value: 'copy', text: '复制' }));
    more.appendChild(h('option', { value: 'delete', text: '删除' }));
    more.appendChild(h('option', { value: 'raw', text: '查看其他来源义项' }));
    more.addEventListener('change', () => {
      const value = more.value;
      more.value = '';
      if (value === 'copy') {
        void navigator.clipboard?.writeText(`${word.en}\t${word.senses.map((s) => s.text).join('；')}`).catch(() => undefined);
      } else if (value === 'delete') handlers.onDelete(word);
      else if (value === 'raw') handlers.onRawSources(word);
    });
    opCell.appendChild(more);
    tr.appendChild(opCell);

    tbody.appendChild(tr);
  }

  table.appendChild(tbody);
  if (items.length === 0) {
    return h('div', {}, h('p', { class: 'note' }, '没有符合条件的词。'), table);
  }
  return table;
}

/** 属性补丁的小工具：把「未通过 / 复习次数」的输入结果转成 Attrs 补丁 */
export function attrsNumberPatch(field: 'failCount' | 'reviewCount', value: number): Partial<Attrs> {
  return field === 'failCount' ? { failCount: value } : { reviewCount: value };
}
