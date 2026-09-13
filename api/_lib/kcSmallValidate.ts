/**
 * 二期三张小表的请求体归一化（服务端也要自己校验一遍客户端数据）。
 *
 * 与 `kcValidate.ts` 同样的理由：客户端数据不可信，进库的一定要是合法 JSON 字符串。
 * 这里的长度上限与前端 `core/config.ts` 的 `KC` 是同一套口径。
 */
import type { KcSmallTableKey, SyncRow } from './kcSmallTables.js';

/** 单条长文本的上限（题干/题目原文可能较长，但也不能无限） */
const MAX_LONG_TEXT = 20_000;
/** 短文本上限（来源标注之类） */
const MAX_SHORT_TEXT = 200;

/** 取字符串 */
function str(v: unknown, max = MAX_SHORT_TEXT): string {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

/** 取数字（有限数才算） */
function num(v: unknown, fallback = 0): number {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string') {
    const n = Number(v);
    if (Number.isFinite(n)) return Math.trunc(n);
  }
  return fallback;
}

/** 取 0/1 */
function bool01(v: unknown): number {
  return v === 1 || v === true || v === '1' ? 1 : 0;
}

/** 时间戳钳制（负数当 0；未来 1 天以上按现在算，防手滑写坏游标） */
function ts(v: unknown): number {
  const n = num(v, 0);
  return Math.max(0, Math.min(n, Date.now() + 86_400_000));
}

/**
 * 归一化一行。
 * @param tableKey 表
 * @param raw 请求体里的一项
 * @returns 非法（没有 id）返回 null
 */
function normalizeRow(tableKey: KcSmallTableKey, raw: unknown): SyncRow | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const id = str(r['id'], 128).trim();
  if (id === '') return null;
  const updatedAt = ts(r['updated_at'] ?? r['updatedAt']);
  const createdAt = ts(r['created_at'] ?? r['createdAt']) || updatedAt;
  const deleted = bool01(r['deleted']);

  if (tableKey === 'contextWords') {
    return {
      id,
      values: {
        date: str(r['date'], 10),
        // words 是 JSON 数组的字符串形式；坏 JSON 一律换成空数组，别让前端 parse 抛异常
        words: jsonArray(r['words']),
        source: str(r['source'], 20) === 'manual' ? 'manual' : 'ai',
        confirmed: bool01(r['confirmed']),
        created_at: createdAt,
        updated_at: updatedAt,
        deleted,
      },
    };
  }
  if (tableKey === 'examRecords') {
    return {
      id,
      values: {
        card_id: str(r['card_id'] ?? r['cardId'], 128),
        date: str(r['date'], 10),
        type: str(r['type'], 32),
        question: str(r['question'], MAX_LONG_TEXT),
        user_answer: str(r['user_answer'] ?? r['userAnswer'], MAX_LONG_TEXT),
        ai_score: num(r['ai_score'] ?? r['aiScore'], 0),
        ai_reason: str(r['ai_reason'] ?? r['aiReason'], MAX_LONG_TEXT),
        context_word: str(r['context_word'] ?? r['contextWord'], 64),
        created_at: createdAt,
        updated_at: updatedAt,
        deleted,
      },
    };
  }
  return {
    id,
    values: {
      type: str(r['type'], 32),
      content: str(r['content'], MAX_LONG_TEXT),
      source: str(r['source'], MAX_SHORT_TEXT),
      created_at: createdAt,
      updated_at: updatedAt,
      deleted,
    },
  };
}

/**
 * 把 words 字段归一化成「合法 JSON 数组字符串」。
 * @param v 原始值
 */
function jsonArray(v: unknown): string {
  if (Array.isArray(v)) {
    const list = v.filter((x): x is string => typeof x === 'string').map((x) => x.slice(0, 64));
    return JSON.stringify(list);
  }
  if (typeof v === 'string') {
    try {
      const parsed: unknown = JSON.parse(v);
      if (Array.isArray(parsed)) {
        return JSON.stringify(parsed.filter((x): x is string => typeof x === 'string').map((x) => x.slice(0, 64)));
      }
    } catch {
      /* 坏 JSON → 空数组 */
    }
  }
  return '[]';
}

/**
 * 归一化一批行。
 * @param tableKey 表
 * @param raw 请求体里的数组
 * @param max 单批上限
 */
export function normalizeRows(
  tableKey: KcSmallTableKey,
  raw: unknown[],
  max: number,
): { rows: SyncRow[]; skipped: number } {
  const rows: SyncRow[] = [];
  let skipped = 0;
  for (const item of raw) {
    if (rows.length >= max) {
      skipped += 1;
      continue;
    }
    const row = normalizeRow(tableKey, item);
    if (row === null) skipped += 1;
    else rows.push(row);
  }
  return { rows, skipped };
}
