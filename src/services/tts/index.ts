/**
 * ★ T4：统一的朗读入口（TTS 抽象层）。
 *
 * ── 调度逻辑（与阶段文档 T4 任务 2.2 一致）──
 * ```
 * speak(text, lang)
 *    │
 *    ├─ ① 归一化文本 → normalized
 *    ├─ ② 查缓存（key = providerId + normalized + speed + variant）
 *    │      命中 → 直接播放，return（秒播、离线可用）
 *    ├─ ③ 配置了第三方 provider 且密钥已填？
 *    │      try { synth() → 写缓存 → 播放 }
 *    │      catch { 记一次失败 → 降级 browser }
 *    │      （连续失败 3 次 → 本次会话内不再尝试第三方）
 *    └─ ④ 否则 / 降级 → browser speechSynthesis
 * ```
 *
 * ── 语气（重要）──
 * **失败必须静默降级**：第三方失败时不弹错误框打断用户，
 * 只 `console.warn` + 在设置页显示「上次调用失败：<原因>」。
 * 朗读是辅助功能，绝不能因为网络/额度问题挡住背单词。
 *
 * ── 兼容性 ──
 * 这个文件同时导出旧版 `services/tts.ts` 的全部公开 API
 * （`speak` / `cancelSpeak` / `stop` / `isSupported` / `pickVoice`），
 * 所以老的 `import { speak } from '.../services/tts'` 全部照常工作
 * （`services/tts.ts` 变成了一层再导出）。
 */
import { getSettings } from '../../core/config';
import type { SpeechSettings } from '../../core/types';
import { cancelSpeak as cancelBrowserSpeak, isBrowserSpeechSupported, speakWithBrowser } from './browser';
import { getCachedAudio, putCachedAudio, ttsCacheKey } from './cache';
import { normalizeForSpeech } from './normalize';
import type { LastThirdPartyResult, SpeakOptions, TtsLang } from './types';
import { pickBrowserVoice } from './voices';
import { createYoudaoProvider } from './youdao';

export type { SpeakOptions, TtsLang, TtsProvider, LastThirdPartyResult } from './types';
export { normalizeForSpeech } from './normalize';
export { pickBrowserVoice, listBrowserVoices, onVoicesChanged, resolveBrowserVoice } from './voices';
export * from './youdao';
export {
  clearTtsCache,
  formatBytes,
  ttsCacheStats,
  type TtsCacheStats,
} from './cache';
export { isBrowserSpeechSupported } from './browser';

/**
 * 连续失败多少次之后，本次会话内不再尝试第三方。
 *
 * 为什么要有：有道额度用完 / 密钥错 / 断网时，**每一次**朗读都会先等一个
 * 15 秒超时再降级 —— 用户听到的是「点了没反应、过一会儿才出声」。
 * 失败 3 次就说明这条路当前不通，本会话内直接用浏览器语音，体验立刻恢复。
 * 不做**永久**记忆是有意的：用户可能马上就去充值/改密钥，刷新页面即恢复。
 */
const THIRD_PARTY_FAIL_LIMIT = 3;

/** 本次会话内第三方连续失败次数 */
let thirdPartyFails = 0;
/** 上一次第三方调用的结果（设置页显示用） */
let lastThirdParty: LastThirdPartyResult | null = null;

/**
 * 上一次第三方调用的结果。
 * @returns 还没调用过时返回 null
 */
export function getLastThirdPartyResult(): LastThirdPartyResult | null {
  return lastThirdParty;
}

/**
 * 第三方是否已被本次会话「熔断」（连续失败达到上限）。
 */
export function isThirdPartyDisabled(): boolean {
  return thirdPartyFails >= THIRD_PARTY_FAIL_LIMIT;
}

/**
 * 重置熔断状态（设置页「测试朗读」成功后、或用户改了密钥时调）。
 */
export function resetThirdPartyCircuit(): void {
  thirdPartyFails = 0;
  lastThirdParty = null;
}

/**
 * 重复触发去重：同一文本在 {@link DEDUPE_WINDOW_MS} 内只念一次。
 *
 * 为什么需要：用户连点喇叭、或者「自动朗读」与手动朗读撞在一起时，
 * 声音会叠加成一片（`speechSynthesis` 的 cancel 只能取消浏览器语音，
 * 取消不了已经在播的 `<audio>`）。实测连点是最常见的误操作。
 */
const DEDUPE_WINDOW_MS = 1500;
/** 上一次真正发声的文本与时间 */
let lastSpoken = { text: '', at: 0 };

/**
 * 复位「重复触发去重」的记忆。
 *
 * 用途：**测试**。验收里要连点同一个词两次、证明「可重复点击」，
 * 而 1.5 秒窗口会（正确地）把第二次拦掉 —— 靠 sleep 绕过会把测试变慢且脆弱
 * （窗口值以后一改，测试又要跟着改）。
 *
 * ⚠️ 这是给测试用的显式开关，**不要在业务代码里调用它**：
 * 用户点同一个词两次本来就该被去重（那正是它的目的）。
 */
export function resetSpeechDedupe(): void {
  lastSpoken = { text: '', at: 0 };
}

/**
 * 读朗读设置（缓存没准备好时给一份安全默认值，避免整页崩掉）。
 */
function speechSettings(): SpeechSettings {
  try {
    return getSettings().speech;
  } catch {
    return {
      provider: 'browser',
      voiceName: '',
      rate: 0.9,
      youdao: { appKey: '', appSecret: '', voiceName: 'youmeimei' },
      accent: 'en-US',
      variant: 'single',
    };
  }
}

/**
 * 取有道 provider（惰性读设置：用户随时能改密钥，不必重建实例）。
 */
const youdaoProvider = createYoudaoProvider(() => {
  const s = speechSettings();
  return {
    appKey: s.youdao.appKey,
    appSecret: s.youdao.appSecret,
    voiceName: s.youdao.voiceName,
    accent: s.accent,
  };
});

/** 当前正在播放的音频元素（换曲要先把上一个停掉） */
let currentAudio: HTMLAudioElement | null = null;

/**
 * 播放一段音频字节。
 *
 * 用 `new Audio(objectURL)` 而不是 Web Audio API：前者在 iOS 上对手势解锁的
 * 兼容性最好（一期已经踩过这个坑），而且实现最短。
 * @param bytes 音频字节
 * @param onEnd 播放结束回调
 */
async function playAudioBytes(bytes: ArrayBuffer, onEnd?: () => void): Promise<void> {
  stopCurrentAudio();
  const blob = new Blob([bytes], { type: 'audio/mpeg' });
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  currentAudio = audio;
  const cleanup = (): void => {
    URL.revokeObjectURL(url);
    if (currentAudio === audio) currentAudio = null;
  };
  audio.addEventListener('ended', () => {
    cleanup();
    onEnd?.();
  });
  audio.addEventListener('error', () => {
    cleanup();
    // 播放失败也算「结束」，否则调用方的等待逻辑会挂住
    onEnd?.();
  });
  await audio.play();
}

/** 停掉正在播放的音频（换词/退出时调，避免两条音频叠在一起） */
function stopCurrentAudio(): void {
  if (currentAudio === null) return;
  try {
    currentAudio.pause();
  } catch {
    /* 已经结束了 */
  }
  currentAudio = null;
}

/**
 * 当前环境能不能出声。
 *
 * 口径：**浏览器语音可用**（旧版语义）—— 第三方只是增强，
 * 浏览器语音不可用时整个朗读功能就是不可用（与旧版 `isSupported()` 一致，
 * 调用方 `HintButton` 依赖这个语义决定要不要记「用过提示」）。
 */
export function isSupported(): boolean {
  return isBrowserSpeechSupported();
}

/**
 * 选一个发音语音（旧版 API 的兼容转发）。
 *
 * ⚠️ 语义与旧版**完全一致**：只按 `lang` 挑，**不看** `speech.voiceName`。
 * 为什么：旧调用点（如果有）期待的是「按语言挑一个」；
 * 而「用户在设置里指定的那个语音」由 `speak()` 那条路径负责（那才代表用户意图）。
 * 两者混在一起会出现「试听用的是用户选的、实际朗读用的是自动挑的」这种怪事。
 * @param lang 语言标签
 */
export function pickVoice(lang: string): SpeechSynthesisVoice | null {
  const target = (lang || speechSettings().accent) as TtsLang;
  return pickBrowserVoice(target);
}

/**
 * 朗读一段文本（统一入口）。
 *
 * 详细调度见文件头注释。**永不抛错**：任何失败都会降级到浏览器语音，
 * 浏览器语音也不可用时只打一条 warn。
 *
 * @param text 要读的文本（可以是带音标/词性/中文的原始字段，内部会归一化）
 * @param opts 语速 / 语言 / 结束回调 / 强制浏览器语音
 */
export function speak(text: string, opts: SpeakOptions = {}): void {
  void speakAsync(text, opts);
}

/**
 * `speak` 的异步实现（需要它的地方可以 await；普通调用直接用 `speak`）。
 *
 * 之所以把 `speak` 保持成同步签名：调用点很多（WordCard / PaperStage / HintButton），
 * 它们都不关心何时读完，改成 Promise 只会制造一堆无意义的 `void`。
 *
 * @param raw 原始文本
 * @param opts 朗读选项
 */
export async function speakAsync(raw: string, opts: SpeakOptions = {}): Promise<void> {
  const settings = speechSettings();
  const lang = (opts.lang ?? settings.accent) as TtsLang;
  const speed = clampRate(opts.rate ?? settings.rate);
  const isChinese = String(lang).toLowerCase().startsWith('zh');
  const normalized = normalizeForSpeech(raw, isChinese);
  if (normalized === '') return;

  // ② 去重：1.5 秒内连续触发同一文本，只念一次
  const now = Date.now();
  if (lastSpoken.text === normalized && now - lastSpoken.at < DEDUPE_WINDOW_MS) return;

  // ③ 第三方 + 缓存（forceBrowser 时整段跳过）
  const useThirdParty = !opts.forceBrowser && settings.provider === 'youdao' && !isThirdPartyDisabled();
  if (useThirdParty) {
    try {
      await speakWithThirdParty(normalized, lang, speed, settings, opts.onEnd);
      lastSpoken = { text: normalized, at: Date.now() };
      return;
    } catch (err) {
      // 静默降级：只记失败，不弹框、不打断
      const reason = friendlyReason(err);
      thirdPartyFails += 1;
      lastThirdParty = { ok: false, reason, at: Date.now() };
      console.warn(`[tts] 第三方朗读失败（第 ${thirdPartyFails} 次，达到 ${THIRD_PARTY_FAIL_LIMIT} 次后本次会话不再尝试）：${reason}`);
    }
  }

  // ④ 浏览器语音
  speakWithBrowser(normalized, { rate: speed, lang, voiceName: settings.voiceName, onEnd: opts.onEnd });
  lastSpoken = { text: normalized, at: Date.now() };
}

/**
 * 走第三方：缓存 → 合成 → 播放。
 *
 * @param text 已归一化的文本
 * @param lang 语言
 * @param speed 语速
 * @param settings 朗读设置
 * @param onEnd 结束回调
 */
async function speakWithThirdParty(
  text: string,
  lang: TtsLang,
  speed: number,
  settings: SpeechSettings,
  onEnd?: () => void,
): Promise<void> {
  const voice = settings.youdao.voiceName.trim() === '' ? 'youmeimei' : settings.youdao.voiceName.trim();
  const key = await ttsCacheKey({ providerId: 'youdao', text, speed, variant: 0, voice });
  const cached = await getCachedAudio(key);
  if (cached !== null) {
    // 缓存命中：秒播、不联网
    await playAudioBytes(cached, onEnd);
    lastThirdParty = { ok: true, reason: '（缓存命中）', at: Date.now() };
    return;
  }
  const bytes = await youdaoProvider.synth(text, { lang, speed, variant: 0 });
  await putCachedAudio(key, bytes);
  await playAudioBytes(bytes, onEnd);
  thirdPartyFails = 0;
  lastThirdParty = { ok: true, reason: '', at: Date.now() };
}

/**
 * 把各种错误转成一句人话（设置页要显示「上次调用失败：<原因>」）。
 * @param err 错误
 */
function friendlyReason(err: unknown): string {
  if (err !== null && typeof err === 'object' && 'friendly' in err) {
    const f = (err as { friendly?: unknown }).friendly;
    if (typeof f === 'string' && f !== '') return f;
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * 语速钳制到 0.5~1.5。
 *
 * 为什么上限是 1.5：再快就听不清单词的尾音了（而朗读的目的是听清），
 * 下限 0.5 是合成器普遍支持的边界。设置页的滑块也是这个范围。
 * @param rate 原始语速
 */
function clampRate(rate: number): number {
  if (!Number.isFinite(rate)) return 0.9;
  return Math.min(1.5, Math.max(0.5, rate));
}

/**
 * 停止/取消朗读。
 *
 * 两路都要停：浏览器语音（`speechSynthesis.cancel`）与第三方音频（`<audio>.pause`）。
 * 只停一路的话，切页/退出后可能有声音继续播。
 */
export function cancelSpeak(): void {
  cancelBrowserSpeak();
  stopCurrentAudio();
}

/** `cancelSpeak` 的别名（兼容旧调用） */
export function stop(): void {
  cancelSpeak();
}
