import { getSettings } from '../../core/config';
import { adoptRawSource } from '../../core/model';
import { computePriority } from '../../core/priority';
import type { Attrs, Source, Word, WordQuery, WordStats, WordStatus } from '../../core/types';
import * as dao from '../../dao';
import { exportBackup, importBackup } from '../../services/backup';
import { button, debounce, h } from '../dom';
import { confirmModal, openModal, promptModal } from '../components/Modal';
import { renderPagination } from '../components/Pagination';
import { toastError, toastOk, toastWarn } from '../components/Toast';
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

  /** 加载数据并重画 */
  const load = async (): Promise<void> => {
    sources = await dao.sources.list();
    const query: WordQuery = {
      keyword: state.keyword || undefined,
      status: effectiveStatuses(state),
      sourceId: state.sourceId || undefined,
      needSpell: state.needSpellOnly ? true : undefined,
      minFailCount: state.minFailCount ?? undefined,
      minPriority: state.minPriority ?? undefined,
      sort: state.sort,
      order: state.order,
      page: state.page,
      pageSize: state.pageSize,
    };
    const [res, st] = await Promise.all([dao.words.query(query), dao.words.stats()]);
    items = res.items;
    total = res.total;
    stats = st;
    state.page = Math.min(state.page, Math.max(1, Math.ceil(total / state.pageSize)));
    // 清掉不在当前页上的选中项，避免误操作
    const pageIds = new Set(items.map((w) => w.id));
    for (const id of Array.from(selected)) if (!pageIds.has(id)) selected.delete(id);
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
    tableBox.replaceChildren(
      renderListTable(items, sources, selected, handlers, failCap),
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
          onChop: () => void batchStatus('chopped'),
          onRevive: () => void batchStatus(null),
          onSpell: (value) => void batchAttrs({ needSpell: value }),
          onUnlearned: () => void batchStatus('unlearned'),
          onDelete: () => void batchDelete(),
          onClear: () => {
            selected.clear();
            renderAll();
          },
        }),
      );
    }
  };

  // —— 各项操作 ——
  const handlers = {
    onToggleSelect: (id: string, checked: boolean): void => {
      if (checked) selected.add(id);
      else selected.delete(id);
      renderAll();
    },
    onToggleSelectAll: (checked: boolean): void => {
      selected.clear();
      if (checked) for (const w of items) selected.add(w.id);
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
      void dao.words.chop(word.id).then(() => {
        toastOk(`已斩：${word.en}`);
        return load();
      });
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
  };

  /** 批量改状态 */
  const batchStatus = async (status: WordStatus | null): Promise<void> => {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    await dao.words.setStatusMany(ids, status);
    toastOk(`已处理 ${ids.length} 个词`);
    selected.clear();
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

  void load();
  return page;
}
