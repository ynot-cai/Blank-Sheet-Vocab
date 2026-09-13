/**
 * 卡片列表的**单行（桌面表格行）/ 单卡（手机卡片流）**渲染。
 *
 * 与一期 `pages/list/` 的分工一样：桌子宽时用表格，窄屏用卡片流。
 * 这里只负责「长什么样 + 点哪个按钮回调什么」，状态与数据都在列表页里。
 */
import { EXAM_TYPES, type KnowledgeCard } from '../../../core/kcTypes';
import { button, h } from '../../dom';
import { isBlindSpot } from '../../../core/kcPriority';

/** 行渲染回调 */
export interface KcRowHandlers {
  onToggleSelect: (id: string) => void;
  onOpen: (id: string) => void;
  onEdit: (id: string) => void;
  onChop: (card: KnowledgeCard) => void;
  onRevive: (card: KnowledgeCard) => void;
  onRemove: (card: KnowledgeCard) => void;
}

/**
 * 掌握度可视化：三色点 + 百分比。
 *
 * 为什么用点而不是进度条：一眼能看出「会了 / 模糊 / 不会」三档，
 * 而百分比在列表里读起来慢；两者都给，扫视和精读都不误。
 * @param card 卡片
 */
function renderMastery(card: KnowledgeCard): HTMLElement {
  const m = Math.max(0, Math.min(1, card.attrs.mastery));
  const level = m >= 0.67 ? 'high' : m >= 0.34 ? 'mid' : 'low';
  const box = h('span', { class: `kc-mastery kc-mastery--${level}` });
  const dots = h('span', { class: 'kc-mastery-dots' });
  const filled = level === 'high' ? 3 : level === 'mid' ? 2 : 1;
  for (let i = 0; i < 3; i += 1) {
    dots.appendChild(h('i', { class: i < filled ? 'kc-dot kc-dot--on' : 'kc-dot' }));
  }
  box.appendChild(dots);
  box.appendChild(h('span', { class: 'kc-mastery-pct', text: `${Math.round(m * 100)}%` }));
  // 盲目自信（自评高、考核低）是「最该复习」的状态，列表里必须一眼看见
  if (isBlindSpot(card.attrs)) {
    box.appendChild(h('span', { class: 'kc-blindflag', text: '⚠️', title: '自评高但考核低（盲目自信）——最该复习' }));
  }
  return box;
}

/**
 * 考核标签 chips。
 * @param card 卡片
 */
function renderTags(card: KnowledgeCard): HTMLElement {
  const row = h('span', { class: 'kc-chips' });
  if (card.examTags.length === 0) row.appendChild(h('span', { class: 'kc-chip kc-chip--empty', text: '未标注' }));
  for (const id of card.examTags) {
    row.appendChild(h('span', { class: 'kc-chip', text: EXAM_TYPES.find((t) => t.id === id)?.name ?? id }));
  }
  return row;
}

/**
 * 「上次复习 / 复习次数」这行小字。
 * @param card 卡片
 */
function renderReviewMeta(card: KnowledgeCard): HTMLElement {
  const last = card.attrs.lastReviewAt;
  const when = last === null ? '还没复习过' : `${relativeDays(last)}`;
  return h('span', {
    class: 'kc-row-sub',
    text: `${when} · 复习 ${card.attrs.reviewCount} 次`,
  });
}

/**
 * 时间戳 → 「今天 / 3 天前 / 日期」。
 * @param ts 时间戳
 */
function relativeDays(ts: number): string {
  const days = Math.floor((Date.now() - ts) / 86_400_000);
  if (days <= 0) return '今天复习';
  if (days === 1) return '昨天复习';
  if (days < 30) return `${days} 天前复习`;
  return `${new Date(ts).toLocaleDateString()} 复习`;
}

/**
 * 渲染「⋯」菜单里的操作按钮组（展开后显示）。
 * @param card 卡片
 * @param handlers 回调
 */
function renderActions(card: KnowledgeCard, handlers: KcRowHandlers): HTMLElement {
  const box = h('span', { class: 'kc-row-actions' });
  box.appendChild(button('编辑', () => handlers.onEdit(card.id), { variant: 'ghost', class: 'kc-mini-btn' }));
  box.appendChild(button('详情', () => handlers.onOpen(card.id), { variant: 'ghost', class: 'kc-mini-btn' }));
  if (card.deleted === 1 || card.status === 'chopped') {
    box.appendChild(button('复活', () => handlers.onRevive(card), { variant: 'ghost', class: 'kc-mini-btn' }));
  } else {
    box.appendChild(button('斩', () => handlers.onChop(card), { variant: 'ghost', class: 'kc-mini-btn kc-mini-btn--danger' }));
  }
  box.appendChild(button('永久删除', () => handlers.onRemove(card), { variant: 'ghost', class: 'kc-mini-btn kc-mini-btn--danger' }));
  return box;
}

/**
 * 渲染一行（桌面表格 `<tr>`）。
 * @param card 卡片
 * @param selected 是否被勾选
 * @param handlers 回调
 */
export function renderKcRow(card: KnowledgeCard, selected: boolean, handlers: KcRowHandlers): HTMLTableRowElement {
  const tr = h('tr', { class: selected ? 'kc-row kc-row--selected' : 'kc-row' });

  const checkCell = h('td', { class: 'kc-cell-check' });
  const check = h('input', { type: 'checkbox', checked: selected, title: '选中后可以批量操作' });
  check.addEventListener('change', () => handlers.onToggleSelect(card.id));
  checkCell.appendChild(check);
  tr.appendChild(checkCell);

  const mainCell = h('td', { class: 'kc-cell-main' });
  const titleBtn = h('button', { class: 'kc-row-title', type: 'button', text: card.title, title: '打开详情' });
  titleBtn.addEventListener('click', () => handlers.onOpen(card.id));
  mainCell.appendChild(titleBtn);
  if (card.summary !== '') mainCell.appendChild(h('span', { class: 'kc-row-summary', text: card.summary }));
  mainCell.appendChild(h('span', { class: 'kc-row-meta' }, renderTags(card), renderReviewMeta(card)));
  tr.appendChild(mainCell);

  tr.appendChild(h('td', { class: 'kc-cell-mastery' }, renderMastery(card)));
  const actionCell = h('td', { class: 'kc-cell-actions' });
  actionCell.appendChild(renderActions(card, handlers));
  tr.appendChild(actionCell);
  return tr;
}

/**
 * 渲染一张卡（手机卡片流）。
 * @param card 卡片
 * @param selected 是否被勾选
 * @param handlers 回调
 */
export function renderKcListCard(card: KnowledgeCard, selected: boolean, handlers: KcRowHandlers): HTMLElement {
  const box = h('article', { class: selected ? 'kc-list-card kc-list-card--selected' : 'kc-list-card' });

  const head = h('div', { class: 'kc-list-card-head' });
  const check = h('input', { type: 'checkbox', checked: selected, title: '选中后可以批量操作' });
  check.addEventListener('change', () => handlers.onToggleSelect(card.id));
  head.appendChild(check);
  const titleBtn = h('button', { class: 'kc-row-title', type: 'button', text: card.title });
  titleBtn.addEventListener('click', () => handlers.onOpen(card.id));
  head.appendChild(titleBtn);
  box.appendChild(head);

  if (card.summary !== '') box.appendChild(h('p', { class: 'kc-row-summary', text: card.summary }));
  box.appendChild(h('div', { class: 'kc-row-meta' }, renderTags(card), renderMastery(card)));
  box.appendChild(h('div', { class: 'kc-row-meta' }, renderReviewMeta(card)));
  box.appendChild(renderActions(card, handlers));
  return box;
}
