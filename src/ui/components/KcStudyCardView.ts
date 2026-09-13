/**
 * 学习/复习流程里的**单张知识卡片展示**（阶段 04）。
 *
 * 与详情页（`KcCardViewPage`）的区别：
 * - 详情页是**只读查阅**（带属性面板、编辑按钮）；
 * - 这个是**学习态**：右上角有考核标签 chip、底部是三个自评按钮 + 斩，进度在下方。
 *
 * 渲染一律走 `renderBlocks`（AI 内容只当纯文本），这个文件里不出现任何 HTML 拼接。
 */
import { EXAM_TYPES, type KnowledgeCard } from '../../core/kcTypes';
import { renderBlocks } from '../../core/blockRender';
import { button, h } from '../dom';

/** 自评三档 */
export type SelfRating = 1 | 2 | 3;

/** 卡片区回调 */
export interface KcStudyCardHandlers {
  /** 点某个自评按钮 / 按 1/2/3 */
  onRate: (score: SelfRating) => void;
  /** 点「斩」（调用方负责二次确认） */
  onChop: () => void;
}

/** 自评三档的显示信息（**配色与文案只在这里定义一次**） */
export const SELF_RATINGS: { score: SelfRating; label: string; key: string; variant: 'danger' | 'warn' | 'ok' }[] = [
  { score: 1, label: '不会', key: '1', variant: 'danger' },
  { score: 2, label: '模糊', key: '2', variant: 'warn' },
  { score: 3, label: '会了', key: '3', variant: 'ok' },
];

/**
 * 自评按钮的配色 class（`button()` 的 variant 只有 primary/danger/ghost，
 * 而自评要「红/黄/绿」三档，所以用 class 表达，配色在 kc.css 里）。
 * @param variant 档位
 */
function ratingClass(variant: 'danger' | 'warn' | 'ok'): string {
  return `kc-rating kc-rating--${variant}${variant === 'ok' ? ' kc-rating--primary' : ''}`;
}

/**
 * 渲染学习态的卡片。
 *
 * @param card 卡片
 * @param handlers 回调
 */
export function renderKcStudyCard(card: KnowledgeCard, handlers: KcStudyCardHandlers): HTMLElement {
  const box = h('article', { class: 'kc-study-card' });

  // ── 头部：标题 + 右上角考核标签 ──
  const head = h('header', { class: 'kc-study-card-head' });
  head.appendChild(h('h2', { class: 'kc-study-title', text: card.title }));
  const chips = h('div', { class: 'kc-study-chips' });
  for (const id of card.examTags) {
    chips.appendChild(
      h('span', { class: 'kc-chip', text: EXAM_TYPES.find((t) => t.id === id)?.name ?? id, title: '这张卡会考的题型' }),
    );
  }
  head.appendChild(chips);
  box.appendChild(head);

  if (card.summary !== '') box.appendChild(h('p', { class: 'kc-study-summary', text: card.summary }));

  // ── 内容（可滚动）──
  const content = h('div', { class: 'kc-study-content kc-blocks' });
  content.appendChild(renderBlocks(card.blocks));
  box.appendChild(content);

  // ── 底部：三个自评按钮 + 斩 ──
  const bar = h('div', { class: 'kc-study-bar' });
  const ratings = h('div', { class: 'kc-rating-group' });
  for (const r of SELF_RATINGS) {
    const btn = button(r.label, () => handlers.onRate(r.score), {
      // 「会了」用主色（视觉上最肯定），另两档用中性按钮 + 各自的彩色边框
      variant: r.variant === 'ok' ? 'primary' : 'ghost',
      class: ratingClass(r.variant),
      title: `按键盘 ${r.key} 也可以（${r.label}）`,
    });
    btn.dataset['score'] = String(r.score);
    ratings.appendChild(btn);
  }
  bar.appendChild(ratings);
  bar.appendChild(
    button('斩', () => handlers.onChop(), { variant: 'ghost', class: 'kc-chop-btn', title: '斩掉这张卡（之后不再出现，可在「已斩」里复活）' }),
  );
  box.appendChild(bar);
  return box;
}
