/**
 * 设置页「背诵设置」分组（版本 0.0.19）。
 *
 * RULES-R1: 本文件**只存设置值**，不参与任何答题判定，更没有时间限制 / 倒计时
 *   （考核功能本身尚未实现，见下面三项的说明）。
 *
 * ★ 用户提示词 10 第 2 条，原文要求的三项：
 *   - **每出现几个单词进行一次考核**：当前考核功能尚未实现，
 *     暂时定义一个占位变量（不产生实际作用）；
 *   - **每次考核数**：设置每次考核涉及的单词数量；
 *   - **考核严格程度**：提供「低、中、高」三档选项；当前仅需设置选项，具体含义后续再定义。
 *
 * ⚠️ 这三项目前**只存值**：任何地方都不许读它们来做判断或影响背诵流程
 *    （用户明确说考核功能尚未实现）。将来实现考核时才来接这一组设置。
 */
import { clampNum } from '../../../core/config';
import type { ExamSettings, ExamStrictness } from '../../../core/types';
import { h, numberInput, select } from '../../dom';
import { currentSettings, patchSettings } from './ctx';

/** 「每出现几个单词进行一次考核」的可调区间（占位变量的合法范围） */
const EVERY_RANGE = { min: 1, max: 999 };
/** 「每次考核数」的可调区间 */
const COUNT_RANGE = { min: 1, max: 999 };

/** 「考核严格程度」的三档（用户原话：低、中、高） */
const STRICTNESS_OPTIONS: { value: ExamStrictness; label: string }[] = [
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
];

/**
 * 更新背诵设置的一个字段。
 * @param patch 要改的字段
 */
function patchExam(patch: Partial<ExamSettings>): Promise<void> {
  return patchSettings({ exam: { ...currentSettings().exam, ...patch } });
}

/**
 * 渲染「背诵设置」分组。
 */
export function renderExamSection(): HTMLElement {
  const wrap = h('div', { class: 'stack' });
  wrap.dataset.role = 'exam-settings';
  const exam = currentSettings().exam;

  wrap.appendChild(
    h(
      'label',
      { class: 'field' },
      h('span', { class: 'field-label', text: '每出现几个单词进行一次考核' }),
      numberInput(exam.everyWords, (v) => void patchExam({ everyWords: Math.round(clampNum(v, EVERY_RANGE, exam.everyWords)) }), {
        min: EVERY_RANGE.min,
        max: EVERY_RANGE.max,
        step: 1,
      }),
      h('span', { class: 'field-hint', text: '考核功能尚未实现，这一项目前只存值、不产生实际作用。' }),
    ),
  );

  wrap.appendChild(
    h(
      'label',
      { class: 'field' },
      h('span', { class: 'field-label', text: '每次考核数' }),
      numberInput(exam.countPerExam, (v) => void patchExam({ countPerExam: Math.round(clampNum(v, COUNT_RANGE, exam.countPerExam)) }), {
        min: COUNT_RANGE.min,
        max: COUNT_RANGE.max,
        step: 1,
      }),
      h('span', { class: 'field-hint', text: '每次考核涉及的单词数量。' }),
    ),
  );

  wrap.appendChild(
    h(
      'label',
      { class: 'field' },
      h('span', { class: 'field-label', text: '考核严格程度' }),
      select(STRICTNESS_OPTIONS, exam.strictness, (v) => void patchExam({ strictness: v })),
      h('span', { class: 'field-hint', text: '当前只设置选项，具体含义后续再定义。' }),
    ),
  );

  return wrap;
}
