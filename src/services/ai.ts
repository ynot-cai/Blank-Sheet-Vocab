/**
 * AI 解析服务。
 *
 * 接法：这里只有一个「通用接口位」——地址、模型名、密钥三项全部由用户在设置页自己填，
 * 代码里不做任何厂商判断（不会出现 if (url.includes('deepseek')) 这类分支）。
 * 请求格式固定为 OpenAI 兼容格式，只保证 DeepSeek 官方可用，其他兼容服务能填通就能用。
 *
 * **两条路径自动切换（阶段 03）**：
 * 1. **直连**：浏览器直接请求用户填的接口地址（首选）；
 * 2. **代理**：被 CORS / 网络层拦下时，改走自己部署的无状态代理 `POST {后端}/api/ai-proxy`，
 *    目标地址放 `X-Target-Url`，密钥仍放 `Authorization`。
 *
 * **安全底线（任何时候都不许破例）**：密钥只存在这台设备的浏览器里（localStorage / IndexedDB），
 * 两条路径都是「浏览器把密钥发出去」，服务器（含代理）**不保存、不缓存、不落库**。
 */
import type { Settings } from '../core/types';
import { normalizeApiBase } from '../core/syncHelper';
import { splitPackedSenses } from '../core/model';
import { SENSE_RULES_FOR_AI, normalizeAliases } from '../core/senseRules';
import { API_ROUTES } from '../dao/syncServer';

/** AI 接口配置（三项全部由用户填） */
export interface AiConfig {
  endpoint: string;
  model: string;
  key: string;
  /**
   * 走哪条路：
   * - 不填 / false：先直连，失败且是网络类错误时自动切代理；
   * - true：直接走代理，不再尝试直连。
   * 注意：只有同时给了 `cloudApiBase`（自己部署的后端地址）时才可能走代理。
   */
  useProxy?: boolean;
  /** 自己部署的后端地址（阶段 01/03 的 Vercel 项目），代理路径是 `{它}/api/ai-proxy` */
  cloudApiBase?: string;
}

/** 实际使用的调用路径 */
export type AiRoute = 'direct' | 'proxy';

/** 最近一次调用实际走的路径（设置页显示「直连 / 代理」用） */
let lastRoute: AiRoute | null = null;

/**
 * 读最近一次调用走的路径。
 */
export function getLastAiRoute(): AiRoute | null {
  return lastRoute;
}

/** 对话消息 */
export interface ChatMessage {
  role: 'system' | 'user';
  content: string;
}

/** 单批解析出的一个词 */
export interface ParsedWord {
  en: string;
  phonetic: string;
  example: string;
  senses: { text: string; aliases: string[] }[];
}

/** 单批解析结果 */
export interface ParseBatchResult {
  entries: ParsedWord[];
  failed: boolean;
  error?: string;
}

/** 默认超时（毫秒） */
const DEFAULT_TIMEOUT_MS = 60_000;
/** 测试连接用的超时（短一点，别让用户干等） */
const TEST_TIMEOUT_MS = 20_000;

/**
 * 地址规范化：兼容各种填法。
 * @param raw 用户填的接口地址
 * @example
 * normalizeEndpoint('https://api.deepseek.com')            // → https://api.deepseek.com/chat/completions
 * normalizeEndpoint('https://api.deepseek.com/v1')         // → https://api.deepseek.com/v1/chat/completions
 * normalizeEndpoint('https://x/y/chat/completions')        // → 原样返回
 */
export function normalizeEndpoint(raw: string): string {
  let s = raw.trim().replace(/\/+$/, ''); // 去掉结尾斜杠
  if (s === '') return '';
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  if (s.endsWith('/chat/completions')) return s; // 用户填了完整路径
  return `${s}/chat/completions`; // 其余一律补上
}

/**
 * 从设置里取出 AI 配置（自建转发地址优先，留空则用直连地址）。
 * @param settings 设置
 */
export function aiConfigFromSettings(settings: Settings): AiConfig {
  const proxy = settings.ai.proxyUrl.trim();
  const cloudApiBase = normalizeApiBase(settings.cloud.apiBase);
  return {
    endpoint: proxy !== '' ? proxy : settings.ai.baseUrl,
    model: settings.ai.model,
    key: settings.ai.key,
    useProxy: settings.ai.forceProxy,
    cloudApiBase,
  };
}

/** 这个配置能不能走代理（必须填了自己部署的后端地址） */
function canUseProxy(cfg: AiConfig): boolean {
  return (cfg.cloudApiBase ?? '').trim() !== '';
}

/**
 * 拼接代理地址（自己的后端 + API_ROUTES.aiProxy）。
 * 路径统一从 dao/syncServer.ts 的路由表取，避免两处各写一份、改一处漏一处。
 * @param cfg 接口配置
 */
function proxyUrlOf(cfg: AiConfig): string {
  return `${normalizeApiBase(cfg.cloudApiBase ?? '')}${API_ROUTES.aiProxy}`;
}

/**
 * 判断一个错误是不是「网络 / 跨域这一类」——也就是换代理重试可能有用的情况。
 *
 * 浏览器把 CORS 失败报成 `TypeError: Failed to fetch`，拿不到具体原因，
 * 所以这里只能按「不是 HTTP 状态错误」来归类：
 * 我们自己抛的带状态码错误（密钥无效、限流之类）都带 `httpStatus`，它们换代理也没用。
 * @param err 捕获到的错误
 */
function isNetworkLikeError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === 'AbortError') return false; // 超时不属于跨域，重试没意义
  return !(err instanceof Error && 'httpStatus' in err);
}

/**
 * 带 HTTP 状态码的错误（用来区分「上游明确拒绝」和「网络层失败」）。
 */
class AiHttpError extends Error {
  /** HTTP 状态码 */
  readonly httpStatus: number;

  /**
   * @param status 状态码
   * @param message 给用户看的中文说明
   */
  constructor(status: number, message: string) {
    super(message);
    this.name = 'AiHttpError';
    this.httpStatus = status;
  }
}

/**
 * 把 HTTP 状态码翻译成人类可读的错误。
 * @param status 状态码
 */
function messageForStatus(status: number): string {
  if (status === 401 || status === 403) return '密钥无效或未填写';
  if (status === 404) return '模型名或接口地址不对';
  if (status === 429) return '触发限流，请稍后重试';
  if (status >= 500) return `服务端错误（${status}），请稍后重试`;
  return `请求失败（HTTP ${status}）`;
}

/**
 * 真正发一次请求（不重试、不切路径）。
 *
 * @param cfg 接口配置
 * @param payload 请求体（已序列化）
 * @param route 走直连还是代理
 * @param timeoutMs 超时毫秒
 * @returns 上游响应
 */
async function sendOnce(
  cfg: AiConfig,
  payload: string,
  route: AiRoute,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    if (route === 'proxy') {
      // 代理路径：目标地址放 X-Target-Url，密钥照旧放 Authorization（服务器只用一次就丢）
      const url = proxyUrlOf(cfg);
      console.info('[ai] 经代理请求：', normalizeEndpoint(cfg.endpoint));
      return await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Target-Url': normalizeEndpoint(cfg.endpoint),
          Authorization: `Bearer ${cfg.key}`,
        },
        body: payload,
        signal: controller.signal,
      });
    }
    console.info('[ai] 直连请求：', normalizeEndpoint(cfg.endpoint));
    return await fetch(normalizeEndpoint(cfg.endpoint), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.key}`,
      },
      body: payload,
      signal: controller.signal,
    });
  } finally {
    window.clearTimeout(timer);
  }
}

/**
 * 按配置决定「先用哪条路」「失败后要不要换另一条」。
 * @param cfg 接口配置
 * @param payload 请求体
 * @param timeoutMs 超时
 * @returns 上游响应 + 实际走的路径
 */
async function sendWithRoute(
  cfg: AiConfig,
  payload: string,
  timeoutMs: number,
): Promise<{ res: Response; route: AiRoute }> {
  const proxyAvailable = canUseProxy(cfg);
  const preferProxy = cfg.useProxy === true;

  // 情况一：用户手动指定走代理（没填后端地址时只能直连）
  if (preferProxy && proxyAvailable) {
    const res = await sendOnce(cfg, payload, 'proxy', timeoutMs);
    lastRoute = 'proxy';
    return { res, route: 'proxy' };
  }

  // 情况二：先直连；网络层失败（典型是 CORS）且配了后端 → 自动切代理
  try {
    const res = await sendOnce(cfg, payload, 'direct', timeoutMs);
    lastRoute = 'direct';
    return { res, route: 'direct' };
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error('请求超时，请检查网络或换一个接口地址');
    }
    if (!proxyAvailable || !isNetworkLikeError(err)) {
      console.warn('[ai] 直连失败', err);
      throw new Error('连不上，请检查接口地址和网络。浏览器直连很多服务会被跨域拦截，这种情况请到设置页开启「走无状态代理」');
    }
    console.warn('[ai] 直连被拦（多为跨域），自动切换到代理转发', err);
    const res = await sendOnce(cfg, payload, 'proxy', timeoutMs);
    lastRoute = 'proxy';
    return { res, route: 'proxy' };
  }
}

/**
 * 调一次 chat/completions。
 * @param cfg 接口配置
 * @param messages 消息列表
 * @param opts.jsonMode 是否要求返回 JSON 对象；opts.timeoutMs 超时毫秒数
 * @returns 模型返回的文本内容
 */
export async function chatComplete(
  cfg: AiConfig,
  messages: ChatMessage[],
  opts: { jsonMode?: boolean; timeoutMs?: number } = {},
): Promise<string> {
  const url = normalizeEndpoint(cfg.endpoint);
  if (url === '') throw new Error('请先在设置页填写接口地址');
  if (cfg.key.trim() === '') throw new Error('密钥无效或未填写');

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const run = async (withJsonMode: boolean): Promise<Response> => {
    const payload: Record<string, unknown> = { model: cfg.model, messages, stream: false };
    if (withJsonMode) payload.response_format = { type: 'json_object' };
    const sent = await sendWithRoute(cfg, JSON.stringify(payload), timeoutMs);
    return sent.res;
  };

  let res = await run(Boolean(opts.jsonMode));
  // JSON 模式降级：部分中转/代理不支持 response_format，去掉该字段再试一次
  if (!res.ok && opts.jsonMode && (res.status === 400 || res.status === 422 || res.status === 500)) {
    console.warn('[ai] JSON 模式被拒绝，降级为普通模式重试一次');
    res = await run(false);
  }

  if (!res.ok) throw new AiHttpError(res.status, messageForStatus(res.status));

  let data: unknown;
  try {
    data = await res.json();
  } catch {
    throw new Error('返回内容为空，可能该服务不兼容 OpenAI 格式');
  }

  const content = readContent(data);
  if (content === null) throw new Error('返回内容为空，可能该服务不兼容 OpenAI 格式');
  return content;
}

/**
 * 从返回体里取 choices[0].message.content。
 * @param data 返回体
 */
function readContent(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) return null;
  const choices = (data as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0] as { message?: { content?: unknown } } | undefined;
  const content = first?.message?.content;
  return typeof content === 'string' && content.trim() !== '' ? content : null;
}

/**
 * 测试连接：发一条极短 prompt。**不抛异常**，结果直接给设置页展示。
 * @param cfg 接口配置
 */
export async function testConnection(cfg: AiConfig): Promise<{ ok: boolean; message: string }> {
  if (cfg.key.trim() === '') return { ok: false, message: '密钥无效或未填写' };
  if (normalizeEndpoint(cfg.endpoint) === '') return { ok: false, message: '请先填写接口地址' };
  try {
    const reply = await chatComplete(cfg, [{ role: 'user', content: '回复 ok 两个字符即可' }], {
      timeoutMs: TEST_TIMEOUT_MS,
    });
    return { ok: true, message: `连接成功，模型回复：${reply.slice(0, 30)}` };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * AI 解析用的 system prompt（中文，严格要求只输出 JSON）。
 *
 * ★★★ 义项怎么整理，规则全文在 `core/senseRules.ts` 的 `SENSE_RULES_FOR_AI`。
 *     这里只写「输出格式 + 不许做什么」，语义规则一律引用那份，不在这里重写一遍：
 *     规则抄两份的话，改了这份忘了那份，AI 的行为就会和代码兜底、和文档互相矛盾。
 */
export const PARSE_SYSTEM_PROMPT = `你是一个英语词库结构化助手。把用户给的生词文本解析成严格 JSON。

输出 schema：
{"words":[{"en":"abandon","phonetic":"/əˈbændən/","example":"He abandoned his car.","senses":[{"text":"v. 放弃","aliases":["抛弃","遗弃"]}]}]}

规则：
1. 只输出 JSON，不要 markdown 代码块、不要任何解释文字。
2. 义项怎么拆分、怎么挑代表、近义词怎么分隔、多词性怎么判断——**严格按下面这份规范执行**：

${SENSE_RULES_FOR_AI}

3. 义项保留词性前缀（n. v. adj. adv. prep. 等；原文写「adj./adv.」这种多词性就原样保留）。
   ★ 但第 4 步判定为「同源」而合并起来的义项，代表词**不加词性前缀**，
     因为它是跨词性的（例如 run 的义项①写 "跑"，不要写 "v. 跑"）。
4. 音标用国际音标并带斜杠；例句要简短、能体现该词主要用法；如果原文没有音标/例句就自己补一个合适的。
5. 英文单词原样保留大小写，不要翻译，不要造词。
6. 原文一行一个词，输出顺序与输入一致，不要漏词、不要增加原文没有的词。
7. 主动为每个义项补 1~3 个常见近义词写进 aliases（没有就留空数组），
   但**必须逐个分隔**，且每个都是「一个纯中文说法」。`;

/**
 * 把文本按行切成若干批。
 * @param lines 文本行
 * @param size 每批行数（20~100）
 */
export function splitIntoChunks(lines: string[], size: number): string[][] {
  const step = Math.max(1, Math.floor(size));
  const out: string[][] = [];
  for (let i = 0; i < lines.length; i += step) out.push(lines.slice(i, i + step));
  return out;
}

/**
 * 去掉模型可能加的 markdown 代码块围栏。
 * @param text 模型返回的文本
 */
function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return fence && fence[1] ? fence[1].trim() : trimmed;
}

/**
 * 校验并归一化模型返回的一个词。
 *
 * ★ 导出是为了能被自检直接调用（`npm run test:sense-rules`）。
 *   这是**不可信输入**（模型输出）的边界，也是「约束 1」的执行点：
 *   模型经常把多个近义词打包成一项，这里必须拆开。
 *   不导出的话只能靠起假上游 + 打网络请求来测这一段，太重，实际没人会去测。
 *
 * @param raw 原始对象（模型返回的一条）
 */
export function coerceParsedWord(raw: unknown): ParsedWord | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  const en = typeof obj.en === 'string' ? obj.en.trim() : '';
  if (en === '') return null;
  const sensesRaw = Array.isArray(obj.senses) ? obj.senses : [];
  const senses = sensesRaw
    .flatMap((s) => {
      if (typeof s !== 'object' || s === null) return [];
      const so = s as Record<string, unknown>;
      const text = typeof so.text === 'string' ? so.text.trim() : '';
      if (text === '') return [];
      // ★ 约束 1 的执行点：模型经常把多个近义词打包成一项
      //   （aliases:["跑步，奔跑"]）。不拆开的话判分时整串比对，
      //   用户答「跑步」或「奔跑」**都会判错**，而界面上完全看不出来。
      const aliases = normalizeAliases(
        Array.isArray(so.aliases)
          ? so.aliases.filter((a): a is string => typeof a === 'string')
          : [],
      );
      // 兜底：模型偶尔会把「量纲、维度」塞进一个义项，这里强制拆成多个（词性前缀复制到每一段）
      const pieces = splitPackedSenses(text);
      return pieces.map((piece, i) => ({
        text: piece,
        aliases: i === 0 ? aliases : [],
      }));
    })
    .filter((s): s is { text: string; aliases: string[] } => s !== null);
  return {
    en,
    phonetic: typeof obj.phonetic === 'string' ? obj.phonetic.trim() : '',
    example: typeof obj.example === 'string' ? obj.example.trim() : '',
    senses,
  };
}

/**
 * 解析一批原文（失败不抛异常，交给调用方决定是否降级到规则解析）。
 * @param cfg 接口配置
 * @param rawChunk 这一批的原文
 * @param signal 可选的中断信号
 */
export async function parseWordBatch(
  cfg: AiConfig,
  rawChunk: string,
  signal?: AbortSignal,
): Promise<ParseBatchResult> {
  if (signal?.aborted) return { entries: [], failed: true, error: '已取消' };
  try {
    const content = await chatComplete(
      cfg,
      [
        { role: 'system', content: PARSE_SYSTEM_PROMPT },
        { role: 'user', content: rawChunk },
      ],
      { jsonMode: true },
    );
    const jsonText = stripCodeFence(content);
    let data: unknown;
    try {
      data = JSON.parse(jsonText) as unknown;
    } catch {
      return { entries: [], failed: true, error: 'AI 返回的不是合法 JSON，可重试该批或改用规则解析' };
    }
    const wordsRaw = (data as { words?: unknown }).words;
    if (!Array.isArray(wordsRaw)) {
      return { entries: [], failed: true, error: 'AI 返回缺少 words 字段，可重试该批或改用规则解析' };
    }
    const entries = wordsRaw.map(coerceParsedWord).filter((w): w is ParsedWord => w !== null);
    if (entries.length === 0) {
      return { entries: [], failed: true, error: '这一批没有解析出任何单词' };
    }
    return { entries, failed: false };
  } catch (err) {
    return { entries: [], failed: true, error: err instanceof Error ? err.message : String(err) };
  }
}

/** 一条「建议合并」 */
export interface MergeSuggestion {
  en: string;
  /** 保留哪个义项（按义项原文精确匹配） */
  keep: string;
  /** 哪些义项的含义与 keep 相近，可以并进去（会成为近义词） */
  absorb: string[];
}

/** 建议合并的 system prompt */
const MERGE_SYSTEM_PROMPT = `你是一个英语词库义项合并助手。用户会给你若干单词和它们的义项列表。
请找出同一个单词下「含义相近、可以合并」的义项，只输出严格 JSON：
{"merges":[{"en":"abandon","keep":"v. 放弃","absorb":["v. 抛弃","v. 遗弃"]}]}

规则：
1. 只输出 JSON，不要 markdown 代码块、不要解释。
2. keep 和 absorb 里的文字必须与用户给的义项**原文完全一致**，不要改写、不要增删字符。
3. 只提出真正含义相近的建议；没有可合并的单词就不要出现在结果里。
4. 不要给出任何数据修改建议以外的东西。`;

/** 建议合并的结果 */
export interface MergeSuggestionResult {
  suggestions: MergeSuggestion[];
  failed: boolean;
  error?: string;
}

/**
 * 让 AI 对一批词的义项做一次近义合并建议（**只给建议，不自动改数据**）。
 * @param cfg 接口配置
 * @param items 一批词及其义项文本
 * @param signal 可选的中断信号
 */
export async function suggestMerges(
  cfg: AiConfig,
  items: { en: string; senses: string[] }[],
  signal?: AbortSignal,
): Promise<MergeSuggestionResult> {
  if (signal?.aborted) return { suggestions: [], failed: true, error: '已取消' };
  try {
    const content = await chatComplete(
      cfg,
      [
        { role: 'system', content: MERGE_SYSTEM_PROMPT },
        { role: 'user', content: JSON.stringify({ words: items }) },
      ],
      { jsonMode: true },
    );
    let data: unknown;
    try {
      data = JSON.parse(stripCodeFence(content)) as unknown;
    } catch {
      return { suggestions: [], failed: true, error: 'AI 返回的不是合法 JSON' };
    }
    const raw = (data as { merges?: unknown }).merges;
    if (!Array.isArray(raw)) return { suggestions: [], failed: true, error: 'AI 返回缺少 merges 字段' };
    const suggestions: MergeSuggestion[] = [];
    for (const item of raw) {
      if (typeof item !== 'object' || item === null) continue;
      const obj = item as Record<string, unknown>;
      const en = typeof obj.en === 'string' ? obj.en.trim() : '';
      const keep = typeof obj.keep === 'string' ? obj.keep.trim() : '';
      const absorb = Array.isArray(obj.absorb)
        ? obj.absorb.filter((a): a is string => typeof a === 'string').map((a) => a.trim()).filter(Boolean)
        : [];
      if (en && keep && absorb.length > 0) suggestions.push({ en, keep, absorb });
    }
    return { suggestions, failed: false };
  } catch (err) {
    return { suggestions: [], failed: true, error: err instanceof Error ? err.message : String(err) };
  }
}
