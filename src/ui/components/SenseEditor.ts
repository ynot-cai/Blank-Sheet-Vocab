import { createSense } from '../../core/model';
import type { Sense } from '../../core/types';
import { button, h, type DomChild } from '../dom';
import { promptModal } from './Modal';

/** 义项编辑器参数 */
export interface SenseEditorOptions {
  /** 只读（记忆环节的答案卡用） */
  readonly?: boolean;
  /** 紧凑模式（列表页表格里用） */
  compact?: boolean;
}

/**
 * 义项编辑组件：划掉 / 合并到上一项 / 加近义词 / 删除。
 * 供 MergePage、WordCard、ListPage 三处复用。
 * @param senses 初始义项
 * @param onChange 每次改动后回调最新义项数组（已复制，可直接入库）
 * @param opts 只读 / 紧凑
 */
export function renderSenseEditor(
  senses: Sense[],
  onChange: (next: Sense[]) => void,
  opts: SenseEditorOptions = {},
): HTMLElement {
  const wrap = h('div', { class: `sense-editor${opts.compact ? ' compact' : ''}` });
  let current: Sense[] = senses.map((s) => ({ ...s, aliases: [...s.aliases] }));

  const commit = (next: Sense[], redraw = true): void => {
    current = next;
    onChange(next.map((s) => ({ ...s, aliases: [...s.aliases] })));
    if (redraw) draw();
  };

  /** 添加近义词 */
  const addAlias = async (index: number): Promise<void> => {
    const value = await promptModal('添加近义词', '输入一个近义词或等价说法（记忆判分时视为通过）');
    if (!value) return;
    const next = current.map((s, i) => (i === index ? { ...s, aliases: [...s.aliases, value] } : s));
    commit(next);
  };

  /** 合并到上一项 */
  const mergeUp = (index: number): void => {
    const target = current[index];
    const prev = current[index - 1];
    if (!target || !prev) return;
    const merged: Sense = { ...prev, aliases: [...prev.aliases, target.text, ...target.aliases] };
    const next = current.filter((_, i) => i !== index).map((s, i) => (i === index - 1 ? merged : s));
    commit(next);
  };

  /** 删除 */
  const removeAt = (index: number): void => {
    commit(current.filter((_, i) => i !== index));
  };

  /** 添加空白义项 */
  const addSense = (): void => {
    commit([...current, createSense('')]);
  };

  /** 渲染一行义项 */
  const renderRow = (sense: Sense, index: number): HTMLElement => {
    const row = h('div', { class: `sense-row${sense.enabled ? '' : ' disabled'}` });

    if (!opts.readonly) {
      const check = h('input', { type: 'checkbox', checked: sense.enabled, title: '取消勾选 = 划掉该义项' });
      check.addEventListener('change', () => {
        commit(current.map((s, i) => (i === index ? { ...s, enabled: check.checked } : s)));
      });
      row.appendChild(check);
    }

    if (opts.readonly) {
      row.appendChild(h('span', { class: 'sense-text', text: sense.text }));
    } else {
      const input = h('input', { class: 'input sense-input', type: 'text', value: sense.text });
      input.addEventListener('input', () => {
        // 只更新文本，不重画（否则输入框会失焦）
        current = current.map((s, i) => (i === index ? { ...s, text: input.value } : s));
        onChange(current.map((s) => ({ ...s, aliases: [...s.aliases] })));
      });
      row.appendChild(input);
    }

    const aliasBox = h('span', { class: 'alias-box' });
    sense.aliases.forEach((alias, aliasIndex) => {
      const chip = h('span', { class: 'chip', title: '近义词（判分时视为通过）' }, alias);
      if (!opts.readonly) {
        const del = h('button', { class: 'chip-x', type: 'button', text: '×', title: '删除该近义词' });
        del.addEventListener('click', () => {
          commit(
            current.map((s, i) =>
              i === index ? { ...s, aliases: s.aliases.filter((_, ai) => ai !== aliasIndex) } : s,
            ),
          );
        });
        chip.appendChild(del);
      }
      aliasBox.appendChild(chip);
    });
    if (!opts.readonly) {
      aliasBox.appendChild(button('+ 近义词', () => void addAlias(index), { variant: 'ghost', class: 'mini' }));
    }
    row.appendChild(aliasBox);

    if (!opts.readonly) {
      const tools: DomChild[] = [];
      tools.push(
        button('合并到上一项', () => mergeUp(index), {
          variant: 'ghost',
          class: 'mini',
          title: '把这一项变成上一项的近义词，并从列表移除',
        }),
      );
      tools.push(button('删除', () => removeAt(index), { variant: 'danger', class: 'mini' }));
      const toolBox = h('span', { class: 'sense-tools' });
      for (const t of tools) toolBox.appendChild(t as Node);
      if (index === 0) (toolBox.firstElementChild as HTMLButtonElement | null)?.setAttribute('disabled', 'true');
      row.appendChild(toolBox);
    }

    return row;
  };

  /** 整体重画 */
  function draw(): void {
    wrap.replaceChildren();
    current.forEach((sense, index) => wrap.appendChild(renderRow(sense, index)));
    if (!opts.readonly) wrap.appendChild(button('+ 添加义项', addSense, { variant: 'ghost', class: 'mini' }));
  }

  draw();
  return wrap;
}
