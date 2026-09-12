import type { PaperSettings } from '../../../core/types';
import { button, checkbox, h, numberInput, select, textInput } from '../../dom';
import { currentSettings, patchSettings } from './ctx';

/** 纸张比例选项 */
const RATIOS: { value: PaperSettings['ratio']; label: string }[] = [
  { value: 'A4', label: 'A4（210:297）' },
  { value: '16:9', label: '16:9' },
  { value: '4:3', label: '4:3' },
];

/** 纸张模式说明 */
const MODE_HINT: Record<PaperSettings['mode'], string> = {
  auto: '自适应窗口：白纸跟着窗口大小走',
  ratio: '固定比例：按选定比例铺满窗口',
  fixed: '自定义像素：白纸固定成下面填的宽高',
};

/**
 * C 区：画面与纸张。改动会立刻反映到白纸页（阶段 05）。
 */
export function renderDisplaySection(): HTMLElement {
  const settings = currentSettings();
  const wrap = h('div', { class: 'stack' });

  // —— 纸张 ——
  const paperBox = h('div', { class: 'stack' });
  const renderPaperExtra = (): void => {
    paperBox.replaceChildren();
    const paper = currentSettings().paper;
    paperBox.appendChild(h('p', { class: 'field-hint', text: MODE_HINT[paper.mode] }));
    if (paper.mode === 'ratio') {
      paperBox.appendChild(
        h(
          'label',
          { class: 'field' },
          h('span', { class: 'field-label', text: '比例' }),
          select(RATIOS, paper.ratio, (v) => void patchSettings({ paper: { ...currentSettings().paper, ratio: v } })),
        ),
      );
    }
    if (paper.mode === 'fixed') {
      const row = h('div', { class: 'row' });
      row.appendChild(
        h(
          'label',
          { class: 'field' },
          h('span', { class: 'field-label', text: '宽度(px)' }),
          numberInput(paper.width, (v) => void patchSettings({ paper: { ...currentSettings().paper, width: v } }), {
            min: 320,
            max: 5000,
          }),
        ),
      );
      row.appendChild(
        h(
          'label',
          { class: 'field' },
          h('span', { class: 'field-label', text: '高度(px)' }),
          numberInput(paper.height, (v) => void patchSettings({ paper: { ...currentSettings().paper, height: v } }), {
            min: 240,
            max: 5000,
          }),
        ),
      );
      paperBox.appendChild(row);
    }
  };

  wrap.appendChild(
    h(
      'label',
      { class: 'field' },
      h('span', { class: 'field-label', text: '纸张' }),
      select(
        [
          { value: 'auto', label: '自适应窗口' },
          { value: 'ratio', label: '固定比例' },
          { value: 'fixed', label: '自定义像素' },
        ],
        settings.paper.mode,
        (v) => {
          void patchSettings({ paper: { ...currentSettings().paper, mode: v } }).then(renderPaperExtra);
        },
      ),
    ),
  );
  wrap.appendChild(paperBox);
  renderPaperExtra();

  // —— 显示 ——
  wrap.appendChild(h('div', { class: 'divider' }));
  wrap.appendChild(
    h(
      'label',
      { class: 'field' },
      h('span', { class: 'field-label', text: '字体' }),
      textInput(settings.display.fontFamily, (v) => void patchSettings({ display: { ...currentSettings().display, fontFamily: v } }), {
        placeholder: 'system-ui',
      }),
      h('span', { class: 'field-hint', text: '白纸上单词用的字体，例如 system-ui / Georgia / "Times New Roman"' }),
    ),
  );
  wrap.appendChild(
    h(
      'label',
      { class: 'field' },
      h('span', { class: 'field-label', text: '字号(px)' }),
      numberInput(
        settings.display.fontSize,
        (v) => void patchSettings({ display: { ...currentSettings().display, fontSize: v } }),
        { min: 10, max: 96 },
      ),
      h('span', { class: 'field-hint', text: '白纸上单词的基础字号' }),
    ),
  );

  const colorRow = h('div', { class: 'row' });
  const colorInput = h('input', { type: 'color', class: 'color-input', value: settings.display.wordColor });
  colorInput.addEventListener('input', () =>
    void patchSettings({ display: { ...currentSettings().display, wordColor: colorInput.value } }),
  );
  const bgInput = h('input', { type: 'color', class: 'color-input', value: settings.display.bgColor });
  bgInput.addEventListener('input', () =>
    void patchSettings({ display: { ...currentSettings().display, bgColor: bgInput.value } }),
  );
  colorRow.appendChild(h('span', { class: 'field-label', text: '单词颜色' }));
  colorRow.appendChild(colorInput);
  colorRow.appendChild(h('span', { class: 'field-label', text: '背景色' }));
  colorRow.appendChild(bgInput);
  colorRow.appendChild(
    button('恢复黑白', () => {
      void patchSettings({ display: { ...currentSettings().display, wordColor: '#111111', bgColor: '#ffffff' } });
    }),
  );
  wrap.appendChild(colorRow);

  wrap.appendChild(
    checkbox(settings.display.animation, '开启动效（白纸上的淡入/移动动画）', (v) =>
      void patchSettings({ display: { ...currentSettings().display, animation: v } }),
    ),
  );

  // —— 备案号占位（阶段 07）：自用默认留空 = 不显示 ——
  wrap.appendChild(
    h(
      'label',
      { class: 'field' },
      h('span', { class: 'field-label', text: '备案号（可选）' }),
      textInput(
        settings.display.beian ?? '',
        (v) => void patchSettings({ display: { ...currentSettings().display, beian: v } }),
        { placeholder: '留空则不显示（自用工具不需要）' },
      ),
      h('span', { class: 'field-hint', text: '填了才会显示在首页底部与「关于数据」页底部。将来真要公开时用得着。' }),
    ),
  );

  return wrap;
}
