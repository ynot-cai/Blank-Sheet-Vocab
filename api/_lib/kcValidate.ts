/**
 * 二期请求体的归一化与校验（**服务端也必须自己校验一遍**）。
 *
 * 为什么服务端要重复前端 `kcModel.coerceCard` 的工作：客户端数据不可信。
 * 别人可以拿同步码直接 POST 任意结构；这里保证**进库的东西一定是合法 JSON 字符串**，
 * 免得一条坏数据把别的设备的卡片列表渲染炸掉。
 *
 * 注意这里的**长度上限和前端 `core/config.ts` 的 `KC` 是同一套数字**
 * （服务端不 import 前端代码：`api/` 跑在 Node 里，不该依赖 `src/`）。
 */
import { MAX_PULL_ROWS } from './limits.js';
import type { KcCardInput } from './kcInventory.js';

/** 单张卡片的 JSON 字段长度上限（字符数），防止有人塞一篇小说把库撑爆 */
const MAX_JSON_FIELD = 200_000;
/** 标题 / 摘要上限（与前端 KC.maxTitleLength / maxSummaryLength 一致） */
const MAX_TITLE = 120;
const MAX_SUMMARY = 200;
/** 合法状态集合 */
const KC_STATUSES = new Set(['unlearned', 'learning', 'learned', 'chopped']);

/**
 * 取字符串（非字符串给空串）。
 * @param v 任意值
 */
function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/**
 * 取数字（非有限数给默认值）。
 * @param v 任意值
 * @param fallback 兜底值
 */
function num(v: unknown, fallback: number): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

/**
 * 把任意值序列化成**安全的 JSON 字符串**。
 *
 * - 已经是字符串：先试着 parse 一次，**只留能解析的**（坏 JSON 一律换兜底值，
 *   否则前端 `JSON.parse` 会直接抛异常）；
 * - 是对象/数组：直接 stringify；
 * - 其余（undefined / 函数 / 循环引用）：用兜底值。
 *
 * @param v 原始值
 * @param fallback 兜底值（会被 stringify）
 */
function toJson(v: unknown, fallback: unknown): string {
  if (typeof v === 'string') {
    const trimmed = v.trim();
    if (trimmed === '') return JSON.stringify(fallback);
    if (trimmed.length > MAX_JSON_FIELD) return JSON.stringify(fallback);
    try {
      const parsed: unknown = JSON.parse(trimmed);
      const again = JSON.stringify(parsed);
      return again === undefined ? JSON.stringify(fallback) : again;
    } catch {
      return JSON.stringify(fallback);
    }
  }
  if (v === undefined || v === null) return JSON.stringify(fallback);
  try {
    const out = JSON.stringify(v);
    if (out === undefined || out.length > MAX_JSON_FIELD) return JSON.stringify(fallback);
    return out;
  } catch {
    return JSON.stringify(fallback);
  }
}

/**
 * 归一化一张卡片：把所有字段转成库里要存的样子。
 * @param raw 请求体里的一项
 * @returns 非法（没有 id）时返回 null
 */
export function normalizeCard(raw: unknown): KcCardInput | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;

  const id = str(r['id']).trim();
  if (id === '' || id.length > 128) return null;

  const status = str(r['status']);
  const createdAt = Math.trunc(num(r['createdAt'], Date.now()));
  const updatedAt = Math.trunc(num(r['updatedAt'], createdAt));

  return {
    id,
    title: str(r['title']).slice(0, MAX_TITLE),
    summary: str(r['summary']).slice(0, MAX_SUMMARY),
    blocks: toJson(r['blocks'], []),
    examTags: toJson(r['examTags'], []),
    examLoad: toJson(r['examLoad'], { types: [], estMinutes: 0 }),
    source: toJson(r['source'], {}),
    attrs: toJson(r['attrs'], {}),
    status: KC_STATUSES.has(status) ? status : 'unlearned',
    // 时间戳做基本合理性检查：负数当 0，超过当前时间 1 天的当当前时间（防手滑写坏游标）
    createdAt: Math.max(0, Math.min(createdAt, Date.now() + 86_400_000)),
    updatedAt: Math.max(0, Math.min(updatedAt, Date.now() + 86_400_000)),
    deleted: r['deleted'] === 1 || r['deleted'] === true ? 1 : 0,
  };
}

/**
 * 归一化一整批卡片。
 * @param raw 请求体里的数组
 * @param max 单批上限（超过的丢掉，函数外应该已经拦过 400）
 */
export function normalizeCards(raw: unknown[], max: number = MAX_PULL_ROWS): {
  cards: KcCardInput[];
  skipped: number;
} {
  const cards: KcCardInput[] = [];
  let skipped = 0;
  for (const item of raw) {
    if (cards.length >= max) {
      skipped += 1;
      continue;
    }
    const card = normalizeCard(item);
    if (card === null) skipped += 1;
    else cards.push(card);
  }
  return { cards, skipped };
}
