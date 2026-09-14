import { getSettings } from '../../core/config';
import { adoptRawSource } from '../../core/model';
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
 * 单词列表页：统计条 + 筛选 + 表格 + 批量操作 + 导出导入 + 重算优先度。
 */
export function renderListPage(): HTMLElement {
  const page = h('div', { class: 'page list-page' });
  let state: ListFilterState = defaultFilterState();
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

  const filtersBox = h('div', {});
  const tableBox = h('div', { class: 'table-box' });
  const pagerBox = h('div', {});
  const batchBox = h('div', {});

  page.appendChild(head);
  page.appendChild(statsBox);
  page.appendChild(filtersBox);
  page.appendChild(tableBox);
  page.appendChild(pagerBox);
  page.appendChild(batchBox);

  /** 由当前筛选状态构造查询条件（翻页/改每页条数只动 page/pageSize） */
  const buildQuery = (): WordQuery => ({
    keyword: state.keyword || undefined,
    status: effectiveStatuses(state),
    sourceId: state.sourceId || undefined,
    needSpell: state.needSpellOnly ? true : undefined,
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

  /** 重画表格 / 分页 / 批量条 */
  const renderAll = (): void => {
    renderStats();

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

    // 桌面渲染表格、手机渲染卡片流；用 CSS 媒体查询二选一显示（见 global.css）
    // 第 5 个参数传「整个筛选结果」的全选态，让表头勾选框能显示部分选中（indeterminate）
    tableBox.replaceChildren(
      renderListTable(items, sources, selected, handlers, failCap, {
        selectedCount: selected.size,
        matchedCount: matchedIds.length,
      }),
      renderListCards(items, sources, handlers),
    );

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

    batchBox.replaceChildren();
    if (selected.size > 0) {
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
          onSelectAllMatched: () => selectAllMatched(),
          onClear: () => {
            selected.clear();
            renderAll();
          },
        }),
      );
    }
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
      renderAll();
    },
    // 表头勾选框 = 全选/取消**整个筛选结果**（跨页），不再只是当前页
    onToggleSelectAll: (checked: boolean): void => {
      if (checked) for (const id of matchedIds) selected.add(id);
      else selected.clear();
      renderAll();
    },
    onOpenDetail: (word: Word): void => {
      let draft = word;
      openModal({
        title: `单词详情 —— ${word.en}`,
        width: '640px',
        body: renderWordCard(word, {
          editable: true,
          showAttrs: true,
          onChange: (next) => {
            draft = next;
          },
        }),
        actions: [
          {
            text: '保存',
            variant: 'primary',
            onClick: (close) => {
              void (async () => {
                await dao.words.put(draft);
                toastOk('已保存');
                close();
                await load();
              })();
            },
          },
          { text: '取消', variant: 'ghost', onClick: (close) => close() },
        ],
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
      void dao.words.updateAttrs(word.id, { needSpell: value }).then(load);
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

  void load();
  return page;
}
