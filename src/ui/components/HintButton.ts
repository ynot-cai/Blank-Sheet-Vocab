/**
 * ★ T3：「朗诵一遍」提示按钮。
 *
 * ── 为什么做成独立组件 ──
 * 这是**一期（默写/拼写）与二期（语法填空/写句子）共用的同一个提示**。
 * 两处各写一遍必然出现「一边念单词、一边念释义」或者「一边记 hintUsed、
 * 一边忘了记」这类偏差；而 hintUsed 直接影响判分（见下面的 {@link resolvePass}），
 * 记漏一处就等于那个环节的题永远不会被判「提示后未通过」。
 *
 * ── 交互要求（阶段文档 T3）──
 * - 文案「朗诵一遍」+ 喇叭图标；
 * - 点一下把这个单词的**英文**念一遍（不念音标、不念中文释义）；
 * - **可重复点击**：RULES-R1 明确禁止任何次数或时间限制，
 *   所以这里不设上限、也没有旧提示那种「再提示没有更多了」的封顶；
 * - 朗读失败（设备没有语音 / 被浏览器拦截）→ **静默降级**成一行轻提示，
 *   不影响作答、不判错。
 *
 * ── iOS 首次朗读要手势解锁 ──
 * 点击本身就是手势，天然满足；解锁沿用一期已有的 `SpeechGate`
 * （页面挂载时用一次静音 utterance 解锁），这里不重复实现。
 */
import { isSupported, speak } from '../../services/tts';
import { h } from '../dom';

/** 「朗诵一遍」提示按钮的句柄 */
export interface HintButton {
  /** 按钮根元素（挂到作答界面里） */
  el: HTMLButtonElement;
  /** 这道题**有没有真的用过提示**（判分用；朗读失败不算用过） */
  used: () => boolean;
  /** 复位成「没用过」（每道题开始时调一次） */
  reset: () => void;
}

/** 提示按钮的文案（喇叭用 emoji，避免为一个小按钮引入图标体系） */
export const HINT_LABEL = '🔊 朗诵一遍';

/** 朗读不可用时的轻提示文案（用户要求：静默降级，不阻断） */
export const HINT_UNSUPPORTED_TEXT = '当前设备不支持朗读';

/**
 * 每个提示按钮对应的「说明小字」。
 *
 * 用 WeakMap 而不是往元素上挂属性：`h()` 造出来的是真 HTMLElement，
 * 往上挂自定义属性要靠类型断言（丑陋且容易和 DOM 自身属性撞名）。
 */
const notes = new WeakMap<HTMLButtonElement, HTMLElement>();

/**
 * 是否应该给这个考察环节显示「朗诵一遍」。
 *
 * 用户明确要求：**只对需要拼写的考察显示**（一期的默写/拼写、二期的语法填空、
 * 写句子）；**选择题与判断正误不显示** —— 那两种题型的选项已经给出来了，
 * 听发音帮不上忙（念出来也没用）。
 *
 * @param kind 题型标识
 */
export function shouldShowHint(kind: 'spell' | 'fill' | 'sentence' | 'choice' | 'judge'): boolean {
  return kind === 'spell' || kind === 'fill' || kind === 'sentence';
}

/**
 * 造一个「朗诵一遍」提示按钮。
 *
 * @param getText 取要朗读的英文（**惰性取值**：词可能在作答途中被编辑）
 */
export function createHintButton(getText: () => string): HintButton {
  let used = false;

  const btn = h('button', {
    class: 'btn btn-hint',
    type: 'button',
    text: HINT_LABEL,
    title: '把这个单词念一遍（可以重复点）',
  });
  btn.dataset.role = 'speak-hint';

  /**
   * 轻提示行：朗读不可用时只提示、不判错、不阻断。
   *
   * 为什么不用 Toast：Toast 挂在 body 上，而作答界面是一层遮罩，
   * 手机上容易被卡片挡掉。放在按钮旁边的一行小字位置固定、必然可见。
   */
  const note = h('span', { class: 'hint-note hidden', text: HINT_UNSUPPORTED_TEXT });
  notes.set(btn, note);

  btn.addEventListener('click', () => {
    /**
     * ★ 只有**真的发出了声音**才算「用过提示」。
     *
     * 设备不支持语音、或词是空的时候，用户一点帮助都没得到，
     * 此时把它记成「用了提示」再判未通过是不合理的（会让用户在坏设备上
     * 无论如何都拿不到通过）。所以这两条路径只显示提示、不置 hintUsed。
     */
    if (!isSupported()) {
      note.classList.remove('hidden');
      return;
    }
    const text = getText().trim();
    if (text === '') {
      note.classList.remove('hidden');
      return;
    }
    note.classList.add('hidden');
    speak(text);
    used = true;
    // 把状态同步到 DOM：Enter 提交那条路径（examKeys 统一处理）拿不到组件实例，
    // 只能从 DOM 上读「这道题用过提示没有」。见 hintUsedIn()。
    btn.dataset.used = '1';
  });

  return {
    el: btn,
    used: () => used,
    reset: () => {
      used = false;
      delete btn.dataset.used;
      note.classList.add('hidden');
    },
  };
}

/**
 * 从一段 DOM 里读「这道题用过提示没有」。
 *
 * 为什么需要它：Enter 提交走的是 `components/examKeys` 的统一键盘处理，
 * 那里只有 DOM、没有组件实例。两个提交入口必须得到**同一个答案**，
 * 否则「点提交」和「按 Enter」在同一个设置下会判出不同结果。
 *
 * @param root 作答区域的根元素（没传就查整个文档）
 */
export function hintUsedIn(root: ParentNode = document): boolean {
  return root.querySelector('[data-role="speak-hint"][data-used="1"]') !== null;
}

/**
 * 取提示按钮配套的说明元素（「当前设备不支持朗读」那行小字）。
 *
 * 调用方把它和按钮放在同一行（或紧挨着），按钮发声失败时它才会出现。
 * @param hint {@link createHintButton} 的返回值
 */
export function hintNoteEl(hint: HintButton): HTMLElement {
  return notes.get(hint.el) ?? h('span', { class: 'hint-note hidden' });
}

/**
 * ★ T3 的判分规则（**唯一实现**）。
 *
 * ```
 * 若 设置「提示后算作未通过」= 是 且 hintUsed = true
 *   → pass = false
 * 否则 → pass = answerCorrect
 * ```
 *
 * 场景 C（本次改造的核心语义）：**开启后，哪怕答对，用了提示也记未通过**。
 *
 * ⚠️ 这里**不碰任何历史数据**：开关只影响「之后发生的考核」，
 *   已记录的 failCount / examCount 一个都不改（用户明确要求，且不许写回填代码）。
 *
 * @param answerCorrect 答案本身对不对（按 R2 的义项规则判出来的）
 * @param hintUsed 这道题有没有用过提示
 * @param hintFails 设置项 `practice.hintFails`
 */
export function resolvePass(answerCorrect: boolean, hintUsed: boolean, hintFails: boolean): boolean {
  if (hintFails && hintUsed) return false;
  return answerCorrect;
}
