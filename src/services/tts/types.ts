/**
 * ★ T4：TTS 抽象层的类型定义。
 *
 * 这一层存在的理由：朗读以前是「直接调 speechSynthesis」，于是
 * 音色/语速/文本预处理/缓存/第三方服务全都无处安放。
 * 现在 `speak()` 是一个**统一入口**，背后可以是浏览器语音、也可以是有道 TTS：
 *
 * ```
 * speak(text, lang)
 *    │
 *    ├─ ① 有缓存音频？      → 直接播放（秒播，离线可用）
 *    ├─ ② 配置了第三方 TTS？ → 调 API → 写入缓存 → 播放
 *    └─ ③ 都没有 / 失败    → 降级到浏览器 speechSynthesis
 * ```
 */

/** 支持的语言标签（本项目只用到英文两种口音） */
export type TtsLang = 'en-US' | 'en-GB';

/**
 * 一个 TTS 提供方。
 *
 * ⚠️ 提供方**只负责「文本 → 音频字节」**，不负责播放、不负责缓存 ——
 * 那两件事在 `index.ts` 与 `cache.ts` 里统一做。这样新增一个第三方服务
 * （比如换成 Azure / 讯飞）只需要实现这一个接口，不用碰调度逻辑。
 */
export interface TtsProvider {
  /** 稳定 id（也是缓存键的一部分，换实现要换 id，否则会读到旧实现的音频） */
  id: 'browser' | 'youdao' | string;
  /** 界面上显示的名字 */
  label: string;
  /** 是否需要密钥（决定设置页要不要显示密钥输入框） */
  requiresKey: boolean;
  /**
   * 合成音频。
   *
   * @param text 已经过 `normalizeForSpeech` 的文本
   * @param opts 语言 / 速度 / 变体
   * @returns 音频字节（mp3）
   * @throws 失败时抛错，由调用方决定是否降级
   */
  synth(text: string, opts: { lang: TtsLang; speed: number; variant: number }): Promise<ArrayBuffer>;
}

/** `speak()` 的可选参数（与旧版 `SpeakOptions` 兼容） */
export interface SpeakOptions {
  /** 语速（不传则用设置里的 `speech.rate`） */
  rate?: number;
  /** 语言（不传则用设置里的 `speech.accent`） */
  lang?: TtsLang | string;
  /** 朗读结束后的回调 */
  onEnd?: () => void;
  /**
   * 强制只用浏览器语音（跳过第三方与缓存）。
   *
   * 用途：设置页的「可用语音」试听 —— 用户在那里就是在挑浏览器语音，
   * 不该被第三方 provider 抢走（否则试听听到的是有道的声音，选了个寂寞）。
   */
  forceBrowser?: boolean;
}

/** 第三方调用的上一次结果（设置页显示「上次第三方调用：成功 / 失败（原因）」） */
export interface LastThirdPartyResult {
  ok: boolean;
  /** 失败原因（成功时为空串） */
  reason: string;
  /** 发生时间戳 */
  at: number;
}
