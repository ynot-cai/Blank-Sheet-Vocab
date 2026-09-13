/**
 * 答题组件（阶段 05）：按题型渲染不同的作答方式 + 提交 + 评分结果卡。
 *
 * 四种题型的作答方式（**只需在这个 switch 里加分支，别处不用改**）：
 * - `fill` 语法填空 → 单行输入框
 * - `sentence` 独立写句子 → 多行 textarea
 * - `choice` 选择题 → A/B/C/D 按钮
 * - `judge` 判断正误 → 对 / 错 两个按钮
 *
 * 评分结果卡上有**「改分」入口**：用户明确要求保留（AI 评分不一定准），
 * 改分后会回写 `ExamRecord.aiScore` 与 `card.attrs.lastExamScore`（由调用方负责）。
 */
import { EXAM_TYPES } from '../../core/kcTypes';
import { button, h } from '../dom';
import { nextOptionIndex } from './examKeys';

/** 一道待作答的题 */
export interface KcQuestion {
  /** 题型 id */
  type: string;
  /** 题干 */
  question: string;
  /** 关联的语境词（空串 = 没关联） */
  contextWord: string;
  /** 参考答案 */
  expected: string;
}

/** 评分结果 */
export interface KcGradeResult {
  score: number;
  reason: string;
}

/** 答题组件的回调 */
export interface KcExamTakerHandlers {
  /** 提交答案（调用方去调 AI 评分） */
  onSubmit: (answer: string) => void;
  /** 用户手动改分 */
  onRegrade: (score: number) => void;
  /** 点「继续」（下一题） */
  onNext: () => void;
  /** 点「重新作答」（评分失败时用） */
  onRetry?: () => void;
}

/**
 * 渲染答题卡。
 *
 * @param q 题目
 * @param state 当前状态：作答中 / 评分中 / 已评分
 */
export function renderKcExamTaker(
  q: KcQuestion,
  state: { phase: 'answering' | 'grading' | 'graded'; answer: string; grade?: KcGradeResult; error?: string },
  handlers: KcExamTakerHandlers,
): HTMLElement {
  const box = h('article', { class: 'kc-exam' });

  // ── 头部：题型 + 关联语境词 ──
  const head = h('div', { class: 'kc-exam-head' });
  const typeName = EXAM_TYPES.find((t) => t.id === q.type)?.name ?? q.type;
  head.appendChild(h('span', { class: 'kc-chip', text: typeName }));
  head.appendChild(
    h('span', {
      class: 'kc-exam-context',
      text: q.contextWord === '' ? '未关联语境词' : `关联词：${q.contextWord}`,
      title: '这道题融入了今天的一个语境词',
    }),
  );
  box.appendChild(head);

  // ── 题干（保留换行，纯文本）──
  box.appendChild(h('p', { class: 'kc-exam-question', text: q.question }));

  // ── 作答区 ──
  if (state.phase === 'answering') {
    box.appendChild(renderAnswerInput(q, state.answer, handlers));
  } else {
    // 评过分之后把答案只读地摆出来（用户要能看到自己写了什么）
    box.appendChild(
      h('div', { class: 'kc-exam-answerbox' }, [
        h('span', { class: 'kc-field-label', text: '你的答案' }),
        h('p', { class: 'kc-exam-answer', text: state.answer.trim() === '' ? '（没有作答）' : state.answer }),
      ]),
    );
  }

  // ── 状态区：评分中 / 结果 ──
  if (state.phase === 'grading') {
    box.appendChild(h('p', { class: 'kc-exam-loading', text: 'AI 评分中…' }));
  }
  if (state.phase === 'graded' && state.grade !== undefined) {
    box.appendChild(renderGradeCard(state.grade, q, handlers));
  }
  if (state.error !== undefined) {
    box.appendChild(h('p', { class: 'kc-bubble-error', text: state.error }));
    if (handlers.onRetry !== undefined) {
      box.appendChild(h('div', { class: 'kc-exam-actions' }, button('重新作答', () => handlers.onRetry?.(), { variant: 'primary' })));
    }
  }
  return box;
}

/**
 * 按题型渲染作答控件。
 * @param q 题目
 * @param answer 当前答案
 * @param handlers 回调
 */
function renderAnswerInput(q: KcQuestion, answer: string, handlers: KcExamTakerHandlers): HTMLElement {
  const box = h('div', { class: 'kc-exam-input' });
  const submit = (value: string): void => handlers.onSubmit(value);

  if (q.type === 'choice') {
    // 选择题：从题干里找 A/B/C/D 选项行（AI 一般写成 "A. xxx"）
    const options = extractOptions(q.question);
    if (options.length > 0) {
      // 选项按钮上保留「A. 」前缀（用户要看着它选），但提交的值只是字母
      box.appendChild(buildOptionRow(options.map((o) => ({ key: o.key, text: `${o.key}. ${o.text}` })), submit));
      return box;
    }
    // 没解析出选项就退化成输入框（AI 偶尔把选项放 expected 里）
    box.appendChild(h('p', { class: 'kc-hint-dim', text: '（没解析出选项，直接填答案字母）' }));
  }

  if (q.type === 'judge') {
    box.appendChild(
      buildOptionRow(
        [
          { key: '对', text: '对 ✓' },
          { key: '错', text: '错 ✗' },
        ],
        submit,
      ),
    );
    return box;
  }

  // fill / sentence（以及兜底）：输入框
  const multiline = q.type === 'sentence';
  const el = multiline
    ? h('textarea', { class: 'input kc-answer-input', rows: '4', placeholder: '写出你的句子…（Enter 提交，Shift+Enter 换行）' })
    : h('input', { class: 'input kc-answer-input', type: 'text', placeholder: '填答案（多个空用空格分开）…' });
  el.value = answer;
  box.appendChild(el);
  const actions = h('div', { class: 'kc-exam-actions' });
  const submitBtn = button('提交', () => submit(el.value), { variant: 'primary' });
  actions.appendChild(submitBtn);
  // ⚠️ 这里**故意不监听 Enter**：Enter 由 `components/examKeys` 统一处理
  //（用户明确要求「Enter 要一直有用」）。散在各处监听正是当初「时灵时不灵」的原因：
  // 填空题认 Enter、选择题不认、评分页也不认。
  box.appendChild(actions);
  window.setTimeout(() => el.focus(), 30);
  return box;
}

/**
 * 渲染一行可选项（选择题 / 判断题共用）。
 *
 * 键盘：↑↓←→ 换项、数字键直选、Enter 确认（Enter 在 `examKeys` 里统一处理）。
 * 鼠标：**点一下直接提交**（保持原来的手感，不给鼠标用户多加一步）。
 *
 * @param options 选项（key 是提交的值）
 * @param submit 提交回调
 */
function buildOptionRow(options: { key: string; text: string }[], submit: (v: string) => void): HTMLElement {
  const row = h('div', { class: 'kc-options' });
  /** 当前高亮的下标（默认第一项，这样用户不作任何操作直接按 Enter 也能答） */
  let active = 0;
  const buttons: HTMLButtonElement[] = [];

  /** 换高亮项 */
  const highlight = (index: number): void => {
    active = index;
    buttons.forEach((b, i) => {
      b.classList.toggle('kc-option-btn--active', i === index);
    });
  };

  options.forEach((opt, i) => {
    const btn = button(opt.text, () => submit(opt.key), { variant: 'ghost', class: 'kc-option-btn' });
    // Enter 统一出口靠这个属性找到「当前选中的是哪一项」
    btn.dataset.optionKey = opt.key;
    // 鼠标移到哪一项，高亮就跟到哪一项（和键盘高亮保持一致，不会出现两处高亮）
    btn.addEventListener('mouseenter', () => highlight(i));
    buttons.push(btn);
    row.appendChild(btn);
  });
  highlight(0);

  row.appendChild(
    h('span', { class: 'kc-hint-dim kc-options-hint', text: '↑↓ 选择，Enter 确认（也可以直接点）' }),
  );

  const onKey = (ev: KeyboardEvent): void => {
    const next = nextOptionIndex(ev, options.length, active);
    if (next === null) return;
    ev.preventDefault();
    highlight(next);
  };
  row.addEventListener('keydown', onKey);
  return row;
}

/** 从题干里抽 A/B/C/D 选项 */
function extractOptions(question: string): { key: string; text: string }[] {
  const out: { key: string; text: string }[] = [];
  for (const line of question.split('\n')) {
    const m = /^\s*([A-Da-d])\s*[.、:：)]\s*(.+)$/.exec(line);
    if (m?.[1] !== undefined && m[2] !== undefined && m[2].trim() !== '') {
      out.push({ key: m[1].toUpperCase(), text: m[2].trim() });
    }
  }
  return out;
}

/**
 * 渲染评分结果卡（得分点 + 理由 + 参考答案 + 改分）。
 * @param grade 评分
 * @param q 题目
 * @param handlers 回调
 */
function renderGradeCard(grade: KcGradeResult, q: KcQuestion, handlers: KcExamTakerHandlers): HTMLElement {
  const card = h('div', { class: `kc-grade kc-grade--${grade.score}` });
  const head = h('div', { class: 'kc-grade-head' });
  head.appendChild(h('span', { class: 'kc-grade-label', text: '得分' }));
  const dots = h('span', { class: 'kc-grade-dots' });
  for (let i = 1; i <= 3; i += 1) dots.appendChild(h('i', { class: i <= grade.score ? 'kc-dot kc-dot--on' : 'kc-dot' }));
  head.appendChild(dots);
  head.appendChild(h('span', { class: 'kc-grade-score', text: `${grade.score}/3` }));
  // 改分：AI 评分不一定准，用户明确要求保留这个入口
  const regrade = h('div', { class: 'kc-regrade' });
  regrade.appendChild(h('span', { class: 'kc-hint-dim', text: '改分：' }));
  for (const s of [1, 2, 3]) {
    regrade.appendChild(
      button(String(s), () => handlers.onRegrade(s), {
        variant: s === grade.score ? 'primary' : 'ghost',
        class: 'kc-regrade-btn',
        title: `手动改成 ${s} 分`,
      }),
    );
  }
  head.appendChild(regrade);
  card.appendChild(head);

  card.appendChild(h('p', { class: 'kc-grade-reason', text: grade.reason }));
  if (q.expected !== '') {
    const details = h('details', { class: 'kc-grade-expected' });
    details.appendChild(h('summary', { text: '查看参考答案' }));
    details.appendChild(h('pre', { class: 'kc-pre', text: q.expected }));
    card.appendChild(details);
  }
  card.appendChild(h('div', { class: 'kc-exam-actions' }, button('继续', () => handlers.onNext(), { variant: 'primary' })));
  return card;
}
