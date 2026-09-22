/**
 * 云同步的 HTTP 客户端：只负责「发请求 + 超时 + 一次重试 + 错误归类」。
 *
 * 安全纪律（改这个文件前必读）：
 * - 请求头 `X-Space-Key` 里带的是 **SHA-256 哈希**，不是明文同步码；
 *   明文只在设置里存着，`getSpaceKey()` 之后就没用了。
 * - 这个文件里**不许出现 AI 密钥**：同步请求与 AI 密钥毫无关系。
 *
 * 可靠性纪律：**任何失败都不抛异常到 UI**，统一返回带 `error` 的结果对象，
 * 由调用方决定怎么提示——同步失败绝不能阻断背单词。
 */
import { SYNC } from '../core/config';
import { apiUrl, getSpaceKey } from '../core/syncHelper';
import type { ServerSource, ServerWord } from './syncMap';

/** 统一结果：ok 为 false 时 error 一定有值 */
export interface ApiResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
  /** HTTP 状态码（网络错误 / 超时为 undefined） */
  status?: number;
}

/** 拉取结果 */
export interface PullData {
  words: ServerWord[];
  sources: ServerSource[];
  serverTime: number;
  hasMore: boolean;
}

/** 推送结果 */
export interface PushData {
  applied: number;
  conflicts: number;
  skipped: number;
  serverTime: number;
}

/** 同步接口需要的配置（从设置里取，避免这个文件去读全局状态） */
export interface SyncEndpoint {
  apiBase: string;
  syncCode: string;
}

/** 可重试的 HTTP 状态码（服务器临时问题） */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * 发一个 JSON 请求（带超时），失败返回结果对象而不是抛异常。
 * @param url 完整地址
 * @param init fetch 参数
 * @param timeoutMs 超时毫秒
 * @param spaceKey 同步码的哈希
 */
async function requestJson<T>(
  url: string,
  init: { method: 'GET' | 'POST'; body?: string },
  timeoutMs: number,
  spaceKey: string,
): Promise<ApiResult<T>> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: init.method,
      headers: {
        'Content-Type': 'application/json',
        // 只发哈希！服务器不知道明文同步码（见文件头说明）
        'X-Space-Key': spaceKey,
      },
      body: init.body,
      signal: controller.signal,
    });
    if (!res.ok) {
      const detail = await readErrorDetail(res);
      return { ok: false, status: res.status, error: detail ?? `服务器返回 ${res.status}` };
    }
    const data = (await res.json()) as T;
    return { ok: true, data, status: res.status };
  } catch (err) {
    const aborted = err instanceof DOMException && err.name === 'AbortError';
    if (aborted) return { ok: false, error: '请求超时（网络慢或后端没起来）' };
    console.warn('[syncServer] 请求失败', err);
    return { ok: false, error: '连不上后端（检查后端地址和网络）' };
  } finally {
    window.clearTimeout(timer);
  }
}

/**
 * 读服务器返回的错误说明（读不到就给 null）。
 * @param res 响应
 */
async function readErrorDetail(res: Response): Promise<string | null> {
  try {
    const text = await res.text();
    if (text.trim() === '') return null;
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === 'object' && parsed !== null) {
      const err = (parsed as { error?: unknown }).error;
      if (typeof err === 'string' && err.trim() !== '') return err;
    }
    return text.slice(0, 200);
  } catch {
    return null;
  }
}

/**
 * 带一次重试的请求（只对「可能只是临时抽风」的失败重试）。
 * @param url 地址
 * @param init fetch 参数
 * @param spaceKey 同步码哈希
 * @param timeoutMs 超时
 */
async function requestWithRetry<T>(
  url: string,
  init: { method: 'GET' | 'POST'; body?: string },
  spaceKey: string,
  timeoutMs: number = SYNC.requestTimeoutMs,
): Promise<ApiResult<T>> {
  const first = await requestJson<T>(url, init, timeoutMs, spaceKey);
  if (first.ok) return first;
  // 401/403/400 这类是我们自己参数不对，重试没意义
  if (first.status !== undefined && !RETRYABLE_STATUS.has(first.status)) return first;
  console.warn('[syncServer] 请求失败，2 秒后重试一次：', first.error);
  await new Promise((resolve) => window.setTimeout(resolve, SYNC.retryDelayMs));
  return requestJson<T>(url, init, timeoutMs, spaceKey);
}

/**
 * 后端路由表（**全部集中在这里，不要在别处硬编码路径**）。
 *
 * ⚠️ 路径规则是踩过坑的：Vercel 把 `api/` 下的文件名直接映射成路由，
 * `api/sync-pull.ts` 对应的是 **`/api/sync-pull`（连字符）**，
 * **不是** `/api/sync/pull`。之前写成带斜杠的路径，线上一直 404，
 * 表现就是「同步不了」——后端其实好好的。
 *
 * 改这里的路径时请连带更新：
 * - `api/_dev/harness.mjs`：本地直调 API 的路由分发表（**必须同步**，否则本地测试调不到）
 * - `api/_dev/test-live.mjs`：线上路由冒烟测试，逐个请求这些路径
 * - `api/_dev/test-build.mjs`：有护栏校验「前端路由表与 api/ 真实文件一一对应」
 */
export const API_ROUTES = {
  health: '/api/health',
  /** 拉取接口，使用时拼查询串：`${API_ROUTES.syncPull}?since=<ts>` */
  syncPull: '/api/sync-pull',
  syncPush: '/api/sync-push',
  syncPurge: '/api/sync-purge',
  aiProxy: '/api/ai-proxy',
  /**
   * ★ T4：无状态 TTS 转发（浏览器直连有道的 ttsapi 会被 CORS 拦）。
   * 同样只做转发：不存密钥、不写库、不缓存（见 api/tts-proxy.ts）。
   */
  ttsProxy: '/api/tts-proxy',
  // ── 二期（知识点精学）：数据完全独立，只是共用同一个库和空间隔离逻辑 ──
  /** 卡片增量拉取，使用时拼查询串：`${API_ROUTES.kcList}?since=<ts>` */
  kcList: '/api/kc-list',
  kcPush: '/api/kc-push',
  /** 每日语境词（阶段 05）：GET ?since=<ts> / POST */
  contextWords: '/api/context-words',
  /** 题目历史（阶段 05）：GET ?since=<ts>&recent=<days> / POST */
  examHistory: '/api/exam-history',
  /** 题库（阶段 05）：GET ?since=<ts>&type=<id> / POST */
  bankQuestions: '/api/bank-questions',
} as const;

/**
 * 健康检查（「测试连接」按钮用；不需要同步码，也不带 spaceKey）。
 * @param apiBase 后端地址
 */
export async function pingHealth(apiBase: string): Promise<{ ok: boolean; message: string; dbOk: boolean }> {
  const url = apiUrl(apiBase, API_ROUTES.health);
  const res = await requestJson<{ ok?: boolean; db?: string }>(url, { method: 'GET' }, SYNC.healthTimeoutMs, '');
  if (!res.ok) return { ok: false, dbOk: false, message: res.error ?? '连不上后端' };
  const dbOk = res.data?.db === 'connected';
  return {
    ok: true,
    dbOk,
    message: dbOk ? '连接成功，数据库正常' : '后端能连上，但数据库连接失败（检查 Vercel 环境变量）',
  };
}

/**
 * 增量拉取。
 * @param ep 后端地址 + 同步码
 * @param since 只取 updated_at 大于它的记录（0 = 全量）
 */
export async function pullRemote(ep: SyncEndpoint, since: number): Promise<ApiResult<PullData>> {
  const spaceKey = await getSpaceKey(ep.syncCode);
  const url = apiUrl(ep.apiBase, `${API_ROUTES.syncPull}?since=${Math.max(0, Math.floor(since))}`);
  return requestWithRetry<PullData>(url, { method: 'GET' }, spaceKey);
}

/**
 * 批量推送（**内部自动分批：每批 ≤ 500 条**，规避 Vercel 4.5MB 请求体限制）。
 * @param ep 后端地址 + 同步码
 * @param words 待推词条
 * @param sources 待推来源
 */
export async function pushRemote(
  ep: SyncEndpoint,
  words: unknown[],
  sources: unknown[],
): Promise<ApiResult<PushData>> {
  const spaceKey = await getSpaceKey(ep.syncCode);
  const url = apiUrl(ep.apiBase, API_ROUTES.syncPush);
  const total: PushData = { applied: 0, conflicts: 0, skipped: 0, serverTime: 0 };

  // 先把两类合并成一批批「每批 ≤ pushBatchSize 条」，再逐批发
  const wordBatches = chunk(words, SYNC.pushBatchSize);
  const sourceBatches = chunk(sources, SYNC.pushBatchSize);

  for (const batch of wordBatches) {
    const res = await requestWithRetry<PushData>(
      url,
      { method: 'POST', body: JSON.stringify({ words: batch }) },
      spaceKey,
    );
    if (!res.ok || !res.data) return { ok: false, error: res.error, status: res.status };
    accumulate(total, res.data);
  }
  for (const batch of sourceBatches) {
    const res = await requestWithRetry<PushData>(
      url,
      { method: 'POST', body: JSON.stringify({ sources: batch }) },
      spaceKey,
    );
    if (!res.ok || !res.data) return { ok: false, error: res.error, status: res.status };
    accumulate(total, res.data);
  }
  return { ok: true, data: total };
}

/**
 * 清空当前数据空间（设置页「清空云端数据」）。
 * @param ep 后端地址 + 同步码
 */
export async function purgeRemote(ep: SyncEndpoint): Promise<ApiResult<{ ok: boolean; removed: number }>> {
  const spaceKey = await getSpaceKey(ep.syncCode);
  const url = apiUrl(ep.apiBase, API_ROUTES.syncPurge);
  return requestWithRetry<{ ok: boolean; removed: number }>(
    url,
    { method: 'POST', body: JSON.stringify({ confirm: 'DELETE' }) },
    spaceKey,
  );
}

/**
 * 把一批数据切成若干批。
 * @param list 原始数组
 * @param size 每批上限
 */
function chunk<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/**
 * 累加每批的结果。
 * @param total 汇总对象
 * @param part 单批结果
 */
function accumulate(total: PushData, part: PushData): void {
  total.applied += part.applied ?? 0;
  total.conflicts += part.conflicts ?? 0;
  total.skipped += part.skipped ?? 0;
  total.serverTime = Math.max(total.serverTime, part.serverTime ?? 0);
}
