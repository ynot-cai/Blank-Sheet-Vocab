import type { Attrs, PriorityPreset, Settings, Word } from './types';
import { WORD_PRIORITY_DEFAULT } from './types';

/**
 * ★ T2：没有总考核次数记录时用的**默认失败率**（= 默认正确率 50%）。
 *
 * 为什么是 0.5 而不是 0 或 1：
 * - 给 0 等于「没考过 = 一定没问题」，新词永远排不上复习；
 * - 给 1 等于「没考过 = 一定有问题」，新词会把所有老词挤掉；
 * - 0.5 是「信息不足时的中性猜测」，也是用户明确指定的默认正确率 50% 的补数。
 */
export const DEFAULT_FAIL_RATE = 0.5;

/**
 * ★ T2：失败率 = 失败次数 ÷ 总考核次数（钳制在 0~1）。
 *
 * 分母 `examCount` 缺失或为 0 时**不做除法**，直接返回 {@link DEFAULT_FAIL_RATE}
 * （除零保护；用户明确要求「0 不做除法」）。
 *
 * 为什么这个函数对「0 次考核」和「null（老数据没记录）」一视同仁：
 * 两者都意味着「我们不知道这个词的实际表现」，用同一个默认值最诚实。
 * 迁移（dbSchema 的 migrateToV7ExamCount / model 的 backfillExamCount）
 * 会把 null 补成具体数字，之后这里只会遇到数字。
 *
 * @param attrs 词属性
 */
export function getFailRate(attrs: Attrs): number {
  const exams = attrs.examCount;
  if (typeof exams !== 'number' || !Number.isFinite(exams) || exams <= 0) return DEFAULT_FAIL_RATE;
  const fails = Number.isFinite(attrs.failCountTotal) ? Math.max(0, attrs.failCountTotal) : 0;
  return Math.min(1, Math.max(0, fails / exams));
}

/**
 * 预设表达式与介绍。
 *
 * ★ T2 的量纲提醒（**改表达式前必读**）：
 *   `failRate` 是 **0~1 的比率**，`failCount` / `failCountTotal` 是**次数**，`examCount` 是次数。
 *   同一个系数配在两者上，结果差一两个数量级：
 *   - 旧预设 `failCount * 10`（次数口径）在「考 20 次错 5 次」上是 50 分；
 *   - 换成 `failRate * 10` 只有 2.5 分 —— 需要把系数放大到「× 可能的最大次数」量级。
 *   所以**新预设的系数是重新标的**（例如 balanced 里 `failRate * 30`，对应
 *   「失败率 0.5 且考了 60 次」与旧式 `failCountTotal 30` 同量级），
 *   而不是把旧式里的 `failCount` 直接替换成 `failRate`。
 */
export const PRESETS: Record<PriorityPreset, { name: string; desc: string; expr: string }> = {
  forgetting: {
    name: '遗忘曲线型',
    desc: '越久没复习、复习次数越少，优先度越高；失败率会再加权。',
    expr: 'daysSinceReview / (reviewCount + 1) + failRate * 20',
  },
  failFirst: {
    name: '失败率优先型',
    desc: '把「没答对的比例」当成最强信号，失败率直接放大 60 倍（0.5 的失败率 = 30 分）。',
    expr: 'failRate * 60 + daysSinceReview',
  },
  balanced: {
    name: '均衡型（默认）',
    desc: '时间、失败率、是否需拼写三者平衡，复习次数多则略微降权。',
    expr: 'daysSinceReview * 0.5 + failRate * 30 + (needSpell ? 2 : 0) + reviewCount * -0.2',
  },
  failRateBalanced: {
    name: '失败率均衡型',
    desc: '只按「错误率 + 多久没复习」排序，失败率权重更高，不看复习次数。',
    expr: 'failRate * 50 + daysSinceReview * 0.5',
  },
};

/**
 * 表达式里允许出现的变量名。
 *
 * T2 新增 `failRate`（0~1 比率，推荐主用）与 `examCount`（总考核次数）；
 * 旧的 `failCount` / `failCountTotal` 保留给高级用户（量纲是次数）。
 */
export const ALLOWED_VARS = [
  'needSpell',
  'failRate',
  'examCount',
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
      // T2：给一个**非零**的分母，这样 `x / examCount` 这类写法在试算时不会因除零被误判成非法
      examCount: 2,
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
 *
 * ★ T2 新增两个变量：
 * - `failRate`：失败率 0~1（= 失败次数 / 总考核次数），**推荐在表达式里主用它**；
 * - `examCount`：总考核次数（老数据没记录时是 0，此时 failRate 取默认 0.5）。
 *
 * 同时保留 `failCount`（封顶值）与 `failCountTotal`（真实累计）——
 * 量纲是「次数」，与 failRate 不是一回事，写表达式时别混用（见 PRESETS 的量纲提醒）。
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
    failRate: getFailRate(attrs),
    examCount: typeof attrs.examCount === 'number' && Number.isFinite(attrs.examCount) ? attrs.examCount : 0,
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
