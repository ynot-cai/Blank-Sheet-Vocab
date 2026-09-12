/**
 * iOS 语音解锁层（阶段 05）。
 *
 * 问题：iOS Safari 上 `speechSynthesis.speak()` **第一次必须在用户手势回调里调用**，
 * 否则整段会话都会静音——而且不报错，用户只会觉得「朗读坏了」。
 *
 * 做法：
 * 1. 首次进入背诵页盖一层「点击开始」引导（只在真正需要时出现）；
 * 2. 用户点击时，在**同一次手势回调内**执行一次极短、静音的朗读来解锁；
 * 3. 解锁成功后把引导层收掉，并把「已解锁」记在内存 + localStorage（同一台设备只提示一次）；
 * 4. 文案里提醒「关掉 iPhone 侧边静音键」——这是 iOS 静音最常见的坑。
 */
import { button, h } from '../dom';

/** 已解锁标记（同一设备只提示一次） */
const UNLOCK_KEY = 'wordpaper.speechUnlocked';

/** 内存里的解锁状态（localStorage 被清掉也不影响本次会话） */
let unlockedInSession = false;

/**
 * 判断是否有必要显示引导层。
 * - 桌面浏览器不需要（没有这个限制，弹出来只会烦人）；
 * - 已经解锁过的不再显示。
 */
export function needsSpeechUnlock(): boolean {
  if (unlockedInSession) return false;
  if (readUnlockFlag()) {
    unlockedInSession = true;
    return false;
  }
  return isIosLike();
}

/**
 * 判断是不是「有这条限制」的设备。
 * 说明：不只看 iPhone——iPadOS 的 Safari 也走同一套 WebKit 限制；
 * 桌面版 Safari 直接在 Mac 上跑不受影响，但它的 UA 也含 Safari，
 * 所以这里用「触摸 + WebKit 内核」来判断，避免误伤桌面 Safari。
 */
function isIosLike(): boolean {
  const ua = navigator.userAgent;
  const isWebkit = /AppleWebKit/i.test(ua);
  const isIos = /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1);
  return isWebkit && isIos;
}

/** 读解锁标记（读不到就当没解锁） */
function readUnlockFlag(): boolean {
  try {
    return localStorage.getItem(UNLOCK_KEY) === '1';
  } catch {
    return false;
  }
}

/** 写解锁标记 */
function writeUnlockFlag(): void {
  try {
    localStorage.setItem(UNLOCK_KEY, '1');
  } catch {
    /* 隐私模式下写不进去也没关系，内存里已经记住了 */
  }
}

/**
 * 在用户手势里跑一次「静音朗读」来解锁语音引擎。
 * 必须**同步**在 click 回调里调用，不能 await 之后再调（那样就不再算用户手势了）。
 */
export function unlockSpeech(): void {
  try {
    const synth = window.speechSynthesis;
    if (!synth) return;
    const utter = new SpeechSynthesisUtterance(' ');
    utter.volume = 0; // 静音，用户听不到
    utter.rate = 2;
    synth.speak(utter);
    unlockedInSession = true;
    writeUnlockFlag();
  } catch (err) {
    console.warn('[speechGate] 语音解锁失败（不影响其他功能）', err);
  }
}

/**
 * 需要时挂载引导层。
 * @param host 承载容器（一般直接挂到页面根元素上）
 * @param onDone 解锁完成（或用户跳过）后的回调
 */
export function mountSpeechGate(host: HTMLElement, onDone: () => void): void {
  if (!needsSpeechUnlock()) {
    onDone();
    return;
  }

  const gate = h(
    'div',
    { class: 'speech-gate' },
    h('p', { class: 'speech-gate-title', text: '点击屏幕开始' }),
    h('p', { class: 'speech-gate-hint', text: '首次需要点击一下，才能启用语音朗读' }),
    h('p', { class: 'speech-gate-hint speech-gate-warn', text: '如果听不到声音，请检查 iPhone 侧边的静音键是否打开' }),
    button(
      '开始',
      () => {
        unlockSpeech(); // 必须在点击回调里同步调用
        gate.remove();
        onDone();
      },
      { variant: 'primary', class: 'speech-gate-btn' },
    ),
  );

  host.appendChild(gate);
}
