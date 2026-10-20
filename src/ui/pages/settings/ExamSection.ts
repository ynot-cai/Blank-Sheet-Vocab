/**
 * 设置页「背诵设置」分组（版本 0.0.23）。
 *
 * RULES-R1: 本文件**只存设置值**，不参与任何答题判定，更没有时间限制 / 倒计时。
 *
 * ★ 0.0.19（用户提示词 10）要求的三项，0.0.21 起生效（考核已实现）：
 *   - **每出现几个单词进行一次考核**：点几次「下一个」后自动开始一轮考核；
 *   - **每次考核数**：每轮考核固定选取的单词数量（总数不足则全选）；
 *   - **考核严格程度**：→ 0.0.23 按用户要求**移除**。
 * ★ 0.0.21 新增 **分数阈值**：用户「三、选取逻辑」第 4 条
 *   「若某单词考核分数低于固定值（可调）且未被抽到，则无视设定的记忆次数，额外加入考核」。
 * ★ 0.0.23 新增 **考核评分标准**：可编辑文本，原样作为提示词交给 AI 评分（替代「考核严格程度」）。
 */
import { clampNum } from '../../../core/config';
import type { ExamSettings } from '../../../core/types';
import { debounce, h, numberInput } from '../../dom';
import { currentSettings, patchSettings } from './ctx';

/** 「每出现几个单词进行一次考核」的可调区间 */
const EVERY_RANGE = { min: 1, max: 999 };
/** 「每次考核数」的可调区间 */
const COUNT_RANGE = { min: 1, max: 999 };
/** 「分数阈值」的可调区间（考核满分 5 分） */
const THRESHOLD_RANGE = { min: 0, max: 5 };

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

  /**
   * ★ 0.0.23（用户）：「将原有的『考核难易程度（低/中/高）』选项移除，改为『考核评分标准』设置项，
   *   该设置项应支持直接编辑并作为提示词提供给 AI，初始内容由你生成一份。」
   *
   * 所以这里把原来的三档下拉换成一个可编辑的多行文本框：
   * 内容会**原样**拼进 AI 评分的 system prompt（`services/aiScore.ts`）。
   * 输入即存（防抖），末尾的提示行说明它会怎么被用、留空会怎样。
   */
  const rubricArea = h('textarea', {
    class: 'textarea exam-rubric',
    rows: '12',
    placeholder: '写清评分标准（满分 5 分）：什么算对、漏答怎么扣分、如何分档……',
  });
  rubricArea.value = exam.scoreRubric;
  rubricArea.dataset.role = 'exam-rubric';
  const saveRubric = debounce((value: string) => {
    void patchExam({ scoreRubric: value });
  }, 400);
  rubricArea.addEventListener('input', () => saveRubric(rubricArea.value));
  wrap.appendChild(
    h(
      'div',
      { class: 'field exam-rubric-field' },
      h('span', { class: 'field-label', text: '考核评分标准' }),
      rubricArea,
      h('span', {
        class: 'field-hint',
        text: '这段文字会原样作为提示词交给 AI，用来给英译中考核打分（满分 5 分）。留空则使用内置的默认标准。',
      }),
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
