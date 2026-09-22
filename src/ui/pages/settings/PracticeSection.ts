import { checkbox, h, select, textInput } from '../../dom';
import { currentSettings, patchSettings } from './ctx';

/** ★ T3：考核分组里「提示后算作未通过」的两个取值（用 radio 表达二选一更贴用户原话） */
const HINT_FAILS_OPTIONS = [
  { value: false, label: '否 —— 提示只是辅助，看答案对错（默认）' },
  { value: true, label: '是 —— 用了提示就记一次未通过' },
] as const;

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
          { value: 'centerTop', label: '居中偏上（默认，自动避开底部按钮）' },
          { value: 'origin', label: '原位置（保持在白纸上的位置）' },
        ],
        settings.memorize.position,
        (v) => {
          void patchSettings({ memorize: { ...currentSettings().memorize, position: v } }).then(renderOffset);
        },
      ),
      h(
        'span',
        { class: 'field-hint' },
        '进入「记忆」环节时，被抽到的词显示在哪里。两种模式都会把整块卡片夹在屏幕内' +
          '（原位置模式在手机上会被夹到最近的空白处，因为词分两列、卡片比词宽得多）。',
      ),
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

  // ── ★ T3：考核分组的「提示后算作未通过」──
  wrap.appendChild(h('div', { class: 'divider' }));
  wrap.appendChild(h('h4', { class: 'sub-title', text: '考核提示' }));

  /**
   * 单选组：用原生 radio 而不是下拉框。
   *
   * 为什么：这一项用户原话就是「是 / 否」两个选项，radio 让两个选项和它们的后果
   * 同时可见（下拉框要展开才看得到「否」是什么意思）。
   */
  const hintFailsBox = h('div', { class: 'radio-group' });
  hintFailsBox.dataset.role = 'hint-fails';
  for (const opt of HINT_FAILS_OPTIONS) {
    const input = h('input', {
      type: 'radio',
      name: 'hint-fails',
      value: opt.value ? 'yes' : 'no',
      checked: settings.practice.hintFails === opt.value,
    });
    input.addEventListener('change', () => {
      if (!input.checked) return;
      void patchSettings({ practice: { ...currentSettings().practice, hintFails: opt.value } });
    });
    hintFailsBox.appendChild(
      h('label', { class: 'radio-row' }, input, h('span', { text: opt.label })),
    );
  }
  wrap.appendChild(
    h(
      'div',
      { class: 'field' },
      h('span', { class: 'field-label', text: '提示后算作未通过' }),
      hintFailsBox,
      h(
        'span',
        { class: 'field-hint' },
        '说明：「提示」指考核卡片上的「🔊 朗诵一遍」。此规则**只对开启之后的考核生效**，' +
          '不会改变已记录的历史次数（拨动开关不会让任何旧数据变化）。默认「否」：' +
          '听了发音仍然要靠自己答对才算通过。',
      ),
    ),
  );

  return wrap;
}
