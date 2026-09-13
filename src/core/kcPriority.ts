/**
 * 二期复习优先度（属性④）+ 掌握度重算。
 *
 * 与一期的关系：一期 `core/priority.ts` 有一套「表达式自定义」机制（属性⑥）。
 * 二期阶段 01 **不引入表达式引擎**（那会变成两套公式语言），
 * 先用一套结构化的加权公式，把每个可调数字放在 `settings.kc.priority` 里；
 * 阶段 07 再做设置界面（那时如果要表达式，把这里换成 formula 即可，调用方不用改）。
 *
 * 优先度的三个信号（都是「越大越该先复习」）：
 * 1. **掌握度低** → `(1 - mastery) * masteryWeight`
 * 2. **很久没复习** → `daysSinceReview * staleWeight`
 * 3. **自评与考核差距大**（盲目自信）→ `gap * gapWeight`
 *
 * 第 3 条是这套算法存在的理由：`mastery` 已经被惩罚项拉低了，但优先度里再
 * 显式加一份「不一致程度」，能保证这类卡片**排在最前面**，
 * 而不是和「同样低分但一致」的卡片混在一起。
 */
import { KC, getSettings } from './config';
import { activeKcExpr, evalKcExpr } from './kcPriorityExpr';
import { calcMasteryWith, normalizeScore, roundTo } from './kcModel';
import type { KcAttrs, KcPriorityWeights, KnowledgeCard, MasteryConfig } from './kcTypes';

/** 一天的毫秒数 */
const DAY_MS = 86_400_000;

/**
 * 取权重（从全局设置缓存读，读不到用兜底值——core 层不许直接读 IndexedDB）。
 * @param override 显式传入的权重（测试与同步层可绕过设置）
 */
export function weightsOf(override?: Partial<KcPriorityWeights>): KcPriorityWeights {
  const base = getSettings().kc?.priority ?? {
    masteryWeight: 1,
    staleWeight: 0.02,
    gapWeight: 0.5,
  };
  const pick = (v: number | undefined, fallback: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  return {
    masteryWeight: pick(override?.masteryWeight, base.masteryWeight),
    staleWeight: pick(override?.staleWeight, base.staleWeight),
    gapWeight: pick(override?.gapWeight, base.gapWeight),
  };
}

/**
 * 自评与考核的归一化差距（0~1）。
 *
 * - 两边都有：真实差距（自评 3 / 考核 1 → 0.667）
 * - 只有一边：按「和中性值 0.5 的差距」算，**但打个折**，
 *   因为「还没考过」不是「考砸了」，不该和盲目自信同等对待。
 * @param attrs 属性组
 */
export function scoreGap(attrs: KcAttrs): number {
  const hasSelf = attrs.lastSelfScore !== null;
  const hasExam = attrs.lastExamScore !== null;
  if (hasSelf && hasExam) {
    return Math.abs(normalizeScore(attrs.lastSelfScore) - normalizeScore(attrs.lastExamScore));
  }
  if (hasSelf || hasExam) {
    const only = hasSelf ? normalizeScore(attrs.lastSelfScore) : normalizeScore(attrs.lastExamScore);
    return Math.abs(only - 0.5) * KC.missingSideGapDiscount;
  }
  return 0;
}

/**
 * 「是不是盲目自信」：自评明显高于考核。
 * 供界面打标记用（阶段 04 的学习流程会在卡片上显示 ⚠️）。
 * @param attrs 属性组
 */
export function isBlindSpot(attrs: KcAttrs): boolean {
  if (attrs.lastSelfScore === null || attrs.lastExamScore === null) return false;
  const self = normalizeScore(attrs.lastSelfScore);
  const exam = normalizeScore(attrs.lastExamScore);
  return self - exam >= KC.blindSpotGap;
}

/**
 * 距上次复习多少天（从没复习过给 `KC.noRecordDays`，视作很久没看）。
 * @param attrs 属性组
 * @param now 当前时间戳
 */
export function daysSinceReview(attrs: KcAttrs, now: number = Date.now()): number {
  if (attrs.lastReviewAt === null) return KC.noRecordDays;
  return Math.max(0, (now - attrs.lastReviewAt) / DAY_MS);
}

/**
 * 计算复习优先度。
 *
 * **两种模式**（阶段 07 引入表达式机制后）：
 * 1. 设置里有**合法**的 `customExpr` 或选了预设 → 走**表达式**（与一期同一套机制）；
 * 2. 表达式为空/非法 → 退回阶段 01 的**固定加权公式**（三个权重）。
 *
 * 之所以保留公式兜底：老设置里可能只有权重没有表达式（阶段 01 的默认值），
 * 而已有的 `attrs.reviewPriority` 是按公式算出来的 —— 直接换算法会让
 * 「重算全部」前后的排序差异无法解释。两条路都留着，切换是显式的。
 *
 * @param attrs 属性组（只读）
 * @param now 当前时间戳
 * @param override 权重覆盖（测试用；给了它就走固定公式）
 */
export function computeKcPriority(
  attrs: KcAttrs,
  now: number = Date.now(),
  override?: Partial<KcPriorityWeights>,
): number {
  // 表达式模式（override 存在时说明调用方明确要算固定公式，比如单测）
  if (override === undefined) {
    const kc = getSettings().kc;
    const preset = kc?.priority.preset ?? 'balanced';
    const expr = activeKcExpr(preset, kc?.priority.customExpr ?? '');
    if (expr.trim() !== '') {
      return roundTo(evalKcExpr(expr, { attrs }, now), 2);
    }
  }

  const w = weightsOf(override);
  const lowMastery = 1 - attrs.mastery;
  const stale = daysSinceReview(attrs, now);
  const gap = scoreGap(attrs);
  const value = lowMastery * w.masteryWeight + stale * w.staleWeight + gap * w.gapWeight;
  // 保留 2 位小数：界面不显示抖动的小数，排序也稳定
  return roundTo(value, 2);
}

/** 卡片属性的可选补丁（掌握度重算只需要这几个字段） */
export interface ScorePatch {
  lastSelfScore?: number | null;
  lastExamScore?: number | null;
}

/**
 * 重算一张卡片的 `mastery` + `reviewPriority`，返回**新的 attrs**（不改原对象）。
 *
 * 调用时机：自评后、考核后、云端拉回来一批卡片后。
 * 之所以不写在 DAO 的每次写操作里：批量同步时逐个读设置会读上几百次，
 * 集中调一次 `recomputePriorities` 更省。
 *
 * @param attrs 原属性组
 * @param patch 自评/考核分数补丁
 * @param now 当前时间戳
 * @param masteryCfg 掌握度公式参数（不传则从设置读）
 */
export function recomputeAttrs(
  attrs: KcAttrs,
  patch: ScorePatch = {},
  now: number = Date.now(),
  masteryCfg?: MasteryConfig,
): KcAttrs {
  const next: KcAttrs = {
    ...attrs,
    lastSelfScore: patch.lastSelfScore !== undefined ? patch.lastSelfScore : attrs.lastSelfScore,
    lastExamScore: patch.lastExamScore !== undefined ? patch.lastExamScore : attrs.lastExamScore,
  };
  const cfg =
    masteryCfg ?? getSettings().kc?.mastery ?? { w1: 0.6, w2: 0.4, penalty: 0.8, asymmetry: 2 };
  next.mastery = calcMasteryWith(next.lastSelfScore, next.lastExamScore, cfg);
  next.reviewPriority = computeKcPriority(next, now);
  return next;
}

/**
 * 重算一张卡片（返回新卡片对象）。
 * @param card 原卡片
 * @param patch 分数补丁
 * @param now 当前时间戳
 */
export function recomputeCard(card: KnowledgeCard, patch: ScorePatch = {}, now: number = Date.now()): KnowledgeCard {
  const attrs = recomputeAttrs(card.attrs, patch, now);
  return { ...card, attrs };
}
