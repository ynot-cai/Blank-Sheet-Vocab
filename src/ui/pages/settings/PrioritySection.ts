import { PRESETS, activeExpr, computePriority, validateExpr } from '../../../core/priority';
import type { PriorityPreset, Settings } from '../../../core/types';
import * as dao from '../../../dao';
import { button, h, select } from '../../dom';
import { toastError, toastOk } from '../../components/Toast';
import { currentSettings, patchSettings } from './ctx';

/** 可点击插入的变量 */
const VAR_CHIPS = [
  'needSpell',
  'failCount',
  'failCountTotal',
  'reviewCount',
  'daysSinceReview',
  'daysSinceLearned',
];

/**
 * E 区：复习优先度（三个预设 + 自定义表达式 + 试算）。
 */
export function renderPrioritySection(): HTMLElement {
  const settings = currentSettings();
  const wrap = h('div', { class: 'stack' });

  const isCustom = settings.priority.customExpr.trim() !== '';
  const modeSelect = select<'preset' | 'custom'>(
    [
      { value: 'preset', label: '使用预设（推荐）' },
      { value: 'custom', label: '自定义表达式' },
    ],
    isCustom ? 'custom' : 'preset',
    (v) => {
      if (v === 'custom') {
        void patchSettings({
          priority: { ...currentSettings().priority, customExpr: textarea.value.trim() || 'failCount * 10 + daysSinceReview' },
        }).then(() => toastOk('已切到自定义表达式，可直接编辑'));
        textarea.value = textarea.value.trim() || 'failCount * 10 + daysSinceReview';
        customBox.classList.remove('hidden');
      } else {
        void patchSettings({ priority: { ...currentSettings().priority, customExpr: '' } });
        customBox.classList.add('hidden');
        exprPreview.textContent = PRESETS[currentSettings().priority.preset].expr;
        toastOk('已切回预设');
      }
    },
  );

  // —— 预设选择 ——
  const presetSelect = select<PriorityPreset>(
    (Object.keys(PRESETS) as PriorityPreset[]).map((k) => ({ value: k, label: `${PRESETS[k].name} —— ${PRESETS[k].desc}` })),
    settings.priority.preset,
    (v) => {
      void patchSettings({ priority: { ...currentSettings().priority, preset: v, customExpr: '' } });
      exprPreview.textContent = PRESETS[v].expr;
      customBox.classList.add('hidden');
      modeSelect.value = 'preset';
      toastOk(`已切换到预设：${PRESETS[v].name}`);
    },
  );

  const exprPreview = h('code', { class: 'expr-preview', text: activeExpr(settings) });

  wrap.appendChild(h('label', { class: 'field' }, h('span', { class: 'field-label', text: '优先度来源' }), modeSelect));
  wrap.appendChild(h('label', { class: 'field' }, h('span', { class: 'field-label', text: '预设' }), presetSelect));
  wrap.appendChild(h('div', { class: 'field' }, h('span', { class: 'field-label', text: '当前生效的表达式' }), exprPreview));

  // —— 自定义 ——
  const textarea = h('textarea', { class: 'input expr-input', rows: '3', text: settings.priority.customExpr });
  const chipBox = h('div', { class: 'chips' });
  for (const chip of VAR_CHIPS) {
    chipBox.appendChild(
      button(chip, () => {
        const start = textarea.selectionStart ?? textarea.value.length;
        textarea.value = `${textarea.value.slice(0, start)}${chip}${textarea.value.slice(start)}`;
        textarea.focus();
      }, { variant: 'ghost', class: 'mini' }),
    );
  }

  const checkLine = h('div', { class: 'test-result' });
  const saveBtn = button(
    '保存表达式',
    () => {
      const expr = textarea.value.trim();
      const check = validateExpr(expr);
      if (!check.ok) {
        checkLine.className = 'test-result bad';
        checkLine.textContent = `表达式非法：${check.message}`;
        toastError(`表达式非法：${check.message}`);
        return;
      }
      void patchSettings({ priority: { ...currentSettings().priority, preset: 'balanced', customExpr: expr } });
      exprPreview.textContent = expr;
      checkLine.className = 'test-result ok';
      checkLine.textContent = '表达式已保存';
      toastOk('表达式已保存');
    },
    { variant: 'primary' },
  );

  const calcBox = h('div', { class: 'stack' });
  const calcBtn = button(
    '试算（拿词库前 5 个词算一遍）',
    () => {
      void (async () => {
        calcBox.replaceChildren(h('p', { class: 'field-hint', text: '计算中…' }));
        const exprNow = modeSelect.value === 'custom' ? textarea.value : activeExpr(currentSettings());
        const check = validateExpr(exprNow);
        if (!check.ok) {
          calcBox.replaceChildren(h('p', { class: 'test-result bad', text: `表达式非法：${check.message}` }));
          return;
        }
        const { items } = await dao.words.query({ page: 1, pageSize: 5, sort: 'createdAt', order: 'desc' });
        if (items.length === 0) {
          calcBox.replaceChildren(h('p', { class: 'field-hint', text: '词库还是空的，先去「录入」页加几个词' }));
          return;
        }
        const table = h('table', { class: 'table' });
        table.appendChild(
          h('thead', {}, h('tr', {}, h('th', { text: '单词' }), h('th', { text: '优先度' }), h('th', { text: '未通过 / 复习次数' }))),
        );
        const tbody = h('tbody');
        const settingsNow: Settings = { ...currentSettings(), priority: { ...currentSettings().priority, customExpr: modeSelect.value === 'custom' ? exprNow : '' } };
        for (const w of items) {
          const value = computePriority(w, settingsNow);
          tbody.appendChild(
            h(
              'tr',
              {},
              h('td', { text: w.en }),
              h('td', { text: value.toFixed(2) }),
              h('td', { text: `${w.attrs.failCount} / ${w.attrs.reviewCount}` }),
            ),
          );
        }
        table.appendChild(tbody);
        calcBox.replaceChildren(table);
      })();
    },
    {},
  );

  const customBox = h(
    'div',
    { class: `stack${isCustom ? '' : ' hidden'}` },
    h('p', { class: 'note' }, '只允许数字运算和下面这些变量；保存前会做白名单校验，不合法的表达式不会被保存。'),
    textarea,
    chipBox,
    h('div', { class: 'row' }, saveBtn, calcBtn),
    checkLine,
    calcBox,
  );

  wrap.appendChild(customBox);
  return wrap;
}
