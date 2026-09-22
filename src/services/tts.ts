/**
 * 朗读（TTS）—— **再导出层**。
 *
 * ★ T4 起真正的实现在 `services/tts/` 目录下（抽象层 + 浏览器语音 + 有道适配器 + 缓存）：
 * - `tts/index.ts`  统一入口 `speak()`（缓存 → 第三方 → 浏览器语音三级降级）
 * - `tts/browser.ts` 浏览器 SpeechSynthesis
 * - `tts/voices.ts`  语音挑选规则与「语音列表就绪」监听
 * - `tts/normalize.ts` 朗读前文本预处理（音标/词性/缩写/连字符/数字）
 * - `tts/youdao.ts`  有道 TTS 签名与适配器
 * - `tts/cache.ts`   音频缓存（IndexedDB）
 *
 * 这个文件保留下来只为**不动既有 import**（历史代码写的是 `from '.../services/tts'`）。
 * 新代码可以直接从 `services/tts` 目录导入，语义更清楚。
 *
 * ⚠️ 不要把实现写回这个文件：`services/tts.ts` 与 `services/tts/` 同名会让
 * 模块解析产生歧义（有的打包器优先文件、有的优先目录），本项目统一用
 * 「目录 + index.ts」承载实现，这个文件只做转发。
 */
export {
  cancelSpeak,
  clearTtsCache,
  formatBytes,
  getLastThirdPartyResult,
  isSupported,
  isThirdPartyDisabled,
  listBrowserVoices,
  normalizeForSpeech,
  onVoicesChanged,
  pickVoice,
  resetSpeechDedupe,
  resetThirdPartyCircuit,
  resolveBrowserVoice,
  speak,
  speakAsync,
  stop,
  ttsCacheStats,
  YOUDAO_VOICES,
  type LastThirdPartyResult,
  type SpeakOptions,
  type TtsCacheStats,
  type TtsLang,
  type TtsProvider,
} from './tts/index';
export { isBrowserSpeechSupported } from './tts/browser';
export { createYoudaoProvider, YoudaoTtsError } from './tts/youdao';
