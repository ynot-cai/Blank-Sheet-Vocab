/**
 * 录入页的「预设词库」选择器。
 *
 * 点一下（比如「四级」）做的事：
 *   1. 把那一档的词表拉下来；
 *   2. **把词表粘贴到下面那个编辑框里**（就是录入功能本来就有的那个文本栏，不另建）；
 *   3. 切到「粘贴文本」页签，让你看见它已经填好了，并带出该档的来源名与一个合理的优先级；
 *   4. 后面的步骤和手打文本**完全一样**：点「开始解析」→ AI 把一切过一遍 → 合并确认 → 入库。
 *
 * ★ 预设词表里的义项是原始词表直接生成的（一个词往往只有一条、塞着一整串中文），
 *   所以才要 MUST 走一遍 AI：让 AI 按《资料整理规范》分类义项、挑代表词、把近义词逐个分开。
 *   这也是「点预设不再弹确认框、直接进编辑框」的原因——确认框会绕过 AI 这一步。
 *
 * ★ 各档之间**已经保证没有重复词**（见 scripts/preset-lib.mjs 的递归剔除），
 *   所以挨个点几档也不会出现「同一个词被两个来源争抢义项」。
 */
import { PRESET_TIERS } from '../../../core/presets';
import type { PresetTier } from '../../../core/presets';
import { button, h } from '../../dom';

/**
 * 渲染预设词库选择器。
 * @param onPick 选中一档后的回调（由录入页负责加载词表并粘进编辑框）
 * @param isBusy 当前是否有档位正在加载
 */
export function renderPresetPanel(onPick: (tier: PresetTier) => void, isBusy: () => boolean): HTMLElement {
  const box = h('div', { class: 'card' });
  box.appendChild(h('h3', { class: 'card-title', text: '0. 预设词库' }));
  box.appendChild(
    h('p', {
      class: 'note',
      text:
        '内置五套现成词表。点一下会把这一档的词表**直接填进下面的文本栏**，' +
        '然后你点「开始解析」，让 AI 把义项重新整理一遍，再入库。',
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
        { variant: 'primary', title: `把「${tier.sourceName}」的 ${tier.count} 词填进文本栏` },
      ),
    );
  }
  box.appendChild(row);

  box.appendChild(
    h('p', {
      class: 'field-hint',
      text:
        '各档之间互不重复（比如四级里不会再有初中词），需要多背几档就挨个点一遍——顺序随便，' +
        '已经导入过的词再点一次也安全。填进文本栏后可以自己改，改完再点「开始解析」。',
    }),
  );

  return box;
}
