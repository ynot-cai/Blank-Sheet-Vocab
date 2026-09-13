/**
 * 学习 / 复习流程的**收尾面板**（卡片看完之后）。
 *
 * 从 `KcStudyPage` 拆出来：单文件 ≤ 300 行；而且阶段 06 的复习流程
 * 收尾时要显示**不一样**的一组动作（复习是「背单词 → 做题」，学习是「做题」），
 * 所以做成一个带参数的面板，两边共用同一套排版。
 */
import { button, h } from '../dom';

/** 一块可点的动作 */
export interface KcFinishAction {
  label: string;
  variant: 'primary' | 'ghost' | 'danger';
  onClick: () => void;
}

/**
 * 渲染「看完了」面板。
 *
 * @param title 标题（如「卡片看完啦」「复习的三个环节都走完了」）
 * @param lines 说明文字（一段一行）
 * @param actions 底部按钮
 */
export function renderKcFinishPanel(title: string, lines: string[], actions: KcFinishAction[]): HTMLElement {
  const box = h('div', { class: 'kc-finished' });
  box.appendChild(h('p', { class: 'kc-empty-title', text: title }));
  for (const line of lines) {
    if (line.trim() !== '') box.appendChild(h('p', { class: 'kc-hint-dim', text: line }));
  }
  for (const action of actions) {
    box.appendChild(button(action.label, action.onClick, { variant: action.variant }));
  }
  return box;
}

/**
 * 把自评分统计成一句人话。
 * @param scores 分数数组
 */
export function summarizeScores(scores: number[]): string {
  if (scores.length === 0) return '这一轮没有记录到分数。';
  return `共 ${scores.length} 个：不会 ${scores.filter((s) => s === 1).length} 个、模糊 ${scores.filter((s) => s === 2).length} 个、会了 ${scores.filter((s) => s === 3).length} 个。`;
}
