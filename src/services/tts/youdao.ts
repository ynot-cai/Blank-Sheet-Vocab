/**
 * ★ T4：有道 TTS 适配器。
 *
 * ── 为什么签名必须在**浏览器端**算（方案 B 的底线）──
 * 签名需要 `appSecret`。如果把签名交给服务器，服务器就必然要拿到 appSecret ——
 * 那正是 AI_RULES.md R4 明令禁止的（服务器永不接触密钥）。
 * 所以：浏览器用本机的 appSecret 算好签名，把**已签名的完整表单**POST 给
 * `/api/tts-proxy`，代理只做「原样转发 + 原样返回音频」，永远看不到 appSecret。
 *
 * ── API 事实（照抄官方文档，不要凭记忆改）──
 * - 端点 `https://openapi.youdao.com/ttsapi`，POST，`application/x-www-form-urlencoded`
 * - 成功返回**音频二进制**（mp3）；失败返回 JSON
 * - 必填：`q`（≤2048 字符）、`appKey`、`salt`（UUID）、`sign`、`signType=v3`、`curtime`（秒）、`voiceName`
 * - 可选：`format=mp3`、`speed`（0.5~2.0）、`volume`（0.5~5.0）
 *
 * ── 签名算法（最容易写错的一处，逐字对照文档）──
 * ```
 * sign = SHA256(appKey + input + salt + curtime + appSecret)
 * 其中 input:
 *   if (q.length > 20) input = q 的前 10 个字符 + q 的长度 + q 的后 10 个字符
 *   else               input = q
 * ```
 * ⚠️ 三个反直觉的点（写错就是 202「签名校验失败」）：
 * 1. 拼接用的是 **q 本身**（截断规则只作用于 `input`，且 `input` 只参与签名、不作为参数发送）；
 * 2. 长度是**字符数**（JS 的 `q.length`，UTF-8 下的码元数）；
 * 3. 生成签名时 **q 不做 URL encode**；只有发送时才由 `URLSearchParams` 统一编码。
 *
 * 自测入口：`window.__selftest.youdaoSign`（见 `dev/selftest` 的挂载点说明），
 * 给定固定的 appKey / appSecret / salt / curtime / q，输出必须与
 * 《有道 TTS 接入教程》里的 Node 脚本算出的一致。
 */
import { API_ROUTES } from '../../dao/syncServer';
import type { TtsLang, TtsProvider } from './types';

/** API 端点（代理会把它当作目标地址转发过去） */
export const YOUDAO_TTS_ENDPOINT = 'https://openapi.youdao.com/ttsapi';

/**
 * 发音人对照表（名称 → 说明 → 口音）。
 *
 * 默认推荐 `youmeimei`（有梅梅）：官方说明是「英文·词典美式发音」，
 * 专为单词发音设计，最贴合本项目的用途（念单词）。
 */
export const YOUDAO_VOICES: readonly { value: string; label: string; accent: TtsLang }[] = [
  { value: 'youmeimei', label: '有梅梅（词典美式，推荐）', accent: 'en-US' },
  { value: 'youyingying', label: '有莹莹（词典英式）', accent: 'en-GB' },
  { value: 'youxiaomei', label: '有小美（英文·美式）', accent: 'en-US' },
  { value: 'youxiaoying', label: '有小英（英文·英式）', accent: 'en-GB' },
  { value: 'youyating', label: '有雅婷（英文·美式）', accent: 'en-US' },
  { value: 'youxiaoguan', label: '有小官（英文·英式）', accent: 'en-GB' },
  { value: 'youxiaoshao', label: '有小绍（中英混·词典发音）', accent: 'en-US' },
  { value: 'weixiaomei', label: '薇小美（英文·美式，非常见语种档）', accent: 'en-US' },
  { value: 'weixiaoying', label: '薇小英（英文·英式，非常见语种档）', accent: 'en-GB' },
];

/**
 * 常见错误码 → 给用户看的提示。
 *
 * 为什么要逐个映射：有道把失败信息放在 JSON 的 `errorCode` 里，
 * 直接显示「错误码 202」用户完全不知道要做什么。这里把每条都翻译成**能照做的动作**。
 */
export const YOUDAO_ERRORS: Record<string, string> = {
  '108': '应用 ID 无效，请检查设置',
  '110': '应用未绑定语音合成服务，请去控制台绑定',
  '202': '签名错误，请检查应用密钥',
  '401': '账户余额不足，请充值',
  '411': '体验额度已用完',
};

/**
 * 有道 TTS 的错误（带上错误码，便于界面映射文案）。
 */
export class YoudaoTtsError extends Error {
  /** 有道返回的错误码（网络失败等场景为空串） */
  readonly code: string;

  /**
   * @param message 面向开发者的说明
   * @param code 有道错误码（可选）
   */
  constructor(message: string, code = '') {
    super(message);
    this.name = 'YoudaoTtsError';
    this.code = code;
  }

  /** 面向用户的提示文案（错误码能映射就用映射，否则给原始信息） */
  get friendly(): string {
    return YOUDAO_ERRORS[this.code] ?? this.message;
  }
}

/** 生成 UUID（salt 用）。优先用 crypto.randomUUID，环境不支持时降级。 */
export function makeSalt(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 计算签名的 `input` 字段（截断规则）。
 *
 * ⚠️ 这个函数**只用于签名拼接**，它的返回值不作为参数发送 ——
 * 发送的 `q` 永远是原文（见 {@link buildSignedForm}）。
 * @param q 待合成文本（原文）
 */
export function youdaoSignInput(q: string): string {
  if (q.length <= 20) return q;
  return `${q.slice(0, 10)}${q.length}${q.slice(-10)}`;
}

/**
 * 把字符串算成 SHA-256 的十六进制小写（用 WebCrypto，**不引任何 SDK**）。
 *
 * 为什么不用 `crypto.subtle.digest` 之外的方案：它就是标准库，
 * 引第三方库只为算一个哈希不值得（用户明确要求「不引入任何 TTS SDK」）。
 * @param text 待哈希文本
 */
export async function sha256Hex(text: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new YoudaoTtsError('当前环境不支持 WebCrypto，无法计算签名（需要 https 或 localhost）');
  const data = new TextEncoder().encode(text);
  const digest = await subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 算有道 v3 签名。
 *
 * `sign = SHA256(appKey + input + salt + curtime + appSecret)`
 *
 * @param args appKey / appSecret / salt / curtime / q
 */
export async function youdaoSign(args: {
  appKey: string;
  appSecret: string;
  salt: string;
  curtime: string;
  q: string;
}): Promise<string> {
  const input = youdaoSignInput(args.q);
  return sha256Hex(`${args.appKey}${input}${args.salt}${args.curtime}${args.appSecret}`);
}

/**
 * 组装「已签名」的完整表单（**代理会原样转发它**）。
 *
 * 为什么返回的是表单而不是让调用方自己拼：签名与参数必须严格对应，
 * 分成两处写迟早出现「签名用了一个 q、发送用了另一个」这种查不出来的偏差。
 * 所以这里**一次把 q / appKey / salt / sign / curtime / signType / voiceName / format
 * 全部算好**，调用方只负责 POST。
 *
 * @param args 文本与配置
 */
export async function buildSignedForm(args: {
  q: string;
  appKey: string;
  appSecret: string;
  voiceName: string;
  speed: number;
  /** 现在的时间戳（秒）；默认 Date.now()，测试可注入 */
  now?: number;
}): Promise<Record<string, string>> {
  const salt = makeSalt();
  const curtime = String(Math.floor((args.now ?? Date.now()) / 1000));
  const sign = await youdaoSign({ appKey: args.appKey, appSecret: args.appSecret, salt, curtime, q: args.q });
  // 有道规定 speed 0.5~2.0（越界会被拒），这里先夹住
  const speed = Math.min(2, Math.max(0.5, args.speed));
  return {
    q: args.q,
    appKey: args.appKey,
    salt,
    sign,
    signType: 'v3',
    curtime,
    voiceName: args.voiceName,
    format: 'mp3',
    speed: String(speed),
  };
}

/**
 * 从代理响应里取出音频字节。
 *
 * 约定（与教程一致）：**Content-Type 含 audio 就是成功**，
 * 否则 body 是 JSON 错误（`{ errorCode, message }`）。
 *
 * 为什么按 Content-Type 而不是按状态码判断：代理是原样透传上游状态的，
 * 有道成功时返回 200 + audio/mpeg，失败时也可能返回 200 + application/json。
 * @param res fetch 响应
 */
export async function readYoudaoResponse(res: Response): Promise<ArrayBuffer> {
  const ct = res.headers.get('Content-Type') ?? '';
  if (ct.includes('audio')) return res.arrayBuffer();
  // 失败：尽力解析错误码，解析不出来也要给出可读信息
  let code = '';
  let message = `HTTP ${res.status}`;
  try {
    const data: unknown = await res.json();
    if (typeof data === 'object' && data !== null) {
      const obj = data as Record<string, unknown>;
      code = String(obj['errorCode'] ?? '');
      message = String(obj['message'] ?? obj['error'] ?? message);
    }
  } catch {
    /* body 不是 JSON（例如网关的 HTML 错误页）：保留 HTTP 状态信息 */
  }
  throw new YoudaoTtsError(`有道 TTS 失败：${code} ${message}`.trim(), code);
}

/**
 * 有道提供方（实现 {@link TtsProvider}）。
 *
 * ⚠️ 它只做「文本 → 音频字节」，不碰播放与缓存。
 * @param getConfig 取配置（惰性读设置：用户可以随时改密钥，不必重建 provider）
 * @param proxyUrl 代理地址（默认同源 `/api/tts-proxy`）
 */
export function createYoudaoProvider(
  getConfig: () => { appKey: string; appSecret: string; voiceName: string; accent: TtsLang },
  proxyUrl = API_ROUTES.ttsProxy,
): TtsProvider {
  return {
    id: 'youdao',
    label: '有道 TTS',
    requiresKey: true,
    async synth(text, opts) {
      const cfg = getConfig();
      const q = text.trim();
      if (q === '') throw new YoudaoTtsError('要合成的文本是空的');
      if (q.length > 2048) throw new YoudaoTtsError('文本超过 2048 个字符，有道不支持');
      if (cfg.appKey.trim() === '' || cfg.appSecret.trim() === '') {
        throw new YoudaoTtsError('还没填有道 TTS 的应用 ID / 应用密钥（设置 → D 区）');
      }

      const form = await buildSignedForm({
        q,
        appKey: cfg.appKey.trim(),
        appSecret: cfg.appSecret.trim(),
        voiceName: cfg.voiceName.trim() === '' ? 'youmeimei' : cfg.voiceName.trim(),
        speed: opts.speed,
      });

      let res: Response;
      try {
        res = await fetch(proxyUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams(form).toString(),
        });
      } catch (err) {
        throw new YoudaoTtsError(`请求 TTS 代理失败：${err instanceof Error ? err.message : String(err)}`);
      }
      return readYoudaoResponse(res);
    },
  };
}
