/**
 * 预设词库的导入确认框。
 *
 * 点预设按钮后先弹这个，而不是直接导入，有两个理由：
 *   1. 让用户在**导入前**能改优先度——优先级决定「已有词的义项会不会被覆盖」，
 *      事后改来源优先级不会补做合并，所以必须给一个改的机会；
 *   2. 几千个词直接进合并页容易让人以为已经入库了，先确认一下更稳。
 */
import type { PresetTier } from '../../../core/presets';
import { h } from '../../dom';
import { openModal } from '../../components/Modal';

/** 确认结果 */
export interface PresetConfirmResult {
  /** 用户确认导入 */
  confirmed: boolean;
  /** 用户填的优先级（已保证是合法数字） */
  priority: number;
}

/**
 * 打开预设导入确认框。
 * @param tier 选中的档位
 * @param opts.words 实际词条数（加载后才知道，可能与清单略有出入）
 * @param opts.senseCount 义项总数
 * @param opts.existing 该档位对应的来源是否已存在（存在则提示会更新优先度）
 */
export function confirmPresetImport(
  tier: PresetTier,
  opts: { words: number; senseCount: number; existing: { priority: number } | null },
): Promise<PresetConfirmResult> {
  return new Promise((resolve) => {
    let answered = false;

    const priorityInput = h('input', {
      class: 'input',
      type: 'number',
      min: '0',
      max: '999',
      value: String(opts.existing?.priority ?? tier.priority),
    });

    /** 读当前输入的优先级；非法就退回该档位默认值 */
    const readPriority = (): number => {
      const n = Number(priorityInput.value);
      if (!Number.isFinite(n)) return tier.priority;
      return Math.min(999, Math.max(0, Math.floor(n)));
    };

    const body = h(
      'div',
      {},
      h('p', {
        class: 'modal-text',
        text: `即将导入「${tier.sourceName}」，共 ${opts.words} 词、${opts.senseCount} 个义项。`,
      }),
      h(
        'p',
        {
          class: 'field-hint',
          text: '这些词表彼此不重复（四级里没有初中词、六级里没有四级词……），所以想背几档就挨个导入，顺序随便，重复导入同一档也不会建出重复的词。',
        },
      ),
      h(
        'label',
        { class: 'field' },
        h('span', { class: 'field-label', text: `来源名称：${tier.sourceName}` }),
        h('span', { class: 'field-label', text: '优先级' }),
        priorityInput,
        h('span', {
          class: 'field-hint',
          text:
            '数字越大越优先（方向可在设置页改）。优先级决定「同一个词在别的来源里已存在时，谁的义项被保留」——' +
            '所以它只在**导入那一刻**起作用：事后再改这个数字，已经合并好的义项不会重新合并。',
        }),
      ),
      opts.existing
        ? h('p', {
            class: 'note warn',
            text: `来源「${tier.sourceName}」已经存在（当前优先级 ${opts.existing.priority}）。继续导入会复用这个来源，并按上面填的数字更新它的优先级。`,
          })
        : null,
      h('p', {
        class: 'note',
        text: '导入后不会直接入库，会先进下一屏「确认义项并入库」，在那里逐词看一眼、确认完才真正写进词库。',
      }),
    );

    openModal({
      title: `导入预设词库 —— ${tier.label}`,
      width: '560px',
      body,
      actions: [
        { text: '取消', variant: 'ghost', onClick: (close) => close() },
        {
          text: '导入',
          variant: 'primary',
          onClick: (close) => {
            answered = true;
            resolve({ confirmed: true, priority: readPriority() });
            close();
          },
        },
      ],
      onClose: () => {
        if (!answered) resolve({ confirmed: false, priority: tier.priority });
      },
    });

    // 弹窗一出来就聚焦优先级，方便直接改
    window.setTimeout(() => priorityInput.focus(), 30);
  });
}
