/**
 * 知识卡片预览卡（录入页用；阶段 03 的卡片列表也会复用）。
 *
 * 三件事：
 * - 标题 + 摘要 + 考核标签 chip + 出题量；
 * - 「预览」展开后用 `renderBlocks` 渲染**完整块内容**（安全渲染，不是拼 HTML）；
 * - 右侧一排操作按钮（采纳 / 丢弃 / 编辑），由调用方传回调。
 *
 * ⚠️ 这个文件里**不允许**出现 `innerHTML`：卡片内容是 AI 生成的，
 * 一律走 `renderBlocks` / `textContent`（见 `core/blockRender.ts` 的安全铁律）。
 */
import type { Block, ExamLoad } from '../../core/kcTypes';
import { renderBlocks } from '../../core/blockRender';
import { examTypeName } from '../../services/kcImportParse';
import { button, h } from '../dom';

/** 预览卡的状态 */
export type KcPreviewState = 'pending' | 'adopted' | 'discarded';

/** 预览卡需要的数据（结构化，不直接吃 KnowledgeCard，这样解析结果也能直接喂进来） */
export interface KcPreviewData {
  title: string;
  summary: string;
  blocks: Block[];
  examTags: string[];
  examLoad: ExamLoad;
}

/** 预览卡的回调 */
export interface KcPreviewHandlers {
  onAdopt?: () => void;
  onDiscard?: () => void;
  onEdit?: () => void;
  /** 展开/收起预览时通知（用于按钮文案与持久化展开状态） */
  onTogglePreview?: (open: boolean) => void;
}

/** 状态 → 中文（也给自测与界面提示用） */
export const KC_PREVIEW_STATE_TEXT: Record<KcPreviewState, string> = {
  pending: '待处理',
  adopted: '已采纳',
  discarded: '已丢弃',
};

/**
 * 渲染考核标签 chip 行。
 * @param tags 题型 id 数组
 */
function renderTagChips(tags: string[]): HTMLElement {
  const row = h('div', { class: 'kc-chips' });
  if (tags.length === 0) {
    row.appendChild(h('span', { class: 'kc-chip kc-chip--empty', text: '未标注考法' }));
    return row;
  }
  for (const tag of tags) {
    row.appendChild(h('span', { class: 'kc-chip', text: examTypeName(tag), title: tag }));
  }
  return row;
}

/**
 * 渲染一张卡片预览。
 *
 * @param data 卡片数据
 * @param state 当前状态（已采纳 / 已丢弃会灰掉并禁用按钮）
 * @param handlers 操作回调
 * @param opts.startOpen 是否一开始就展开块预览
 */
export function renderKcPreviewCard(
  data: KcPreviewData,
  state: KcPreviewState,
  handlers: KcPreviewHandlers = {},
  opts: { startOpen?: boolean } = {},
): HTMLElement {
  const card = h('article', { class: `kc-preview kc-preview--${state}` });

  // ── 头部：标题 + 摘要 + 标签 + 耗时 ──
  const head = h('div', { class: 'kc-preview-head' });
  head.appendChild(h('h4', { class: 'kc-preview-title', text: data.title }));
  if (data.summary !== '') {
    head.appendChild(h('p', { class: 'kc-preview-summary', text: data.summary }));
  }
  const meta = h('div', { class: 'kc-preview-meta' }, renderTagChips(data.examTags));
  meta.appendChild(
    h('span', {
      class: 'kc-preview-minutes',
      text: `约 ${data.examLoad.estMinutes} 分钟`,
      title: '预计出题耗时（3~5 分钟）',
    }),
  );
  meta.appendChild(h('span', { class: 'kc-preview-blocks', text: `${data.blocks.length} 个块` }));
  if (state !== 'pending') {
    meta.appendChild(h('span', { class: `kc-state kc-state--${state}`, text: KC_PREVIEW_STATE_TEXT[state] }));
  }
  head.appendChild(meta);
  card.appendChild(head);

  // ── 块预览区（点「预览」才填充并显示）──
  const body = h('div', { class: 'kc-preview-body kc-blocks' });
  body.hidden = opts.startOpen !== true;
  let filled = false;
  const fill = (): void => {
    if (filled) return;
    filled = true;
    // renderBlocks 返回 DocumentFragment；内容是 AI 输出，只能这样渲染
    body.appendChild(renderBlocks(data.blocks));
  };
  if (opts.startOpen === true) fill();
  card.appendChild(body);

  // ── 操作区 ──
  const actions = h('div', { class: 'kc-preview-actions' });
  const toggleText = (): string => (body.hidden ? '预览' : '收起');
  const toggleBtn = button(toggleText(), () => {
    if (body.hidden) fill();
    body.hidden = !body.hidden;
    toggleBtn.textContent = toggleText();
    handlers.onTogglePreview?.(!body.hidden);
  });
  actions.appendChild(toggleBtn);

  if (handlers.onEdit !== undefined) {
    actions.appendChild(button('编辑', () => handlers.onEdit?.(), { title: '改标题与考法标签' }));
  }
  if (handlers.onAdopt !== undefined) {
    const adopt = button(state === 'adopted' ? '已采纳' : '采纳', () => handlers.onAdopt?.(), {
      variant: state === 'adopted' ? 'ghost' : 'primary',
    });
    adopt.disabled = state === 'adopted';
    actions.appendChild(adopt);
  }
  if (handlers.onDiscard !== undefined) {
    const discard = button('丢弃', () => handlers.onDiscard?.(), { variant: 'ghost' });
    discard.disabled = state === 'discarded';
    actions.appendChild(discard);
  }
  card.appendChild(actions);

  return card;
}
