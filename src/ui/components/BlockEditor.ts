/**
 * 块编辑器（阶段 03）：8 种块的新建 / 编辑 / 上移下移 / 复制 / 删除 / 预览切换。
 *
 * ══════════════════════════════════════════════════════════════
 * 三条硬性要求（来自阶段 03 提示词）
 * ══════════════════════════════════════════════════════════════
 * 1. **不用 `contenteditable`**，一律 `textarea` / `input`（见 `KcBlockFields` 的注释）；
 * 2. **改动实时通过 `onChange` 回调**，由调用方决定何时写库（本组件不碰数据库）；
 * 3. 移动端按钮热区 ≥44px、输入框字号 ≥16px（字号在 kc.css 里统一设）。
 *
 * 组件本身**无状态**：传入 blocks，改动时回调新的数组。
 * 调用方（卡片编辑页）负责防抖落库 —— 这样编辑器也能被将来的学习流程复用。
 */
import { renderBlocks } from '../../core/blockRender';
import { coerceBlock, newId } from '../../core/kcModel';
import type { Block } from '../../core/kcTypes';
import { button, h } from '../dom';
import { blockTypeTag, renderBlockFields } from './KcBlockFields';
import { renderInsertBar } from './kcBlockTypes';

/** 渲染参数 */
export interface BlockEditorOptions {
  /** 紧凑模式（阶段 04 学习流程里可能用得上：只显示内容，不显示工具条） */
  compact?: boolean;
}

/**
 * 渲染块编辑器。
 *
 * @param blocks 当前块数组
 * @param onChange 改动回调（拿到**新的数组**，不改原数组）
 * @param opts 选项（见 `BlockEditorOptions`）
 */
export function renderBlockEditor(
  blocks: Block[],
  onChange: (next: Block[]) => void,
  opts: BlockEditorOptions = {},
): HTMLElement {
  const root = h('div', { class: `kc-editor${opts.compact === true ? ' kc-editor--compact' : ''}` });
  /** 本地工作副本：改动先落这里，再整体回调出去 */
  let current: Block[] = blocks.map((b) => ({ ...b }));
  /** 预览开关（打开后用 renderBlocks 渲染最终效果） */
  let previewing = false;

  /** 提交改动（复制一份出去，避免调用方持有内部引用） */
  const emit = (next: Block[]): void => {
    current = next;
    onChange(next.map((b) => ({ ...b })));
  };

  /** 重画 */
  const paint = (): void => {
    root.replaceChildren();

    // ── 顶部：预览开关 ──
    const head = h('div', { class: 'kc-editor-head' });
    const previewBtn = button(previewing ? '回到编辑' : '预览', () => {
      previewing = !previewing;
      paint();
    }, { variant: previewing ? 'primary' : 'ghost' });
    head.appendChild(previewBtn);
    head.appendChild(h('span', { class: 'kc-editor-count', text: `共 ${current.length} 个块` }));
    root.appendChild(head);

    // ── 预览模式：只读渲染（与最终展示完全同一套渲染，所见即所得） ──
    if (previewing) {
      const box = h('div', { class: 'kc-editor-preview kc-blocks' });
      if (current.length === 0) {
        box.appendChild(h('p', { class: 'kc-hint-dim', text: '还没有任何块。' }));
      } else {
        box.appendChild(renderBlocks(current));
      }
      root.appendChild(box);
      return;
    }

    // ── 编辑模式：逐块一行 ──
    if (current.length === 0) {
      root.appendChild(h('p', { class: 'kc-hint-dim', text: '还没有任何块，用下面的按钮加一个。' }));
    }
    current.forEach((block, index) => {
      root.appendChild(renderBlockRow(block, index));
    });

    // ── 底部工具条：新增块 ──
    if (opts.compact !== true) {
      root.appendChild(
        renderInsertBar((blank) => {
          emit([...current, blank]);
          paint();
        }),
      );
    }
  };

  /**
   * 渲染一个块（头部工具 + 编辑控件）。
   * @param block 块
   * @param index 下标
   */
  function renderBlockRow(block: Block, index: number): HTMLElement {
    const row = h('section', { class: `kc-editor-block kc-editor-block--${block.type}` });

    // 头部：类型标签 + 操作按钮
    const head = h('div', { class: 'kc-editor-block-head' });
    head.appendChild(blockTypeTag(block));
    const tools = h('div', { class: 'kc-editor-block-tools' });

    tools.appendChild(
      button('↑', () => {
        if (index === 0) return;
        const next = [...current];
        const [moved] = next.splice(index, 1);
        next.splice(index - 1, 0, moved as Block);
        emit(next);
        paint();
      }, { variant: 'ghost', class: 'kc-mini-btn', title: '上移' }),
    );
    tools.appendChild(
      button('↓', () => {
        if (index === current.length - 1) return;
        const next = [...current];
        const [moved] = next.splice(index, 1);
        next.splice(index + 1, 0, moved as Block);
        emit(next);
        paint();
      }, { variant: 'ghost', class: 'kc-mini-btn', title: '下移' }),
    );
    tools.appendChild(
      button('复制', () => {
        // 复制要换新 id，否则两个块的 key 会撞（渲染没问题，但将来做拖拽会出鬼）
        const copy = { ...structuredCloneBlock(block), id: newId() };
        const next = [...current];
        next.splice(index + 1, 0, copy);
        emit(next);
        paint();
      }, { variant: 'ghost', class: 'kc-mini-btn', title: '在下面复制一个同样的块' }),
    );
    tools.appendChild(
      button('删除', () => {
        // 二次确认：块是用户手写的内容，误删最心疼
        if (!window.confirm(`确定删除这个「${block.type}」块？`)) return;
        const next = current.filter((_b, i) => i !== index);
        emit(next);
        paint();
      }, { variant: 'ghost', class: 'kc-mini-btn kc-mini-btn--danger', title: '删除这个块' }),
    );
    head.appendChild(tools);
    row.appendChild(head);

    // 编辑控件：改动只换这一个块，其它块保持不变
    row.appendChild(
      renderBlockFields(block, (next) => {
        emit(current.map((b, i) => (i === index ? next : b)));
        // 注意：这里**不重画** —— 重画会让输入框失焦（每敲一个字就跳出去）。
        // 块内部的增删（列表项/表格行列）由各自控件自己 repaint。
      }),
    );
    return row;
  }

  paint();
  return root;
}

/**
 * 深拷贝一个块（列表项、表格行都是数组，浅拷贝会让复制出来的块和原块共享引用）。
 * @param b 块
 */
function structuredCloneBlock(b: Block): Block {
  // 用 coerceBlock 兜一层：既深拷贝，又顺手清掉非法字段（它本来就做归一化）
  return coerceBlock(JSON.parse(JSON.stringify(b)) as unknown) ?? { id: newId(), type: 'text', content: '' };
}
