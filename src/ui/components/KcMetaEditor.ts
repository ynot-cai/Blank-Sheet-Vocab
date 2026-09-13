/**
 * 卡片「标题 / 摘要 / 考法标签」编辑弹窗。
 *
 * 为什么单独一个文件：完整块编辑是阶段 03 的 `BlockEditor`（几百行），
 * 这个只改元信息的小弹窗和它没有关系；留在录入页里会让那一页超出行数硬约束。
 *
 * 返回新的卡片数据（**不改原对象**），由调用方决定怎么存。
 */
import { EXAM_TYPES, type ParsedKcCard } from '../../core/kcTypes';
import { button, h } from '../dom';
import { openModal } from './Modal';

/**
 * 打开编辑弹窗。
 * @param current 当前卡片
 * @param onSave 保存回调（拿到改好的卡片）
 */
export function openKcMetaEditor(current: ParsedKcCard, onSave: (next: ParsedKcCard) => void): void {
  const title = h('input', { class: 'input', type: 'text', value: current.title });
  const summary = h('input', { class: 'input', type: 'text', value: current.summary });

  /** 编辑中的标签集合（顺序即显示顺序） */
  const tags = new Set(current.examTags);
  const tagBox = h('div', { class: 'kc-chip-edit' });

  /** 重画标签区：已选的带 ×，未选的给「＋」按钮 */
  const paintTags = (): void => {
    tagBox.replaceChildren();
    for (const id of tags) {
      const chip = h('span', { class: 'kc-chip kc-chip--editable' });
      chip.appendChild(h('span', { text: id }));
      chip.appendChild(
        button('×', () => {
          tags.delete(id);
          paintTags();
        }, { variant: 'ghost', class: 'kc-chip-x', title: '去掉这个考法' }),
      );
      tagBox.appendChild(chip);
    }
    // 未选的题型从 EXAM_TYPES 生成 —— 新增题型只改 kcTypes，这里自动跟上
    for (const t of EXAM_TYPES) {
      if (tags.has(t.id)) continue;
      tagBox.appendChild(
        button(`＋${t.name}`, () => {
          tags.add(t.id);
          paintTags();
        }, { variant: 'ghost', class: 'kc-chip-add' }),
      );
    }
  };
  paintTags();

  openModal({
    title: '编辑卡片（块内容的编辑在阶段 03）',
    width: '560px',
    body: [
      h('label', { class: 'field' }, h('span', { class: 'field-label', text: '标题' }), title),
      h('label', { class: 'field' }, h('span', { class: 'field-label', text: '摘要' }), summary),
      h('div', { class: 'field' }, h('span', { class: 'field-label', text: '考法标签' }), tagBox),
    ],
    actions: [
      { text: '取消', variant: 'ghost', onClick: (close) => close() },
      {
        text: '保存',
        variant: 'primary',
        onClick: (close) => {
          const nextTags = [...tags];
          onSave({
            ...current,
            title: title.value.trim() !== '' ? title.value.trim() : current.title,
            summary: summary.value.trim(),
            examTags: nextTags,
            // 标签清空时保留原来的出题量，别把 types 也清成空
            examLoad: {
              types: nextTags.length > 0 ? nextTags : current.examLoad.types,
              estMinutes: current.examLoad.estMinutes,
            },
          });
          close();
        },
      },
    ],
  });
}
