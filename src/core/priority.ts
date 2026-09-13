import type { PriorityPreset, Settings, Word } from './types';
import { WORD_PRIORITY_DEFAULT } from './types';

/** 预设表达式与介绍 */
export const PRESETS: Record<PriorityPreset, { name: string; desc: string; expr: string }> = {
  forgetting: {
    name: '遗忘曲线型',
    desc: '越久没复习、复习次数越少，优先度越高；未通过会再加权。',
    expr: 'daysSinceReview / (reviewCount + 1) + failCount * 2',
  },
  failFirst: {
    name: '未通过优先型',
    desc: '把「没答对」当成最强信号，未通过次数直接放大 10 倍。',
    expr: 'failCount * 10 + daysSinceReview',
  },
  balanced: {
    name: '均衡型',
    desc: '时间、未通过、是否需拼写三者平衡，复习次数多则略微降权。',
    expr: 'daysSinceReview * 0.5 + failCount * 3 + (needSpell ? 2 : 0) + reviewCount * -0.2',
  },
};

/** 表达式里允许出现的变量名 */
export const ALLOWED_VARS = [
  'needSpell',
  'failCount',
  'failCountTotal',
  'reviewCount',
  'daysSinceReview',
  'daysSinceLearned',
  'true',
  'false',
] as const;

/** 表达式里允许出现的字符（其余一律拒绝，防止注入） */
const ALLOWED_CHARS_RE = /^[0-9.\-+*/()?:<>=!&| \tA-Za-z_]*$/;
/** 标识符提取 */
const IDENT_RE = /[A-Za-z_][A-Za-z0-9_]*/g;

/** 表达式校验结果 */
export interface ExprCheck {
  ok: boolean;
  message: string;
}

/**
 * 表达式白名单校验：字符集 + 标识符都必须在白名单内。
 * @param expr 表达式
 */
export function validateExpr(expr: string): ExprCheck {
  const trimmed = expr.trim();
  if (trimmed === '') return { ok: false, message: '表达式为空' };
  if (!ALLOWED_CHARS_RE.test(trimmed)) {
    return { ok: false, message: '表达式含不允许的字符（只允许数字、运算符和列出的变量）' };
  }
  const allowed = new Set<string>(ALLOWED_VARS);
  const idents = trimmed.match(IDENT_RE) ?? [];
  for (const id of idents) {
    if (!allowed.has(id)) return { ok: false, message: `不允许的变量或关键字：${id}` };
  }
  if (idents.length === 0) return { ok: false, message: '表达式至少要用到一个变量' };
  // 再做一次真正的试算：语法错误 / 除以 0 都算不合法（不能只看 evalPriority 的返回值，它会把错误吞成 0）
  const result = tryEvaluate(trimmed, probeWord(), Date.now());
  if (!result.ok) return { ok: false, message: `表达式无法求值：${result.error ?? '未知错误'}` };
  return { ok: true, message: '' };
}

/** 试算用的假词 */
function probeWord(): Word {
  return {
    id: 'probe',
    en: 'probe',
    phonetic: '',
    example: '',
    senses: [],
    sourceId: 'probe',
    rawSources: [],
    attrs: {
      needSpell: false,
      failCount: 1,
      failCountTotal: 1,
      reviewCount: 1,
      lastReviewAt: Date.now() - 86_400_000,
      learnedAt: Date.now() - 172_800_000,
      reviewPriority: 0,
    },
    status: 'learning',
    priority: WORD_PRIORITY_DEFAULT,
    learnOrder: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

/** 一天的毫秒数 */
const DAY_MS = 86_400_000;
/** 没有复习记录时给的默认天数（视为很久没复习） */
const NO_RECORD_DAYS = 999;

/**
 * 计算表达式作用域里的变量值。
 * @param w 单词
 * @param now 当前时间戳
 */
export function exprScope(w: Word, now: number = Date.now()): Record<string, number> {
  const { attrs } = w;
  const daysSinceReview =
    attrs.lastReviewAt === null ? NO_RECORD_DAYS : Math.max(0, (now - attrs.lastReviewAt) / DAY_MS);
  const daysSinceLearned =
    attrs.learnedAt === null ? NO_RECORD_DAYS : Math.max(0, (now - attrs.learnedAt) / DAY_MS);
  return {
    needSpell: attrs.needSpell ? 1 : 0,
    failCount: attrs.failCount,
    failCountTotal: attrs.failCountTotal,
    reviewCount: attrs.reviewCount,
    daysSinceReview,
    daysSinceLearned,
  };
}

/**
 * 真正编译并试算一次，把「语法错误 / 结果不是有限数」和「算出来是 0」区分开。
 * 说明：evalPriority 会把一切异常吞成 0，所以表达式校验不能依赖它的返回值，
 * 否则 `failCount *` 这种写坏了的表达式会被当成合法（这是自测里抓到的一个真 bug）。
 * @param expr 已通过字符集与变量白名单校验的表达式
 * @param w 单词
 * @param now 当前时间戳
 */
function tryEvaluate(expr: string, w: Word, now: number): { ok: boolean; value: number; error?: string } {
  const scope = exprScope(w, now);
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

/**
 * 求值优先度表达式。非法表达式返回 0。
 * @param expr 表达式
 * @param w 单词
 * @param now 当前时间戳
 */
export function evalPriority(expr: string, w: Word, now: number = Date.now()): number {
  const trimmed = expr.trim();
  if (trimmed === '') return 0;
  if (!ALLOWED_CHARS_RE.test(trimmed)) {
    console.warn('[priority] 表达式含非法字符，已忽略：', trimmed);
    return 0;
  }
  const allowed = new Set<string>(ALLOWED_VARS);
  for (const id of trimmed.match(IDENT_RE) ?? []) {
    if (!allowed.has(id)) {
      console.warn('[priority] 表达式含非法变量，已忽略：', id);
      return 0;
    }
  }
  const result = tryEvaluate(trimmed, w, now);
  if (!result.ok) {
    console.warn('[priority] 表达式求值失败，已按 0 处理：', trimmed, result.error);
    return 0;
  }
  return result.value;
}

/**
 * 取当前生效的表达式：customExpr 非空时优先，否则用预设。
 * @param settings 设置
 */
export function activeExpr(settings: Settings): string {
  const custom = settings.priority.customExpr.trim();
  if (custom !== '') return custom;
  return PRESETS[settings.priority.preset]?.expr ?? PRESETS.balanced.expr;
}

/**
 * 计算某词的复习综合优先度（属性⑥）。
 * @param w 单词
 * @param settings 设置
 * @param now 当前时间戳
 */
export function computePriority(w: Word, settings: Settings, now: number = Date.now()): number {
  const value = evalPriority(activeExpr(settings), w, now);
  return Math.round(value * 100) / 100;
}
