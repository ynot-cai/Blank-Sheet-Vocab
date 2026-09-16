/**
 * 设置页 · 布局参数（阶段 M2）。
 *
 * 为什么要有这一节：手机上一屏放几个词，完全由这几个数字决定——
 * 边距 / 间距 / 字号 / 目标数 / 按钮直径 / 按钮间距。
 * 之前它们散在算法和 CSS 里，用户觉得「手机上词太少」时**没有任何地方能调**；
 * 现在全部集中在这里（并且和 `#/dev/layout` 调试页读写同一份 `settings.layout.mobile`）。
 *
 * 改完即时生效：`patchSettings` 会刷新 core 的内存缓存，背诵页下次布点就用新值。
 */
import { DEFAULT_SETTINGS } from '../../../core/config';
import { controlBandHeight } from '../../../core/layout';
import type { LayoutTier } from '../../../core/types';
import { button, h, numberInput } from '../../dom';
import { currentSettings, patchSettings } from './ctx';

/** 可调项的说明（写在输入框下方，避免用户不知道该调大还是调小） */
const HINTS = {
  edgeMarginPx: '与纸面边界的最小距离（像素）。调小能多放词，太小会显得挤。',
  minGapPx: '相邻单词之间的最小空隙（像素）。这就是「不重叠」的底线，调小能多塞词。',
  fontSizePx: '手机上单词的字号（像素）。调小能多放词，但别低于 14。',
  targetCount: '希望一屏出现几个词。算法会尽量放下这么多，放不下时按实际最大值。',
  diameterPx: '底部圆形按钮的直径（像素）。至少 44 才好点。',
  gapPx: '底部按钮之间的横向间距（像素）。',
} as const;

/** 档位元信息 */
const TIERS: { key: 'mobile' | 'tablet' | 'desktop'; label: string; note: string }[] = [
  { key: 'mobile', label: '手机（<768px）', note: '★ M2 重构的就是这一档：按平均词宽定列数 + 底部圆形按钮' },
  { key: 'tablet', label: '平板（768~1024px）', note: '平板与桌面仍用原来的抖动网格算法，这里只影响避让区尺寸' },
  { key: 'desktop', label: '桌面（>1024px）', note: '桌面布局**故意保持原样**（用户要求），这一档基本不用动' },
];

/**
 * 渲染「布局参数」折叠块。
 */
export function renderLayoutSection(): HTMLElement {
  const wrap = h('div', { class: 'stack' });
  wrap.appendChild(
    h(
      'p',
      { class: 'note' },
      '这些数字直接决定「一屏能放几个词」。想边看边调就用调试页：地址栏访问 #/dev/layout（能同时看到包围盒与避让区）。',
    ),
  );

  for (const tier of TIERS) {
    const box = h('div', { class: 'stack' });
    wrap.appendChild(h('h4', { class: 'sub-title', text: tier.label }));
    wrap.appendChild(h('p', { class: 'field-hint', text: tier.note }));
    wrap.appendChild(box);
    const draw = (): void => {
      box.replaceChildren();
      const current = currentSettings().layout[tier.key];
      const row1 = h('div', { class: 'row' });
      const row2 = h('div', { class: 'row' });

      /** 改一个字段并写回设置 */
      const patch = (field: keyof LayoutTier, value: number): void => {
        void patchSettings({ layout: { [tier.key]: { [field]: value } } }).then(draw);
      };
      /** 改按钮里的一个字段 */
      const patchButton = (field: keyof LayoutTier['button'], value: number): void => {
        void patchSettings({ layout: { [tier.key]: { button: { [field]: value } } } }).then(draw);
      };

      row1.appendChild(
        h(
          'label',
          { class: 'field' },
          h('span', { class: 'field-label', text: '边距 px' }),
          numberInput(current.edgeMarginPx, (v) => patch('edgeMarginPx', v), { min: 0, max: 80, step: 1 }),
          h('span', { class: 'field-hint', text: HINTS.edgeMarginPx }),
        ),
      );
      row1.appendChild(
        h(
          'label',
          { class: 'field' },
          h('span', { class: 'field-label', text: '间距 px' }),
          numberInput(current.minGapPx, (v) => patch('minGapPx', v), { min: 0, max: 60, step: 1 }),
          h('span', { class: 'field-hint', text: HINTS.minGapPx }),
        ),
      );
      row2.appendChild(
        h(
          'label',
          { class: 'field' },
          h('span', { class: 'field-label', text: '字号 px' }),
          numberInput(current.fontSizePx, (v) => patch('fontSizePx', v), { min: 10, max: 48, step: 1 }),
          h('span', { class: 'field-hint', text: HINTS.fontSizePx }),
        ),
      );
      row2.appendChild(
        h(
          'label',
          { class: 'field' },
          h('span', { class: 'field-label', text: '目标词数' }),
          numberInput(current.targetCount, (v) => patch('targetCount', v), { min: 4, max: 60, step: 1 }),
          h('span', { class: 'field-hint', text: HINTS.targetCount }),
        ),
      );
      box.appendChild(row1);
      box.appendChild(row2);

      const row3 = h('div', { class: 'row' });
      row3.appendChild(
        h(
          'label',
          { class: 'field' },
          h('span', { class: 'field-label', text: '按钮直径 px' }),
          numberInput(current.button.diameterPx, (v) => patchButton('diameterPx', v), { min: 32, max: 96, step: 1 }),
          h('span', { class: 'field-hint', text: HINTS.diameterPx }),
        ),
      );
      row3.appendChild(
        h(
          'label',
          { class: 'field' },
          h('span', { class: 'field-label', text: '按钮间距 px' }),
          numberInput(current.button.gapPx, (v) => patchButton('gapPx', v), { min: 0, max: 60, step: 1 }),
          h('span', { class: 'field-hint', text: HINTS.gapPx }),
        ),
      );
      box.appendChild(row3);

      // 按钮带占多高 = 布点要避让多少，直接显示出来（用户能看懂「为什么底部不能放词」）
      const band = controlBandHeight(current);
      box.appendChild(
        h('p', { class: 'field-hint' }, `底部按钮带占 ${band}px 高、整屏宽 —— 这条带子里不会布点，其余区域都能放词。`),
      );
      box.appendChild(
        button(
          '恢复这一档的默认值',
          () => {
            const def = DEFAULT_SETTINGS.layout[tier.key];
            void patchSettings({ layout: { [tier.key]: def } }).then(draw);
          },
          { variant: 'ghost' },
        ),
      );
    };
    draw();
  }

  return wrap;
}
