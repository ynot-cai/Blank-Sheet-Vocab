/**
 * ★ T4：浏览器语音的挑选与参数。
 *
 * ── 为什么要把「挑 voice」单独抽出来 ──
 * 老实现是「完全匹配 lang 且 localService → 返回；否则返回第一个前缀匹配的」，
 * 于是**经常挑到一个 compact/低质量语音**（用户原话：「朗读音质怎么这么差」），
 * 而且顺序敏感：`getVoices()` 的返回顺序在不同设备上不一样，
 * 同一段代码在 A 机器挑到 Siri、在 B 机器挑到 Google 的压缩语音。
 *
 * 新规则（按优先级排序，**不依赖数组顺序**）：
 *   1. lang 匹配（en-US / en-GB，按用户设置）
 *   2. `localService === true`（本地语音：不联网、更稳、延迟低）
 *   3. 名称含 Premium / Enhanced / Siri 等高质量标记
 *   4. 都挑不到 → 第一个 lang 前缀匹配的
 * 每一步都是「先看这一步的条件，满足就停」，
 * 且**同一优先级内按名称排序**取第一个 —— 这样同设备结果稳定、可复现。
 */
import type { TtsLang } from './types';

/** 高质量语音的名称标记（命中越多越靠前） */
const QUALITY_MARKERS = ['premium', 'enhanced', 'neural', 'siri', 'natural', 'google'];

/** 低质量语音的名称标记（compact 是 Chrome/Android 上最常见的小体积语音） */
const LOW_QUALITY_MARKERS = ['compact', 'espeak', 'robot'];

/**
 * 给一个 voice 打「质量分」（越大越好）。
 *
 * 之所以用打分而不是「命中就返回」：一台设备上可能同时有多个 premium 语音
 * （例如 `Samantha (Enhanced)` 与 `Alex (Premium)`），
 * 打分能把「同时命中多个标记」的那个排前面，比数组顺序可靠。
 * @param voice 语音
 */
function qualityScore(voice: SpeechSynthesisVoice): number {
  const name = voice.name.toLowerCase();
  let score = 0;
  for (const m of QUALITY_MARKERS) if (name.includes(m)) score += 2;
  for (const m of LOW_QUALITY_MARKERS) if (name.includes(m)) score -= 3;
  if (voice.localService) score += 1;
  if (voice.default) score += 0.5;
  return score;
}

/**
 * 挑一个最合适的英文语音。
 *
 * @param lang 目标语言（en-US / en-GB）
 * @param voices 可用语音列表（不传则读 `speechSynthesis.getVoices()`）
 * @returns 挑中的语音；一个可用语音都没有时返回 null
 */
export function pickBrowserVoice(lang: TtsLang, voices?: SpeechSynthesisVoice[]): SpeechSynthesisVoice | null {
  const list = voices ?? listBrowserVoices();
  if (list.length === 0) return null;

  const target = lang.toLowerCase();
  const prefix = target.split('-')[0] ?? 'en';

  /** 排序器：先按质量分降序，再按名称升序（保证同设备结果稳定） */
  const best = (candidates: SpeechSynthesisVoice[]): SpeechSynthesisVoice | null => {
    if (candidates.length === 0) return null;
    return [...candidates].sort((a, b) => {
      const d = qualityScore(b) - qualityScore(a);
      if (d !== 0) return d;
      return a.name.localeCompare(b.name);
    })[0] ?? null;
  };

  // ① lang 完全匹配
  const exact = list.filter((v) => v.lang.toLowerCase() === target);
  if (exact.length > 0) {
    // ② 其中优先本地语音（不联网、更稳）
    const local = exact.filter((v) => v.localService);
    return best(local.length > 0 ? local : exact);
  }

  // ③ 前缀匹配（en-*）：同样优先本地
  const prefixed = list.filter((v) => v.lang.toLowerCase().startsWith(prefix));
  if (prefixed.length > 0) {
    const local = prefixed.filter((v) => v.localService);
    return best(local.length > 0 ? local : prefixed);
  }

  // ④ 实在没有英文语音：给一个质量最好的（总比不发声强），交给合成器按 lang 处理
  return best(list);
}

/**
 * 取系统可用语音列表（**同步**，拿不到返回空数组）。
 *
 * 说明：部分浏览器（Chrome）首次调用 `getVoices()` 返回空数组，
 * 要等 `voiceschanged` 事件之后才有值 —— 调用方应该监听 `onVoicesChanged` 再刷新界面。
 */
export function listBrowserVoices(): SpeechSynthesisVoice[] {
  try {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return [];
    return window.speechSynthesis.getVoices() ?? [];
  } catch (err) {
    console.warn('[tts] 读取语音列表失败', err);
    return [];
  }
}

/**
 * 注册「语音列表就绪」回调。
 *
 * 为什么需要：Chrome 首次 `getVoices()` 是空的，设置页的语音下拉如果只读一次
 * 就会永远是空的（用户看到「没有可用语音」但实际有一堆）。
 * @param fn 列表变化时调用
 * @returns 取消注册
 */
export function onVoicesChanged(fn: () => void): () => void {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return () => undefined;
  const handler = (): void => fn();
  window.speechSynthesis.addEventListener('voiceschanged', handler);
  return () => window.speechSynthesis.removeEventListener('voiceschanged', handler);
}

/**
 * 按用户设置挑语音：指定了名字就找同名的，找不到（换设备了）回退到自动挑选。
 *
 * @param lang 目标语言
 * @param preferredName 设置里存的名字（空串 = 自动）
 */
export function resolveBrowserVoice(lang: TtsLang, preferredName: string): SpeechSynthesisVoice | null {
  const list = listBrowserVoices();
  const want = preferredName.trim();
  if (want !== '') {
    const hit = list.find((v) => v.name === want);
    if (hit) return hit;
    // 找不到不报错：不同设备可用语音不同，静默回退（用户下次在设置页重选即可）
    console.info(`[tts] 设置里的语音「${want}」在这台设备上不存在，已自动回退`);
  }
  return pickBrowserVoice(lang, list);
}
