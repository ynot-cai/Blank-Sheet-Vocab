/**
 * 列表页「白纸」视图（版本 1.0.0）。
 *
 * ★ 用户 1.0.0：「『卡片』界面移除单词卡浏览功能，并改名为『白纸』，仅用于浏览白纸存档；
 *   搜索、收藏等功能同样针对白纸存档生效。」
 *
 * 所以这个视图**只浏览白纸存档**（不是单词卡）：
 * - 工具栏：搜索（存档名称 / 存档里出现过的单词）、状态（全部 / 进行中 / 已背完）、
 *   只看收藏、排序（最近改动 / 创建时间 / 名称 / 词数）+ 升降序、结果计数、重置；
 * - 卡片：名称、状态 · 词数、收藏星标、查看 / 重命名。
 */
import type { PaperArchive, Word } from '../../../core/types';
import { button, h, select, textInput } from '../../dom';
import { debounce } from '../../dom';

/** 白纸视图的筛选状态 */
export interface PaperFilterState {
  keyword: string;
  status: 'all' | 'draft' | 'finished';
  favoriteOnly: boolean;
  sort: 'updatedAt' | 'createdAt' | 'name' | 'words';
  order: 'asc' | 'desc';
}

/** 默认筛选状态 */
export function defaultPaperFilter(): PaperFilterState {
  return { keyword: '', status: 'all', favoriteOnly: false, sort: 'updatedAt', order: 'desc' };
}

/** 面板参数 */
export interface PaperPanelOptions {
  papers: PaperArchive[];
  /** 词表（搜索时把存档里出现过的单词也纳入匹配） */
  words: Word[];
  /** 已收藏的存档 id */
  favorites: Set<string>;
  state: PaperFilterState;
  onChange: (patch: Partial<PaperFilterState>) => void;
  onReset: () => void;
  onFavorite: (paper: PaperArchive, value: boolean) => void;
  onOpen: (paper: PaperArchive) => void;
  onRename: (paper: PaperArchive) => void;
}

/**
 * 渲染白纸视图。
 * @param opts 存档、收藏与回调
 */
export function renderPaperPanel(opts: PaperPanelOptions): HTMLElement {
  const { papers, words, favorites, state } = opts;
  const box = h('div', { class: 'paper-view', dataset: { role: 'paper-view' } });

  // ── 工具栏 ──
  const bar = h('div', { class: 'paper-view-bar' });
  bar.appendChild(
    h(
      'div',
      { class: 'ct-search' },
      textInput(state.keyword, debounce((v: string) => opts.onChange({ keyword: v.trim() }), 300), {
        placeholder: '搜索存档名称或存档里的单词',
      }),
    ),
  );
  bar.appendChild(
    select(
      [
        { value: 'all', label: '全部存档' },
        { value: 'draft', label: '进行中' },
        { value: 'finished', label: '已背完' },
      ],
      state.status,
      (v) => opts.onChange({ status: v as PaperFilterState['status'] }),
    ),
  );
  const favChip = h('button', {
    class: `ct-chip ct-chip-fav${state.favoriteOnly ? ' is-active' : ''}`,
    type: 'button',
    text: '★ 只看收藏',
    'aria-pressed': state.favoriteOnly ? 'true' : 'false',
  });
  favChip.addEventListener('click', () => opts.onChange({ favoriteOnly: !state.favoriteOnly }));
  bar.appendChild(favChip);
  bar.appendChild(
    select(
      [
        { value: 'updatedAt', label: '最近改动' },
        { value: 'createdAt', label: '创建时间' },
        { value: 'name', label: '名称' },
        { value: 'words', label: '词数' },
      ],
      state.sort,
      (v) => opts.onChange({ sort: v as PaperFilterState['sort'] }),
    ),
  );
  bar.appendChild(
    select(
      [
        { value: 'desc', label: '降序' },
        { value: 'asc', label: '升序' },
      ],
      state.order,
      (v) => opts.onChange({ order: v as 'asc' | 'desc' }),
    ),
  );
  const count = h('span', { class: 'review-card-count', dataset: { role: 'paper-count' }, text: '' });
  bar.appendChild(count);
  bar.appendChild(button('重置筛选', () => opts.onReset(), { variant: 'ghost', class: 'mini' }));
  box.appendChild(bar);

  // ── 过滤 + 排序 ──
  const enById = new Map(words.map((w) => [w.id, w.en.toLowerCase()]));
  const keyword = state.keyword.toLowerCase();
  let rows = papers.filter((p) => {
    if (state.status !== 'all' && p.status !== state.status) return false;
    if (state.favoriteOnly && !favorites.has(p.id)) return false;
    if (keyword !== '') {
      const inName = (p.name || '').toLowerCase().includes(keyword);
      const inWords = p.shownIds.some((id) => (enById.get(id) ?? '').includes(keyword));
      if (!inName && !inWords) return false;
    }
    return true;
  });
  const dir = state.order === 'asc' ? 1 : -1;
  rows = rows.slice().sort((a, b) => {
    if (state.sort === 'name') return (a.name || '').localeCompare(b.name || '') * dir;
    if (state.sort === 'words') return (a.shownIds.length - b.shownIds.length) * dir;
    if (state.sort === 'createdAt') return (a.createdAt - b.createdAt) * dir;
    return (a.updatedAt - b.updatedAt) * dir;
  });
  count.textContent = `${rows.length} 张`;

  if (rows.length === 0) {
    box.appendChild(
      h('p', {
        class: 'note',
        text: papers.length === 0 ? '还没有白纸存档。背诵时点「保存并退出」或「背完了」就会在这里留一张。' : '没有符合条件的存档。',
      }),
    );
    return box;
  }

  // ── 存档卡片 ──
  const grid = h('div', { class: 'paper-view-grid' });
  for (const p of rows) {
    const favorited = favorites.has(p.id);
    const tile = h('div', {
      class: `paper-tile${favorited ? ' is-favorite' : ''}`,
      dataset: { paperId: p.id },
    });
    const top = h('div', { class: 'paper-tile-top' });
    const star = button(favorited ? '★' : '☆', () => opts.onFavorite(p, !favorited), {
      variant: 'ghost',
      class: `fav-btn${favorited ? ' is-on' : ''}`,
      title: favorited ? '取消收藏这张存档' : '收藏这张存档',
    });
    star.setAttribute('aria-pressed', favorited ? 'true' : 'false');
    top.appendChild(star);
    top.appendChild(h('span', { class: 'paper-tile-name', text: p.name === '' ? '（未命名）' : p.name }));
    tile.appendChild(top);
    tile.appendChild(
      h('div', {
        class: 'paper-tile-meta',
        text: `${p.status === 'finished' ? '已背完' : '进行中'} · ${p.shownIds.length} 词`,
      }),
    );
    const foot = h('div', { class: 'paper-tile-foot' });
    foot.appendChild(button('查看', () => opts.onOpen(p), { variant: 'ghost', class: 'mini' }));
    foot.appendChild(button('重命名', () => opts.onRename(p), { variant: 'ghost', class: 'mini' }));
    tile.appendChild(foot);
    grid.appendChild(tile);
  }
  box.appendChild(grid);
  return box;
}
