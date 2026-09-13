/**
 * 单词列表的**手机卡片流**（阶段 05）。
 *
 * 桌面上是表格（一屏能扫很多行），手机上表格必须横向滚动才能看全，
 * 所以手机上换成卡片流：一张卡一个词，只显示最关键的信息，
 * 其余操作收进右上角的「⋯」菜单里。
 *
 * 显示/隐藏由 CSS 媒体查询控制（`.list-table` 与 `.list-cards` 二选一），
 * 这样不用监听 resize 重画，横竖屏切换也不会错位。
 */
import { humanizeDays, wordPriorityOf } from '../../../core/model';
import type { Source, Word } from '../../../core/types';
import { WORD_PRIORITY_OPTIONS } from '../../../core/types';
import { button, h } from '../../dom';
import { openModal } from '../../components/Modal';
import type { ListTableHandlers } from './ListTable';
import { renderPriorityBadge } from './ListTable';

/** 状态中文名 */
const STATUS_LABEL: Record<Word['status'], string> = {
  unlearned: '未背',
  learning: '学习中',
  learned: '已背',
  chopped: '已斩',
};

/**
 * 渲染手机用的单词卡片流。
 * @param items 当前页的词
 * @param sources 来源列表（显示名字用）
 * @param handlers 操作回调（与表格共用同一套）
 */
export function renderListCards(items: Word[], sources: Source[], handlers: ListTableHandlers): HTMLElement {
  const box = h('div', { class: 'list-cards' });

  if (items.length === 0) {
    box.appendChild(h('p', { class: 'note', text: '没有符合条件的词。' }));
    return box;
  }

  const sourceName = (id: string): string => sources.find((s) => s.id === id)?.name ?? '未知来源';

  for (const word of items) {
    box.appendChild(renderCard(word, sourceName(word.sourceId)));
  }
  return box;

  /** 一张卡 */
  function renderCard(word: Word, source: string): HTMLElement {
    const card = h('div', { class: `list-card status-${word.status}` });

    // —— 第一行：单词 + 优先级徽章 + 状态 + 「⋯」——
    const top = h('div', { class: 'list-card-top' });
    const titleBox = h('div', { class: 'list-card-title' });
    titleBox.appendChild(h('span', { class: 'list-card-en', text: word.en }));
    if (word.phonetic.trim() !== '') {
      titleBox.appendChild(h('span', { class: 'list-card-phonetic', text: word.phonetic }));
    }
    // R3：手机上也要能看到优先级（徽章小、不占地方）
    titleBox.appendChild(renderPriorityBadge(wordPriorityOf(word)));
    top.appendChild(titleBox);
    top.appendChild(h('span', { class: `stat-label st-${word.status}`, text: STATUS_LABEL[word.status] }));
    top.appendChild(
      button('⋯', () => openMenu(word), { variant: 'ghost', class: 'list-card-more', title: '更多操作' }),
    );
    card.appendChild(top);

    // —— 前 2 个代表义项 ——
    const senses = h('div', { class: 'list-card-senses' });
    for (const sense of word.senses.filter((s) => s.enabled).slice(0, 2)) {
      senses.appendChild(h('span', { class: 'chip', text: sense.text }));
    }
    if (senses.childElementCount === 0) senses.appendChild(h('span', { class: 'sub', text: '（没有义项）' }));
    card.appendChild(senses);

    // —— 底部小字：来源 + 两个关键属性 ——
    card.appendChild(
      h('div', {
        class: 'list-card-meta',
        text: `${source} · ②未通过 ${word.attrs.failCount} · ④距上次复习 ${humanizeDays(word.attrs.lastReviewAt)}`,
      }),
    );

    // 点卡片主体 = 详情（和桌面上点「详情」一致）
    card.addEventListener('click', (ev) => {
      if (ev.target instanceof Element && ev.target.closest('button')) return;
      handlers.onOpenDetail(word);
    });
    return card;
  }

  /** 「⋯」菜单：把桌面上那一堆按钮收进来 */
  function openMenu(word: Word): void {
    const body = h('div', { class: 'stack' });
    body.appendChild(
      h('p', { class: 'note', text: `${word.en} · ②未通过 ${word.attrs.failCount}/${word.attrs.failCountTotal} · ③复习 ${word.attrs.reviewCount} 次` }),
    );
    const actions = h('div', { class: 'row-actions' });
    actions.appendChild(button('查看详情', () => handlers.onOpenDetail(word)));
    actions.appendChild(
      button(word.attrs.needSpell ? '取消拼写标记' : '标记要拼写', () => handlers.onNeedSpell(word, !word.attrs.needSpell)),
    );
    actions.appendChild(
      button('改未通过次数', () => handlers.onEditNumber(word, 'failCount')),
    );
    actions.appendChild(button('改复习次数', () => handlers.onEditNumber(word, 'reviewCount')));
    // R3：手机上改优先级（下拉在卡片里太挤，放菜单里）
    const prioRow = h('div', { class: 'row' }, h('span', { class: 'field-label', text: '词优先级' }));
    const prioSel = h('select', { class: 'input mini-select' });
    for (const opt of WORD_PRIORITY_OPTIONS) {
      const o = h('option', { value: String(opt.value), text: `P${opt.value}` });
      if (opt.value === wordPriorityOf(word)) o.selected = true;
      prioSel.appendChild(o);
    }
    prioSel.addEventListener('change', () => handlers.onPriority(word, Number(prioSel.value)));
    prioRow.appendChild(prioSel);
    actions.appendChild(prioRow);
    actions.appendChild(
      word.status === 'chopped'
        ? button('复活', () => handlers.onRevive(word))
        : button('斩掉', () => handlers.onChop(word)),
    );
    actions.appendChild(button('删除', () => handlers.onDelete(word), { variant: 'danger' }));
    body.appendChild(actions);
    openModal({ title: '操作', width: '420px', body });
  }
}
