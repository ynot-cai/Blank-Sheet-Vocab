import { DEFAULTS } from '../../../core/config';
import type { Settings } from '../../../core/types';
import { h, numberInput } from '../../dom';
import { toastOk } from '../../components/Toast';
import { currentSettings, patchSettings } from './ctx';

/** 星号参数说明 */
const ITEMS: { key: keyof typeof DEFAULTS; label: string; hint: string }[] = [
  {
    key: 'memorizeMaxPick',
    label: '记忆一次最多抽几个',
    hint: `点一次「记忆」最多抽几个词（只抽已经出现在纸上的词；默认 ${DEFAULTS.memorizeMaxPick}）`,
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
 * A 区：5 个星号参数（最重要，放最上面），改动即存。
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
  return wrap;
}
