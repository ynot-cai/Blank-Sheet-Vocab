/**
 * 录入页的「预设词库」选择器。
 *
 * 五个按钮各对应一档内置词表。点一下就把整档词拉下来、直接进合并确认页——
 * 不需要粘贴文本，也不需要 AI 解析（词表里已经带好了义项）。
 *
 * ★ 各档之间**已经保证没有重复词**（见 scripts/preset-lib.mjs 的递归剔除），
 *   所以用户把几档都导入也不会出现「同一个词被两个来源争抢义项」。
 */
import { PRESET_TIERS } from '../../../core/presets';
import type { PresetTier } from '../../../core/presets';
import { button, h } from '../../dom';

/**
 * 渲染预设词库选择器。
 * @param onPick 选中一档后的回调（由录入页负责加载与跳转）
 * @param isBusy 当前是否有档位正在加载
 */
export function renderPresetPanel(onPick: (tier: PresetTier) => void, isBusy: () => boolean): HTMLElement {
  const box = h('div', { class: 'card' });
  box.appendChild(h('h3', { class: 'card-title', text: '0. 预设词库（一键导入）' }));
  box.appendChild(
    h('p', {
      class: 'note',
      text:
        '内置五套现成词表，点一下整档导入，不用自己找词表、也不用 AI 解析。' +
        '各档之间已经互不重复（比如四级里不会再有初中词），需要多背几档就挨个点一遍——' +
        '顺序随便，重复的词不会被建两次。',
    }),
  );

  const row = h('div', { class: 'row' });
  for (const tier of PRESET_TIERS) {
    row.appendChild(
      button(
        `${tier.label}（${tier.count} 词）`,
        () => {
          if (isBusy()) return;
          onPick(tier);
        },
        { variant: 'primary', title: `导入「${tier.sourceName}」，共 ${tier.count} 词` },
      ),
    );
  }
  box.appendChild(row);

  box.appendChild(
    h('p', {
      class: 'field-hint',
      text:
        '导入后会先进入下一屏逐词确认义项，确认完才真正入库；' +
        '已经导入过的档位再点一次也安全，已存在的词不会被重复创建。',
    }),
  );

  return box;
}
