/**
 * 块类型的中文名与「新建块」工具条。
 *
 * 为什么单独一个文件：
 * 1. 单文件 ≤ 300 行的硬约束（`BlockEditor` 本身已经不小）；
 * 2. **8 种块的中文名只写一份** —— 工具条、块头部的类型标签、将来的别处都从这里取，
 *    不会有「工具条写「标题」、块头写「小标题」」这种不一致。
 */
import { createBlock } from '../../core/kcModel';
import { EXAM_TYPES, type Block, type BlockType } from '../../core/kcTypes';
import { button, h } from '../dom';

/** 块类型的中文名（工具条按钮、块头部标签共用） */
export const BLOCK_TYPE_LABEL: Record<BlockType, string> = {
  heading: '标题',
  text: '正文',
  example: '例句',
  list: '列表',
  table: '表格',
  code: '代码',
  quote: '引用',
  tip: '提示',
};

/** 工具条里按钮的排列顺序（按「写卡片时最常用」排，不是类型定义的顺序） */
export const BLOCK_TYPE_ORDER: readonly BlockType[] = [
  'text',
  'heading',
  'example',
  'list',
  'table',
  'tip',
  'quote',
  'code',
];

/**
 * 渲染「新增块」工具条。
 *
 * @param onInsert 点某个类型时回调（参数是新建好的**空块**，已带 id 和骨架）
 */
export function renderInsertBar(onInsert: (block: Block) => void): HTMLElement {
  const bar = h('div', { class: 'kc-insert-bar' });
  bar.appendChild(h('span', { class: 'kc-insert-label', text: '新增块：' }));
  for (const type of BLOCK_TYPE_ORDER) {
    bar.appendChild(
      button(`＋${BLOCK_TYPE_LABEL[type]}`, () => onInsert(createBlock(type)), {
        variant: 'ghost',
        class: 'kc-insert-btn',
        title: `在末尾新增一个${BLOCK_TYPE_LABEL[type]}块`,
      }),
    );
  }
  return bar;
}

/** 题型名（给卡片编辑页的标签用；从 EXAM_TYPES 生成，不写死四种） */
export function examTypeLabel(id: string): string {
  return EXAM_TYPES.find((t) => t.id === id)?.name ?? id;
}
