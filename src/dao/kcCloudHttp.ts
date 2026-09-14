/**
 * 二期云同步的**传输层**：请求、超时、重试、字段映射。
 *
 * 为什么要与 `kcCloud.ts` 分开：那边是「同步编排」（先拉后推、游标、冲突），
 * 这边是「怎么发一个请求、怎么把一行转成卡片」，两件事的变更原因完全不同；
 * 而且项目硬约束是单文件 ≤ 300 行。
 * 一期的对应文件是 `dao/syncServer.ts` + `dao/syncMap.ts`（这里合并成一个，
 * 因为二期的映射比一期简单：JSON 字段直接存取，没有义项拆包那些事）。
 *
 * ⚠️ 安全纪律（与一期完全相同）：请求头 `X-Space-Key` 里带的是**同步码的 SHA-256**，
 * 明文只存在用户浏览器里；这个文件里**不许出现任何 AI 密钥**。
 */
import { SYNC } from '../core/config';
import { apiUrl, getSpaceKey, normalizeApiBase } from '../core/syncHelper';
import { coerceCard } from '../core/kcModel';
import type { KnowledgeCard } from '../core/kcTypes';
import type { Settings } from '../core/types';
import { API_ROUTES, type ApiResult } from './syncServer';

/** 云端卡片行（**线上/IndexedDB 的 JSON 字段在传输时就是字符串**） */
export interface ServerKcCard {
  id: string;
  title: string;
  summary: string | null;
  blocks: string;
  exam_tags: string;
  exam_load: string | null;
  source: string | null;
  attrs: string;
  status: string;
  created_at: number;
  updated_at: number;
  deleted: number;
}

/** 拉取响应 */
export interface KcPullData {
  cards: ServerKcCard[];
  serverTime: number;
  hasMore: boolean;
}

/** 推送响应 */
export interface KcPushData {
  applied: number;
  conflicts: number;
  skipped: number;
  serverTime: number;
}

/** 同步接口需要的配置（从设置里取，避免这一层去读全局状态） */
export interface KcEndpoint {
  apiBase: string;
  syncCode: string;
}

/**
 * 取同步端点（**复用一期的后端地址与同步码**：二期不另设一套凭据）。
 * @param settings 设置
 */
export function endpointOf(settings: Settings): KcEndpoint {
  return {
    apiBase: normalizeApiBase(settings.cloud.apiBase),
    syncCode: settings.cloud.syncCode.trim(),
  };
}

/**
 * 配置是否齐全（地址与同步码都填了）。
 * @param settings 设置
 */
export function kcCloudReady(settings: Settings): boolean {
  return normalizeApiBase(settings.cloud.apiBase) !== '' && settings.cloud.syncCode.trim() !== '';
}

/**
 * 发一个 JSON 请求（带超时；失败返回结果对象而不是抛异常）。
 * @param url 完整地址
 * @param method 方法
 * @param body 请求体（JSON 字符串）
 * @param spaceKey 同步码的 SHA-256
 */
async function requestJson<T>(
  url: string,
  method: 'GET' | 'POST',
  body: string | undefined,
  spaceKey: string,
): Promise<ApiResult<T>> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), SYNC.requestTimeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        // 只发哈希！服务器不知道明文同步码
        'X-Space-Key': spaceKey,
      },
      body,
      signal: controller.signal,
    });
    if (!res.ok) {
      return { ok: false, status: res.status, error: (await readErrorDetail(res)) ?? `服务器返回 ${res.status}` };
    }
    return { ok: true, data: (await res.json()) as T, status: res.status };
  } catch (err) {
    const aborted = err instanceof DOMException && err.name === 'AbortError';
    if (aborted) return { ok: false, error: '请求超时（网络慢或后端没起来）' };
    console.warn('[kcCloudHttp] 请求失败', err);
    return { ok: false, error: '连不上后端（检查后端地址和网络）' };
  } finally {
    window.clearTimeout(timer);
  }
}

/**
 * 读服务器返回的错误说明（读不到给 null）。
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

/** 可重试的 HTTP 状态码（服务器临时问题） */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * 带一次重试的请求（只对「可能只是临时抽风」的失败重试）。
 * @param url 地址
 * @param method 方法
 * @param body 请求体
 * @param spaceKey 同步码哈希
 */
export async function requestWithRetry<T>(
  url: string,
  method: 'GET' | 'POST',
  body: string | undefined,
  spaceKey: string,
): Promise<ApiResult<T>> {
  const first = await requestJson<T>(url, method, body, spaceKey);
  if (first.ok) return first;
  if (first.status !== undefined && !RETRYABLE_STATUS.has(first.status)) return first;
  console.warn('[kcCloudHttp] 请求失败，稍后重试一次：', first.error);
  // RULES-R1: 失败后的重试间隔（网络超时/重试保护），不是答题计时
  await new Promise((resolve) => window.setTimeout(resolve, SYNC.retryDelayMs));
  return requestJson<T>(url, method, body, spaceKey);
}

/** 拼二期接口地址（**路径唯一权威定义在 syncServer 的 API_ROUTES**） */
export function kcListUrl(apiBase: string, since: number): string {
  return apiUrl(apiBase, `${API_ROUTES.kcList}?since=${Math.max(0, Math.floor(since))}`);
}

/** 拼二期推送地址 */
export function kcPushUrl(apiBase: string): string {
  return apiUrl(apiBase, API_ROUTES.kcPush);
}

/** 同步码 → spaceKey（哈希，服务器只看到这个） */
export function spaceKeyOf(syncCode: string): Promise<string> {
  return getSpaceKey(syncCode);
}

/** 把 JSON 字符串安全解析成 unknown（坏了给兜底值） */
function parseJson(raw: string | null, fallback: unknown): unknown {
  if (raw === null || raw === '') return fallback;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return fallback;
  }
}

/**
 * 服务端行 → 本地卡片。
 *
 * 关键：**`updatedAt` 原样保留云端的值**（不能刷成本地时间，
 * 否则「云端更新了但本地时间更晚」会让本地永远赢，同步就停止传播了）。
 * @param row 服务端行
 * @param estMinutes 兜底耗时
 */
export function toLocalCard(row: ServerKcCard, estMinutes: number): KnowledgeCard | null {
  return coerceCard(
    {
      id: row.id,
      title: row.title,
      summary: row.summary ?? '',
      blocks: parseJson(row.blocks, []),
      examTags: parseJson(row.exam_tags, []),
      examLoad: parseJson(row.exam_load, { types: [], estMinutes }),
      source: parseJson(row.source, {}),
      attrs: parseJson(row.attrs, {}),
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      deleted: row.deleted,
    },
    estMinutes,
  );
}

/**
 * 本地卡片 → 服务端行（JSON 字段序列化成字符串，与库表列名一一对应）。
 * @param card 本地卡片
 */
export function toServerCard(card: KnowledgeCard): ServerKcCard {
  return {
    id: card.id,
    title: card.title,
    summary: card.summary,
    blocks: JSON.stringify(card.blocks),
    exam_tags: JSON.stringify(card.examTags),
    exam_load: JSON.stringify(card.examLoad),
    source: JSON.stringify(card.source),
    attrs: JSON.stringify(card.attrs),
    status: card.status,
    created_at: card.createdAt,
    updated_at: card.updatedAt,
    deleted: card.deleted === 1 ? 1 : 0,
  };
}
