/**
 * 做题流程的**键盘统一出口**（用户明确要求：Enter 要一直有用）。
 *
 * ══════════════════════════════════════════════════════════════
 * 用户原话与它对应的问题
 * ══════════════════════════════════════════════════════════════
 * 「做题流程中，enter 键应当一直有用，不要一会用 enter 可以快捷『确认/输入』
 *   一会又不行了」
 *
 * 原来的 Enter 是**散在各处**的：填空题的输入框自己监听 Enter 提交，
 * 选择题 / 判断题的按钮不认 Enter，评分结果页的「继续」也不认 Enter ——
 * 于是用户的感觉就是「时灵时不灵」。
 *
 * 现在的规则（**只有这一处决定 Enter 干什么**）：
 * | 阶段 | Enter |
 * | --- | --- |
 * | 出题中 | 不响应（正在等 AI，没有可确认的东西） |
 * | 作答中 · 填空/造句 | 提交（造句用 Shift+Enter 换行） |
 * | 作答中 · 选择/判断 | 选中的那一项提交（↑↓←→ 或数字键换项） |
 * | 评分中 | 不响应（**故意**：重复提交会重复落库、重复扣分） |
 * | 已评分 | 下一题（最后一题 = 结束） |
 * | 出错 | 重试当前题 |
 * | 做完了 | 回二期首页 |
 *
 * 另外一条规则：**焦点在按钮上时不抢**（浏览器的原生行为就是 Enter = 点这个按钮），
 * 否则会和原生行为打架，出现「按一次 Enter 提交两次」。
 */

// RULES-R1: 此处禁止任何强制时间限制（无倒计时 / 无超时提交 / 无超时判错）
import type { ExamPhase } from '../pages/kcExam/kcExamController';

/** Enter 该做的事 */
export type ExamEnterAction =
  | { kind: 'submit'; value: string }
  | { kind: 'next' }
  | { kind: 'retry' }
  | { kind: 'home' }
  | { kind: 'none' };

/** 页面上和 Enter 有关的控件（由 `readExamControls` 从 DOM 上读出来） */
export interface ExamControls {
  /** 当前可见的作答输入框（选择/判断题没有） */
  input: { value: string } | null;
  /** 选择/判断题里当前高亮选项的 key（A/B/C/D 或 对/错），没有则为 null */
  activeOption: string | null;
}

/**
 * 纯逻辑：算出现在按 Enter 该做什么。
 *
 * 抽成纯函数的意义：这是**用户抱怨的那条规则**，必须能一条条断言，
 * 而不是只能靠手点浏览器去感受（见 `test-kc-exam-ui`）。
 *
 * @param phase 当前阶段
 * @param ctl 页面上的控件
 */
export function resolveEnterAction(phase: ExamPhase, ctl: ExamControls): ExamEnterAction {
  if (phase === 'answering') {
    if (ctl.input !== null) return { kind: 'submit', value: ctl.input.value };
    if (ctl.activeOption !== null) return { kind: 'submit', value: ctl.activeOption };
    return { kind: 'none' };
  }
  if (phase === 'graded') return { kind: 'next' };
  if (phase === 'error') return { kind: 'retry' };
  if (phase === 'done') return { kind: 'home' };
  // preparing / loading / grading：正在等 AI，没有可确认的东西
  return { kind: 'none' };
}

/**
 * 从 DOM 上读出当前可用的控件。
 *
 * 用 class 查而不是留引用：答题卡每次状态变化都会**整块重建**
 * （见 `KcExamPage.render`），留引用必然指向已经脱离文档的旧节点。
 * @param root 答题卡根节点（还没有就传 null）
 */
export function readExamControls(root: HTMLElement | null): ExamControls {
  if (root === null) return { input: null, activeOption: null };
  const input = root.querySelector<HTMLInputElement | HTMLTextAreaElement>('.kc-answer-input');
  const active = root.querySelector<HTMLElement>('.kc-option-btn--active');
  return {
    input: input === null ? null : { value: input.value },
    activeOption: active?.dataset.optionKey ?? null,
  };
}

/**
 * 判断这个键盘事件的来源是否该被「让给浏览器原生行为」。
 *
 * 焦点在按钮/链接上时，浏览器原生就会把 Enter 变成一次点击；
 * 我们再处理一遍就会**提交两次**（选择题会连落两条记录）。
 *
 * 注意**不含** `summary`（「查看参考答案」那个折叠条）：焦点在它上面时
 * 原生行为是展开/收起，那样用户连按两次 Enter 会变成「展开又收起」，
 * 而他的意思显然是「看完了，下一题」——这正是用户抱怨的「时灵时不灵」。
 * 折叠条仍然可以用空格或鼠标展开。
 * @param target 事件目标
 */
export function shouldYieldToNative(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (el === null) return false;
  const tag = el.tagName;
  return tag === 'BUTTON' || tag === 'A';
}

/**
 * 这个键是不是「确认键」。
 *
 * 只认主键区的 Enter（`key === 'Enter'`），小键盘的 Enter 在浏览器里
 * 同样报 `'Enter'`，所以不用区分。
 * @param ev 键盘事件
 */
export function isConfirmKey(ev: KeyboardEvent): boolean {
  return ev.key === 'Enter';
}

/**
 * 选项类题目（选择/判断）的键盘操作：↑↓←→ 换项，数字键直选。
 *
 * Enter **不在这里处理**（统一走 `resolveEnterAction`），
 * 否则同一个键会被两处各响应一次。
 * @param ev 键盘事件
 * @param count 选项个数
 * @param current 当前高亮的下标
 * @returns 新的高亮下标；不认识的键返回 null
 */
export function nextOptionIndex(ev: KeyboardEvent, count: number, current: number): number | null {
  if (count <= 0) return null;
  if (ev.key === 'ArrowDown' || ev.key === 'ArrowRight') return (current + 1) % count;
  if (ev.key === 'ArrowUp' || ev.key === 'ArrowLeft') return (current - 1 + count) % count;
  const n = Number(ev.key);
  if (Number.isInteger(n) && n >= 1 && n <= count) return n - 1;
  return null;
}
