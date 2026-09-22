/**
 * 布局调整的「草稿态」（T1）。
 *
 * ── 为什么需要它 ──
 * 改造前设置页是「拖动/输入即生效」：`patchSettings()` 立刻写库 + 刷新内存缓存 +
 * 触发全应用布局重算。用户在调参过程中产生的**每一个中间态**都是一个真实的、
 * 已经落库的设置 —— 中间态一旦不合法（或缺字段），全应用就跟着进坏状态。
 * T1 诊断实测的崩溃正是这条路：改一次「手机档边距」把 `layout.mobile` 写成
 * `{ edgeMarginPx: 18 }`，`button` 子树丢失 → 设置页每次打开都白屏。
 *
 * ── 改成什么 ──
 * 「编辑 → 确认 → 应用」：
 * - 用户改控件 → 只更新这里的内存草稿 + 刷新预览，
 *   **不写 settings、不写库、不触发全局重算**；
 * - 点「应用并预览」→ 一次性写出**完整且已净化**的布局设置 → 进入观察期（见 `layoutObserve.ts`）；
 * - 点「取消」→ 丢弃草稿，恢复已保存的值；
 * - 有未应用的修改就离开页面 → 草稿在内存里，**天然写不进去**。
 *
 * ── 为什么是模块级单例而不是页面局部状态 ──
 * 1. 内存草稿必须能跨「设置页重新渲染」存活（切分组展开、`refresh()` 都会重建 DOM），
 *    否则用户改了一半、页面一重绘就丢；
 * 2. `layoutObserve.ts`（观察期/回滚）与设置页是两个模块，需要读同一份
 *    「已保存值」来判断当前设置是否干净。页面局部 `let` 做不到。
 *
 * 注意：这里**没有**任何跨会话持久化，草稿只活在当前标签页的内存里
 * （刷新页面即丢弃 —— 这正是验收项「未应用不落盘」要的行为）。
 */
import {
  coerceColsOverride,
  defaultTierCopy,
  DEFAULT_SETTINGS,
  getPresetParams,
  getSettings,
  sanitizeLayoutSettings,
} from '../../../core/config';
import type { LayoutColsOverride, LayoutSettings } from '../../../core/types';

/** 布局档位名（手机 / 平板 / 桌面） */
export type LayoutTierKey = keyof LayoutSettings;

/**
 * 一个档位参数的**数值**字段名。
 *
 * ★ 为什么不直接用 `keyof LayoutTier`：`LayoutTier` 里有 `button` 这个**对象**字段，
 *   `keyof` 会把它带进来，于是 `tier[field]` 的类型变成
 *   `number | { diameterPx… }`，后面每处都得再收窄一次。
 *   数值字段的名单本来就该与 `LAYOUT_LIMITS` 对齐（那边是唯一真源）。
 */
export type LayoutFieldKey = 'edgeMarginPx' | 'minGapPx' | 'fontSizePx' | 'targetCount';

/** 按钮参数的字段名 */
export type LayoutButtonFieldKey = 'diameterPx' | 'gapPx' | 'labelFontPx';

/** 三档的档位名（显式列出，保证遍历顺序稳定） */
export const LAYOUT_TIER_KEYS: readonly LayoutTierKey[] = ['mobile', 'tablet', 'desktop'];

/** 档位里的数值字段（显式列出，顺序即界面顺序） */
export const LAYOUT_FIELD_KEYS: readonly LayoutFieldKey[] = [
  'edgeMarginPx',
  'minGapPx',
  'fontSizePx',
  'targetCount',
];

/** 按钮里的数值字段 */
export const LAYOUT_BUTTON_FIELD_KEYS: readonly LayoutButtonFieldKey[] = ['diameterPx', 'gapPx', 'labelFontPx'];

/** 一次布局草稿的全部内容 */
export interface LayoutDraft {
  /** 三档布点参数（已净化） */
  layout: LayoutSettings;
  /** 手动列数覆盖（'auto' = 自动推导） */
  colsOverride: LayoutColsOverride;
}

/** 当前草稿；null = 没有未应用的修改 */
let draft: LayoutDraft | null = null;

/**
 * 深拷贝三档布局参数（含 button 子树）。
 *
 * ★ 必须深拷贝按钮那一层：`{ ...tier }` 只复制一层，`tier.button` 仍是同一个对象，
 *   改草稿里的按钮直径会**顺手改到全局默认值**（`DEFAULT_SETTINGS` 是共享的），
 *   于是「取消」根本取消不回去。
 * @param layout 原始布局设置
 */
export function cloneLayout(layout: LayoutSettings): LayoutSettings {
  return {
    mobile: { ...layout.mobile, button: { ...layout.mobile.button } },
    tablet: { ...layout.tablet, button: { ...layout.tablet.button } },
    desktop: { ...layout.desktop, button: { ...layout.desktop.button } },
  };
}

/**
 * 读「当前已保存的布局」（净化过的）。
 * 这是草稿的基线，也是「取消」要回到的地方。
 */
export function savedLayout(): LayoutDraft {
  const s = getSettings();
  return {
    layout: sanitizeLayoutSettings(s.layout),
    colsOverride: coerceColsOverride(s.layoutColsOverride),
  };
}

/**
 * 取当前草稿；没有未应用修改时返回**已保存值**（只读用）。
 */
export function currentDraft(): LayoutDraft {
  return draft ?? savedLayout();
}

/** 是否存在未应用的修改 */
export function isDirty(): boolean {
  return draft !== null;
}

/**
 * 对比两个布局草稿是否等价（字段逐个比，不用 JSON.stringify —— 键序不该影响结果）。
 * @param a 甲
 * @param b 乙
 */
export function sameLayout(a: LayoutDraft, b: LayoutDraft): boolean {
  if (a.colsOverride !== b.colsOverride) return false;
  for (const k of LAYOUT_TIER_KEYS) {
    for (const f of LAYOUT_FIELD_KEYS) {
      if (a.layout[k][f] !== b.layout[k][f]) return false;
    }
    for (const f of LAYOUT_BUTTON_FIELD_KEYS) {
      if (a.layout[k].button[f] !== b.layout[k].button[f]) return false;
    }
  }
  return true;
}

/**
 * 在草稿上做一次修改。
 *
 * 第一次修改时以**已保存值**为基线建立草稿；若改完与已保存值完全一致，
 * 草稿自动清空（「改了又改回去」不该还显示「有未应用的修改」）。
 *
 * @param mutate 修改函数（拿到可写的草稿副本，直接改）
 */
export function editDraft(mutate: (next: LayoutDraft) => void): void {
  const base = currentDraft();
  const next: LayoutDraft = { layout: cloneLayout(base.layout), colsOverride: base.colsOverride };
  mutate(next);
  draft = sameLayout(next, savedLayout()) ? null : next;
}

/**
 * 改某一档的某个数值字段。
 *
 * ★ 净化在**写入草稿时**就做（不是等渲染时）：草稿从建立那一刻起就一定是完整合法的，
 *   预览、应用、落库三条路拿到的都是同一份干净数据，不会出现「预览正常、应用后崩」。
 * @param tier 档位
 * @param field 字段名
 * @param value 原始值（可能来自输入框，是字符串）
 */
export function editTierField(tier: LayoutTierKey, field: LayoutFieldKey, value: unknown): void {
  editDraft((next) => {
    const fallback = DEFAULT_SETTINGS.layout[tier];
    const patch = field === 'edgeMarginPx'
      ? { edgeMarginPx: value }
      : field === 'minGapPx'
        ? { minGapPx: value }
        : field === 'fontSizePx'
          ? { fontSizePx: value }
          : { targetCount: value };
    next.layout[tier] = getPresetParams({ ...next.layout[tier], ...patch }, fallback);
  });
}

/**
 * 改某一档按钮里的某个数值字段。
 * @param tier 档位
 * @param field 按钮字段名
 * @param value 原始值
 */
export function editButtonField(tier: LayoutTierKey, field: LayoutButtonFieldKey, value: unknown): void {
  editDraft((next) => {
    const fallback = DEFAULT_SETTINGS.layout[tier];
    const patch = field === 'diameterPx'
      ? { diameterPx: value }
      : field === 'gapPx'
        ? { gapPx: value }
        : { labelFontPx: value };
    const tierNext = { ...next.layout[tier], button: { ...next.layout[tier].button, ...patch } };
    next.layout[tier] = getPresetParams(tierNext, fallback);
  });
}

/**
 * 改手动列数覆盖。
 * @param value 原始值（下拉框给的是字符串）
 */
export function editColsOverride(value: unknown): void {
  editDraft((next) => {
    next.colsOverride = coerceColsOverride(typeof value === 'number' ? value : Number(value));
  });
}

/**
 * 把某一档恢复成默认值（**只改草稿**，点应用才落库）。
 * @param tier 档位
 */
export function resetTierToDefault(tier: LayoutTierKey): void {
  editDraft((next) => {
    next.layout[tier] = defaultTierCopy(tier);
  });
}

/** 丢弃草稿，回到已保存值 */
export function discardDraft(): void {
  draft = null;
}

/**
 * 取出一份「可安全落库的布局」。
 *
 * 不在这里清空草稿：清理由调用方在确认应用成功后显式做（`discardDraft()`），
 * 因为观察期可能回滚，回滚后界面还要能显示回滚后的值。
 */
export function draftPatch(): { layout: LayoutSettings; layoutColsOverride: LayoutColsOverride } {
  const d = currentDraft();
  // 再净化一次：调用方拿到的必须一定是完整合法的布局（双保险，代价可忽略）
  return { layout: sanitizeLayoutSettings(d.layout), layoutColsOverride: d.colsOverride };
}
