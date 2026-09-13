/**
 * 二期复习优先度的**表达式引擎**（阶段 07）。
 *
 * 一期 `core/priority.ts` 已经有一套同样的机制（白名单校验 + `new Function` 求值），
 * 但**变量完全不同**（那边是单词的 needSpell/failCount，这边是知识点的 mastery/天数），
 * 所以二期需要自己的一份白名单 —— 不能直接复用一期的（复用会让「mastery」这种
 * 二期变量在一期表达式里被拒，或者相反）。
 *
 * ⚠️ 求值用 `new Function`，所以**白名单校验是安全边界**：
 * 字符集 + 标识符双重过滤，任何不认识的变量或字符一律拒绝。
 */
import { KC } from './config';
import type { KcAttrs } from './kcTypes';

/** 预设表达式（阶段 07 给的三档） */
export const KC_PRIORITY_PRESETS: Record<'balanced' | 'weakFirst' | 'forgetting', { name: string; desc: string; expr: string }> = {
  balanced: {
    name: '均衡',
    desc: '时间与掌握度各占一半权重。',
    expr: 'daysSinceReview * 0.5 + (1 - mastery) * 10',
  },
  weakFirst: {
    name: '薄弱优先',
    desc: '掌握度低的最优先，复习次数多的略微降权。',
    expr: '(1 - mastery) * 20 - reviewCount',
  },
  forgetting: {
    name: '遗忘曲线',
    desc: '越久没复习越优先，同时按复习次数摊薄。',
    expr: 'daysSinceReview / (reviewCount + 1) + (1 - mastery) * 8',
  },
};

/** 表达式里允许出现的变量名（**新增变量只加这里**） */
export const KC_ALLOWED_VARS = [
  'mastery',
  'reviewCount',
  'daysSinceReview',
  'daysSinceLearned',
  'selfScore',
  'examScore',
  'true',
  'false',
] as const;

/** 允许的字符集（其余一律拒绝，防注入） */
const ALLOWED_CHARS_RE = /^[0-9.\-+*/()?:<>=!&| \tA-Za-z_]*$/;
/** 标识符提取 */
const IDENT_RE = /[A-Za-z_][A-Za-z0-9_]*/g;
/** 一天的毫秒数 */
const DAY_MS = 86_400_000;

/** 表达式校验结果 */
export interface KcExprCheck {
  ok: boolean;
  message: string;
}

/**
 * 求值作用域里的变量。
 * @param card 卡片（只要 attrs 与时间）
 * @param now 当前时间戳
 */
export function kcExprScope(
  card: { attrs: KcAttrs },
  now: number = Date.now(),
): Record<string, number> {
  const a = card.attrs;
  return {
    mastery: a.mastery,
    reviewCount: a.reviewCount,
    daysSinceReview: a.lastReviewAt === null ? KC.noRecordDays : Math.max(0, (now - a.lastReviewAt) / DAY_MS),
    daysSinceLearned: a.learnedAt === null ? KC.noRecordDays : Math.max(0, (now - a.learnedAt) / DAY_MS),
    // 分数缺失时给 0（表达式里可以据此分支，如 `selfScore > 0 ? ... : ...`）
    selfScore: a.lastSelfScore ?? 0,
    examScore: a.lastExamScore ?? 0,
  };
}

/**
 * 试算一次，把「语法错 / 结果不是有限数」与「算出来是 0」区分开。
 * @param expr 已通过白名单校验的表达式
 * @param card 卡片
 * @param now 当前时间
 */
function tryEvaluate(
  expr: string,
  card: { attrs: KcAttrs },
  now: number,
): { ok: boolean; value: number; error?: string } {
  const scope = kcExprScope(card, now);
  const names = Object.keys(scope);
  try {
    const fn = new Function(...names, `"use strict"; return (${expr});`) as (...args: number[]) => unknown;
    const raw = fn(...names.map((n) => scope[n] ?? 0));
    const num = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(num)) return { ok: false, value: 0, error: '计算结果不是有限数字（可能除以了 0）' };
    return { ok: true, value: num };
  } catch (err) {
    return { ok: false, value: 0, error: err instanceof Error ? err.message : String(err) };
  }
}

/** 试算用的假卡片（校验表达式时用） */
function probeCard(): { attrs: KcAttrs } {
  return {
    attrs: {
      learnedAt: Date.now() - 2 * DAY_MS,
      lastReviewAt: Date.now() - DAY_MS,
      reviewCount: 1,
      lastSelfScore: 2,
      lastExamScore: 3,
      mastery: 0.5,
      reviewPriority: 0,
    },
  };
}

/**
 * 校验一条表达式（字符集 + 变量白名单 + 真试算）。
 * @param expr 表达式
 */
export function validateKcExpr(expr: string): KcExprCheck {
  const trimmed = expr.trim();
  if (trimmed === '') return { ok: false, message: '表达式为空' };
  if (!ALLOWED_CHARS_RE.test(trimmed)) {
    return { ok: false, message: '表达式含不允许的字符（只允许数字、运算符和列出的变量）' };
  }
  const allowed = new Set<string>(KC_ALLOWED_VARS);
  const idents = trimmed.match(IDENT_RE) ?? [];
  for (const id of idents) {
    if (!allowed.has(id)) return { ok: false, message: `不允许的变量或关键字：${id}` };
  }
  if (idents.length === 0) return { ok: false, message: '表达式至少要用到一个变量' };
  const result = tryEvaluate(trimmed, probeCard(), Date.now());
  if (!result.ok) return { ok: false, message: `表达式无法求值：${result.error ?? '未知错误'}` };
  return { ok: true, message: '' };
}

/**
 * 求值一条表达式（非法表达式返回 0，并打日志）。
 * @param expr 表达式
 * @param card 卡片
 * @param now 当前时间
 */
export function evalKcExpr(expr: string, card: { attrs: KcAttrs }, now: number = Date.now()): number {
  const trimmed = expr.trim();
  if (trimmed === '') return 0;
  if (!ALLOWED_CHARS_RE.test(trimmed)) {
    console.warn('[kcPriority] 表达式含非法字符，已忽略：', trimmed);
    return 0;
  }
  const allowed = new Set<string>(KC_ALLOWED_VARS);
  for (const id of trimmed.match(IDENT_RE) ?? []) {
    if (!allowed.has(id)) {
      console.warn('[kcPriority] 表达式含非法变量，已忽略：', id);
      return 0;
    }
  }
  const result = tryEvaluate(trimmed, card, now);
  if (!result.ok) {
    console.warn('[kcPriority] 表达式求值失败，已按 0 处理：', trimmed, result.error);
    return 0;
  }
  return result.value;
}

/**
 * 取当前生效的表达式。
 *
 * 优先级：`customExpr`（非空且合法）> 预设。
 * **非法自定义表达式会被忽略并退回预设** —— 否则用户填错一个字符，
 * 全部卡片的优先度会一起变成 0（排序失去意义）。
 *
 * @param settings 二期设置
 * @param preset 预设名
 * @param customExpr 自定义表达式
 */
export function activeKcExpr(preset: keyof typeof KC_PRIORITY_PRESETS, customExpr: string): string {
  const custom = customExpr.trim();
  if (custom !== '' && validateKcExpr(custom).ok) return custom;
  return KC_PRIORITY_PRESETS[preset]?.expr ?? KC_PRIORITY_PRESETS.balanced.expr;
}
