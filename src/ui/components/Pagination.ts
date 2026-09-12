import { button, h, select } from '../dom';

/** 分页参数 */
export interface PaginationOptions {
  page: number;
  pageSize: number;
  total: number;
  onChange: (page: number) => void;
  onPageSizeChange?: (size: number) => void;
}

/**
 * 渲染分页组件（上一页 / 页码 / 下一页 / 每页条数）。
 * @param opts 分页参数
 */
export function renderPagination(opts: PaginationOptions): HTMLElement {
  const pageCount = Math.max(1, Math.ceil(opts.total / Math.max(1, opts.pageSize)));
  const page = Math.min(Math.max(1, opts.page), pageCount);

  const wrap = h('div', { class: 'pagination' });

  if (opts.onPageSizeChange) {
    const sizeSel = select(
      [
        { value: '50', label: '50 条/页' },
        { value: '100', label: '100 条/页' },
        { value: '200', label: '200 条/页' },
      ],
      String(opts.pageSize),
      (v) => opts.onPageSizeChange?.(Number(v)),
    );
    wrap.appendChild(sizeSel);
  }

  const prev = button('上一页', () => opts.onChange(page - 1));
  prev.disabled = page <= 1;
  const next = button('下一页', () => opts.onChange(page + 1));
  next.disabled = page >= pageCount;

  wrap.appendChild(prev);
  wrap.appendChild(h('span', { class: 'page-info', text: `第 ${page} / ${pageCount} 页 · 共 ${opts.total} 条` }));
  wrap.appendChild(next);
  return wrap;
}
