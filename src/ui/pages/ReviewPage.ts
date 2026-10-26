/**
 * 复习选择界面（`#/review`）—— 版本 0.0.24。
 *
 * RULES-R1: 本页只负责「选哪种复习方式 / 选哪张卡片」，不参与任何作答判定，
 *   也没有任何时间限制 / 倒计时（复习不计时）。
 *
 * 用户要求（「一、入口与界面」）：
 * 1. 点击主界面的「复习」按钮，进入「复习选择界面」。
 * 2. 布局与交互参照「背诵选择界面」。
 * 3. 可以选择复习方式：「默认复习模式」或「复习卡片」。
 *
 * 所以这里**直接复用**背诵选择界面的骨架类名（`.learn-select-body` / `.learn-select-nav` /
 * `.learn-nav-item` / `.learn-select-bottom`）：左栏是两个方式（对应背诵页的两个页签），
 * 右栏是当前方式的内容，底部是主按钮。
 *
 * 两种方式的区别（用户「二、三」）：
 * - 默认复习模式：全部单词按「复习优先度 → 背诵优先级 → 首字母」排序后逐个复习；
 * - 复习卡片：先在卡片列表里选一张卡片（支持搜索 / 筛选 / 排序），点「确认选择」后，
 *   只复习**这张卡片出现过的单词**。
 */
import type { PaperArchive, Settings, Word } from '../../core/types';
import { buildReviewQueue, reviewCandidates } from '../../core/reviewSelect';
import * as dao from '../../dao';
import { button, debounce, h, select, textInput } from '../dom';
import { toastWarn } from '../components/Toast';
import { navigate } from '../router';
import { currentSettings } from './settings/ctx';

/** 复习方式 */
type ReviewMode = 'default' | 'card';

/**
 * 卡片列表的筛选/排序状态（★ 0.1.1：用户「进一步完善卡片模式的筛选与排序功能」）。
 *
 * 相比上一版补了三件事：
 * 1. 搜索同时匹配**卡片名称**与**卡片里的单词**（名称想不起来时也能按词找）；
 * 2. 新增「词数下限」筛选（空卡 / 至少 3 词 / 至少 10 词），便于跳过刚建的空纸；
 * 3. 排序多了「卡里的词数」与「名称」两个键，并保留升/降序；另加「重置筛选」。
 */
interface CardListState {
  keyword: string;
  /** 全部 / 进行中 / 已背完 */
  status: 'all' | 'draft' | 'finished';
  /** 词数下限：0 = 不限 */
  minWords: number;
  /** 最近改动 / 创建时间 / 名称 / 词数 */
  sort: 'updatedAt' | 'createdAt' | 'name' | 'words';
  order: 'asc' | 'desc';
}

/** 默认状态 */
function defaultCardState(): CardListState {
  return { keyword: '', status: 'all', minWords: 0, sort: 'updatedAt', order: 'desc' };
}

/**
 * 渲染复习选择界面。
 */
export function renderReviewPage(): HTMLElement {
  const page = h('div', { class: 'page learn-select review-select' });

  let mode: ReviewMode = 'default';
  /** 词库全量（已排除已斩） */
  let words: Word[] = [];
  /** 全部白纸存档 */
  let papers: PaperArchive[] = [];
  /** 已选中的卡片 id（卡片模式下点「确认选择」用） */
  let pickedId = '';
  let cardState = defaultCardState();

  const left = h('aside', { class: 'learn-select-nav' });
  const right = h('section', { class: 'learn-select-main' });
  page.appendChild(h('div', { class: 'learn-select-body' }, left, right));

  // ── 底部：主按钮 ──
  const bottom = h('div', { class: 'learn-select-bottom' });
  const startBtn = button('开始复习', () => void start(), { variant: 'primary', class: 'learn-start-btn' });
  bottom.appendChild(h('span', { class: 'field-hint', text: '复习不产生白纸存档，只累计复习次数与优先度。' }));
  bottom.appendChild(startBtn);
  page.appendChild(bottom);

  /** 左栏两个方式 */
  const drawNav = (): void => {
    left.replaceChildren();
    const items: { key: ReviewMode; label: string }[] = [
      { key: 'default', label: '默认复习模式' },
      { key: 'card', label: '复习卡片' },
    ];
    for (const item of items) {
      const b = h('button', {
        class: `learn-nav-item${mode === item.key ? ' is-active' : ''}`,
        type: 'button',
        text: item.label,
      });
      b.dataset['mode'] = item.key;
      b.addEventListener('click', () => {
        mode = item.key;
        drawNav();
        void drawRight();
      });
      left.appendChild(b);
    }
  };

  /** 开始 / 确认选择 */
  const start = async (): Promise<void> => {
    if (mode === 'default') {
      if (words.length === 0) {
        toastWarn('词库里还没有可以复习的单词');
        return;
      }
      navigate('/review/paper?mode=all');
      return;
    }
    if (pickedId === '') {
      toastWarn('请先选择一张卡片');
      return;
    }
    navigate(`/review/paper?paper=${pickedId}`);
  };

  /** 默认复习模式：按用户的排序规则排一遍，给一份前 12 个的预览 */
  const drawDefault = (settings: Settings): HTMLElement => {
    const box = h('div', { class: 'stack' });
    const queue = buildReviewQueue(words, settings);
    box.appendChild(
      h('p', {
        class: 'note',
        text: `按「复习优先度 → 背诵优先级 → 首字母」排序，共 ${queue.length} 个单词。`,
      }),
    );
    if (queue.length === 0) return box;
    const listBox = h('div', { class: 'learn-archive-list review-preview' });
    for (const entry of queue.slice(0, 12)) {
      const row = h('div', { class: 'learn-archive-row' });
      row.appendChild(h('span', { class: 'field-label', text: entry.word.en }));
      row.appendChild(h('span', { class: 'field-hint', text: `复习优先度 ${Math.round(entry.reviewPriority * 100) / 100}` }));
      row.appendChild(h('span', { class: 'field-hint', text: `背诵 P${entry.word.priority}` }));
      listBox.appendChild(row);
    }
    box.appendChild(listBox);
    if (queue.length > 12) {
      box.appendChild(h('p', { class: 'note', text: `……后面还有 ${queue.length - 12} 个，进白纸后逐个复习。` }));
    }
    return box;
  };

  /** 复习卡片：卡片列表（搜索 / 筛选 / 排序 / 选中） */
  const drawCard = (): HTMLElement => {
    const box = h('div', { class: 'stack' });

    // 工具栏：搜索 + 状态 + 排序 + 升降序
    const bar = h('div', { class: 'review-card-filters' });
    bar.appendChild(
      h(
        'div',
        { class: 'ct-search' },
        textInput(cardState.keyword, debounce((v: string) => {
          cardState.keyword = v.trim();
          redrawCards();
        }, 300), { placeholder: '搜索卡片名称或卡片里的单词' }),
      ),
    );
    bar.appendChild(
      select(
        [
          { value: 'all', label: '全部卡片' },
          { value: 'draft', label: '进行中' },
          { value: 'finished', label: '已背完' },
        ],
        cardState.status,
        (v) => {
          cardState.status = v as CardListState['status'];
          redrawCards();
        },
      ),
    );
    // ★ 0.1.1：词数下限（跳过刚建的空纸）
    bar.appendChild(
      select(
        [
          { value: '0', label: '不限词数' },
          { value: '1', label: '至少 1 词' },
          { value: '3', label: '至少 3 词' },
          { value: '10', label: '至少 10 词' },
        ],
        String(cardState.minWords),
        (v) => {
          cardState.minWords = Number(v);
          redrawCards();
        },
      ),
    );
    bar.appendChild(
      select(
        [
          { value: 'updatedAt', label: '最近改动' },
          { value: 'createdAt', label: '创建时间' },
          { value: 'name', label: '名称' },
          { value: 'words', label: '词数' },
        ],
        cardState.sort,
        (v) => {
          cardState.sort = v as CardListState['sort'];
          redrawCards();
        },
      ),
    );
    bar.appendChild(
      select(
        [
          { value: 'desc', label: '降序' },
          { value: 'asc', label: '升序' },
        ],
        cardState.order,
        (v) => {
          cardState.order = v as 'asc' | 'desc';
          redrawCards();
        },
      ),
    );
    // 重置筛选 + 结果计数（★ 0.1.1）
    const countEl = h('span', { class: 'review-card-count', text: '' });
    countEl.dataset['role'] = 'review-card-count';
    const resetBtn = button('重置筛选', () => {
      cardState = defaultCardState();
      void drawRight();
    }, { variant: 'ghost', class: 'mini' });
    bar.appendChild(countEl);
    bar.appendChild(resetBtn);
    box.appendChild(bar);

    const listBox = h('div', { class: 'learn-archive-list review-card-list' });
    listBox.dataset['role'] = 'review-card-list';
    box.appendChild(listBox);
    box.appendChild(h('p', { class: 'note', role: 'hint', text: '选中一张卡片后，点右下角「确认选择」开始复习。' }));

    /** 重画卡片列表（只重画列表，不动工具栏） */
    function redrawCards(): void {
      const keyword = cardState.keyword.toLowerCase();
      /** 词 id → 英文（搜索时连卡片里的单词一起匹配） */
      const enById = new Map(words.map((w) => [w.id, w.en.toLowerCase()]));
      let rows = papers.filter((p) => {
        if (cardState.status !== 'all' && p.status !== cardState.status) return false;
        if (cardState.minWords > 0 && p.shownIds.length < cardState.minWords) return false;
        if (keyword !== '') {
          const inName = (p.name || '').toLowerCase().includes(keyword);
          const inWords = p.shownIds.some((id) => (enById.get(id) ?? '').includes(keyword));
          if (!inName && !inWords) return false;
        }
        return true;
      });
      const dir = cardState.order === 'asc' ? 1 : -1;
      rows = rows.slice().sort((a, b) => {
        if (cardState.sort === 'name') return (a.name || '').localeCompare(b.name || '') * dir;
        if (cardState.sort === 'words') return (a.shownIds.length - b.shownIds.length) * dir;
        if (cardState.sort === 'createdAt') return (a.createdAt - b.createdAt) * dir;
        return (a.updatedAt - b.updatedAt) * dir;
      });

      countEl.textContent = `${rows.length} 张`;
      listBox.replaceChildren();
      if (rows.length === 0) {
        listBox.appendChild(h('p', { class: 'note', text: '没有符合条件的卡片。' }));
        return;
      }
      for (const p of rows) {
        /**
         * ★ 0.0.28（用户）：「将复习卡片优化为精致的方块样式，选中时卡片变暗以表示选中状态。」
         * 所以每张卡片是一个 1:1 的方块：名称在上（最多两行）、状态与词数在下，
         * 右上角一颗选中角标；选中时整块背景变暗（CSS `.review-card-tile.is-selected`）。
         */
        const tile = h('button', {
          class: `review-card-tile${pickedId === p.id ? ' is-selected' : ''}`,
          type: 'button',
          dataset: { paperId: p.id },
          'aria-pressed': pickedId === p.id ? 'true' : 'false',
          title: pickedId === p.id ? '点击取消选中' : '点击选中这张卡片',
        });
        tile.appendChild(h('span', { class: 'review-tile-check', text: '✓' }));
        tile.appendChild(h('span', { class: 'review-tile-name', text: p.name || '（未命名）' }));
        tile.appendChild(h('span', { class: 'review-tile-meta', text: `${p.status === 'finished' ? '已背完' : '进行中'} · ${p.shownIds.length} 词` }));
        tile.addEventListener('click', () => {
          // 再点一次取消选中
          pickedId = pickedId === p.id ? '' : p.id;
          startBtn.textContent = '确认选择';
          startBtn.disabled = pickedId === '';
          redrawCards();
        });
        listBox.appendChild(tile);
      }
    }
    redrawCards();
    return box;
  };

  const drawRight = async (): Promise<void> => {
    right.replaceChildren();
    startBtn.textContent = mode === 'default' ? '开始复习' : '确认选择';
    startBtn.disabled = mode === 'card' && pickedId === '';
    if (mode === 'default') {
      right.appendChild(h('h2', { class: 'page-title', text: '默认复习模式' }));
      right.appendChild(drawDefault(currentSettings()));
    } else {
      right.appendChild(h('h2', { class: 'page-title', text: '复习卡片' }));
      right.appendChild(drawCard());
    }
  };

  drawNav();
  void (async () => {
    try {
      const [all, list] = await Promise.all([dao.words.listAlive(), dao.papers.list()]);
      words = reviewCandidates(all);
      papers = list.slice().sort((a, b) => b.updatedAt - a.updatedAt);
    } catch (err) {
      console.error('[review] 读取数据失败', err);
    }
    await drawRight();
  })();

  return page;
}
