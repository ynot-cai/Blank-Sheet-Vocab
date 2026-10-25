import { getSettings } from '../../core/config';
import { adoptRawSource, withSpellFlag } from '../../core/model';
import { computePriority } from '../../core/priority';
import type { Attrs, Source, Word, WordQuery, WordStats, WordStatus } from '../../core/types';
import * as dao from '../../dao';
import { exportBackup, importBackup } from '../../services/backup';
import { button, debounce, h } from '../dom';
import { confirmModal, openModal, promptModal } from '../components/Modal';
import { renderPagination } from '../components/Pagination';
import { showUndoToast, toastError, toastOk, toastWarn } from '../components/Toast';
import { renderWordCard } from '../components/WordCard';
import { currentSettings } from './settings/ctx';
import { renderBatchBar } from './list/BatchBar';
import { renderCardToolbar } from './list/CardToolbar';
import { renderListCards } from './list/ListCards';
import type { ListFilterState } from './list/ListFilters';
import { defaultFilterState, effectiveStatuses, renderListFilters } from './list/ListFilters';
import { renderListTable } from './list/ListTable';
import { openRawSourcesModal } from './list/RawSourcesModal';

/** 顶部统计条上可点的数字 */
const STAT_ITEMS: { key: keyof WordStats; label: string; status: WordStatus | null }[] = [
  { key: 'total', label: '总词数', status: null },
  { key: 'unlearned', label: '未背', status: 'unlearned' },
  { key: 'learning', label: '学习中', status: 'learning' },
  { key: 'learned', label: '已背', status: 'learned' },
  { key: 'chopped', label: '已斩', status: 'chopped' },
];

/**
 * 单词列表页（版本 0.0.20）：统计条 + **视图切换（卡片 / 单词）** + 筛选 + 视图内容
 * + 批量操作 + 导出导入 + 重算优先度 + 白纸存档区。
 *
 * ★ 0.0.20 的改动（用户本轮要求）：
 *   1. 页面上方新增「卡片 / 单词」切换；两个视图共用同一套筛选/搜索/排序/批量编辑/收藏；
 *   2. 卡片视图补全功能（勾选、星标收藏、义项、属性、操作菜单），桌面多列网格、手机单列；
 *   3. 新增「收藏」：词上加 `favorite` 字段、筛选区加「只看收藏」、批量条加收藏/取消收藏。
 */

/** 视图类型 */
type ListView = 'card' | 'word';

/** 视图选择存本机（下次进来还是上次那个视图） */
const VIEW_KEY = 'blank-sheet-vocab.listView';

/**
 * 读上次选的视图（默认卡片：本轮把卡片视图做成主视图）。
 */
function readView(): ListView {
  try {
    return localStorage.getItem(VIEW_KEY) === 'word' ? 'word' : 'card';
  } catch {
    return 'card';
  }
}

/**
 * 记住视图选择（隐私模式下写不进去也不影响使用）。
 * @param v 视图
 */
function writeView(v: ListView): void {
  try {
    localStorage.setItem(VIEW_KEY, v);
  } catch {
    /* 忽略 */
  }
}

/**
 * 渲染单词列表页。
 */
export function renderListPage(): HTMLElement {
  const page = h('div', { class: 'page list-page' });
  let state: ListFilterState = defaultFilterState();
  /** 当前视图（卡片 / 单词） */
  let view: ListView = readView();
  let items: Word[] = [];
  let total = 0;
  /**
   * 当前筛选结果的**全部** id（跨页）。
   *
   * ★ 存在的理由：原来「全选」只选当前页那 ≤200 条，翻页还会把选中清空，
   *   于是批量操作的上限就是 200 条。现在全选作用于整个筛选结果，
   *   选中状态也不再随翻页丢失，批量编辑没有数量上限。
   */
  let matchedIds: string[] = [];
  let stats: WordStats = { total: 0, unlearned: 0, learning: 0, learned: 0, chopped: 0 };
  let sources: Source[] = [];
  /** ★ 0.0.22：被收藏的**卡片** id 集合（来自 cardFavorites 表） */
  let cardFavoriteIds = new Set<string>();
  const selected = new Set<string>();

  const failCap = getSettings().failCountCap;

  // —— 顶部：标题 + 统计条 + 右侧常驻按钮 ——
  const statsBox = h('div', { class: 'stats-bar' });
  const jsonPicker = h('input', { type: 'file', accept: '.json,application/json', class: 'hidden' });
  let importMode: 'merge' | 'replace' = 'merge';
  jsonPicker.addEventListener('change', () => {
    const file = jsonPicker.files?.[0];
    jsonPicker.value = '';
    if (!file) return;
    void (async () => {
      try {
        const res = await importBackup(file, importMode);
        toastOk(`导入完成：${res.words} 个词、${res.sources} 个来源`);
        await load();
      } catch (err) {
        toastError(err instanceof Error ? err.message : String(err));
      }
    })();
  });

  const head = h(
    'div',
    { class: 'list-head' },
    h('h2', { class: 'page-title', text: '单词列表' }),
    h(
      'div',
      { class: 'row' },
      button('导出备份', () => void exportBackup().then(() => toastOk('已导出 json')), { variant: 'ghost' }),
      button('导入备份', () => {
        importMode = 'merge';
        jsonPicker.click();
      }, { variant: 'ghost' }),
      button(
        '重算优先度',
        () => void recompute(),
        { variant: 'primary' },
      ),
      button(
        '清空全部单词',
        () => void clearAllWords(),
        { variant: 'danger', title: '把词库里的单词全部删掉，重新开始' },
      ),
      jsonPicker,
    ),
  );

  /**
   * 视图切换条（用户：在页面上方添加一个切换按钮，点击可在「卡片」与「单词」之间切换）。
   * 两个按钮是一组分段控件，当前视图亮起。
   */
  const viewBar = h('div', { class: 'list-viewbar' });
  const cardViewBtn = button('卡片', () => setView('card'), { variant: 'ghost', class: 'list-view-btn' });
  const wordViewBtn = button('单词', () => setView('word'), { variant: 'ghost', class: 'list-view-btn' });
  viewBar.appendChild(cardViewBtn);
  viewBar.appendChild(wordViewBtn);

  /** 按当前视图给两个按钮上「亮起」状态 */
  const paintViewSwitch = (): void => {
    for (const [btn, key] of [
      [cardViewBtn, 'card'],
      [wordViewBtn, 'word'],
    ] as [HTMLButtonElement, ListView][]) {
      const on = view === key;
      btn.classList.toggle('is-active', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  };

  /**
   * 切视图：记住选择并重画内容区（筛选条件与选中集合都不动）。
   *
   * ★ 0.0.22：收藏是**卡片**的属性，单词视图里没有收藏概念，
   * 所以切到单词视图时把「只看收藏」关掉（否则表格会莫名其妙只剩几张卡）。
   * @param next 目标视图
   */
  const setView = (next: ListView): void => {
    if (view === next) return;
    view = next;
    if (next === 'word' && state.favoriteOnly) {
      state = { ...state, favoriteOnly: false, page: 1 };
      void load();
    }
    writeView(next);
    paintViewSwitch();
    renderAll();
  };

  const filtersBox = h('div', {});
  const tableBox = h('div', { class: 'table-box' });
  const pagerBox = h('div', {});
  const batchBox = h('div', {});
  /**
   * ★ 版本 0.0.19（提示词 07 §2.3 末句 / 提示词 10 修 Bug）：
   *   「在单词列表中另开一块区域，可查看、重命名该存档。」
   *   这里就是那块区域：白纸存档列表（进行中 + 已背完），每行「查看 / 重命名」。
   */
  const papersBox = h('div', { class: 'list-papers' });

  page.appendChild(head);
  page.appendChild(viewBar);
  page.appendChild(statsBox);
  page.appendChild(filtersBox);
  page.appendChild(tableBox);
  page.appendChild(pagerBox);
  page.appendChild(batchBox);
  page.appendChild(papersBox);
  paintViewSwitch();

  /** 由当前筛选状态构造查询条件（翻页/改每页条数只动 page/pageSize） */
  const buildQuery = (): WordQuery => ({
    keyword: state.keyword || undefined,
    status: effectiveStatuses(state),
    sourceId: state.sourceId || undefined,
    needSpell: state.needSpellOnly ? true : undefined,
    /**
     * ★ 0.0.22：只看收藏 —— 收藏对象是**卡片**（`cardFavorites` 表），不是词的字段，
     * 所以这里传「被收藏的卡片 id 白名单」，分页/全选仍然按筛选后的口径算。
     * 收藏筛选只属于卡片视图：单词视图里没有收藏概念（切过去时会把这一项清掉）。
     */
    ids: state.favoriteOnly && view === 'card' ? Array.from(cardFavoriteIds) : undefined,
    minFailCount: state.minFailCount ?? undefined,
    minPriority: state.minPriority ?? undefined,
    // ★ R3：词级优先级精确筛选
    priority: state.wordPriority ?? undefined,
    sort: state.sort,
    order: state.order,
    page: state.page,
    pageSize: state.pageSize,
  });

  /** 加载数据并重画 */
  const load = async (): Promise<void> => {
    sources = await dao.sources.list();
    // ★ 0.0.22：卡片收藏（读一次整表，收藏量很小）
    cardFavoriteIds = await dao.cardFavorites.ids();
    const query = buildQuery();
    const [res, st, matched, alive] = await Promise.all([
      dao.words.query(query),
      dao.words.stats(),
      dao.words.queryIds(query),
      // 不筛选、不分页的一遍，只为拿到「库里还有哪些词」
      dao.words.queryIds({ page: 1, pageSize: 1 }),
    ]);
    items = res.items;
    total = res.total;
    matchedIds = matched.ids;
    stats = st;
    state.page = Math.min(state.page, Math.max(1, Math.ceil(total / state.pageSize)));

    // ★ 这里刻意**不再**清理「不在当前页上的选中项」。
    //   以前会清，是为了防止用户翻页后误操作看不见的词；
    //   但那样一来跨页全选就没意义了（翻一页选中就没了）。
    //   现在的取舍：保留跨页选中，由批量条的「已选 N 个」把数量说清楚。
    //
    // 注意只摘掉**库里已经不存在**的 id（词被删了），
    // 不能用「当前筛选结果」去摘——那样换个筛选条件就会把之前选的悄悄清掉。
    const aliveIds = new Set(alive.ids);
    for (const id of Array.from(selected)) if (!aliveIds.has(id)) selected.delete(id);

    renderAll();
  };

  /** 重画统计条 */
  const renderStats = (): void => {
    statsBox.replaceChildren();
    for (const item of STAT_ITEMS) {
      const active =
        item.status === null ? state.statuses.length === 0 && state.includeChopped : state.statuses.includes(item.status);
      const el = h('button', {
        class: `stat-btn${active ? ' active' : ''}`,
        type: 'button',
        title: item.status === null ? '不过滤状态（全部，含已斩）' : `只看「${item.label}」`,
      });
      el.appendChild(h('span', { class: 'stat-num', text: String(stats[item.key]) }));
      el.appendChild(h('span', { class: 'stat-label', text: item.label }));
      el.addEventListener('click', () => {
        void (async () => {
          state.statuses = item.status === null ? [] : [item.status];
          // 点「总词数」= 看全部（含已斩）；点其他状态 = 只看该状态
          state.includeChopped = item.status === null;
          state.page = 1;
          await load();
        })();
      });
      statsBox.appendChild(el);
    }
  };

  /** 重画筛选区 / 视图内容 / 分页 / 批量条 */
  const renderAll = (): void => {
    renderStats();

    /**
     * ★ 0.0.22：两个视图各有**自己的**筛选区——
     * 卡片视图用新工具栏（搜索 / 筛选 / 排序 / 批量编辑 / 只看收藏），
     * 单词视图仍用原来那一排筛选项（没有收藏，因为收藏对象是卡片）。
     */
    if (view === 'card') {
      filtersBox.replaceChildren(
        renderCardToolbar({
          state,
          sources,
          selectedCount: selected.size,
          matchedCount: total,
          onKeyword: debounce((v: string) => {
            state.keyword = v.trim();
            state.page = 1;
            void load();
          }, 300),
          onChange: (patch) => {
            state = { ...state, ...patch, page: 1 };
            void load();
          },
          onReset: () => {
            state = { ...defaultFilterState(), pageSize: state.pageSize };
            selected.clear();
            void load();
          },
          onSelectPage: () => {
            for (const item of items) selected.add(item.id);
            updateSelectionUi();
          },
          onClearSelect: () => {
            selected.clear();
            updateSelectionUi();
          },
        }),
      );
    } else {
      filtersBox.replaceChildren(
        renderListFilters({
          state,
          sources,
          onKeyword: debounce((v: string) => {
            state.keyword = v.trim();
            state.page = 1;
            void load();
          }, 300),
          onChange: (patch) => {
            state = { ...state, ...patch, page: 1 };
            void load();
          },
          onReset: () => {
            state = { ...defaultFilterState(), pageSize: state.pageSize };
            selected.clear();
            void load();
          },
        }),
      );
    }

    // ★ 0.0.20：按当前视图二选一渲染（不再靠 CSS 媒体查询按屏宽切换）。
    //   「单词」视图 = 原来的表格；「卡片」视图 = 卡片网格。
    //   表格那一路第 6 个参数传「整个筛选结果」的全选态，让表头勾选框能显示部分选中（indeterminate）。
    if (view === 'card') {
      tableBox.replaceChildren(renderListCards({ items, sources, selected, favorites: cardFavoriteIds, handlers }));
    } else {
      tableBox.replaceChildren(
        renderListTable(items, sources, selected, handlers, failCap, {
          selectedCount: selected.size,
          matchedCount: matchedIds.length,
        }),
      );
    }

    pagerBox.replaceChildren(
      renderPagination({
        page: state.page,
        pageSize: state.pageSize,
        total,
        onChange: (p) => {
          state.page = p;
          void load();
        },
        onPageSizeChange: (size) => {
          state.pageSize = size;
          state.page = 1;
          void load();
        },
      }),
    );

    renderBatch();
  };

  /**
   * 只重画底部的批量操作条（0.0.20 从 renderAll 里抽出来的）。
   *
   * 为什么要抽：勾选一个词不该把整页（含所有卡片/表格行）重画——
   *   实测（v020 验收）整页重画会让「连点两个勾选框」失效：第一次点击后 DOM 被换掉，
   *   测试拿到的是已脱离文档的旧节点，第二次点击就丢了。对用户来说也是闪烁。
   * 所以勾选走 {@link updateSelectionUi}：只改那一个节点的 class + 重画批量条。
   */
  const renderBatch = (): void => {
    batchBox.replaceChildren();
    if (selected.size === 0) return;
    batchBox.appendChild(
      renderBatchBar({
        count: selected.size,
        matchedCount: matchedIds.length,
        onChop: () => void batchStatus('chopped'),
        onRevive: () => void batchStatus(null),
        onSpell: (value) => void batchAttrs({ needSpell: value }),
        onUnlearned: () => void batchStatus('unlearned'),
        onDelete: () => void batchDelete(),
        // ★ R3：批量设优先级
        onSetPriority: (priority) => void batchSetPriority(priority),
        // ★ 0.0.22：批量收藏**卡片**（只有卡片视图给这条回调，单词视图不显示收藏按钮）
        onFavorite: view === 'card' ? (value) => void batchCardFavorite(value) : undefined,
        onSelectAllMatched: () => selectAllMatched(),
        onClear: () => {
          selected.clear();
          updateSelectionUi();
        },
      }),
    );
  };

  /**
   * 把「选中态」同步到现有 DOM（卡片 / 表格行），并重画批量条。
   *
   * 依赖两个视图都给节点打了 `data-word-id`（见 ListCards/ListTable）。
   */
  const updateSelectionUi = (): void => {
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('[data-word-id]'))) {
      const on = selected.has(el.dataset.wordId ?? '');
      el.classList.toggle('is-selected', on);
      el.classList.toggle('row-selected', on);
    }
    // ★ 0.0.22：卡片工具栏上的「已选 N 张」也要跟着变（否则勾了卡还是显示 0）
    const countEl = filtersBox.querySelector('.ct-count');
    if (countEl !== null) countEl.textContent = `共 ${total} 张卡片 · 已选 ${selected.size} 张`;
    renderBatch();
  };

  /**
   * 把当前筛选结果的**全部**词选上（跨页，不设数量上限）。
   * 几千个词也会逐个加进 Set，但不会去建 DOM，所以不会卡。
   */
  const selectAllMatched = (): void => {
    for (const id of matchedIds) selected.add(id);
    renderAll();
    toastOk(`已选中当前筛选结果的全部 ${matchedIds.length} 个词`);
  };

  // —— 各项操作 ——
  const handlers = {
    onToggleSelect: (id: string, checked: boolean): void => {
      if (checked) selected.add(id);
      else selected.delete(id);
      // 只同步这一个节点的选中态 + 批量条（不整页重画，见 updateSelectionUi 的说明）
      updateSelectionUi();
    },
    // 表头勾选框 = 全选/取消**整个筛选结果**（跨页），不再只是当前页
    onToggleSelectAll: (checked: boolean): void => {
      if (checked) for (const id of matchedIds) selected.add(id);
      else selected.clear();
      renderAll();
    },
    onOpenDetail: (word: Word): void => {
      /**
       * ★ 0.0.20：单词卡自带「编辑 ↔ 保存」两态，所以这里不再需要弹窗底部的「保存/取消」——
       *   卡里的「保存」直接落库并重画列表（用户要求：点击编辑后卡改变形态，原「编辑」被「保存」取代）。
       */
      openModal({
        title: `单词卡 —— ${word.en}`,
        width: '640px',
        body: renderWordCard(word, {
          editable: true,
          showAttrs: true,
          onChange: (next) => {
            void (async () => {
              await dao.words.put(next);
              toastOk('已保存');
              await load();
            })();
          },
          // ★ 0.0.21：拼写 / 仅拼写 在这里也能标记（与白纸页同一套数据）
          onSpell: (value) => {
            void (async () => {
              await dao.words.put(withSpellFlag(word, value));
              toastOk(value ? `已标记「${word.en}」要拼写` : `已取消「${word.en}」的拼写标记`);
              await load();
            })();
          },
          onSpellOnly: (value) => {
            void (async () => {
              await dao.words.setSpellOnly(word.id, value);
              toastOk(value ? `已把「${word.en}」标记为仅拼写` : `已取消「${word.en}」的仅拼写标记`);
              await load();
            })();
          },
          // 卡上的「斩」与表格行内「斩」同一套行为（无确认 + 8 秒撤销）
          onChop: () => handlers.onChop(word),
        }),
        actions: [{ text: '关闭', variant: 'ghost', onClick: (close) => close() }],
      });
    },
    onEditNumber: (word: Word, field: 'failCount' | 'reviewCount'): void => {
      void (async () => {
        const current = field === 'failCount' ? word.attrs.failCount : word.attrs.reviewCount;
        const input = await promptModal(
          field === 'failCount' ? '修改未通过次数' : '修改复习次数',
          `输入新的数字（当前 ${current}）`,
          String(current),
        );
        if (input === null) return;
        const value = Number(input);
        if (!Number.isFinite(value) || value < 0) {
          toastError('请输入一个不小于 0 的数字');
          return;
        }
        const patch: Partial<Attrs> = field === 'failCount' ? { failCount: Math.floor(value) } : { reviewCount: Math.floor(value) };
        await dao.words.updateAttrs(word.id, patch);
        await load();
      })();
    },
    onNeedSpell: (word: Word, value: boolean): void => {
      void dao.words.setNeedSpell(word.id, value).then(load);
    },
    onStatus: (word: Word, status: WordStatus): void => {
      void dao.words.setStatus(word.id, status).then(load);
    },
    onChop: (word: Word): void => {
      void (async () => {
        // RULES-R3: 斩不弹确认，但必须提供 ≥8 秒的撤销 Toast
        const prevStatus = word.status;
        await dao.words.chop(word.id);
        showUndoToast(`已斩 ${word.en}`, async () => {
          await dao.words.setStatus(word.id, prevStatus);
          await load();
        });
        await load();
      })();
    },
    onRevive: (word: Word): void => {
      void dao.words.revive(word.id).then(() => {
        toastOk(`已复活：${word.en}`);
        return load();
      });
    },
    onDelete: (word: Word): void => {
      void (async () => {
        const ok = await confirmModal('删除单词', `确定删除「${word.en}」吗？此操作不可撤销。`, '删除', true);
        if (!ok) return;
        await dao.words.remove(word.id);
        toastOk('已删除');
        await load();
      })();
    },
    onRawSources: (word: Word): void => {
      openRawSourcesModal(word, sources, (sourceId) => {
        void (async () => {
          const next = adoptRawSource(word, sourceId);
          await dao.words.put(next);
          toastOk('已采纳为主义项');
          await load();
        })();
      });
    },
    onAdoptRaw: (word: Word): void => {
      handlers.onRawSources(word);
    },
    /** ★ R3：行内改词级优先级，改完立即生效并同步 */
    onPriority: (word: Word, priority: number): void => {
      void (async () => {
        await dao.words.setWordPriority(word.id, priority);
        toastOk(`「${word.en}」的词优先级已改为 P${Math.min(5, Math.max(1, Math.round(priority)))}`);
        await load();
      })();
    },
    /**
     * ★ 0.0.22：切换**卡片**收藏（收藏对象从「单词」改为「卡片」）。
     * 数据写在 `cardFavorites` 表里，改完重读一遍再重画（星标状态立刻变）。
     */
    onCardFavorite: (word: Word, value: boolean): void => {
      void (async () => {
        await dao.cardFavorites.set(word.id, value);
        cardFavoriteIds = await dao.cardFavorites.ids();
        toastOk(value ? `已收藏「${word.en}」这张卡片` : `已取消收藏「${word.en}」这张卡片`);
        renderAll();
      })();
    },
  };

  /** 批量改状态 */
  const batchStatus = async (status: WordStatus | null): Promise<void> => {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    // RULES-R3: 批量斩也是斩，同样要能撤销——先把每个词的原状态快照下来。
    // 不能事后用「一律设成 unlearned」代替：那会把用户的复习进度抹平。
    const snapshot =
      status === 'chopped'
        ? (await dao.words.getAll())
            .filter((w) => selected.has(w.id))
            .map((w) => ({ id: w.id, status: w.status }))
        : null;
    await dao.words.setStatusMany(ids, status);
    selected.clear();
    if (snapshot !== null) {
      showUndoToast(`已斩 ${ids.length} 个词`, async () => {
        await dao.words.restoreStatuses(snapshot);
        await load();
      });
    } else {
      toastOk(`已处理 ${ids.length} 个词`);
    }
    await load();
  };

  /** 批量改属性 */
  const batchAttrs = async (patch: Partial<Attrs>): Promise<void> => {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    await dao.words.updateAttrsMany(ids, patch);
    toastOk(`已处理 ${ids.length} 个词`);
    selected.clear();
    await load();
  };

  /**
   * ★ R3：批量设词级优先级。
   * 说明用的是 `setWordPriorityMany`（改 `word.priority`），
   * 而不是 `updateAttrsMany`（改 attrs）——词级优先级不属于属性组，
   * 放错层级的话列表页改了、背诵抽词读的还是老值。
   * @param priority 目标优先级
   */
  const batchSetPriority = async (priority: number): Promise<void> => {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    await dao.words.setWordPriorityMany(ids, priority);
    toastOk(`已把 ${ids.length} 个词设为 P${priority}`);
    selected.clear();
    await load();
  };

  /** 批量删除 */
  const batchDelete = async (): Promise<void> => {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    const ok = await confirmModal('批量删除', `确定删除选中的 ${ids.length} 个词吗？此操作不可撤销。`, '删除', true);
    if (!ok) return;
    await dao.words.removeMany(ids);
    toastOk(`已删除 ${ids.length} 个词`);
    selected.clear();
    await load();
  };

  /**
   * ★ 0.0.22：批量收藏 / 取消收藏**卡片**（卡片视图的批量编辑条用）。
   * @param value 收藏还是取消
   */
  const batchCardFavorite = async (value: boolean): Promise<void> => {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    await dao.cardFavorites.setMany(ids, value);
    toastOk(`已${value ? '收藏' : '取消收藏'} ${ids.length} 张卡片`);
    selected.clear();
    await load();
  };

  /** 重算全部优先度 */
  const recompute = async (): Promise<void> => {
    const all = await dao.words.getAll();
    if (all.length === 0) {
      toastWarn('词库是空的，先去录入几个词');
      return;
    }
    const settings = currentSettings();
    const entries = all.map((w) => ({ id: w.id, priority: computePriority(w, settings) }));
    await dao.words.applyPriorities(entries);
    toastOk(`已重算 ${entries.length} 个词的优先度`);
    await load();
  };

  /**
   * 清空全部单词（把词库恢复成空白，相当于「初始化」）。
   *
   * 两个刻意的设计：
   *   1. 要求手动输入「删除」才真的执行——这是不可撤销的操作，
   *      和设置页那个「清空所有数据」用同一套确认方式，保持一致；
   *   2. **来源（词库）保留不动**。预设导入后来源带着优先级，
   *      那是用户特意设的（预设确认框里能改），清词时一起清掉等于白设一遍。
   *      来源不占多少地方，留着下次导入就直接复用。
   */
  const clearAllWords = async (): Promise<void> => {
    const all = await dao.words.getAll();
    if (all.length === 0) {
      toastWarn('词库本来就是空的');
      return;
    }
    const typed = await promptModal(
      '清空全部单词',
      `这会删掉词库里的全部 ${all.length} 个单词（含学习记录、义项编辑），不可撤销。` +
        '来源（词库）会保留，方便你重新导入。建议先「导出备份」。\n\n请输入「删除」两个字以确认：',
    );
    if (typed === null) return;
    if (typed.trim() !== '删除') {
      toastWarn('输入不正确，已取消');
      return;
    }
    await dao.words.clearAll();
    selected.clear();
    toastOk(`已清空 ${all.length} 个单词`);
    await load();
  };

  /**
   * 白纸存档区：查看 / 重命名（用户提示词 07 §2.3、提示词 10「修 Bug」）。
   *
   * 数据来自 `dao.papers`（`list()` 已按 `updatedAt` 降序）。
   * 「查看」＝ 弹窗列出这张纸上的单词（按存档里的已出现顺序），
   * 「重命名」＝ 输入框改名后落库（`papers.rename`）。
   */
  const renderPapers = async (): Promise<void> => {
    papersBox.replaceChildren();
    let papers: Awaited<ReturnType<typeof dao.papers.list>> = [];
    try {
      papers = await dao.papers.list();
    } catch (err) {
      console.error('[list] 读取白纸存档失败', err);
    }
    const card = h('div', { class: 'card list-papers-card' });
    const cardHead = h('div', { class: 'list-papers-head' });
    cardHead.appendChild(h('h3', { class: 'card-title', text: '白纸存档' }));
    cardHead.appendChild(h('span', { class: 'field-hint', text: `共 ${papers.length} 张` }));
    card.appendChild(cardHead);

    if (papers.length === 0) {
      card.appendChild(h('p', { class: 'note', text: '还没有白纸存档。背诵时点「保存并退出」或「背完了」就会在这里留一张。' }));
      papersBox.appendChild(card);
      return;
    }

    const list = h('div', { class: 'papers-list' });
    for (const p of papers) {
      /**
       * ★ 0.0.27（用户）：「白纸存档的排版调整：单词数放到最后显示，
       *   且与名称之间保留间隙。」行内顺序 = 名称 → 状态 → 查看 → 重命名 → 词数（最后一格）。
       */
      const row = h('div', { class: 'papers-row' });
      row.appendChild(h('span', { class: 'papers-name', text: p.name === '' ? '（未命名）' : p.name }));
      row.appendChild(h('span', { class: 'papers-status', text: p.status === 'finished' ? '已背完' : '进行中' }));
      row.appendChild(
        button(
          '查看',
          () => {
            void openPaperDetail(p);
          },
          { variant: 'ghost' },
        ),
      );
      row.appendChild(
        button(
          '重命名',
          () => {
            void (async () => {
              const next = await promptModal('重命名白纸存档', '输入新的名字；留空则记为「（未命名）」。', p.name);
              if (next === null) return;
              await dao.papers.rename(p.id, next.trim());
              toastOk('已重命名');
              await renderPapers();
            })();
          },
          { variant: 'ghost' },
        ),
      );
      // 单词数放最后（用户：单词数放到最后显示，且与名称之间保留间隙）
      row.appendChild(h('span', { class: 'papers-count', text: `${p.shownIds.length} 词` }));
      list.appendChild(row);
    }
    card.appendChild(list);
    papersBox.appendChild(card);
  };

  /**
   * 「查看」一张白纸存档：把存档里的「已出现单词」按顺序列出来。
   *
   * 说明：这里**只读**，不改存档；改名在列表行上。
   * @param paper 存档
   */
  const openPaperDetail = async (paper: import('../../core/types').PaperArchive): Promise<void> => {
    const all = await dao.words.getAll();
    const byId = new Map(all.map((w) => [w.id, w]));
    const body = h('div', { class: 'stack paper-detail' });
    body.appendChild(
      h('p', { class: 'field-hint' }, `状态：${paper.status === 'finished' ? '已背完（永久存档）' : '进行中'}　词数：${paper.shownIds.length}`),
    );
    body.appendChild(
      h('p', { class: 'field-hint' }, `创建：${new Date(paper.createdAt).toLocaleString()}　最后改动：${new Date(paper.updatedAt).toLocaleString()}`),
    );
    if (paper.shownIds.length === 0) {
      body.appendChild(h('p', { class: 'note', text: '这张纸上还没有出现过单词。' }));
    } else {
      const list = h('div', { class: 'papers-detail-list' });
      for (const id of paper.shownIds) {
        const w = byId.get(id);
        if (!w) continue;
        const line = h('div', { class: 'papers-detail-row' });
        line.appendChild(h('span', { class: 'field-label', text: w.en }));
        line.appendChild(h('span', { class: 'field-hint', text: w.senses.map((s) => s.text).join(' / ') }));
        list.appendChild(line);
      }
      body.appendChild(list);
    }
    openModal({
      title: `白纸存档 —— ${paper.name === '' ? '（未命名）' : paper.name}`,
      width: '640px',
      body,
      actions: [{ text: '关闭', variant: 'ghost', onClick: (close) => close() }],
    });
  };

  void load();
  void renderPapers();
  return page;
}
