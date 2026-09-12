/**
 * 朗读：浏览器自带 SpeechSynthesis（Web Speech API）封装。
 * 不支持时静默失败（只 console.warn），不弹窗打断背单词。
 */

/** 语音列表是否已加载过（loadVoices 是异步填充的） */
let voicesLoaded = false;

/** 确保 voices 列表已加载 */
function ensureVoices(): void {
  if (!isSupported() || voicesLoaded) return;
  window.speechSynthesis.getVoices();
  window.speechSynthesis.addEventListener(
    'voiceschanged',
    () => {
      voicesLoaded = true;
    },
    { once: true },
  );
}

/**
 * 当前环境是否支持语音合成。
 */
export function isSupported(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window;
}

/**
 * 选一个发音语音：优先选与 lang 完全匹配的本地语音，其次前缀匹配（en-*），
 * 再其次系统默认。选不到返回 null（speak 里会静默降级）。
 * @param lang 语言标签，如 en-US
 */
export function pickVoice(lang: string): SpeechSynthesisVoice | null {
  if (!isSupported()) return null;
  ensureVoices();
  const voices = window.speechSynthesis.getVoices();
  const target = lang.toLowerCase();
  const prefix = target.split('-')[0] ?? 'en';
  let fallback: SpeechSynthesisVoice | null = null;
  for (const voice of voices) {
    const vlang = voice.lang.toLowerCase();
    if (vlang === target && voice.localService) return voice;
    if (vlang === target && !fallback) fallback = voice;
    if (vlang.startsWith(prefix) && !fallback) fallback = voice;
  }
  return fallback;
}

/** 朗读参数 */
export interface SpeakOptions {
  rate?: number;
  lang?: string;
  /** 朗读结束后回调 */
  onEnd?: () => void;
}

/**
 * 朗读一段文本（会先打断上一条，避免连续快速点击时排队叠读）。
 * 环境不支持语音时静默失败。
 * @param text 要读的文本
 * @param opts 语速 / 语言
 */
export function speak(text: string, opts: SpeakOptions = {}): void {
  if (!isSupported() || text.trim() === '') {
    if (text.trim() === '') return;
    console.warn('[tts] 当前环境不支持语音合成，跳过朗读');
    return;
  }
  const synth = window.speechSynthesis;
  synth.cancel(); // 先取消上一条，再读新的
  const utter = new SpeechSynthesisUtterance(text);
  utter.rate = opts.rate ?? 1;
  utter.lang = opts.lang ?? 'en-US';
  const voice = pickVoice(utter.lang);
  if (voice) utter.voice = voice;
  if (opts.onEnd) utter.onend = () => opts.onEnd?.();
  synth.speak(utter);
}

/**
 * 停止/取消朗读。
 */
export function cancelSpeak(): void {
  if (!isSupported()) return;
  window.speechSynthesis.cancel();
}

/**
 * 停止朗读（cancelSpeak 的别名，兼容旧调用）。
 */
export function stop(): void {
  cancelSpeak();
}
