/**
 * ★ T4：浏览器语音（SpeechSynthesis）提供方。
 *
 * 从原来的 `services/tts.ts` 搬过来，改动只有三处（都是为了新的抽象层）：
 * 1. 语速由调用方传入（不再写死 1.0）；
 * 2. 语音挑选走 `voices.ts` 的新规则（本地 + 质量标记 + 稳定排序）；
 * 3. 支持「用户指定语音名」——换设备后名字对不上时自动回退。
 *
 * 其余行为**一字未改**（尤其是静默降级：环境不支持时只 warn，不抛错、不弹窗）。
 */
import type { TtsLang } from './types';
import { pickBrowserVoice, resolveBrowserVoice } from './voices';

/** 语音列表是否已经触发过加载（`getVoices` 是异步填充的） */
let voicesLoadRequested = false;

/**
 * 触发一次 voices 列表加载。
 *
 * Chrome 首次 `getVoices()` 返回空数组，要等 `voiceschanged` 才有值。
 * 这里主动调一次 `getVoices()` 让浏览器开始填充，并挂一次性监听。
 */
function ensureVoices(): void {
  if (!isBrowserSpeechSupported() || voicesLoadRequested) return;
  voicesLoadRequested = true;
  try {
    window.speechSynthesis.getVoices();
    window.speechSynthesis.addEventListener('voiceschanged', () => undefined, { once: true });
  } catch (err) {
    console.warn('[tts] 初始化语音列表失败', err);
  }
}

/**
 * 当前环境是否支持浏览器语音合成。
 */
export function isBrowserSpeechSupported(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window;
}

/** 浏览器朗读的参数 */
export interface BrowserSpeakOptions {
  /** 语速 */
  rate: number;
  /** 语言 */
  lang: TtsLang;
  /** 用户指定的语音名（空串 = 自动挑） */
  voiceName?: string;
  /** 结束回调 */
  onEnd?: () => void;
}

/**
 * 用浏览器语音朗读（**同步触发**，不返回 Promise）。
 *
 * 为什么保持同步：`speechSynthesis.speak()` 本身就是「排队后立即返回」的语义，
 * 包成 Promise 只会让调用方以为要等读完，反而写出一堆无意义的 await。
 *
 * @param text 已归一化的文本
 * @param opts 语速 / 语言 / 语音名 / 结束回调
 */
export function speakWithBrowser(text: string, opts: BrowserSpeakOptions): void {
  if (!isBrowserSpeechSupported()) {
    console.warn('[tts] 当前环境不支持语音合成，跳过朗读');
    return;
  }
  if (text.trim() === '') return;
  ensureVoices();

  let utter: SpeechSynthesisUtterance;
  try {
    utter = new SpeechSynthesisUtterance(text);
  } catch (err) {
    console.warn('[tts] 创建朗读对象失败', err);
    return;
  }
  utter.rate = opts.rate;
  utter.lang = opts.lang;
  const voice = opts.voiceName !== undefined && opts.voiceName !== ''
    ? resolveBrowserVoice(opts.lang, opts.voiceName)
    : pickBrowserVoice(opts.lang);
  /**
   * ⚠️ `utter.voice` 必须是**真正的 SpeechSynthesisVoice 对象**。
   * 传一个普通对象（例如测试里自己造的假 voice）会抛
   * `Failed to set the 'voice' property …: Failed to convert value to 'SpeechSynthesisVoice'`，
   * 而且这个异常是同步抛的 —— 会把调用它的那一段流程整段打断。
   * 这一条实测踩过（T3 的测试脚手架），所以赋值单独包一层 try。
   */
  if (voice !== null) {
    try {
      utter.voice = voice;
    } catch (err) {
      console.warn('[tts] 设置语音失败，改用系统默认', err);
    }
  }
  if (opts.onEnd !== undefined) utter.onend = () => opts.onEnd?.();

  try {
    window.speechSynthesis.cancel(); // 先取消上一条，再读新的（避免叠读）
    window.speechSynthesis.speak(utter);
  } catch (err) {
    console.warn('[tts] 朗读失败（静默降级，不影响作答）', err);
  }
}

/**
 * 取消浏览器语音。
 */
export function cancelSpeak(): void {
  if (!isBrowserSpeechSupported()) return;
  try {
    window.speechSynthesis.cancel();
  } catch (err) {
    console.warn('[tts] 取消朗读失败', err);
  }
}
