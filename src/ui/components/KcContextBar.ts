/**
 * 今日语境词显示条（二期首页顶部 + 语境词管理弹窗共用）。
 *
 * 机制（用户明确要求）：每天 5 个互不相关的词；AI 生成后**要用户确认或修改**才生效；
 * 未确认时页面显示黄条提醒。
 */
import type { DailyContextWords } from '../../core/kcTypes';
import { button, h } from '../dom';

/** 语境词条的回调 */
export interface KcContextBarHandlers {
  /** 点「重新生成」（调 AI） */
  onGenerate: () => void;
  /** 点「编辑」 */
  onEdit: () => void;
  /** 点「确认使用」 */
  onConfirm: () => void;
}

/**
 * 渲染今日语境词条。
 *
 * @param today 今天的记录（null = 还没生成）
 * @param loading 是否正在请求 AI
 * @param handlers 回调
 */
export function renderKcContextBar(
  today: DailyContextWords | null,
  loading: boolean,
  handlers: KcContextBarHandlers,
): HTMLElement {
  const box = h('section', { class: 'kc-contextbar' });
  const head = h('div', { class: 'kc-contextbar-head' });
  head.appendChild(h('span', { class: 'kc-contextbar-title', text: '今日语境词' }));
  const actions = h('div', { class: 'kc-contextbar-actions' });
  actions.appendChild(button(loading ? '生成中…' : '重新生成', () => handlers.onGenerate(), { variant: 'ghost', class: 'kc-ctx-btn' }));
  actions.appendChild(button('编辑', () => handlers.onEdit(), { variant: 'ghost', class: 'kc-ctx-btn' }));
  if (today !== null && !today.confirmed) {
    actions.appendChild(button('确认使用', () => handlers.onConfirm(), { variant: 'primary', class: 'kc-ctx-btn' }));
  }
  head.appendChild(actions);
  box.appendChild(head);

  if (today === null) {
    box.appendChild(
      h('p', {
        class: 'kc-ctx-hint',
        text: '还没有今天的语境词。点「重新生成」让 AI 出 5 个互不相关的词（出题时会用它们提供语境）。',
      }),
    );
    return box;
  }

  const chips = h('div', { class: 'kc-chips' });
  for (const w of today.words) chips.appendChild(h('span', { class: 'kc-chip', text: w }));
  if (today.words.length === 0) chips.appendChild(h('span', { class: 'kc-chip kc-chip--empty', text: '（空的）' }));
  box.appendChild(chips);

  box.appendChild(
    h('p', {
      class: `kc-ctx-note${today.confirmed ? '' : ' kc-ctx-note--warn'}`,
      text: today.confirmed
        ? '已确认，出题时会从这 5 个词里挑一个融入题目。'
        : '⚠️ 还没确认 —— 出题时不会使用（先看一眼，改成你想要的词再确认）。',
    }),
  );
  return box;
}
