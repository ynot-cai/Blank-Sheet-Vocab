/**
 * 二期卡片的**查询**逻辑（过滤 + 排序 + 分页）。
 *
 * 为什么从 `dao/kc.ts` 里拆出来：那边是「怎么读写 IndexedDB」，
 * 这边是「怎么从一堆卡片里挑出用户想看的那一页」，两件事的变更原因不同；
 * 而且项目硬约束是单文件 ≤ 300 行。
 *
 * 这个文件是**纯函数**（不碰 IndexedDB、不碰 DOM），所以可以直接做单测：
 * 传一堆卡片进去，断言筛选与排序结果。
 *
 * 说明：二期的卡片量是「几十到几百张」级别（精学知识点，不是单词），
 * 所以直接在内存里过滤排序就够了，不需要给每个筛选条件建 IndexedDB 索引。
 */
import { KC } from '../core/config';
import type { KcQuery, KnowledgeCard } from '../core/kcTypes';

/** 排序字段 → 取值函数（一处定义，排序/查询都用它） */
const SORTERS: Record<NonNullable<KcQuery['sort']>, (c: KnowledgeCard) => number | string> = {
  reviewPriority: (c) => c.attrs.reviewPriority,
  createdAt: (c) => c.createdAt,
  mastery: (c) => c.attrs.mastery,
  title: (c) => c.title,
};

/** 缺省排序：优先度高的在前（「最该复习的」排最前） */
export const DEFAULT_SORT: NonNullable<KcQuery['sort']> = 'reviewPriority';
/** 缺省方向 */
export const DEFAULT_ORDER: NonNullable<KcQuery['order']> = 'desc';

/**
 * 取块的**可搜索文本**（只取正文型的块，不取表格/列表的行列）。
 *
 * 为什么把表格与列表排除在外：那两类里的单元极短（"where" / "地点" / "状语"），
 * 搜一个「的」或「a」会命中几乎每一张卡，结果等于没筛。
 * 正文型块的文本有上下文，命中才代表「这张卡真的讲了这件事」。
 * @param card 卡片
 */
function blockSearchText(card: KnowledgeCard): string {
  const parts: string[] = [];
  for (const b of card.blocks) {
    if (b.type === 'heading' || b.type === 'text' || b.type === 'tip' || b.type === 'quote' || b.type === 'example') {
      if (typeof b.content === 'string') parts.push(b.content);
      if (typeof b.translation === 'string') parts.push(b.translation);
    }
  }
  return parts.join('\n').toLowerCase();
}

/**
 * 按查询条件过滤（**不含排序与分页**）。
 *
 * 墓碑规则（容易搞混，重点）：
 * - 默认**不含** `deleted=1` 的卡片（斩掉的不该出现在学习/复习队列里）；
 * - 只有明确传 `status: ['chopped']` 时才把墓碑放出来（「已斩」列表要能复活它们）。
 *
 * 搜索范围：标题 + 摘要 + **正文型块的内容**（验收标准 5 要求能搜到块内容）。
 *
 * @param all 全部卡片（含墓碑）
 * @param q 查询条件
 */
export function filterCards(all: KnowledgeCard[], q: KcQuery): KnowledgeCard[] {
  const keyword = (q.keyword ?? '').trim().toLowerCase();
  const wantsChopped = (q.status ?? []).includes('chopped');

  return all.filter((c) => {
    if (c.deleted === 1 && !wantsChopped) return false;
    if (q.status !== undefined && q.status.length > 0 && !q.status.includes(c.status)) return false;
    if (q.examTag !== undefined && q.examTag !== '' && !c.examTags.includes(q.examTag)) return false;
    if (keyword !== '') {
      const hay = `${c.title}\n${c.summary}`.toLowerCase();
      if (!hay.includes(keyword) && !blockSearchText(c).includes(keyword)) return false;
    }
    return true;
  });
}

/**
 * 排序（**不改原数组**，返回新数组）。
 * @param rows 已过滤的卡片
 * @param sort 排序字段
 * @param order 方向
 */
export function sortCards(
  rows: KnowledgeCard[],
  sort: KcQuery['sort'] = DEFAULT_SORT,
  order: KcQuery['order'] = DEFAULT_ORDER,
): KnowledgeCard[] {
  const dir = order === 'asc' ? 1 : -1;
  const keyOf = SORTERS[sort ?? DEFAULT_SORT] ?? SORTERS[DEFAULT_SORT];
  return [...rows].sort((a, b) => {
    const ka = keyOf(a);
    const kb = keyOf(b);
    if (typeof ka === 'string' || typeof kb === 'string') {
      return String(ka).localeCompare(String(kb), 'zh-Hans-CN') * dir;
    }
    // 同分时按标题稳定排序，翻页时不会出现「同一张卡出现两次 / 某张卡翻不到」
    if (ka === kb) return a.title.localeCompare(b.title, 'zh-Hans-CN') * dir;
    return (ka - kb) * dir;
  });
}

/**
 * 分页（返回这一页的切片）。
 * @param rows 已排序的卡片
 * @param page 页码（从 1 开始；非法值当 1）
 * @param pageSize 每页条数（非法值用默认值）
 */
export function paginate(
  rows: KnowledgeCard[],
  page: number,
  pageSize: number,
): { total: number; items: KnowledgeCard[] } {
  const safePage = Math.max(1, Math.trunc(page) || 1);
  const safeSize = Math.max(1, Math.trunc(pageSize) || KC.defaultPageSize);
  const start = (safePage - 1) * safeSize;
  return { total: rows.length, items: rows.slice(start, start + safeSize) };
}

/**
 * 一次做完「过滤 → 排序 → 分页」。
 * @param all 全部卡片（含墓碑）
 * @param q 查询条件
 */
export function runQuery(all: KnowledgeCard[], q: KcQuery): { total: number; items: KnowledgeCard[] } {
  return paginate(sortCards(filterCards(all, q), q.sort, q.order), q.page, q.pageSize);
}

/**
 * 统计各状态条数（首页/列表页顶部用）。
 * @param all 全部卡片（含墓碑）
 * @param includeChopped 是否把墓碑计入 total（默认不计）
 */
export function countStats(
  all: KnowledgeCard[],
  includeChopped = false,
): { total: number; unlearned: number; learning: number; learned: number; chopped: number } {
  const out = { total: 0, unlearned: 0, learning: 0, learned: 0, chopped: 0 };
  for (const c of all) {
    const isChopped = c.deleted === 1 || c.status === 'chopped';
    if (isChopped) {
      out.chopped += 1;
      if (includeChopped) out.total += 1;
      continue;
    }
    out.total += 1;
    if (c.status === 'learned') out.learned += 1;
    else if (c.status === 'learning') out.learning += 1;
    else out.unlearned += 1;
  }
  return out;
}
