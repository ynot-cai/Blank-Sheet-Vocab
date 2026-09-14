/**
 * 请求体的校验与归一化。
 *
 * 原则：**这里只做结构性校验，不做业务判断**。
 * 脏数据一律「跳过并计数」，而不是整批 400——同步是后台静默任务，
 * 因为一条坏记录就让整批重试，用户会卡在永远同步不完的状态里。
 */
import { isRecord } from './http.js';
import type { SourceInput, WordInput } from './inventory.js';

/** 归一化结果：合法的行 + 被跳过的条数 */
export interface CoercedBatch {
  words: WordInput[];
  sources: SourceInput[];
  /** 结构不合法、被跳过的条数（客户端会看到 skipped 计数） */
  skipped: number;
}

/** 合法的单词状态（与前端 WordStatus 一致） */
const WORD_STATUSES = new Set(['unlearned', 'learning', 'learned', 'chopped']);

/**
 * R1 词级优先级的合法区间与默认值（与前端 `core/types.ts` 的
 * `WORD_PRIORITY_MIN/MAX/DEFAULT` 一致）。
 *
 * 为什么服务端也要钳：客户端版本可能比服务端旧（用户没刷新页面），
 * 老客户端根本不会传 `priority`；也可能有人手搓请求塞一个 9999。
 * 不钳的话列表页的「按优先级筛选」和服务端数据就会长期不一致。
 */
const WORD_PRIORITY_MIN = 1;
const WORD_PRIORITY_MAX = 5;
const WORD_PRIORITY_DEFAULT = 3;

/**
 * 把词级优先级钳到 1~5（缺失/非法 → 默认 3）。
 * @param v 原值
 */
function toWordPriority(v: unknown): number {
  const n = toNumber(v, WORD_PRIORITY_DEFAULT);
  const int = Math.round(n);
  if (!Number.isFinite(int)) return WORD_PRIORITY_DEFAULT;
  return Math.min(WORD_PRIORITY_MAX, Math.max(WORD_PRIORITY_MIN, int));
}

/** 字符串字段的默认值上限，防止有人塞一兆的文本进来 */
const MAX_TEXT_LENGTH = 20_000;

/**
 * 转成字符串（去掉首尾空白并截断）。
 * @param v 原值
 * @param max 最大长度
 */
function toText(v: unknown, max = MAX_TEXT_LENGTH): string {
  if (typeof v === 'string') return v.length > max ? v.slice(0, max) : v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return '';
}

/**
 * 转成有限数字，失败用默认值。
 * @param v 原值
 * @param fallback 默认值
 */
function toNumber(v: unknown, fallback: number): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

/**
 * 转成 0/1 整数（软删除标记）。
 * @param v 原值
 */
function toFlag(v: unknown): number {
  if (v === true) return 1;
  if (typeof v === 'number' && Number.isFinite(v)) return v === 0 ? 0 : 1;
  if (typeof v === 'string') return v === '1' || v.toLowerCase() === 'true' ? 1 : 0;
  return 0;
}

/**
 * 把 JSON 字段统一成字符串落库。
 * 客户端传对象就 stringify；传字符串就原样（避免二次编码变成 "{\"a\":1}" 的字符串）。
 * @param v 原值
 * @param fallbackJson 缺失时的默认 JSON 文本
 */
function toJsonText(v: unknown, fallbackJson: string): string {
  if (typeof v === 'string') return v === '' ? fallbackJson : v;
  if (v === null || v === undefined) return fallbackJson;
  try {
    return JSON.stringify(v);
  } catch {
    return fallbackJson;
  }
}

/**
 * 归一化一条单词；结构不合法返回 null。
 * 说明：`updatedAt` / `createdAt` 缺失时用「服务器当前时间」兜底，而不是 0——
 * 时间戳 0 会让这条记录永远满足不了 `updated_at > since`，等于**数据在库里但谁也拉不到**。
 * @param raw 原始对象
 * @param now 兜底用的时间戳（处理函数传 Date.now()，方便测试注入固定值）
 */
export function coerceWord(raw: unknown, now: number = Date.now()): WordInput | null {
  if (!isRecord(raw)) return null;
  const id = toText(raw.id, 128);
  const en = toText(raw.en, 200);
  if (id === '' || en === '') return null;
  const status = toText(raw.status, 20);
  const learnOrderRaw = raw.learnOrder;
  const createdAt = Math.trunc(toNumber(raw.createdAt, 0)) || now;
  return {
    id,
    en,
    phonetic: toText(raw.phonetic, 500),
    example: toText(raw.example, 2000),
    senses: toJsonText(raw.senses, '[]'),
    sourceId: toText(raw.sourceId, 128),
    rawSources: toJsonText(raw.rawSources, '[]'),
    attrs: toJsonText(raw.attrs, '{}'),
    status: WORD_STATUSES.has(status) ? status : 'unlearned',
    priority: toWordPriority(raw.priority),
    learnOrder:
      learnOrderRaw === null || learnOrderRaw === undefined ? null : Math.trunc(toNumber(learnOrderRaw, 0)),
    createdAt,
    updatedAt: Math.trunc(toNumber(raw.updatedAt, 0)) || createdAt,
    deleted: toFlag(raw.deleted),
  };
}

/**
 * 归一化一条来源；结构不合法返回 null。
 * 说明：来源**没有优先级**（优先级只有一套、挂在词上），所以这里只处理名字与时间戳。
 * 老的 `priority` 字段即使传上来也**直接忽略**——写了也没人读。
 * @param raw 原始对象
 * @param now 兜底用的时间戳
 */
export function coerceSource(raw: unknown, now: number = Date.now()): SourceInput | null {
  if (!isRecord(raw)) return null;
  const id = toText(raw.id, 128);
  const name = toText(raw.name, 200);
  if (id === '' || name === '') return null;
  const createdAt = Math.trunc(toNumber(raw.createdAt, 0)) || now;
  return {
    id,
    name,
    createdAt,
    updatedAt: Math.trunc(toNumber(raw.updatedAt, 0)) || createdAt,
    deleted: toFlag(raw.deleted),
  };
}

/**
 * 归一化整个请求体。
 * @param wordsRaw body.words（可能是任意东西）
 * @param sourcesRaw body.sources（可能是任意东西）
 * @param now 兜底用的时间戳
 */
export function coerceBatch(wordsRaw: unknown, sourcesRaw: unknown, now: number = Date.now()): CoercedBatch {
  let skipped = 0;
  const words: WordInput[] = [];
  const sources: SourceInput[] = [];

  if (wordsRaw !== undefined && wordsRaw !== null) {
    if (!Array.isArray(wordsRaw)) skipped += 1;
    else {
      for (const raw of wordsRaw) {
        const w = coerceWord(raw, now);
        if (w === null) skipped += 1;
        else words.push(w);
      }
    }
  }

  if (sourcesRaw !== undefined && sourcesRaw !== null) {
    if (!Array.isArray(sourcesRaw)) skipped += 1;
    else {
      for (const raw of sourcesRaw) {
        const s = coerceSource(raw, now);
        if (s === null) skipped += 1;
        else sources.push(s);
      }
    }
  }

  return { words, sources, skipped };
}
