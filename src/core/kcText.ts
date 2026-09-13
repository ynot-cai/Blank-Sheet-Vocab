/**
 * 二期的底层小工具：id 生成、文本清洗、分数归一化、钳制与取整，
 * 以及「把 unknown 安全地读成 string / number / string[]」的一组取值器。
 *
 * 为什么要单独一个文件：这些函数被 `kcBlock`（块）、`kcCard`（卡片）、
 * `kcMastery`（掌握度）三个模块共用，放在任何一个里面都会形成
 * 「兄弟模块互相 import」的怪关系。
 *
 * 这个文件**只依赖 `config` 与 `kcTypes`**（后者本来就只放类型），
 * 所以它永远是二期依赖图的最底层，不会成环。
 */
import { KC } from './config';

/**
 * 生成一个 id。
 * 说明：优先用 `crypto.randomUUID()`（安全上下文才有），
 * 没有就退化成「时间戳 + 随机数」——它只是主键，不需要密码学强度。
 */
export function newId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `kc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 去掉控制字符、限制长度。
 *
 * **安全铁律的第一道防线**：AI 输出（或用户粘贴的东西）里可能带
 * `\u0000` 之类的控制字符，直接塞进 DOM 会有各种诡异表现。
 * 注意这里**不是**转义 HTML——转义由渲染层用 `textContent` 保证，
 * 这一层只做「字符合法化 + 长度上限」。
 *
 * @param s 原始文本
 * @param maxLength 最大长度（默认取 `KC.maxBlockTextLength`）
 */
export function sanitizeText(s: string, maxLength: number = KC.maxBlockTextLength): string {
  // 允许换行(\n)和制表(\t)，其余 C0/C1 控制字符与 DEL 全部删掉；顺带把 \r\n 归一成 \n
  const cleaned = s
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '');
  const trimmed = cleaned.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n');
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, maxLength)}…`;
}

/**
 * 归一化分数：1~3 → 0~1。
 *
 * - `null` / 非有限数 → 0（当作「没有这个分数」，调用方另有分支）
 * - 越界值先钳到 `[1, 3]`（防 AI 给出 5 分或 0 分）
 * @param score 原始分数
 */
export function normalizeScore(score: number | null): number {
  if (score === null || !Number.isFinite(score)) return 0;
  const clamped = Math.min(KC.maxScore, Math.max(1, score));
  return clamped / KC.maxScore;
}

/**
 * 钳制到 [0, 1]（非有限数当 0）。
 * @param v 任意数字
 */
export function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.min(1, Math.max(0, v));
}

/**
 * 保留固定小数位（默认 3 位，见 `KC.masteryDigits`）。
 * @param v 数字
 * @param digits 小数位
 */
export function roundTo(v: number, digits: number = KC.masteryDigits): number {
  const factor = 10 ** digits;
  return Math.round(v * factor) / factor;
}

// ─────────────────────────────────────────────
// 下面四个是「从不可信数据里安全取值」的取值器。
// 云端拉回来的行、AI 吐出来的 JSON 都是 unknown，
// 直接 `as string` 是骗自己——字段可能真的是数字或对象。
// ─────────────────────────────────────────────

/** 取字符串（非字符串给空串） */
export function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** 取数字（非有限数给默认值；数字字符串也认） */
export function asNumber(v: unknown, fallback: number): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

/** 取可空数字（不是有限数就给 null） */
export function asNullableNumber(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 取字符串数组（只保留字符串元素） */
export function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string');
}
