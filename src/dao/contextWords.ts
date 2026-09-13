/**
 * 每日语境词本地 DAO（二期阶段 01 建数据层，界面在阶段 05 做）。
 *
 * 机制（用户明确要求，见主提示词 4.5）：
 * - 每天 **5 个**语境词，**互不相关甚至可以完全不同**（防止 AI 硬凑成一个主题）；
 * - 每道题目**只与其中某一个词关联**（不强求全部关联）；
 * - **生成词时**检索近 1 个月历史避免重复；
 * - **出题时**检索近 3 天历史题目避免重复；
 * - 自然日更新（过零点换新一组）；
 * - AI 生成 → **用户确认或修改**后才生效（`confirmed`）。
 *
 * 说明：本地表里存 `spaceKey` 是为了和云端行同构（云端每条都带 space_key，
 * 那是最外层的隔离冗余），本地只有一个空间，但保留字段能让「推上去」零转换。
 */
import { STORE, clearStore, tx } from '../core/db';
import { newId, sanitizeText } from '../core/kcModel';
import { getSettings } from '../core/config';
import { getSpaceKey } from '../core/syncHelper';
import type { DailyContextWords } from '../core/kcTypes';

/** 一天的毫秒数 */
const DAY_MS = 86_400_000;

/**
 * 本地自然日（'YYYY-MM-DD'）。
 *
 * 用**本地时区**而不是 UTC：用户说的「今天」是自己日历上的今天，
 * 用 UTC 会让东八区的用户在早上 8 点前看到「昨天」的语境词。
 * @param ts 时间戳（默认现在）
 */
export function localDate(ts: number = Date.now()): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * 取当前空间的 spaceKey（同步码没填时返回空串，功能照常可用——本地优先）。
 */
export async function currentSpaceKey(): Promise<string> {
  try {
    const code = getSettings().cloud.syncCode.trim();
    if (code === '') return '';
    return await getSpaceKey(code);
  } catch (err) {
    // 非安全上下文没有 crypto.subtle：这时同步本来就用不了，但不该影响本地读写
    console.warn('[dao/contextWords] 取 spaceKey 失败（不影响本地功能）', err);
    return '';
  }
}

/**
 * 读某天的语境词（没有返回 null）。
 * @param date 'YYYY-MM-DD'，默认今天
 */
export async function getForDate(date: string = localDate()): Promise<DailyContextWords | null> {
  const all = await getAll();
  const spaceKey = await currentSpaceKey();
  const hit = all.find((w) => w.date === date && (spaceKey === '' || w.spaceKey === spaceKey));
  return hit ?? null;
}

/**
 * 读全部语境词（按日期倒序）。
 */
export async function getAll(): Promise<DailyContextWords[]> {
  const rows = await tx<unknown[]>(STORE.dailyContextWords, 'readonly', (s) => s.getAll() as IDBRequest<unknown[]>);
  const out: DailyContextWords[] = [];
  for (const row of rows) {
    const w = coerceContextWords(row);
    if (w !== null) out.push(w);
  }
  return out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

/**
 * 归一化一条语境词记录（坏数据丢掉，不抛异常）。
 * @param raw 原始值
 */
function coerceContextWords(raw: unknown): DailyContextWords | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r['id'] === 'string' && r['id'] !== '' ? r['id'] : newId();
  const date = typeof r['date'] === 'string' ? r['date'] : localDate();
  const words = Array.isArray(r['words'])
    ? r['words'].filter((w): w is string => typeof w === 'string').map((w) => sanitizeText(w, 64))
    : [];
  return {
    id,
    spaceKey: typeof r['spaceKey'] === 'string' ? r['spaceKey'] : '',
    date,
    words,
    source: r['source'] === 'manual' ? 'manual' : 'ai',
    confirmed: r['confirmed'] === true || r['confirmed'] === 1,
    createdAt: typeof r['createdAt'] === 'number' ? r['createdAt'] : Date.now(),
  };
}

/**
 * 保存一组语境词（**新建时 `confirmed` 默认 false**：AI 生成的要等用户点头才生效）。
 * @param words 词数组
 * @param source 来源
 * @param date 日期
 * @param confirmed 是否已确认
 */
export async function save(
  words: string[],
  source: 'ai' | 'manual' = 'ai',
  date: string = localDate(),
  confirmed = false,
): Promise<DailyContextWords> {
  const settings = getSettings();
  const spaceKey = await currentSpaceKey();
  const row: DailyContextWords = {
    id: newId(),
    spaceKey,
    date,
    // 数量上限来自设置（默认 5），去重后截断
    words: dedupe(words).slice(0, settings.kc.contextWordCount),
    source,
    confirmed,
    createdAt: Date.now(),
  };
  await tx(STORE.dailyContextWords, 'readwrite', (s) => s.put(row));
  return row;
}

/**
 * 删掉一条语境词记录（同一天重新生成时先删旧的，保证「一天只有一条」）。
 * @param id 记录 id
 */
export async function removeById(id: string): Promise<void> {
  await tx(STORE.dailyContextWords, 'readwrite', (s) => s.delete(id));
}

/**
 * 用户确认（或改完词后确认）某天的语境词。
 * @param id 记录 id
 * @param words 可选：用户改过的词（不传就沿用原来的）
 */
export async function confirm(id: string, words?: string[]): Promise<boolean> {
  const row = await tx<unknown>(STORE.dailyContextWords, 'readonly', (s) => s.get(id) as IDBRequest<unknown>);
  const current = coerceContextWords(row);
  if (current === null) return false;
  const settings = getSettings();
  const next: DailyContextWords = {
    ...current,
    words: words === undefined ? current.words : dedupe(words).slice(0, settings.kc.contextWordCount),
    confirmed: true,
  };
  await tx(STORE.dailyContextWords, 'readwrite', (s) => s.put(next));
  return true;
}

/**
 * 取「生成新词时要避开的历史词」：近 N 天的全部语境词（默认 30 天，来自设置）。
 *
 * 用途：阶段 05 把这份清单塞进出题/生成提示词，让 AI 别重复出同一批词。
 * @param lookbackDays 回看天数（不传则读设置）
 * @param now 当前时间戳
 */
export async function recentWords(lookbackDays?: number, now: number = Date.now()): Promise<string[]> {
  const days = lookbackDays ?? getSettings().kc.contextGenLookbackDays;
  const since = now - days * DAY_MS;
  const all = await getAll();
  const out: string[] = [];
  for (const row of all) {
    // date 是自然日字符串，直接转时间戳比较（比字符串比较更稳，避免时区/格式差异）
    const ts = Date.parse(`${row.date}T00:00:00`);
    if (!Number.isFinite(ts) || ts < since) continue;
    for (const w of row.words) out.push(w);
  }
  return dedupe(out);
}

/**
 * 数组去重（保序、去空、去首尾空白）。
 * @param list 原始数组
 */
export function dedupe(list: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    const v = raw.trim();
    const key = v.toLowerCase();
    if (v === '' || seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

/**
 * 清空语境词表（设置页清库用）。
 */
export async function clearAll(): Promise<void> {
  await clearStore(STORE.dailyContextWords);
}
