import type { Source, Word } from '../../../core/types';
import { button, h } from '../../dom';
import { openModal } from '../../components/Modal';

/**
 * 「查看其他来源义项」弹窗：展示 rawSources 里每条来源的义项，可一键采纳为主义项。
 * @param word 单词
 * @param sources 来源列表（显示名字用）
 * @param onAdopt 采纳回调（参数是来源 id）
 */
export function openRawSourcesModal(word: Word, sources: Source[], onAdopt: (sourceId: string) => void): void {
  const nameOf = (id: string): string => sources.find((s) => s.id === id)?.name ?? '（未知来源）';

  const body = h('div', { class: 'stack' });
  if (word.rawSources.length === 0) {
    body.appendChild(h('p', { class: 'note' }, '这个词没有其他来源的记录。'));
  } else {
    const current = h('div', { class: 'raw-block current' });
    current.appendChild(h('h4', { class: 'sub-title', text: `当前义项（来源：${nameOf(word.sourceId)}）` }));
    for (const s of word.senses) {
      current.appendChild(h('div', { class: s.enabled ? 'sense-line' : 'sense-line chopped', text: s.text || '（空）' }));
    }
    body.appendChild(current);

    for (const record of word.rawSources) {
      const block = h('div', { class: 'raw-block' });
      block.appendChild(h('h4', { class: 'sub-title', text: `来源：${nameOf(record.sourceId)}` }));
      for (const s of record.senses) {
        block.appendChild(h('div', { class: s.enabled ? 'sense-line' : 'sense-line chopped', text: s.text || '（空）' }));
      }
      block.appendChild(
        button(
          '采纳为主义项',
          () => {
            onAdopt(record.sourceId);
          },
          { variant: 'primary', class: 'mini' },
        ),
      );
      body.appendChild(block);
    }
  }

  openModal({
    title: `其他来源义项 —— ${word.en}`,
    body,
    width: '640px',
    actions: [{ text: '关闭', variant: 'ghost', onClick: (close) => close() }],
  });
}
