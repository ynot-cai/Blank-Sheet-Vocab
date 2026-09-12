/**
 * 云同步的字段映射：本地对象 ⇄ 服务器行（snake_case）。
 *
 * 两边结构本来就基本一致（服务器就是按前端的字段建的），所以这里只做三件事：
 * 1. 字段名 camelCase ⇄ snake_case；
 * 2. 数据库里 `senses` / `raw_sources` / `attrs` 存 **JSON 字符串**，这里负责打包/拆包；
 * 3. 缺字段兜底（老数据没有 phonetic / deleted 之类的字段）。
 *
 * 纪律：**转换函数里不许出现任何密钥相关字段**。服务器永远不接触 AI 密钥（方案 B），
 * 同步内容里也没有密钥——它只存在浏览器设置里。
 */
import type { Attrs, RawSourceRecord, Sense, Source, Word, WordStatus } from '../core/types';

/** 服务器上的一条单词（words 表） */
export interface ServerWord {
  id: string;
  en: string;
  phonetic: string | null;
  example: string | null;
  senses: string;
  source_id: string | null;
  raw_sources: string | null;
  attrs: string;
  status: string;
  learn_order: number | null;
  created_at: number;
  updated_at: number;
  deleted: number;
}

/** 服务器上的一条来源（sources 表） */
export interface ServerSource {
  id: string;
  name: string;
  priority: number;
  created_at: number;
  updated_at: number;
  deleted: number;
}

/** 推送时的单词载荷（服务器接受 snake_case） */
export interface WordPayload {
  id: string;
  en: string;
  phonetic: string;
  example: string;
  senses: Sense[];
  sourceId: string;
  rawSources: RawSourceRecord[];
  attrs: Attrs;
  status: WordStatus;
  learnOrder: number | null;
  createdAt: number;
  updatedAt: number;
  deleted: 0 | 1;
}

/** 推送时的来源载荷 */
export interface SourcePayload {
  id: string;
  name: string;
  priority: number;
  createdAt: number;
  updatedAt: number;
  deleted: 0 | 1;
}

/** 空的属性组（服务器数据缺 attrs 时兜底） */
const EMPTY_ATTRS: Attrs = {
  needSpell: false,
  failCount: 0,
  failCountTotal: 0,
  reviewCount: 0,
  lastReviewAt: null,
  learnedAt: null,
  reviewPriority: 0,
};

/** 合法的单词状态 */
const STATUSES = new Set<string>(['unlearned', 'learning', 'learned', 'chopped']);

/**
 * 安全地 JSON.parse 一个数组字段。
 * @param text JSON 文本（可能是 null / 坏字符串）
 */
function parseArray<T>(text: string | null): T[] {
  if (typeof text !== 'string' || text.trim() === '') return [];
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch (err) {
    console.warn('[syncMap] 字段不是合法 JSON 数组，已忽略', err);
    return [];
  }
}

/**
 * 安全地 JSON.parse 一个对象字段。
 * @param text JSON 文本
 */
function parseObject(text: string | null): Record<string, unknown> {
  if (typeof text !== 'string' || text.trim() === '') return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch (err) {
    console.warn('[syncMap] 字段不是合法 JSON 对象，已忽略', err);
    return {};
  }
}

/**
 * 服务器行 → 本地 Word。
 * @param row 服务器返回的一行
 */
export function toLocalWord(row: ServerWord): Word {
  const attrsRaw = parseObject(row.attrs);
  const status = STATUSES.has(row.status) ? (row.status as WordStatus) : 'unlearned';
  return {
    id: String(row.id),
    en: String(row.en ?? ''),
    phonetic: row.phonetic ?? '',
    example: row.example ?? '',
    senses: parseArray<Sense>(row.senses),
    sourceId: row.source_id ?? '',
    rawSources: parseArray<RawSourceRecord>(row.raw_sources),
    attrs: { ...EMPTY_ATTRS, ...attrsRaw } as Attrs,
    status,
    learnOrder: row.learn_order === null || row.learn_order === undefined ? null : Number(row.learn_order),
    createdAt: Number(row.created_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0),
    deleted: Number(row.deleted ?? 0) === 1 ? 1 : 0,
  };
}

/**
 * 服务器行 → 本地 Source。
 * @param row 服务器返回的一行
 */
export function toLocalSource(row: ServerSource): Source {
  return {
    id: String(row.id),
    name: String(row.name ?? ''),
    priority: Number(row.priority ?? 0),
    createdAt: Number(row.created_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0),
    deleted: Number(row.deleted ?? 0) === 1 ? 1 : 0,
  };
}

/**
 * 本地 Word → 推送载荷。
 * @param word 本地词
 */
export function toWordPayload(word: Word): WordPayload {
  return {
    id: word.id,
    en: word.en,
    phonetic: word.phonetic ?? '',
    example: word.example ?? '',
    senses: word.senses ?? [],
    sourceId: word.sourceId ?? '',
    rawSources: word.rawSources ?? [],
    attrs: word.attrs,
    status: word.status,
    learnOrder: word.learnOrder,
    createdAt: word.createdAt,
    updatedAt: word.updatedAt,
    deleted: word.deleted === 1 ? 1 : 0,
  };
}

/**
 * 本地 Source → 推送载荷。
 * @param source 本地来源
 */
export function toSourcePayload(source: Source): SourcePayload {
  return {
    id: source.id,
    name: source.name,
    priority: source.priority,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt ?? source.createdAt,
    deleted: source.deleted === 1 ? 1 : 0,
  };
}
