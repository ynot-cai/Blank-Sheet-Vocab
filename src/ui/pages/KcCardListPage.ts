/**
 * 卡片列表页（`#/kc/list`）—— 阶段 03 的主界面。
 *
 * 结构：统计条（可点筛选）→ 筛选区 → 列表（桌面表格 / 手机卡片流）→ 分页 → 批量操作栏。
 * 渲染细节在 `kcList/KcListParts`（行与卡片）与 `kcList/KcListFilters`（筛选与批量），
 * 这一页只管**状态 + 数据流**：查询 → `dao.kc.query()` → 重画。
 *
 * 两个实现要点：
 * 1. **搜索防抖**：每敲一个字就查一次库没必要（虽然卡量不大），防抖 250ms；
 * 2. **列表项点开进详情**（`#/kc/view?id=`），「编辑」才进编辑页（`#/kc/edit?id=`）——
 *    与提示词里「点整张卡片 → 进入详情（只读渲染）」一致。
 */
import { KC } from '../../core/config';
import type { KcQuery, KnowledgeCard } from '../../core/kcTypes';
import * as dao from '../../dao';
import { openModal } from '../components/Modal';
import { showUndoToast, toastOk } from '../components/Toast';
import { button, debounce, h, select } from '../dom';
import { navigate, registerCleanup } from '../router';
import { renderKcFilters, renderKcStatsBar, type KcListQuery } from './kcList/KcListFilters';
import { renderKcBatchActions } from './kcList/KcListBatch';
import { renderKcListCard, renderKcRow, type KcRowHandlers } from './kcList/KcListParts';

/**
 * 渲染卡片列表页。
 */
export function renderKcCardListPage(): HTMLElement {
  const page = h('div', { class: 'page kc-list-page' });
  const statsBox = h('div', {});
  const filterBox = h('div', {});
  const listBox = h('div', { class: 'kc-list-host' });
  const pagerBox = h('div', { class: 'kc-pager' });
  const batchBox = h('div', { class: 'kc-batch-host' });

  /** 当前查询 */
  let q: KcListQuery = {
    keyword: '',
    status: [],
    examTag: '',
    sort: 'reviewPriority',
    order: 'desc',
    page: 1,
    pageSize: KC.defaultPageSize,
  };
  /** 已选中的卡片 id */
  const selected = new Set<string>();
  /** 是否窄屏（决定表格还是卡片流） */
  let narrow = window.matchMedia('(max-width: 767px)').matches;

  /** 重新查库并重画 */
  const refresh = async (): Promise<void> => {
    // 列表页要看到「已斩」，所以墓碑必须能被查出来（query 默认不含墓碑）
    const query: KcQuery = {
      ...q,
      // 用户没选状态时，仍然把已斩排除在默认视图外 —— 这是「斩了就不该出现」的语义；
      // 想看已斩就点统计条上的「已斩」（那时 status 里就有 chopped 了）
      status: q.status.length > 0 ? q.status : undefined,
    };
    const [res, stats] = await Promise.all([dao.kc.query(query), dao.kc.stats(true)]);
    // 选中的卡片如果已经不在当前结果里，就取消勾选（避免「批量操作到看不见的卡」）
    const visible = new Set(res.items.map((c) => c.id));
    for (const id of [...selected]) if (!visible.has(id)) selected.delete(id);

    statsBox.replaceChildren(
      renderKcStatsBar(stats, q.status.length > 0 ? q.status : null, {
        onChange: () => undefined,
        onPickStatus: (status) => {
          q = { ...q, status: status ?? [], page: 1 };
          void refresh();
        },
      }),
    );

    filterBox.replaceChildren(
      renderKcFilters(q, {
        onChange: (patch) => {
          q = { ...q, ...patch };
          // 输入类改动（keyword）防抖，点选类立即生效
          if (patch.keyword !== undefined) debouncedRefresh();
          else void refresh();
        },
        onPickStatus: (status) => {
          q = { ...q, status: status ?? [], page: 1 };
          void refresh();
        },
      }),
    );

    renderList(res.items);
    renderPager(res.total);
    renderBatch();
  };

  const debouncedRefresh = debounce(() => void refresh(), 250);

  /**
   * 渲染列表本体（桌面表格 / 手机卡片流）。
   * @param items 当前页的卡片
   */
  function renderList(items: KnowledgeCard[]): void {
    listBox.replaceChildren();
    if (items.length === 0) {
      listBox.appendChild(renderEmpty());
      return;
    }
    const handlers: KcRowHandlers = {
      onToggleSelect: (id) => {
        if (selected.has(id)) selected.delete(id);
        else selected.add(id);
        renderList(items);
        renderBatch();
      },
      onOpen: (id) => navigate(`/kc/view?id=${encodeURIComponent(id)}`),
      onEdit: (id) => navigate(`/kc/edit?id=${encodeURIComponent(id)}`),
      onChop: (card) => {
        void (async () => {
          // RULES-R3: 斩不弹确认，但必须提供 ≥8 秒的撤销 Toast
          const prev = { deleted: card.deleted ?? 0, status: card.status } as const;
          await dao.kc.chop(card.id);
          showUndoToast(`已斩 ${card.title}`, async () => {
            await dao.kc.restoreChopState(card.id, { deleted: prev.deleted, status: prev.status });
            await refresh();
          });
          await refresh();
        })();
      },
      onRevive: (card) => {
        void (async () => {
          await dao.kc.revive(card.id);
          toastOk('已复活');
          await refresh();
        })();
      },
      onRemove: (card) => {
        openModal({
          title: `永久删除「${card.title}」？`,
          body: h('p', { class: 'modal-text', text: '永久删除不可恢复。只想让它不再出现的话，请用「斩」。' }),
          actions: [
            { text: '取消', variant: 'ghost', onClick: (close) => close() },
            {
              text: '永久删除',
              variant: 'danger',
              onClick: (close) => {
                void (async () => {
                  await dao.kc.removePermanently(card.id);
                  toastOk('已永久删除');
                  close();
                  await refresh();
                })();
              },
            },
          ],
        });
      },
    };

    if (narrow) {
      const flow = h('div', { class: 'kc-cardflow' });
      for (const card of items) flow.appendChild(renderKcListCard(card, selected.has(card.id), handlers));
      listBox.appendChild(flow);
      return;
    }

    const wrap = h('div', { class: 'kc-table-wrap' });
    const table = h('table', { class: 'kc-table kc-list-table' });
    const thead = h('thead', {});
    const headRow = h('tr', {});
    // 表头全选：只影响「当前页」（跨页全选交给筛选结果，不在这里做，避免误解）
    const allCheck = h('input', { type: 'checkbox', title: '全选当前页' });
    allCheck.checked = items.length > 0 && items.every((c) => selected.has(c.id));
    allCheck.addEventListener('change', () => {
      for (const card of items) {
        if (allCheck.checked) selected.add(card.id);
        else selected.delete(card.id);
      }
      renderList(items);
      renderBatch();
    });
    const checkCell = h('th', { class: 'kc-cell-check' }, allCheck);
    headRow.appendChild(checkCell);
    headRow.appendChild(h('th', { text: '知识点' }));
    headRow.appendChild(h('th', { class: 'kc-cell-mastery', text: '掌握度' }));
    headRow.appendChild(h('th', { class: 'kc-cell-actions', text: '操作' }));
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = h('tbody', {});
    for (const card of items) tbody.appendChild(renderKcRow(card, selected.has(card.id), handlers));
    table.appendChild(tbody);
    wrap.appendChild(table);
    listBox.appendChild(wrap);
  }

  /** 空状态（区分「一张卡都没有」和「筛没了」） */
  function renderEmpty(): HTMLElement {
    const box = h('div', { class: 'kc-empty' });
    if (q.keyword !== '' || q.status.length > 0 || q.examTag !== '') {
      box.appendChild(h('p', { class: 'kc-empty-title', text: '没有符合条件的卡片' }));
      box.appendChild(
        button('清空筛选', () => {
          q = { ...q, keyword: '', status: [], examTag: '', page: 1 };
          void refresh();
        }, { variant: 'primary' }),
      );
      return box;
    }
    box.appendChild(h('p', { class: 'kc-empty-title', text: '还没有任何知识点卡片' }));
    box.appendChild(h('p', { class: 'kc-hint-dim', text: '去「录入」说说你哪里不行，AI 帮你拆成卡片。' }));
    box.appendChild(button('去录入', () => navigate('/kc/import'), { variant: 'primary' }));
    return box;
  }

  /**
   * 渲染分页。
   * @param count 过滤后的总数
   */
  function renderPager(count: number): void {
    pagerBox.replaceChildren();
    const pages = Math.max(1, Math.ceil(count / q.pageSize));
    pagerBox.appendChild(h('span', { class: 'kc-pager-info', text: `共 ${count} 张 · 第 ${q.page}/${pages} 页` }));
    pagerBox.appendChild(
      button('上一页', () => {
        if (q.page <= 1) return;
        q = { ...q, page: q.page - 1 };
        void refresh();
      }, { variant: 'ghost' }),
    );
    pagerBox.appendChild(
      button('下一页', () => {
        if (q.page >= pages) return;
        q = { ...q, page: q.page + 1 };
        void refresh();
      }, { variant: 'ghost' }),
    );
    pagerBox.appendChild(
      select(
        KC.pageSizeOptions.map((n) => ({ value: String(n), label: `每页 ${n}` })),
        String(q.pageSize),
        (v) => {
          q = { ...q, pageSize: Number(v), page: 1 };
          void refresh();
        },
      ),
    );
  }

  /** 渲染批量操作栏（动作逻辑在 kcList/KcListBatch） */
  function renderBatch(): void {
    batchBox.replaceChildren();
    if (selected.size === 0) return;
    batchBox.appendChild(
      renderKcBatchActions([...selected], async () => {
        selected.clear();
        await refresh();
      }),
    );
  }

  // ── 组装 ──
  page.appendChild(
    h(
      'header',
      { class: 'kc-list-head' },
      h('h1', { class: 'kc-list-title', text: '知识点卡片' }),
      h('div', { class: 'kc-list-headbtns' }, button('＋ 录入新知识点', () => navigate('/kc/import'), { variant: 'primary' }), button('二期首页', () => navigate('/kc'), { variant: 'ghost' })),
    ),
  );
  page.appendChild(statsBox);
  page.appendChild(filterBox);
  page.appendChild(listBox);
  page.appendChild(pagerBox);
  page.appendChild(batchBox);

  // 窄屏切换时重画（表格 ↔ 卡片流）
  const mq = window.matchMedia('(max-width: 767px)');
  const onMq = (): void => {
    narrow = mq.matches;
    void refresh();
  };
  mq.addEventListener('change', onMq);
  // 路由切走时移除媒体查询监听（否则窄屏切宽屏会去操作已卸载的 DOM）
  registerCleanup(page, () => mq.removeEventListener('change', onMq));

  void refresh();
  return page;
}
