/**
 * 单词列表的**卡片视图**（版本 0.0.22）。
 *
 * 用户要求（对话 2026-10-20 / 2026-10-22）：
 * - 页面上方可在「卡片」与「单词」两个视图间切换；
 * - **卡片界面里要有筛选、搜索、排序、批量编辑、收藏**；
 * - 「将收藏对象从『单词』改为『卡片』，并删除原有的单词收藏功能」。
 *
 * ── 0.0.22 的改动 ──
 * - 收藏的**对象是卡片**：数据存在 `cardFavorites` 表（`dao.cardFavorites`），
 *   不再是 `Word.favorite`；星标只出现在卡片上，单词（表格）视图里没有。
 * - 卡片视图自带一条工具栏（`list/CardToolbar.ts`）：
 *   搜索 / 筛选 / 排序 / 批量编辑 / 只看收藏。
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

/** 卡片视图参数 */
export interface ListCardsOptions {
  /** 当前页的词 */
  items: Word[];
  /** 来源列表（显示名字用） */
  sources: Source[];
  /** 已选中的 id（支持跨页全选，所以可能包含不在当前页的） */
  selected: Set<string>;
  /** 已被收藏的**卡片** id 集合（= 词 id；来自 cardFavorites 表） */
  favorites: Set<string>;
  /** 操作回调（与表格共用同一套，保证两个视图的行为一致） */
  handlers: ListTableHandlers;
}

/**
 * 渲染卡片视图。
 * @param opts 词条、来源、选中/收藏状态与回调
 */
export function renderListCards(opts: ListCardsOptions): HTMLElement {
  const { items, sources, selected, favorites, handlers } = opts;
  const box = h('div', { class: 'list-cards' });

  if (items.length === 0) {
    box.appendChild(h('p', { class: 'note', text: '没有符合条件的卡片。' }));
    return box;
  }

  const sourceName = (id: string): string => sources.find((s) => s.id === id)?.name ?? '未知来源';

  for (const word of items) {
    box.appendChild(renderCard(word));
  }
  return box;

  /** 一张卡 */
  function renderCard(word: Word): HTMLElement {
    const favorited = favorites.has(word.id);
    const card = h('div', {
      class: `list-card status-${word.status}${selected.has(word.id) ? ' is-selected' : ''}${favorited ? ' is-favorite' : ''}`,
      // ★ 勾选时页面只改这一个节点的 class（见 ListPage 的 updateSelectionUi），所以要能按 id 找到它
      dataset: { wordId: word.id },
    });

    // —— 第一行：勾选 + 星标（收藏这张卡片）+ 单词 + 状态 ——
    const top = h('div', { class: 'list-card-top' });
    const check = h('input', {
      type: 'checkbox',
      checked: selected.has(word.id),
      class: 'list-card-check',
      title: '选中这张卡片（用于批量编辑）',
    });
    check.addEventListener('change', () => handlers.onToggleSelect(word.id, check.checked));
    top.appendChild(check);

    top.appendChild(renderCardFavoriteButton(word, favorited, handlers));

    const titleBox = h('div', { class: 'list-card-title' });
    const en = h('button', { class: 'link-btn list-card-en', type: 'button', text: word.en, title: '点击打开单词卡' });
    en.addEventListener('click', () => handlers.onOpenDetail(word));
    titleBox.appendChild(en);
    top.appendChild(titleBox);

    top.appendChild(h('span', { class: `tag st-${word.status}`, text: STATUS_LABEL[word.status] }));
    card.appendChild(top);

    // —— 第二行：音标 + 词级优先级徽章 ——
    const sub = h('div', { class: 'list-card-sub' });
    if (word.phonetic.trim() !== '') sub.appendChild(h('span', { class: 'list-card-phonetic', text: word.phonetic }));
    sub.appendChild(renderPriorityBadge(wordPriorityOf(word)));
    card.appendChild(sub);

    // —— 义项：最多 3 个 chip，多的给「+n」 ——
    const senses = h('div', { class: 'list-card-senses' });
    const active = word.senses.filter((s) => s.enabled);
    for (const sense of active.slice(0, 3)) senses.appendChild(h('span', { class: 'chip', text: sense.text }));
    if (active.length > 3) senses.appendChild(h('span', { class: 'chip', text: `+${active.length - 3}` }));
    if (senses.childElementCount === 0) senses.appendChild(h('span', { class: 'sub', text: '（没有义项）' }));
    card.appendChild(senses);

    // —— 底部：来源 + 三个关键属性 ——
    card.appendChild(
      h('div', {
        class: 'list-card-meta',
        text:
          `${sourceName(word.sourceId)} · ②未通过 ${word.attrs.failCount} · ③复习 ${word.attrs.reviewCount} 次` +
          ` · ④${humanizeDays(word.attrs.lastReviewAt)}`,
      }),
    );

    // —— 卡底操作：单词卡 + ⋯ ——
    const foot = h('div', { class: 'list-card-foot' });
    foot.appendChild(button('单词卡', () => handlers.onOpenDetail(word), { variant: 'ghost', class: 'mini' }));
    foot.appendChild(button('⋯', () => openMenu(word), { variant: 'ghost', class: 'mini list-card-more', title: '更多操作' }));
    card.appendChild(foot);
    return card;
  }

  /** 「⋯」菜单：放不进卡面的一堆操作 */
  function openMenu(word: Word): void {
    const body = h('div', { class: 'stack' });
    body.appendChild(
      h('p', {
        class: 'note',
        text: `${word.en} · ②未通过 ${word.attrs.failCount}/${word.attrs.failCountTotal} · ③复习 ${word.attrs.reviewCount} 次`,
      }),
    );
    const actions = h('div', { class: 'row-actions' });
    actions.appendChild(button('打开单词卡', () => handlers.onOpenDetail(word)));
    actions.appendChild(
      button(favorites.has(word.id) ? '取消收藏这张卡片' : '收藏这张卡片', () =>
        handlers.onCardFavorite(word, !favorites.has(word.id)),
      ),
    );
    actions.appendChild(
      button(word.attrs.needSpell ? '取消拼写标记' : '标记要拼写', () => handlers.onNeedSpell(word, !word.attrs.needSpell)),
    );
    actions.appendChild(button('改未通过次数', () => handlers.onEditNumber(word, 'failCount')));
    actions.appendChild(button('改复习次数', () => handlers.onEditNumber(word, 'reviewCount')));
    // R3：改优先级（下拉在卡片里太挤，放菜单里）
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
      word.status === 'chopped' ? button('复活', () => handlers.onRevive(word)) : button('斩掉', () => handlers.onChop(word)),
    );
    // ★ 0.1.1（用户）：AI 重新整理义项
    actions.appendChild(button('AI 重新整理义项', () => handlers.onReorganizeSenses(word)));
    actions.appendChild(button('其他来源义项', () => handlers.onRawSources(word)));
    actions.appendChild(button('删除', () => handlers.onDelete(word), { variant: 'danger' }));
    body.appendChild(actions);
    openModal({ title: '操作', width: '460px', body });
  }
}

/**
 * 卡片上的星标按钮（收藏**这张卡片**）。
 *
 * 颜色不引入新色：已收藏用 `--warn`（已有），未收藏用 `--fg-dim`。
 * @param word 卡片对应的词
 * @param favorited 这张卡片是否已收藏
 * @param handlers 回调（用其中的 onCardFavorite）
 */
export function renderCardFavoriteButton(
  word: Word,
  favorited: boolean,
  handlers: ListTableHandlers,
): HTMLButtonElement {
  const btn = button(favorited ? '★' : '☆', () => handlers.onCardFavorite(word, !favorited), {
    variant: 'ghost',
    class: `fav-btn${favorited ? ' is-on' : ''}`,
    title: favorited ? '取消收藏这张卡片' : '收藏这张卡片',
  });
  btn.setAttribute('aria-pressed', favorited ? 'true' : 'false');
  return btn;
}
