/**
 * 卡片详情页（`#/kc/view?id=<cardId>`）—— **只读**渲染全部块。
 *
 * 为什么单独一页（而不是弹窗）：知识卡片可能很长（表格 + 多个例句 + 易错点），
 * 弹窗里滚动体验差；而且用户会想「对着卡片看」而不是「在列表上盖一层」。
 * 顶部显示属性（掌握度 / 复习次数 / 自评与考核的最后得分 / 盲目自信标记），
 * 这些是阶段 04~06 会不断改动的数据，放这里一处看全。
 */
import { EXAM_TYPES, type KnowledgeCard } from '../../core/kcTypes';
import { renderBlocks } from '../../core/blockRender';
import { isBlindSpot } from '../../core/kcPriority';
import * as dao from '../../dao';
import { button, h } from '../dom';
import { navigate, type RouteContext } from '../router';

/**
 * 渲染卡片详情页。
 * @param ctx 路由上下文（`?id=<cardId>`）
 */
export function renderKcCardViewPage(ctx: RouteContext): HTMLElement {
  const page = h('div', { class: 'page kc-view-page' });
  const id = (ctx.query.get('id') ?? '').trim();
  page.appendChild(h('p', { class: 'kc-hint-dim', text: '正在读取卡片…' }));

  void (async () => {
    const card = id === '' ? null : await dao.kc.getById(id);
    if (card === null) {
      page.replaceChildren(
        h('div', { class: 'kc-empty' }, [
          h('p', { class: 'kc-empty-title', text: '找不到这张卡片' }),
          button('回卡片列表', () => navigate('/kc/list'), { variant: 'primary' }),
        ]),
      );
      return;
    }
    page.replaceChildren(renderDetail(card));
  })();

  return page;
}

/**
 * 渲染详情正文。
 * @param card 卡片
 */
function renderDetail(card: KnowledgeCard): HTMLElement {
  const box = h('div', { class: 'kc-view-body' });

  // ── 头部：标题 + 摘要 + 标签 + 操作 ──
  const head = h('header', { class: 'kc-view-head' });
  head.appendChild(h('h1', { class: 'kc-view-title', text: card.title }));
  if (card.summary !== '') head.appendChild(h('p', { class: 'kc-view-summary', text: card.summary }));

  const chips = h('div', { class: 'kc-chips' });
  for (const tag of card.examTags) {
    chips.appendChild(h('span', { class: 'kc-chip', text: EXAM_TYPES.find((t) => t.id === tag)?.name ?? tag }));
  }
  chips.appendChild(h('span', { class: 'kc-chip kc-chip--plain', text: `约 ${card.examLoad.estMinutes} 分钟` }));
  head.appendChild(chips);

  head.appendChild(
    h(
      'div',
      { class: 'kc-view-actions' },
      button('编辑', () => navigate(`/kc/edit?id=${encodeURIComponent(card.id)}`), { variant: 'primary' }),
      button('回列表', () => navigate('/kc/list'), { variant: 'ghost' }),
    ),
  );
  box.appendChild(head);

  // ── 属性面板 ──
  box.appendChild(renderAttrs(card));

  // ── 卡片内容（安全渲染：AI 输出只当纯文本）──
  const content = h('div', { class: 'kc-view-content kc-blocks' });
  content.appendChild(renderBlocks(card.blocks));
  box.appendChild(content);

  return box;
}

/**
 * 渲染属性面板（掌握度 / 复习次数 / 自评与考核 / 时间）。
 * @param card 卡片
 */
function renderAttrs(card: KnowledgeCard): HTMLElement {
  const a = card.attrs;
  const row = (label: string, value: string, extra?: Node): HTMLElement =>
    h('div', { class: 'kc-attr' }, h('span', { class: 'kc-attr-label', text: label }), h('span', { class: 'kc-attr-value', text: value }), extra ?? null);

  const box = h('div', { class: 'kc-attrs' });
  box.appendChild(h('span', { class: `kc-status kc-status--${card.status}`, text: statusText(card.status) }));
  box.appendChild(row('掌握度', `${Math.round(a.mastery * 100)}%`));
  box.appendChild(row('复习优先度', a.reviewPriority.toFixed(2)));
  box.appendChild(row('自评 / 考核', `${scoreText(a.lastSelfScore)} / ${scoreText(a.lastExamScore)}`));
  box.appendChild(row('复习次数', String(a.reviewCount)));
  box.appendChild(row('上次复习', a.lastReviewAt === null ? '还没复习过' : new Date(a.lastReviewAt).toLocaleString()));
  box.appendChild(row('首次学习', a.learnedAt === null ? '还没学过' : new Date(a.learnedAt).toLocaleString()));
  if (isBlindSpot(a)) {
    box.appendChild(
      h('p', {
        class: 'kc-blindnote',
        text: '⚠️ 自评说「会了」但考核没过 —— 属于盲目自信，已经把它排到复习队列前面了。',
      }),
    );
  }
  return box;
}

/** 状态中文 */
function statusText(status: KnowledgeCard['status']): string {
  switch (status) {
    case 'unlearned':
      return '未学';
    case 'learning':
      return '学习中';
    case 'learned':
      return '已学';
    case 'chopped':
      return '已斩';
    default:
      return status;
  }
}

/** 分数中文（null = 还没有） */
function scoreText(score: number | null): string {
  if (score === null) return '—';
  if (score <= 1) return '1 不会';
  if (score === 2) return '2 模糊';
  return '3 会了';
}
