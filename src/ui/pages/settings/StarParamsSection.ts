import { DEFAULTS } from '../../../core/config';
import type { Settings } from '../../../core/types';
import { h, numberInput, select } from '../../dom';
import { toastOk } from '../../components/Toast';
import { currentSettings, patchSettings } from './ctx';

/** 星号参数说明 */
const ITEMS: { key: keyof typeof DEFAULTS; label: string; hint: string }[] = [
  {
    key: 'memorizeMaxPick',
    label: '记忆一次最多抽几个',
    hint: `点一次「记忆」最多抽几个词（只抽已经出现在纸上的词；已出现不满这个数就只抽已出现的。上一轮没通过的词作为额外项加入，所以实际可能超过它；默认 ${DEFAULTS.memorizeMaxPick}）`,
  },
  {
    key: 'memorizeTargetCount',
    label: '每词至少记忆几次',
    hint: `每个词至少被「记忆」这么多遍，「背完了」按钮才会出现（默认 ${DEFAULTS.memorizeTargetCount} = 至少记一次）`,
  },
  {
    key: 'memorizeEvery',
    label: '每背几个词提示记忆',
    hint: `每点这么多次「再背一个」，「再背一个」按钮会自动变成「记忆」（默认 ${DEFAULTS.memorizeEvery}）`,
  },
  { key: 'failCountCap', label: '未通过次数上限', hint: `属性② 封顶值，超过后不再累加但仍按未通过处理（默认 ${DEFAULTS.failCountCap}）` },
  { key: 'reviewGroupSize', label: '复习每组上限', hint: `一次复习每组最多多少个词（默认 ${DEFAULTS.reviewGroupSize}）` },
];

/**
 * A 区：5 个星号参数（最重要，放最上面）+ R3 的背诵抽词顺序，改动即存。
 */
export function renderStarParamsSection(): HTMLElement {
  const settings = currentSettings();
  const wrap = h('div', { class: 'grid-2' });
  for (const item of ITEMS) {
    const input = numberInput(
      settings[item.key] as number,
      (v) => {
        void patchSettings({ [item.key]: Math.max(1, Math.floor(v)) } as Partial<Settings>).then(() =>
          toastOk(`已保存：${item.label} = ${Math.max(1, Math.floor(v))}`),
        );
      },
      { min: 1, max: 999 },
    );
    wrap.appendChild(h('label', { class: 'field' }, h('span', { class: 'field-label', text: `${item.label}` }), input, h('span', { class: 'field-hint', text: item.hint })));
  }

  // ★ R3：背诵抽词的同级内顺序。
  //   注意「优先级绝对优先」不在这里——那是硬规则，不给配置项：
  //   一旦能关掉，用户就会遇到「我设了优先级却没生效」而不知道是设置的问题。
  const orderSelect = select<'createdAt' | 'random'>(
    [
      { value: 'createdAt', label: '先录入的先背（可预测）' },
      { value: 'random', label: '同优先级内随机（每次会话不同）' },
    ],
    settings.learnPick.samePriorityOrder,
    (v) => {
      void patchSettings({ learnPick: { samePriorityOrder: v } }).then(() => toastOk('已保存：背诵抽词顺序'));
    },
  );
  wrap.appendChild(
    h(
      'label',
      { class: 'field' },
      h('span', { class: 'field-label', text: '背诵抽词：同优先级内的顺序' }),
      orderSelect,
      h('span', {
        class: 'field-hint',
        text: '优先级高的词**永远**先被抽到（5 → 4 → 3 → 2 → 1，绝对优先，不可关闭）；这里只决定同一优先级内部按什么顺序。',
      }),
    ),
  );

  return wrap;
}
