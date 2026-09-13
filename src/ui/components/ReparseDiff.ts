/**
 * R2「差异预览」弹窗：把 AI 重整理前后的义项结构摆在一起，让用户逐条勾选后再应用。
 *
 * 为什么必须有这一步（而不是整理完直接写库）：
 *   AI 整理义项**是有损的**——它可能把用户特意分开的义项合并、也可能改掉手写的例句。
 *   直接写库的话用户连"被改了什么"都看不到，只能事后一个个回去核对。
 *   先看差异、再决定应用哪些，是这一整套功能能被信任的前提。
 *
 * 界面按提示词 2.4 节的形态实现：
 *   ```
 *   整理完成：共 500 词，其中 312 词有变化
 *   ┌────────────────────────────────────┐
 *   │ abandon                            │
 *   │ 旧：放弃 | 抛弃 | 遗弃 | 舍弃        │  ← 灰色 + 删除线感
 *   │ 新：①放弃（抛弃、遗弃）②舍弃         │  ← 高亮
 *   └────────────────────────────────────┘
 *   （展示前 20 条，其余折叠）
 *   ```
 */
import type { Sense } from '../../core/types';
import { button, checkbox, h } from '../dom';
import { openModal } from './Modal';
import type { ReparseDiff } from '../../services/reparse';

/** 前多少条直接展示，其余折叠 */
const PREVIEW_LIMIT = 20;

/** 用户确认后的结果 */
export interface ReparseApplyResult {
  /** 要应用的词 id（勾选状态） */
  ids: string[];
  /** 用户是否点了「应用」（false = 取消/关闭） */
  confirmed: boolean;
}

/**
 * 把义项列表渲染成一行紧凑文本。
 * @param senses 义项
 */
function sensesBrief(senses: Sense[]): string {
  if (senses.length === 0) return '（无义项）';
  return senses
    .map((s) => (s.aliases.length > 0 ? `${s.text}（${s.aliases.join('、')}）` : s.text))
    .join(' ｜ ');
}

/**
 * 打开差异预览弹窗。
 *
 * @param diffs 全部差异（含没变化的；这里会自己过滤出变化的那些）
 * @param opts.onApplyProgress 应用进度回调（可选）
 * @returns 用户勾选并确认的应用列表
 */
export function openReparseDiff(
  diffs: ReparseDiff[],
  opts: { failedBatches: { index: number; error: string }[]; missingCount: number },
): Promise<ReparseApplyResult> {
  return new Promise((resolve) => {
    let answered = false;
    const changed = diffs.filter((d) => d.changed);
    /** 勾选状态：默认全选（用户点「应用」就是默认全应用，逐条取消才是例外） */
    const selected = new Set<string>(changed.map((d) => d.wordId));

    const summary = h('p', {
      class: 'note',
      text: `整理完成：共 ${diffs.length} 词，其中 ${changed.length} 词有变化。默认全部勾选，取消勾选即可跳过个别词。`,
    });

    const stats = h('p', { class: 'field-hint' });

    const refreshStats = (): void => {
      const senseChanges = changed.filter((d) => d.fields.includes('义项')).length;
      const phoneticChanges = changed.filter((d) => d.fields.includes('音标')).length;
      const exampleChanges = changed.filter((d) => d.fields.includes('例句')).length;
      stats.textContent =
        `其中义项变化 ${senseChanges} 个、补音标 ${phoneticChanges} 个、补例句 ${exampleChanges} 个；` +
        `已勾选 ${selected.size} 个。`;
    };

    /** 画一条差异卡片 */
    const renderCard = (diff: ReparseDiff): HTMLElement => {
      const card = h('div', { class: 'diff-card' });
      const head = h('div', { class: 'diff-head' });
      head.appendChild(
        checkbox(selected.has(diff.wordId), '', (checked) => {
          if (checked) selected.add(diff.wordId);
          else selected.delete(diff.wordId);
          refreshStats();
          applyBtn.textContent = `应用这 ${selected.size} 处修改`;
        }),
      );
      head.appendChild(h('strong', { text: diff.en }));
      for (const field of diff.fields) head.appendChild(h('span', { class: 'chip hint-chip', text: field }));
      card.appendChild(head);

      card.appendChild(h('div', { class: 'diff-old', text: `旧：${sensesBrief(diff.before.senses)}` }));
      card.appendChild(h('div', { class: 'diff-new', text: `新：${sensesBrief(diff.after.senses)}` }));
      // 音标 / 例句单独一行显示（有变化时才显示，避免噪音）
      if (diff.fields.includes('音标')) {
        card.appendChild(
          h('div', { class: 'field-hint', text: `音标：${diff.before.phonetic || '（空）'} → ${diff.after.phonetic || '（空）'}` }),
        );
      }
      if (diff.fields.includes('例句')) {
        card.appendChild(
          h('div', { class: 'field-hint', text: `例句：${diff.before.example || '（空）'} → ${diff.after.example || '（空）'}` }),
        );
      }
      return card;
    };

    const listBox = h('div', { class: 'reparse-diff' });
    const visible = changed.slice(0, PREVIEW_LIMIT);
    for (const diff of visible) listBox.appendChild(renderCard(diff));

    const body = h('div', { class: 'stack' }, summary, stats);
    if (changed.length === 0) {
      body.appendChild(h('p', { class: 'note warn' }, '这次整理没有产生任何变化（AI 返回的结构和现有数据一致）。'));
    } else {
      body.appendChild(listBox);
    }

    // 其余折叠
    if (changed.length > PREVIEW_LIMIT) {
      const restBox = h('div', { class: 'reparse-diff hidden' });
      for (const diff of changed.slice(PREVIEW_LIMIT)) restBox.appendChild(renderCard(diff));
      const restBtn = button(`展开其余 ${changed.length - PREVIEW_LIMIT} 条`, () => {
        const hidden = restBox.classList.toggle('hidden');
        restBtn.textContent = hidden ? `展开其余 ${changed.length - PREVIEW_LIMIT} 条` : '收起其余条目';
      });
      body.appendChild(restBtn);
      body.appendChild(restBox);
    }

    // 失败批次 / 漏词：明确列出来，不含糊过去
    if (opts.failedBatches.length > 0) {
      body.appendChild(
        h('p', {
          class: 'note warn',
          text:
            `${opts.failedBatches.length} 个批次失败了，那些词保持原样未整理：` +
            opts.failedBatches.map((b) => `第 ${b.index} 批（${b.error}）`).join('；'),
        }),
      );
    }
    if (opts.missingCount > 0) {
      body.appendChild(
        h('p', {
          class: 'note warn',
          text: `${opts.missingCount} 个词 AI 没有返回结果，已按「保留原样」处理（不会被删除）。`,
        }),
      );
    }

    const applyBtn = button(`应用这 ${selected.size} 处修改`, () => {
      answered = true;
      resolve({ ids: Array.from(selected), confirmed: true });
      handle.close();
    }, { variant: 'primary' });
    // 「应用」按钮挂在 body 底部，而**不**放进 openModal 的 actions：
    // actions 那一排是「取消/确认」的位置，两个都放进去视觉权重一样，
    // 用户很容易点错——「应用」会真的改几百条词库数据，值得单独一个显眼位置。
    body.appendChild(h('div', { class: 'row' }, applyBtn));

    const handle = openModal({
      title: '整理差异预览',
      width: '760px',
      body,
      actions: [
        {
          text: '取消（不写入）',
          variant: 'ghost',
          onClick: (close) => {
            answered = true;
            resolve({ ids: [], confirmed: false });
            close();
          },
        },
      ],
      onClose: () => {
        // 点遮罩 / 按 Esc / 点右上角 ✕ 关掉：一律按「取消」处理（不写库）
        if (answered) return;
        answered = true;
        resolve({ ids: [], confirmed: false });
      },
    });

    refreshStats();
  });
}
