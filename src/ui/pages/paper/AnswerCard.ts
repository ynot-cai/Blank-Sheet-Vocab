// RULES-R1: 此处禁止任何强制时间限制（无倒计时 / 无超时提交 / 无超时判错）
import type { Word } from '../../../core/types';
import { renderWordCard } from '../../components/WordCard';
import { h } from '../../dom';

/** 一行输入对照（记忆环节的答案卡用） */
export interface AnswerComparison {
  input: string;
  ok: boolean;
}

/**
 * 答案卡上的操作回调（与普通单词卡同一套）。
 * 由 `paper/rounds.ts` 的 `RoundHost.cardActionsFor(word)` 提供。
 */
export interface AnswerCardActions {
  /** 改了音标 / 例句 / 义项 */
  onChange?: (next: Word) => void;
  /** 点「拼（加入拼写环节）」 */
  onSpell?: (needSpell: boolean) => void;
  /** 点「斩掉此词」 */
  onChop?: () => void;
}

/** 当前打开的答案卡（模块级单例：同一时刻最多一张） */
let currentCard: { finish: () => void } | null = null;

/**
 * 是否有一张答案卡正打开着。
 */
export function isAnswerCardOpen(): boolean {
  return currentCard !== null;
}

/**
 * 推进答案卡（点击任意处 / Enter / 空格都会调它）。
 * @returns 是否确实推进了一张卡
 */
export function advanceAnswerCard(): boolean {
  if (!currentCard) return false;
  currentCard.finish();
  return true;
}

/**
 * 统一作答闭环里的「正确答案卡」：**沿用单词卡组件**（WordCard），不另做一套卡。
 * 提交后立刻弹出，点页面任意处（白纸也行）、按 Enter 或空格都会继续（必须手动推进，不会自动跳过）。
 * 内容 = 单词卡（英文 + 中文意思 + 音标 + 🔊 + 例句 + 查看义项）+ 输入对照（对绿错红）+ 提示行。
 *
 * ★ 用户明确要求（2026-09）：**考察中也能随时查看、随时改义项、随时标记拼写、随时斩**，
 *   所以这里传 `editable: true` 并把普通卡片的那套回调原样接过来——
 *   答案卡就是普通界面那张卡，不是只读版。
 *   配套的两处改动（缺一不可）：
 *   1. 点卡片内部的输入控件**不推进**（见下面的 `isInteractive`）——否则点一下输入框就把卡关掉了；
 *   2. `flow.ts` 的全局 Enter 在焦点位于输入控件时**不抢键**，否则在卡里打字按 Enter 会被当成「看完了」。
 *
 * @param word 单词
 * @param inputs 输入对照（拼写环节可传空数组）
 * @param onNext 推进后回调（只触发一次）
 * @param actions 卡片上的编辑 / 拼 / 斩回调（不传就是纯查看）
 * @returns 卡片根元素（已挂到 body）
 */
export function showAnswerCard(
  word: Word,
  inputs: AnswerComparison[],
  onNext: () => void,
  actions: AnswerCardActions = {},
): HTMLElement {
  let done = false;

  const finish = (): void => {
    if (done) return;
    done = true;
    cleanup();
    onNext();
  };

  /**
   * 这个点击是不是落在**卡片内部的可交互控件**上。
   *
   * 为什么必须有它：卡片可编辑之后，用户点输入框、点义项编辑区、点下拉框都是很自然的动作，
   * 而「点任意处推进」的老规则会把这些点击当成「看完了」——表现是
   * **刚点进输入框想改个义项，卡就没了**。按钮本来就已经排除了（它们有自己的行为）。
   * @param target 点击目标
   */
  const isInteractive = (target: Element): boolean =>
    target.closest('button, input, textarea, select, label, .sense-panel, .sense-editor') !== null;

  // 点页面任意处都推进（白纸区域也一样）；卡片里的控件与右下角按钮组除外
  const onDocClick = (ev: MouseEvent): void => {
    const target = ev.target;
    if (target instanceof Element) {
      if (isInteractive(target)) return;
      if (target.closest('.paper-controls')) return;
    }
    finish();
  };
  const cleanup = (): void => {
    document.removeEventListener('click', onDocClick, true);
    currentCard = null;
    card.remove();
  };

  const card = h('div', { class: 'answer-card' });
  card.appendChild(
    renderWordCard(word, {
      answerFeedback: inputs,
      allowViewSenses: true,
      // ★ 和普通界面同一张卡：可编辑 + 拼 + 斩
      editable: true,
      onChange: actions.onChange,
      onSpell: actions.onSpell,
      onChop: actions.onChop,
    }),
  );
  card.appendChild(h('div', { class: 'answer-hint', text: '点击卡片外部、按 Enter 或空格继续（卡内可以直接改）' }));

  document.addEventListener('click', onDocClick, true);
  currentCard = { finish };
  document.body.appendChild(card);
  return card;
}
