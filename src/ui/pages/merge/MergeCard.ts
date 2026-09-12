import type { Sense } from '../../../core/types';
import { button, h } from '../../dom';
import { renderSenseEditor } from '../../components/SenseEditor';
import type { DraftWord } from './drafts';
import { applyMergeHint } from './drafts';

/** 单张草稿卡的参数 */
export interface MergeCardOptions {
  onChange: (next: DraftWord) => void;
  onRemove: () => void;
  openDefault?: boolean;
}

/**
 * 渲染一张词的确认卡：英文/音标/例句可编辑 + 义项编辑 + 建议合并 + 斩掉此词。
 * @param draft 草稿词
 * @param opts 回调
 */
export function renderMergeCard(draft: DraftWord, opts: MergeCardOptions): HTMLElement {
  let current: DraftWord = draft;
  const card = h('details', { class: 'card merge-card', open: opts.openDefault ?? false });
  const body = h('div', { class: 'merge-body' });

  /** 改动草稿并通知调用方 */
  const emit = (next: DraftWord): void => {
    current = next;
    opts.onChange(next);
  };

  /** 折叠标题行 */
  const renderSummary = (): HTMLElement => {
    const active = current.senses.filter((s) => s.enabled && s.text.trim() !== '');
    return h(
      'summary',
      { class: 'merge-summary' },
      h('span', { class: 'word-en', text: current.en || '（未填英文）' }),
      h('span', { class: 'chip', text: `${active.length} 个义项` }),
      current.hints.length > 0 ? h('span', { class: 'chip hint-chip', text: `${current.hints.length} 条合并建议` }) : null,
      current.dropped ? h('span', { class: 'chip danger-chip', text: '已标记斩掉（不入库）' }) : null,
    );
  };

  /** 标题行只需要局部更新，避免输入时丢焦点 */
  const refreshSummary = (): void => {
    const old = card.querySelector('summary');
    if (old) card.replaceChild(renderSummary(), old);
  };

  /** 构建正文 */
  const buildBody = (): HTMLElement => {
    const frag = h('div', { class: 'stack' });

    const en = h('input', { class: 'input', type: 'text', value: current.en });
    en.addEventListener('input', () => {
      emit({ ...current, en: en.value });
      refreshSummary();
    });
    frag.appendChild(
      h('label', { class: 'field' }, h('span', { class: 'field-label', text: '英文（单词 / 短语 / 缩写）' }), en),
    );

    const ph = h('input', { class: 'input', type: 'text', value: current.phonetic, placeholder: '/əˈbændən/' });
    ph.addEventListener('input', () => emit({ ...current, phonetic: ph.value }));
    frag.appendChild(h('label', { class: 'field' }, h('span', { class: 'field-label', text: '音标' }), ph));

    const ex = h('input', { class: 'input', type: 'text', value: current.example, placeholder: 'He abandoned his car.' });
    ex.addEventListener('input', () => emit({ ...current, example: ex.value }));
    frag.appendChild(h('label', { class: 'field' }, h('span', { class: 'field-label', text: '例句' }), ex));

    // —— AI 合并建议（只有用户点「接受」才会改数据） ——
    if (current.hints.length > 0) {
      const hintBox = h('div', { class: 'hint-box' });
      for (const hint of current.hints) {
        hintBox.appendChild(
          h(
            'div',
            { class: 'hint-line' },
            h('span', { class: 'hint-label', text: `≈ 建议合并：${hint.absorb.join('、')} → ${hint.keep}` }),
            button(
              '接受',
              () => {
                const next = applyMergeHint(current, hint);
                if (next === current) {
                  emit({ ...current, hints: current.hints.filter((x) => x !== hint) });
                } else {
                  emit(next);
                }
                redraw();
              },
              { variant: 'primary', class: 'mini' },
            ),
            button(
              '忽略',
              () => {
                emit({ ...current, hints: current.hints.filter((x) => x !== hint) });
                redraw();
              },
              { variant: 'ghost', class: 'mini' },
            ),
          ),
        );
      }
      frag.appendChild(hintBox);
    }

    // —— 义项编辑（复用 SenseEditor） ——
    frag.appendChild(h('div', { class: 'card-label', text: '义项' }));
    frag.appendChild(
      renderSenseEditor(
        current.senses,
        (next: Sense[]) => {
          emit({ ...current, senses: next });
          refreshSummary();
        },
        {},
      ),
    );

    // —— 卡底部 ——
    frag.appendChild(
      h(
        'div',
        { class: 'card-foot' },
        button(
          current.dropped ? '取消「斩掉」' : '斩掉此词（不入库）',
          () => {
            emit({ ...current, dropped: !current.dropped });
            redraw();
          },
          { variant: current.dropped ? 'ghost' : 'danger' },
        ),
        button('删除这张卡', () => opts.onRemove(), { variant: 'danger' }),
      ),
    );
    return frag;
  };

  /** 整卡重画（结构变化时用，输入时不重画以免丢焦点） */
  function redraw(): void {
    card.className = `card merge-card${current.dropped ? ' dropped' : ''}`;
    body.replaceChildren(buildBody());
    const old = card.querySelector('summary');
    if (old) card.replaceChild(renderSummary(), old);
    else card.insertBefore(renderSummary(), body);
  }

  card.appendChild(renderSummary());
  card.appendChild(body);
  redraw(); // 填充正文
  return card;
}
