/**
 * 二期三张小表的云同步（阶段 05）：语境词 / 题目历史 / 题库。
 *
 * 与卡片同步（`kcCloud.ts`）的分工：
 * - 卡片是「**频繁编辑**」的数据，需要一套完整的「先拉后推 + 游标 + 冲突」编排；
 * - 这三张是「**只增不改的记录**」，而且量会一直长（题目历史尤其），
 *   所以做成**轻量的按需同步**：写完就把它推上去（防抖合并），拉取只在启动/手动同步时做。
 *
 * 共用一期的同步通道与 spaceKey 隔离；失败**只 console.warn**，绝不阻断本地功能。
 */
import { SYNC } from '../core/config';
import { apiUrl, getSpaceKey, normalizeApiBase } from '../core/syncHelper';
import { STORE, tx, txRun } from '../core/db';
import * as settingsDao from './settings';
import { API_ROUTES } from './syncServer';
import { emitDataChanged } from '../state/store';

/** 三张小表的键名（与后端 `KC_SMALL_TABLES` 对齐） */
export type SmallTableKey = 'contextWords' | 'examRecords' | 'bankQuestions';

/** 表名 → IndexedDB store */
const STORE_OF: Record<SmallTableKey, string> = {
  contextWords: STORE.dailyContextWords,
  examRecords: STORE.examRecords,
  bankQuestions: STORE.bankQuestions,
};

/** 表名 → 接口路径 */
const ROUTE_OF: Record<SmallTableKey, string> = {
  contextWords: API_ROUTES.contextWords,
  examRecords: API_ROUTES.examHistory,
  bankQuestions: API_ROUTES.bankQuestions,
};

/** 推上去的行里要带的字段（**服务端只认这些**；本地多出来的字段不带） */
const SYNC_FIELDS: Record<SmallTableKey, { local: string; remote: string }[]> = {
  contextWords: [
    { local: 'date', remote: 'date' },
    { local: 'words', remote: 'words' },
    { local: 'source', remote: 'source' },
    { local: 'confirmed', remote: 'confirmed' },
    { local: 'createdAt', remote: 'created_at' },
    { local: 'updatedAt', remote: 'updated_at' },
    { local: 'deleted', remote: 'deleted' },
  ],
  examRecords: [
    { local: 'cardId', remote: 'card_id' },
    { local: 'date', remote: 'date' },
    { local: 'type', remote: 'type' },
    { local: 'question', remote: 'question' },
    { local: 'userAnswer', remote: 'user_answer' },
    { local: 'aiScore', remote: 'ai_score' },
    { local: 'aiReason', remote: 'ai_reason' },
    { local: 'contextWord', remote: 'context_word' },
    { local: 'createdAt', remote: 'created_at' },
    { local: 'updatedAt', remote: 'updated_at' },
    { local: 'deleted', remote: 'deleted' },
  ],
  bankQuestions: [
    { local: 'type', remote: 'type' },
    { local: 'content', remote: 'content' },
    { local: 'source', remote: 'source' },
    { local: 'createdAt', remote: 'created_at' },
    { local: 'updatedAt', remote: 'updated_at' },
    { local: 'deleted', remote: 'deleted' },
  ],
};

/**
 * 本地行 → 推给服务端的行。
 * @param key 表
 * @param local 本地记录
 */
function toRemoteRow(key: SmallTableKey, local: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { id: local['id'] };
  for (const { local: from, remote: to } of SYNC_FIELDS[key]) {
    const v = local[from];
    if (v === undefined) continue;
    // words 本地是数组，服务端存 JSON 字符串
    out[to] = Array.isArray(v) ? JSON.stringify(v) : v;
  }
  // 老记录没有 updatedAt：用 createdAt 兜底（否则服务端会当成 0，永远被覆盖）
  if (out['updated_at'] === undefined) out['updated_at'] = local['createdAt'] ?? 0;
  out['deleted'] = local['deleted'] === 1 ? 1 : 0;
  return out;
}

/**
 * 服务端行 → 本地记录。
 * @param key 表
 * @param row 服务端行
 */
function toLocalRow(key: SmallTableKey, row: Record<string, unknown>): Record<string, unknown> | null {
  const id = row['id'];
  if (typeof id !== 'string' || id === '') return null;
  const out: Record<string, unknown> = { id };
  for (const { local: to, remote: from } of SYNC_FIELDS[key]) {
    const v = row[from];
    if (v === undefined || v === null) continue;
    out[to] = v;
  }
  // words 服务端给的是 JSON 字符串，本地要数组
  if (key === 'contextWords') {
    const raw = out['words'];
    if (typeof raw === 'string') {
      try {
        const parsed: unknown = JSON.parse(raw);
        out['words'] = Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
      } catch {
        out['words'] = [];
      }
    } else if (!Array.isArray(raw)) {
      out['words'] = [];
    }
  }
  out['deleted'] = row['deleted'] === 1 ? 1 : 0;
  if (typeof out['updatedAt'] !== 'number') out['updatedAt'] = Number(row['updated_at'] ?? 0);
  if (typeof out['createdAt'] !== 'number') out['createdAt'] = Number(row['created_at'] ?? out['updatedAt']);
  return out;
}

/** 同步端点（从设置取，避免这一层读全局状态） */
async function endpoint(): Promise<{ apiBase: string; syncCode: string } | null> {
  const settings = await settingsDao.get();
  if (!settings.cloud.enabled) return null;
  const apiBase = normalizeApiBase(settings.cloud.apiBase);
  const syncCode = settings.cloud.syncCode.trim();
  if (apiBase === '' || syncCode === '') return null;
  return { apiBase, syncCode };
}

/**
 * 发一个 JSON 请求（带超时；失败返回 null，不抛异常）。
 * @param url 地址
 * @param method 方法
 * @param body 请求体
 * @param spaceKey 同步码哈希
 */
async function request<T>(
  url: string,
  method: 'GET' | 'POST',
  body: string | undefined,
  spaceKey: string,
): Promise<T | null> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), SYNC.requestTimeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Space-Key': spaceKey },
      body,
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn(`[kcSmallCloud] ${method} ${url} 失败：HTTP ${res.status}`);
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    console.warn('[kcSmallCloud] 请求失败', err);
    return null;
  } finally {
    window.clearTimeout(timer);
  }
}

/**
 * 推一张表里「本地有、且比云端新」的行。
 *
 * 说明：这三张表的量不大（语境词每天 1 条、题目历史每次做题几条），
 * 所以不做「按 updatedAt 游标增量」，直接全量推 —— 简单且不会漏。
 * 分批仍按 500 条切（Vercel 请求体上限）。
 *
 * @param key 表
 * @returns 推成功的条数（失败返回 0）
 */
export async function pushSmallTable(key: SmallTableKey): Promise<number> {
  const ep = await endpoint();
  if (ep === null) return 0;
  const all = await tx<Record<string, unknown>[]>(STORE_OF[key], 'readonly', (s) => s.getAll() as IDBRequest<Record<string, unknown>[]>);
  if (all.length === 0) return 0;
  const spaceKey = await getSpaceKey(ep.syncCode);
  const url = apiUrl(ep.apiBase, ROUTE_OF[key]);
  let applied = 0;
  for (let i = 0; i < all.length; i += SYNC.pushBatchSize) {
    const batch = all.slice(i, i + SYNC.pushBatchSize).map((row) => toRemoteRow(key, row));
    const res = await request<{ applied: number }>(url, 'POST', JSON.stringify({ rows: batch }), spaceKey);
    if (res === null) return applied;
    applied += res.applied ?? 0;
  }
  return applied;
}

/**
 * 拉一张表并合到本地（后写覆盖）。
 * @param key 表
 * @param since 只取比它新的（0 = 全量）
 * @returns 应用的条数
 */
export async function pullSmallTable(key: SmallTableKey, since = 0): Promise<number> {
  const ep = await endpoint();
  if (ep === null) return 0;
  const spaceKey = await getSpaceKey(ep.syncCode);
  // 题目历史顺便多要一份「近 3 天题干」（阶段 05 的出题防重复要用）
  const extra = key === 'examRecords' ? '&recent=3' : '';
  const url = apiUrl(ep.apiBase, `${ROUTE_OF[key]}?since=${Math.max(0, Math.floor(since))}${extra}`);
  const res = await request<{ rows: Record<string, unknown>[] }>(url, 'GET', undefined, spaceKey);
  if (res === null || !Array.isArray(res.rows)) return 0;

  const local = await tx<Record<string, unknown>[]>(STORE_OF[key], 'readonly', (s) => s.getAll() as IDBRequest<Record<string, unknown>[]>);
  const byId = new Map(local.map((r) => [String(r['id']), r]));
  const toWrite: Record<string, unknown>[] = [];
  for (const row of res.rows) {
    const incoming = toLocalRow(key, row);
    if (incoming === null) continue;
    const existing = byId.get(String(incoming['id']));
    const mine = Number(existing?.['updatedAt'] ?? -1);
    const theirs = Number(incoming['updatedAt'] ?? 0);
    if (existing !== undefined && mine >= theirs) continue; // 本地不旧，等推
    toWrite.push(incoming);
  }
  if (toWrite.length === 0) return 0;
  await txRun(STORE_OF[key], 'readwrite', (s) => {
    for (const row of toWrite) s.put(row);
  });
  emitDataChanged();
  return toWrite.length;
}

/**
 * 推所有三张小表（写操作后的防抖调用）。
 * @returns 各表推成功条数
 */
export async function pushAllSmall(): Promise<Record<SmallTableKey, number>> {
  const out: Record<SmallTableKey, number> = { contextWords: 0, examRecords: 0, bankQuestions: 0 };
  for (const key of Object.keys(out) as SmallTableKey[]) {
    try {
      out[key] = await pushSmallTable(key);
    } catch (err) {
      console.warn(`[kcSmallCloud] 推 ${key} 出错（不影响本地）`, err);
    }
  }
  return out;
}

/**
 * 拉所有三张小表（启动/手动同步时调用）。
 * @param since 增量起点
 */
export async function pullAllSmall(since = 0): Promise<Record<SmallTableKey, number>> {
  const out: Record<SmallTableKey, number> = { contextWords: 0, examRecords: 0, bankQuestions: 0 };
  for (const key of Object.keys(out) as SmallTableKey[]) {
    try {
      out[key] = await pullSmallTable(key, since);
    } catch (err) {
      console.warn(`[kcSmallCloud] 拉 ${key} 出错（不影响本地）`, err);
    }
  }
  return out;
}
