/**
 * 单个块的**编辑控件**（按块类型给不同的输入方式）。
 *
 * 硬性要求（阶段 03 提示词）：
 * - **一律用 `textarea` / `input`，不用 `contenteditable`** ——
 *   用户从 Word/网页粘贴时会带一堆脏 HTML，`contenteditable` 会把它原样吃进去；
 *   输入框只会拿到纯文本，天然干净。
 * - 改一个字段只回调**新的块对象**（不改原对象），由调用方决定何时写库。
 * - 移动端：输入框字号 ≥16px（iOS 上小于 16px 会触发页面自动放大）。
 */
import type { Block } from '../../core/kcTypes';
import { button, h } from '../dom';
import { BLOCK_TYPE_LABEL } from './kcBlockTypes';

/** 回调：拿到改好的块 */
export type BlockChange = (next: Block) => void;

/** 建一个文本域（自动高度暂不做，长度可控） */
function area(value: string, placeholder: string, onInput: (v: string) => void, rows = 3): HTMLTextAreaElement {
  const el = h('textarea', { class: 'input kc-block-input', rows: String(rows), placeholder, value });
  el.addEventListener('input', () => onInput(el.value));
  return el;
}

/** 建一个单行输入框 */
function line(value: string, placeholder: string, onInput: (v: string) => void): HTMLInputElement {
  const el = h('input', { class: 'input kc-block-input', type: 'text', placeholder, value });
  el.addEventListener('input', () => onInput(el.value));
  return el;
}

/** 带小标题的字段行 */
function labeled(label: string, control: Node): HTMLElement {
  return h('label', { class: 'kc-field' }, h('span', { class: 'kc-field-label', text: label }), control);
}

/**
 * 文本型块（heading / text / quote / tip / code）的编辑控件。
 * @param block 块
 * @param onChange 变更回调
 */
function renderTextLike(block: Block, onChange: BlockChange): HTMLElement {
  const rows = block.type === 'heading' ? 1 : 3;
  const placeholder =
    block.type === 'code' ? '代码或结构标记（纯文本保存）' : block.type === 'heading' ? '小标题' : '正文内容';
  const box = h('div', { class: 'kc-block-edit-body' });
  box.appendChild(
    area(block.content ?? '', placeholder, (v) => onChange({ ...block, content: v }), rows),
  );
  if (block.type === 'code') {
    // lang 只作 CSS class（将来接高亮），所以这里提示它不能乱填
    box.appendChild(
      labeled('语言标记（可选，只用于样式）', line(block.lang ?? '', '如 js / text', (v) => onChange({ ...block, lang: v }))),
    );
  }
  return box;
}

/**
 * 例句块：英文 + 中文翻译 + 补充说明。
 * @param block 块
 * @param onChange 变更回调
 */
function renderExample(block: Block, onChange: BlockChange): HTMLElement {
  const box = h('div', { class: 'kc-block-edit-body' });
  box.appendChild(labeled('例句（英文）', area(block.content ?? '', 'This is the house where I lived.', (v) => onChange({ ...block, content: v }), 2)));
  box.appendChild(labeled('翻译（中文）', line(block.translation ?? '', '这是我住过的房子。', (v) => onChange({ ...block, translation: v }))));
  box.appendChild(labeled('补充说明（可选）', line(block.note ?? '', '如：注意 where 的先行词', (v) => onChange({ ...block, note: v }))));
  return box;
}

/**
 * 列表块：每项一个输入框，可增可删可上下移。
 * @param block 块
 * @param onChange 变更回调
 */
function renderList(block: Block, onChange: BlockChange): HTMLElement {
  const items = [...(block.items ?? [])];
  const box = h('div', { class: 'kc-block-edit-body' });
  /**
   * 取当前 DOM 里的宿主节点。
   * ⚠️ 理由同表格：外层 `paint()` 重建 DOM 后，闭包里的 `box` 已脱离文档，
   * 往它里面画页面不会变（**不要**改回直接用 `box`）。
   */
  const host = (): HTMLElement => {
    const live = box.isConnected ? box : (document.querySelector('.kc-list-edit-body') as HTMLElement | null);
    return live ?? box;
  };

  const repaint = (): void => {
    const target = host();
    target.replaceChildren();
    items.forEach((item, index) => {
      const row = h('div', { class: 'kc-row' });
      row.appendChild(line(item, `第 ${index + 1} 项`, (v) => {
        items[index] = v;
        onChange({ ...block, items: [...items] });
      }));
      row.appendChild(
        button('↑', () => {
          if (index === 0) return;
          const [moved] = items.splice(index, 1);
          items.splice(index - 1, 0, moved ?? '');
          onChange({ ...block, items: [...items] });
          repaint();
        }, { variant: 'ghost', class: 'kc-mini-btn', title: '上移' }),
      );
      row.appendChild(
        button('↓', () => {
          if (index === items.length - 1) return;
          const [moved] = items.splice(index, 1);
          items.splice(index + 1, 0, moved ?? '');
          onChange({ ...block, items: [...items] });
          repaint();
        }, { variant: 'ghost', class: 'kc-mini-btn', title: '下移' }),
      );
      row.appendChild(
        button('删', () => {
          items.splice(index, 1);
          onChange({ ...block, items: [...items] });
          repaint();
        }, { variant: 'ghost', class: 'kc-mini-btn kc-mini-btn--danger', title: '删掉这一项' }),
      );
      target.appendChild(row);
    });
    target.appendChild(
      button('＋加一项', () => {
        items.push('');
        onChange({ ...block, items: [...items] });
        repaint();
      }, { variant: 'ghost', class: 'kc-mini-btn' }),
    );
  };
  box.classList.add('kc-list-edit-body');
  repaint();
  return box;
}

/**
 * 表格块：简易网格，可增删行列。
 *
 * ★ **没有表头行**（用户明确要求，理由见 `core/blockRender.ts` 的 renderTable 注释）：
 * 所有格子都是普通数据格、用 `<td>`，第一行也不特殊。界面上也不再提示「第一行是表头」——
 * 那句话会诱导用户在第一行填一条表头，而渲染出来只是一行普通数据。
 *
 * 列宽按「最宽的一行」对齐，缺的格子补空串 —— 表格块的行列必须是**矩形**，
 * 否则渲染时列会对不齐（`blockRender` 是按最宽行补的，这里先补齐能让数据本身自洽）。
 * @param block 块
 * @param onChange 变更回调
 */
function renderTable(block: Block, onChange: BlockChange): HTMLElement {
  /** 当前网格（确保至少 1 行 1 列；只写了 1 行的表格是完全合法的，没有表头要凑） */
  const grid: string[][] = (block.rows ?? []).map((r) => [...r]);
  if (grid.length === 0) grid.push(['', '']);
  const cols = (): number => grid.reduce((max, r) => Math.max(max, r.length), 0);
  /** 把每行补齐到 cols() 列 */
  const normalize = (): void => {
    const w = cols();
    for (const row of grid) {
      while (row.length < w) row.push('');
    }
  };
  normalize();

  const box = h('div', { class: 'kc-block-edit-body' });
  /**
   * 重画表格。
   *
   * ⚠️ **不能用闭包里的 `box`**：外层 `BlockEditor.paint()` 会在「加块/移块/删块」时
   * 把整棵 DOM 重新建一遍，旧的 `box` 就从文档里脱离了 —— 往脱离的节点里画，
   * 页面什么都不变（这个 bug 被阶段 03 的界面冒烟抓到过：加行加列时表格纹丝不动）。
   * 所以这里每次都从**当前 DOM** 里重新取一遍自己的宿主节点。
   */
  const host = (): HTMLElement => {
    const live = box.isConnected ? box : (document.querySelector('.kc-table-edit')?.closest('.kc-block-edit-body') as HTMLElement | null);
    return live ?? box;
  };
  const repaint = (): void => {
    normalize();
    const target = host();
    target.replaceChildren();
    const table = h('table', { class: 'kc-table-edit' });
    grid.forEach((row, r) => {
      const tr = h('tr', {});
      row.forEach((cell, c) => {
        const td = h('td', {});
        td.appendChild(line(cell, `第 ${r + 1} 行第 ${c + 1} 列`, (v) => {
          row[c] = v;
          onChange({ ...block, rows: grid.map((x) => [...x]) });
        }));
        tr.appendChild(td);
      });
      // 行尾操作：删这一行
      const ops = h('td', { class: 'kc-table-edit-ops' });
      ops.appendChild(
        button('删行', () => {
          if (grid.length <= 1) return;
          grid.splice(r, 1);
          onChange({ ...block, rows: grid.map((x) => [...x]) });
          repaint();
        }, { variant: 'ghost', class: 'kc-mini-btn kc-mini-btn--danger' }),
      );
      tr.appendChild(ops);
      table.appendChild(tr);
    });
    target.appendChild(table);

    // 底部：加行 / 加列 / 删列
    const tools = h('div', { class: 'kc-table-tools' });
    tools.appendChild(
      button('＋加一行', () => {
        grid.push(new Array(cols()).fill(''));
        onChange({ ...block, rows: grid.map((x) => [...x]) });
        repaint();
      }, { variant: 'ghost', class: 'kc-mini-btn' }),
    );
    tools.appendChild(
      button('＋加一列', () => {
        for (const row of grid) row.push('');
        onChange({ ...block, rows: grid.map((x) => [...x]) });
        repaint();
      }, { variant: 'ghost', class: 'kc-mini-btn' }),
    );
    tools.appendChild(
      button('－删最后一列', () => {
        if (cols() <= 1) return;
        for (const row of grid) row.pop();
        onChange({ ...block, rows: grid.map((x) => [...x]) });
        repaint();
      }, { variant: 'ghost', class: 'kc-mini-btn kc-mini-btn--danger' }),
    );
    tools.appendChild(h('span', { class: 'kc-hint-dim', text: '表格不写表头，每行都是数据（一行一条对照）' }));
    target.appendChild(tools);
  };
  repaint();
  return box;
}

/**
 * 建一个块的编辑控件（按类型分发）。
 * @param block 块
 * @param onChange 变更回调
 */
export function renderBlockFields(block: Block, onChange: BlockChange): HTMLElement {
  switch (block.type) {
    case 'example':
      return renderExample(block, onChange);
    case 'list':
      return renderList(block, onChange);
    case 'table':
      return renderTable(block, onChange);
    default:
      return renderTextLike(block, onChange);
  }
}

/**
 * 块头部的类型标签（`＋标题` 那种按钮的文字来源同一份）。
 * @param block 块
 */
export function blockTypeTag(block: Block): HTMLElement {
  return h('span', { class: `kc-type-tag kc-type-tag--${block.type}`, text: BLOCK_TYPE_LABEL[block.type] ?? block.type });
}
