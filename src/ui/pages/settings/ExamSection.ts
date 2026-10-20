/**
 * 设置页「背诵设置」分组（版本 0.0.21）。
 *
 * RULES-R1: 本文件**只存设置值**，不参与任何答题判定，更没有时间限制 / 倒计时。
 *
 * ★ 0.0.19（用户提示词 10）要求的三项，0.0.21 起**真的生效了**（考核已实现）：
 *   - **每出现几个单词进行一次考核**：点几次「下一个」后自动开始一轮考核；
 *   - **每次考核数**：每轮考核固定选取的单词数量（总数不足则全选）；
 *   - **考核严格程度**：仍是「低 / 中 / 高」三档选项，具体含义后续再定义（代码不读它）。
 * ★ 0.0.21 新增第四项 **分数阈值**：用户「三、选取逻辑」第 4 条
 *   「若某单词考核分数低于固定值（可调）且未被抽到，则无视设定的记忆次数，额外加入考核」。
 */
import { clampNum } from '../../../core/config';
import type { ExamSettings, ExamStrictness } from '../../../core/types';
import { h, numberInput, select } from '../../dom';
import { currentSettings, patchSettings } from './ctx';

/** 「每出现几个单词进行一次考核」的可调区间 */
const EVERY_RANGE = { min: 1, max: 999 };
/** 「每次考核数」的可调区间 */
const COUNT_RANGE = { min: 1, max: 999 };
/** 「分数阈值」的可调区间（考核满分 5 分） */
const THRESHOLD_RANGE = { min: 0, max: 5 };

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
      h('span', { class: 'field-hint', text: '点几次「下一个」之后自动开始一轮考核。' }),
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
      h('span', { class: 'field-hint', text: '每轮考核固定选取的单词数量；纸上单词不足时全部选中。' }),
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

  // ★ 0.0.21：分数阈值（用户「三、选取逻辑」第 4 条要求「可调」）
  wrap.appendChild(
    h(
      'label',
      { class: 'field' },
      h('span', { class: 'field-label', text: '分数阈值' }),
      numberInput(
        exam.scoreThreshold,
        (v) => void patchExam({ scoreThreshold: Math.round(clampNum(v, THRESHOLD_RANGE, exam.scoreThreshold)) }),
        { min: THRESHOLD_RANGE.min, max: THRESHOLD_RANGE.max, step: 1 },
      ),
      h('span', { class: 'field-hint', text: '考核分数（满分 5）低于它的单词，即使没被抽到也会额外加入下一轮考核。' }),
    ),
  );

  return wrap;
}
