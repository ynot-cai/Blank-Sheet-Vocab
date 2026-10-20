/**
 * 考核（记忆过程）界面 —— 版本 0.0.21。
 *
 * 用户「二、交互流程」原文：
 * - 「进入考核后，页面变为纯白，中央显示英文单词，下方有输入框，用户输入中文意思，
 *    系统评判后进入下一个单词。」
 * - 「单词下方有小喇叭，点击可朗读一遍单词作为提示。」
 * - 「英译中考核结束后，进入拼写考察，完全与旧版相同。」
 *
 * ── 与旧版的关系（用户「主体流程沿用旧版」）──
 * 题干与拼写环节的**结构与类名照旧版**（`已归档/02` 的 rounds.ts / paper.css）：
 * `.memorize-box` / `.memorize-word` / `.mem-inputs` / `.mem-input` / `.spell-meanings`，
 * 输入框个数 = 义项个数、Enter 跳到下一格、最后一格再按 Enter 提交、
 * 提交后弹**同一张可编辑单词卡**（带对错对照）点任意处继续 —— 这些都是旧版做法。
 * 与旧版不同的只有两处，都是用户本轮明确要求的：
 * 1. 外观从「原落点小遮罩」改成**纯白整页 + 居中**；
 * 2. 英译中的判分从「逐义项完全匹配」改成**交给 AI 按准确全面程度打 0~5 分**
 *    （AI 不可用时退回旧版那套完全匹配判分，见 services/aiScore.ts）。
 */
import { activeSenses } from '../../../core/model';
import type { AnswerComparison, Word } from '../../../core/types';
import type { AiConfig } from '../../../services/ai';
import { EXAM_MAX_SCORE, scoreChineseAnswers } from '../../../services/aiScore';
import { button, h } from '../../dom';
import { renderWordCard } from '../../components/WordCard';

/** 一个词在这一轮里的结果 */
export interface ExamWordOutcome {
  id: string;
  /** 英译中得分（0~5）；仅拼写词没有英译中，给 null */
  score: number | null;
  /** 是否算「未通过」（决定 failCount 是否 +1） */
  failed: boolean;
  /** 拼写是否通过（没做拼写 = null） */
  spellOk: boolean | null;
}

/** 考核参数 */
export interface ExamOptions {
  /** 本轮英译中考量要考的「固定个数」词（顺序即考核顺序） */
  words: Word[];
  /** 需要额外做一次拼写考察的词 id（被选中且标记了「拼写」） */
  spellIds: Set<string>;
  /** 仅拼写的词（不在纸上，只做拼写考察） */
  spellOnlyWords: Word[];
  /** 分数阈值：英译中得分低于它记一次未通过 */
  scoreThreshold: number;
  /** AI 接口配置（评卷用） */
  aiCfg: AiConfig;
  /** 「提示后算不算未通过」（旧版 practice.hintFails 口径，拼写环节用） */
  hintFails: boolean;
  /**
   * ★ 0.0.23（用户要求）：设置页「背诵设置 → 考核评分标准」的文本，
   * 原样作为提示词交给 AI（见 `services/aiScore.ts` 的 `buildScoreSystemPrompt`）。
   */
  scoreRubric: string;
  /**
   * 旧版行为：进入记忆（英译中）环节时，如果 `practice.autoSpeak` 为真就**自动朗读一遍**这个词
   * （已归档/02 的 rounds.ts：`if (host.settings.practice.autoSpeak) host.stage.speakWord(word)`）。
   * 用户本轮没说这件事，按「未提到的细节与旧版一致」保留。
   */
  autoSpeak: boolean;
  /** 朗读一遍（小喇叭提示） */
  speak: (word: Word) => void;
  /** 答案卡里改了义项/音标/例句等 */
  onChangeWord: (next: Word) => void;
  /** 答案卡里点了「斩」 */
  onChop: (word: Word) => void;
  /** 答案卡里点了「拼写」标记 */
  onSpell: (word: Word, value: boolean) => void;
  /** 答案卡里点了「仅拼写」标记 */
  onSpellOnly: (word: Word, value: boolean) => void;
  /** 页面是否已被销毁（用户中途退出白纸页） */
  isAborted: () => boolean;
}

/** 考核句柄 */
export interface ExamHandle {
  /** 整轮结束后的结果（中途中断则返回已完成的部分） */
  done: Promise<ExamWordOutcome[]>;
  /** 中断考核并拆掉界面 */
  abort: () => void;
  /** 这一轮是不是被中断的（「返回白纸」/离开页面） */
  isAborted: () => boolean;
}

/** 旧版的口径：点过提示 + 设置里「提示后算未通过」同时成立时，答对也算未通过 */
function resolvePass(answerCorrect: boolean, hintUsed: boolean, hintFails: boolean): boolean {
  if (hintFails && hintUsed) return false;
  return answerCorrect;
}

/**
 * 开始一轮考核。
 *
 * 界面是一层 `position: fixed` 的纯白页面（`.exam-page`），挂在 body 上，
 * 结束后自己拆掉；调用方只需要 `await handle.done` 拿结果。
 * @param opts 参数
 */
export function startExam(opts: ExamOptions): ExamHandle {
  let aborted = false;
  /** 当前这道题「等用户提交」的解锁函数（中断时用它放行） */
  let release: (() => void) | null = null;
  /** 当前答案卡「等用户继续」的解锁函数 */
  let releaseCard: (() => void) | null = null;

  const root = h('div', { class: 'exam-page', dataset: { role: 'exam-page' } });
  const inner = h('div', { class: 'exam-inner' });
  const progressEl = h('div', { class: 'exam-progress', text: '' });
  const stageBox = h('div', { class: 'exam-stage-box' });
  /**
   * 退出考核。
   *
   * 旧版的考核遮罩挂在白纸上、白纸的按钮（保存并退出等）仍然能点，等于随时可以中断；
   * 本版按用户要求改成**纯白整页**，所以必须自带一个显式的出口，
   * 否则用户被一道题卡住时只能刷新页面（而刷新会丢掉整轮记录）。
   */
  const exitBtn = h('button', { class: 'exam-exit', type: 'button', text: '返回白纸', title: '中断本轮考核' });
  inner.appendChild(progressEl);
  inner.appendChild(stageBox);
  root.appendChild(exitBtn);
  root.appendChild(inner);
  document.body.appendChild(root);

  /**
   * ★ 0.0.23：把背景锁住。
   *
   * 用户明确反馈过「考核界面被做成拼接在下方、可以滚轮翻到的额外页面」这类问题——
   * 本版是 `position: fixed` 的独立层，但白纸页 + 底部白条仍然可能让**文档**可滚动，
   * 用户滚一下就会觉得「下面还有一页」。所以考核期间把 html/body 的纵向滚动关掉，
   * 结束后原样恢复（只恢复本次改过的属性，不碰别的内联样式）。
   */
  const prevHtmlOverflowY = document.documentElement.style.overflowY;
  const prevBodyOverflowY = document.body.style.overflowY;
  document.documentElement.style.overflowY = 'hidden';
  document.body.style.overflowY = 'hidden';
  /** 还原背景滚动（考核结束/中断时各调一次，重复调用无害） */
  const restoreScroll = (): void => {
    document.documentElement.style.overflowY = prevHtmlOverflowY;
    document.body.style.overflowY = prevBodyOverflowY;
  };

  /** 等一次用户提交（无任何时间限制 —— RULES-R1） */
  const waitSubmit = (bind: (done: () => void) => void): Promise<void> =>
    new Promise<void>((resolve) => {
      if (aborted) {
        resolve();
        return;
      }
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        release = null;
        resolve();
      };
      release = finish;
      bind(finish);
    });

  /** 换一屏内容（进度行保持不动） */
  const renderStage = (content: HTMLElement): void => {
    stageBox.replaceChildren(content);
  };

  /** 真正的中断动作（按钮与外部 abort() 共用） */
  const abortSelf = (): void => {
    aborted = true;
    release?.();
    releaseCard?.();
    restoreScroll();
    root.remove();
  };
  exitBtn.addEventListener('click', abortSelf);

  /**
   * 弹答案卡：沿用旧版的「同一张可编辑单词卡 + 对错对照」，点卡片外部 / Enter / 空格继续。
   * @param word 词
   * @param feedback 每个输入框的对错
   * @param scoreLine 分数与点评（拼写环节传空串）
   */
  const showAnswer = (word: Word, feedback: AnswerComparison[], scoreLine: string): Promise<void> =>
    new Promise<void>((resolve) => {
      let finished = false;
      const card = h('div', { class: 'answer-card' });
      card.appendChild(
        renderWordCard(word, {
          editable: true,
          answerFeedback: feedback,
          onChange: (next) => opts.onChangeWord(next),
          onChop: () => opts.onChop(word),
          onSpell: (value) => opts.onSpell(word, value),
          onSpellOnly: (value) => opts.onSpellOnly(word, value),
        }),
      );
      if (scoreLine !== '') card.appendChild(h('div', { class: 'exam-score-line', text: scoreLine }));
      card.appendChild(h('div', { class: 'answer-hint', text: '点击卡片外部、按 Enter 或空格继续（卡内可以直接改）' }));

      const cleanup = (): void => {
        document.removeEventListener('click', onDocClick, true);
        document.removeEventListener('keydown', onKey);
        card.remove();
        releaseCard = null;
      };
      const finish = (): void => {
        if (finished) return;
        finished = true;
        cleanup();
        resolve();
      };
      const onDocClick = (ev: MouseEvent): void => {
        const t = ev.target;
        // 义项右键菜单挂在 body 上，不算「卡片外部」（否则点「删除」会把卡关掉）
        if (t instanceof Element && t.closest('.answer-card') === null && t.closest('.sense-ctx-menu') === null) finish();
      };
      const onKey = (ev: KeyboardEvent): void => {
        if (ev.key !== 'Enter' && ev.key !== ' ') return;
        const t = ev.target;
        if (t instanceof Element && t.closest('input, textarea, select, [contenteditable]') !== null) return;
        ev.preventDefault();
        finish();
      };
      releaseCard = finish;
      document.addEventListener('click', onDocClick, true);
      document.addEventListener('keydown', onKey);
      document.body.appendChild(card);
    });

  /**
   * 英译中一道题（纯白居中：英文 + 小喇叭 + 按义项个数的输入框 + 提交）。
   * @param word 词
   * @param index 第几个（从 0 起，用于进度）
   * @param total 本轮总数
   */
  const runChineseStage = async (word: Word, index: number, total: number): Promise<ExamWordOutcome> => {
    const senses = activeSenses(word);
    if (progressEl) progressEl.textContent = `考核 ${index + 1} / ${total}`;

    const box = h('div', { class: 'memorize-box exam-stage', dataset: { stage: 'chinese' } });
    box.appendChild(h('div', { class: 'memorize-word exam-word', text: word.en, title: '英译中：填中文意思' }));

    /** 小喇叭：用户「单词下方有小喇叭，点击可朗读一遍单词作为提示」 */
    const speakBtn = button('🔊', () => opts.speak(word), {
      variant: 'ghost',
      class: 'exam-speak',
      title: '朗读一遍（提示）',
    });
    // 用户：「单词下方有小喇叭」
    box.appendChild(h('div', { class: 'row center exam-speak-row' }, speakBtn));

    const inputsRow = h('div', { class: 'mem-inputs exam-inputs' });
    const inputs: HTMLInputElement[] = senses.map((_, i) =>
      h('input', { class: 'input mem-input exam-input', type: 'text', placeholder: `义项 ${i + 1}` }),
    );
    for (const input of inputs) inputsRow.appendChild(input);
    box.appendChild(inputsRow);
    if (inputs.length === 0) box.appendChild(h('div', { class: 'field-hint', text: '这个词没有义项，无法考核' }));
    if (inputs.length > 1) {
      box.appendChild(h('div', { class: 'field-hint mem-hint', text: '按 Enter 填下一个义项；在最后一格按 Enter 提交' }));
    }

    const submit = button('提交', () => {
      /* 真正的提交在下面 waitSubmit 里绑定 */
    }, { variant: 'primary', class: 'mem-submit exam-submit' });
    box.appendChild(h('div', { class: 'row center' }, submit));
    const status = h('div', { class: 'exam-status hidden' });
    box.appendChild(status);
    renderStage(box);
    // 旧版行为：进入记忆环节自动朗读一遍（设置里 practice.autoSpeak 默认开）
    if (opts.autoSpeak) opts.speak(word);

    // Enter：填完一格跳下一格，最后一格提交（旧版做法）
    inputs.forEach((input, i) => {
      input.addEventListener('keydown', (ev) => {
        if (ev.key !== 'Enter') return;
        ev.preventDefault();
        ev.stopPropagation();
        const next = inputs[i + 1];
        if (next) {
          next.focus();
          next.select();
          return;
        }
        submit.click();
      });
    });

    await waitSubmit((done) => {
      submit.addEventListener('click', done);
      window.setTimeout(() => inputs[0]?.focus(), 0);
    });
    if (aborted) return { id: word.id, score: null, failed: false, spellOk: null };

    const answers = inputs.map((input) => input.value.trim());
    status.classList.remove('hidden');
    status.textContent = '评判中…';
    const scored = await scoreChineseAnswers(opts.aiCfg, word, answers, opts.scoreRubric);
    status.classList.add('hidden');

    const feedback: AnswerComparison[] = answers.map((value, i) => ({ input: value, ok: scored.inputs[i] === true }));
    const passed = scored.score >= opts.scoreThreshold;
    const line =
      `得分 ${scored.score} / ${EXAM_MAX_SCORE}（${passed ? '通过' : '未通过'}，阈值 ${opts.scoreThreshold}）` +
      (scored.comment === '' ? '' : ` · ${scored.comment}`);
    await showAnswer(word, feedback, line);
    return { id: word.id, score: scored.score, failed: !passed, spellOk: null };
  };

  /**
   * 拼写考察一道题 —— 「完全与旧版相同」：显示全部中文意思、填英文、完全匹配判对错、
   * 小喇叭念一遍单词作为提示、提交后弹答案卡。
   * @param word 词
   * @param index 第几个拼写题
   * @param total 拼写题总数
   */
  const runSpellStage = async (word: Word, index: number, total: number): Promise<ExamWordOutcome> => {
    if (progressEl) progressEl.textContent = `拼写 ${index + 1} / ${total}`;
    const meanings = activeSenses(word)
      .flatMap((s) => [s.text, ...s.aliases])
      .filter((t) => t.trim() !== '')
      .join('，');
    const box = h('div', { class: 'memorize-box exam-stage', dataset: { stage: 'spell' } });
    box.appendChild(h('div', { class: 'spell-meanings exam-meanings', text: meanings }));

    let hintUsed = false;
    const hint = button(
      '🔊',
      () => {
        hintUsed = true;
        opts.speak(word);
      },
      { variant: 'ghost', class: 'exam-speak', title: '朗读一遍（提示）' },
    );

    const input = h('input', { class: 'input spell-input exam-spell-input', type: 'text', placeholder: '拼写英文' });
    const submit = button('提交', () => {
      /* 绑定在 waitSubmit 里 */
    }, { variant: 'primary', class: 'exam-submit' });
    input.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter') return;
      ev.preventDefault();
      ev.stopPropagation();
      submit.click();
    });
    box.appendChild(h('div', { class: 'row center' }, input, submit));
    box.appendChild(h('div', { class: 'row center exam-speak-row' }, hint));
    renderStage(box);

    await waitSubmit((done) => {
      submit.addEventListener('click', done);
      window.setTimeout(() => input.focus(), 0);
    });
    if (aborted) return { id: word.id, score: null, failed: false, spellOk: null };

    const value = input.value.trim();
    const answerCorrect = value.toLowerCase() === word.en.trim().toLowerCase();
    const passed = resolvePass(answerCorrect, hintUsed, opts.hintFails);
    await showAnswer(word, [{ input: value, ok: passed }], answerCorrect ? '拼写正确' : `拼写错误，正确拼写：${word.en}`);
    return { id: word.id, score: null, failed: !passed, spellOk: passed };
  };

  const run = async (): Promise<ExamWordOutcome[]> => {
    const outcomes: ExamWordOutcome[] = [];
    const total = opts.words.length;

    // ── 第一段：英译中（用户在文本框里填中文意思）──
    for (let i = 0; i < opts.words.length; i += 1) {
      if (aborted || opts.isAborted()) break;
      const word = opts.words[i] as Word;
      outcomes.push(await runChineseStage(word, i, total));
    }

    // ── 第二段：拼写考察（旧版：把「当次记忆选到的词里标了拼的词」再考一遍拼写）──
    const spellWords: Word[] = [];
    for (const word of opts.words) if (opts.spellIds.has(word.id)) spellWords.push(word);
    for (const word of opts.spellOnlyWords) spellWords.push(word);
    for (let i = 0; i < spellWords.length; i += 1) {
      if (aborted || opts.isAborted()) break;
      const word = spellWords[i] as Word;
      const spell = await runSpellStage(word, i, spellWords.length);
      const existing = outcomes.find((o) => o.id === word.id);
      if (existing) {
        existing.spellOk = spell.spellOk;
        if (spell.failed) existing.failed = true;
      } else {
        // 仅拼写的词：只有拼写这一项
        outcomes.push({ id: word.id, score: null, failed: spell.failed, spellOk: spell.spellOk });
      }
    }
    return outcomes;
  };

  const done = run()
    .catch((err: unknown) => {
      console.error('[exam] 考核流程出错', err);
      return [] as ExamWordOutcome[];
    })
    .finally(() => {
      restoreScroll();
      root.remove();
    });

  return {
    done,
    abort: abortSelf,
    isAborted: () => aborted,
  };
}
