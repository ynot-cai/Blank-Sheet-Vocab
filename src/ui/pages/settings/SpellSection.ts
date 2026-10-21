/**
 * 设置页「拼写强化」分组（版本 0.0.25）。
 *
 * 用户「四、选词与复习调度」：
 * - 「每次生成复习队列前，按优先级从高到低排序选词；队列长度可配置，词库不足时取实际数量。」
 * - 「权重参数应做成可配置，便于后续调参。」
 *
 * RULES-R1: 本文件只存设置值，不参与作答判定，也没有任何时间限制 / 倒计时。
 */
import { clampNum } from '../../../core/config';
import type { SpellSettings, SpellWeights } from '../../../core/types';
import { h, numberInput } from '../../dom';
import { currentSettings, patchSettings } from './ctx';

/** 权重可调区间（0 表示该项不参与排序） */
const WEIGHT_RANGE = { min: 0, max: 100 };

/** 权重字段的说明（顺序即展示顺序） */
const WEIGHT_FIELDS: { key: keyof SpellWeights; label: string; hint: string }[] = [
  { key: 'failRate', label: '失败率', hint: '失败次数 ÷ 考核次数（主程序已有的失败率）' },
  { key: 'days', label: '距上次复习天数', hint: '上次复习越久越优先（封顶 30 天）' },
  { key: 'attempts', label: '本功能出现次数', hint: '在拼写强化里被练过的次数' },
  { key: 'lowScore', label: '上次得分', hint: '上次得分越低越优先（按 5 − 上次得分 计）' },
  { key: 'wordPriority', label: '词级优先级', hint: '词的背诵优先级（P1~P5）' },
];

/**
 * 更新拼写强化设置的一个字段。
 * @param patch 要改的字段
 */
function patchSpell(patch: Partial<SpellSettings>): Promise<void> {
  return patchSettings({ spell: { ...currentSettings().spell, ...patch } });
}

/**
 * 更新一个权重。
 * @param key 权重名
 * @param value 新值
 */
function patchWeight(key: keyof SpellWeights, value: number): Promise<void> {
  const spell = currentSettings().spell;
  const cur = spell.weights[key];
  const next = Math.round(clampNum(value, WEIGHT_RANGE, cur) * 10) / 10;
  return patchSpell({ weights: { ...spell.weights, [key]: next } });
}

/** 渲染「拼写强化」分组 */
export function renderSpellSection(): HTMLElement {
  const wrap = h('div', { class: 'stack' });
  const spell = currentSettings().spell;

  // 每次复习词数
  wrap.appendChild(
    h(
      'label',
      { class: 'field' },
      h('span', { class: 'field-label', text: '每次复习词数' }),
      numberInput(spell.count, (v) => void patchSpell({ count: Math.round(clampNum(v, { min: 1, max: 999 }, spell.count)) }), {
        min: 1,
        max: 999,
      }),
      h('span', { class: 'field-hint', text: '每次「开始复习」按优先级选这么多个词；词库不足时取实际数量。' }),
    ),
  );

  // 权重
  wrap.appendChild(h('p', { class: 'field-label', text: '优先级权重（公式与主程序的复习优先度不同，这里可调参）' }));
  for (const field of WEIGHT_FIELDS) {
    const value = spell.weights[field.key];
    wrap.appendChild(
      h(
        'label',
        { class: 'field' },
        h('span', { class: 'field-label', text: field.label }),
        numberInput(value, (v) => void patchWeight(field.key, v), { min: WEIGHT_RANGE.min, max: WEIGHT_RANGE.max, step: 0.1 }),
        h('span', { class: 'field-hint', text: field.hint }),
      ),
    );
  }

  wrap.appendChild(
    h('p', {
      class: 'field-hint',
      text: '公式：失败率×权重 + 距上次复习天数×权重 + 出现次数×权重 + (5 − 上次得分)×权重 + 词级优先级×权重，从高到低排。',
    }),
  );
  return wrap;
}
