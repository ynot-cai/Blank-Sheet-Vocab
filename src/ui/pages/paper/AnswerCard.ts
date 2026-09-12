import type { Word } from '../../../core/types';
import { renderWordCard } from '../../components/WordCard';
import { h } from '../../dom';

/** 一行输入对照（记忆环节的答案卡用） */
export interface AnswerComparison {
  input: string;
  ok: boolean;
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
 * @param word 单词
 * @param inputs 输入对照（拼写环节可传空数组）
 * @param onNext 推进后回调（只触发一次）
 * @returns 卡片根元素（已挂到 body）
 */
export function showAnswerCard(word: Word, inputs: AnswerComparison[], onNext: () => void): HTMLElement {
  let done = false;

  const finish = (): void => {
    if (done) return;
    done = true;
    cleanup();
    onNext();
  };

  // 点页面任意处都推进（白纸区域也一样）；卡片里的按钮（🔊/查看义项）与右下角按钮组除外
  const onDocClick = (ev: MouseEvent): void => {
    const target = ev.target;
    if (target instanceof Node) {
      if (target instanceof Element && target.closest('button')) return;
      if (target instanceof Element && target.closest('.paper-controls')) return;
    }
    finish();
  };
  const cleanup = (): void => {
    document.removeEventListener('click', onDocClick, true);
    currentCard = null;
    card.remove();
  };

  const card = h('div', { class: 'answer-card' });
  card.appendChild(renderWordCard(word, { answerFeedback: inputs, allowViewSenses: true }));
  card.appendChild(h('div', { class: 'answer-hint', text: '点击任意处、按 Enter 或空格继续' }));

  document.addEventListener('click', onDocClick, true);
  currentCard = { finish };
  document.body.appendChild(card);
  return card;
}
