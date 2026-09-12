import { checkbox, h, select, textInput } from '../../dom';
import { currentSettings, patchSettings } from './ctx';

/**
 * D 区：记忆与练习（记忆环节位置、朗读设置）。
 */
export function renderPracticeSection(): HTMLElement {
  const settings = currentSettings();
  const wrap = h('div', { class: 'stack' });

  const offsetBox = h('div', { class: 'stack' });
  const renderOffset = (): void => {
    offsetBox.replaceChildren();
    const memorize = currentSettings().memorize;
    if (memorize.position !== 'centerTop') return;
    const slider = h('input', {
      type: 'range',
      class: 'range',
      min: '0',
      max: '1',
      step: '0.05',
      value: String(memorize.offsetY),
    });
    const label = h('span', { class: 'field-hint', text: `垂直位置：距顶部 ${Math.round(memorize.offsetY * 100)}%` });
    slider.addEventListener('input', () => {
      label.textContent = `垂直位置：距顶部 ${Math.round(Number(slider.value) * 100)}%`;
    });
    slider.addEventListener('change', () =>
      void patchSettings({ memorize: { ...currentSettings().memorize, offsetY: Number(slider.value) } }),
    );
    offsetBox.appendChild(
      h('label', { class: 'field' }, h('span', { class: 'field-label', text: '垂直位置' }), slider, label),
    );
  };

  wrap.appendChild(
    h(
      'label',
      { class: 'field' },
      h('span', { class: 'field-label', text: '记忆环节单词位置' }),
      select(
        [
          { value: 'centerTop', label: '居中偏上（默认）' },
          { value: 'origin', label: '原位置（保持在白纸上的位置）' },
        ],
        settings.memorize.position,
        (v) => {
          void patchSettings({ memorize: { ...currentSettings().memorize, position: v } }).then(renderOffset);
        },
      ),
      h('span', { class: 'field-hint', text: '进入「记忆」环节时，被抽到的词显示在哪里' }),
    ),
  );
  wrap.appendChild(offsetBox);
  renderOffset();

  wrap.appendChild(h('div', { class: 'divider' }));
  wrap.appendChild(
    checkbox(settings.practice.autoSpeak, '自动朗读（单词出现时自动读一遍）', (v) =>
      void patchSettings({ practice: { ...currentSettings().practice, autoSpeak: v } }),
    ),
  );

  const rateSlider = h('input', {
    type: 'range',
    class: 'range',
    min: '0.5',
    max: '2',
    step: '0.1',
    value: String(settings.practice.speakRate),
  });
  const rateLabel = h('span', { class: 'field-hint', text: `语速：${settings.practice.speakRate.toFixed(1)}×` });
  rateSlider.addEventListener('input', () => {
    rateLabel.textContent = `语速：${Number(rateSlider.value).toFixed(1)}×`;
  });
  rateSlider.addEventListener('change', () =>
    void patchSettings({ practice: { ...currentSettings().practice, speakRate: Number(rateSlider.value) } }),
  );
  wrap.appendChild(h('label', { class: 'field' }, h('span', { class: 'field-label', text: '语速' }), rateSlider, rateLabel));

  wrap.appendChild(
    h(
      'label',
      { class: 'field' },
      h('span', { class: 'field-label', text: '发音语言' }),
      textInput(
        settings.practice.speakLang,
        (v) => void patchSettings({ practice: { ...currentSettings().practice, speakLang: v } }),
        { placeholder: 'en-US' },
      ),
      h('span', { class: 'field-hint', text: '一般用 en-US；想听英式可填 en-GB' }),
    ),
  );

  return wrap;
}
