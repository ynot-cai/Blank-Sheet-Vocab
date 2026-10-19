/**
 * 设置页「外观」分组（版本 0.0.19）。
 *
 * ★ 用户提示词 10 第 2 条，本分组只放两项：
 *   1. **分辨率大小**：提供可调的分辨率尺寸选项；
 *   2. **字体大小**：影响白纸界面本体（单词 / 中文含义 / 按钮 / 义项数角标 / 统计信息）
 *      的显示大小，且它们之间的相对大小比例保持不变；单词卡等弹窗不受影响。
 *
 * ── 为什么分辨率写进 `settings.paper` 而不是新造字段 ──
 * 旧版归档（`已归档/11` 的 DisplaySection「画面与纸张」）已经用
 * `paper.mode / ratio / width / height` 表达过纸张尺寸，`resolvePaperSize()` 也一直在读它。
 * 再造一份「分辨率」字段就等于同一个东西存两处，改一处漏一处。
 * 所以这里只是把旧字段包装成「分辨率大小」下拉：自适应窗口 = `mode: 'auto'`，
 * 具体尺寸 = `mode: 'fixed'` + 宽高（自定义时给出宽高输入框，与旧版做法一致）。
 */
import { clampNum, PAPER_FONT_SIZE_RANGE, PAPER_RESOLUTIONS, resolutionValueOf } from '../../../core/config';
import type { PaperSettings } from '../../../core/types';
import { h, numberInput, select } from '../../dom';
import { currentSettings, patchSettings } from './ctx';

/** 自定义尺寸时的宽 / 高区间（与旧版 DisplaySection 的输入框范围一致） */
const WIDTH_RANGE = { min: 320, max: 5000 };
const HEIGHT_RANGE = { min: 240, max: 5000 };

/**
 * 写一份新的纸张设置（只覆盖分辨率相关的四个字段）。
 * @param patch 要合并进 `paper` 的字段
 */
function patchPaper(patch: Partial<PaperSettings>): Promise<void> {
  return patchSettings({ paper: { ...currentSettings().paper, ...patch } });
}

/**
 * 渲染「外观」分组。
 */
export function renderAppearanceSection(): HTMLElement {
  const wrap = h('div', { class: 'stack' });
  wrap.dataset.role = 'appearance-settings';

  // ─── 分辨率大小 ───
  const resBox = h('div', { class: 'stack' });

  /** 重画「自定义尺寸」的两个输入框（只在选了自定义时出现） */
  const renderCustomSize = (): void => {
    resBox.replaceChildren();
    const paper = currentSettings().paper;
    if (paper.mode !== 'fixed' || resolutionValueOf(paper) !== 'custom') return;
    const row = h('div', { class: 'row' });
    row.appendChild(
      h(
        'label',
        { class: 'field' },
        h('span', { class: 'field-label', text: '宽度(px)' }),
        numberInput(paper.width, (v) => void patchPaper({ width: clampNum(v, WIDTH_RANGE, paper.width) }), {
          min: WIDTH_RANGE.min,
          max: WIDTH_RANGE.max,
        }),
      ),
    );
    row.appendChild(
      h(
        'label',
        { class: 'field' },
        h('span', { class: 'field-label', text: '高度(px)' }),
        numberInput(paper.height, (v) => void patchPaper({ height: clampNum(v, HEIGHT_RANGE, paper.height) }), {
          min: HEIGHT_RANGE.min,
          max: HEIGHT_RANGE.max,
        }),
      ),
    );
    resBox.appendChild(row);
  };

  const options = PAPER_RESOLUTIONS.map((r) => ({ value: r.value, label: r.label }));
  wrap.appendChild(
    h(
      'label',
      { class: 'field' },
      h('span', { class: 'field-label', text: '分辨率大小' }),
      select(options, resolutionValueOf(currentSettings().paper), (v) => {
        const preset = PAPER_RESOLUTIONS.find((r) => r.value === v);
        if (!preset) return;
        void (async () => {
          if (v === 'auto') await patchPaper({ mode: 'auto' });
          else if (v === 'custom') await patchPaper({ mode: 'fixed' });
          else await patchPaper({ mode: 'fixed', width: preset.width, height: preset.height });
          renderCustomSize();
        })();
      }),
      h('span', { class: 'field-hint', text: '白纸画布的尺寸：调大后一屏能摆下更多、更小的字。' }),
    ),
  );
  wrap.appendChild(resBox);
  renderCustomSize();

  // ─── 字体大小 ───
  wrap.appendChild(h('div', { class: 'divider' }));
  const font = currentSettings().display.fontSize;
  wrap.appendChild(
    h(
      'label',
      { class: 'field' },
      h('span', { class: 'field-label', text: '字体大小' }),
      numberInput(
        font,
        (v) => {
          const next = Math.round(clampNum(v, PAPER_FONT_SIZE_RANGE, font));
          void patchSettings({ display: { ...currentSettings().display, fontSize: next } });
        },
        { min: PAPER_FONT_SIZE_RANGE.min, max: PAPER_FONT_SIZE_RANGE.max, step: 1 },
      ),
      h(
        'span',
        { class: 'field-hint' },
        '影响白纸界面本体：单词、中文含义、按钮、义项数角标、统计信息（相对比例不变）。单词卡等弹窗不受影响。',
      ),
    ),
  );

  return wrap;
}
