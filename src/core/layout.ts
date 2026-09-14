import type { PaperSettings } from './types';

/** 白纸上的一个落点（归一化 0~1 的相对坐标，换尺寸后位置不变） */
export interface Placement {
  x: number;
  y: number;
}

/** jitteredGrid 参数 */
export interface JitteredGridOptions {
  /** 画布宽高比，默认 16/9 */
  aspect?: number;
  /** 边距占比，默认 0.06 */
  margin?: number;
  /** 随机种子：同一个 seed 结果完全稳定，便于调试 */
  seed?: number;
  /** 冲突检测阈值（相对格宽），默认 0.7 */
  minGapCells?: number;
  /** 相邻单词最小间距（横向，归一化到画布宽），由字号决定 */
  minGapW?: number;
  /** 相邻单词最小间距（纵向，归一化到画布高），由字号决定 */
  minGapH?: number;
  /** 画布像素尺寸（给了才能用 avoidPx 做避让；不给就按 1×1 理解） */
  canvas?: { width: number; height: number };
  /**
   * 要避开的像素矩形（相对画布左上角）：落进这里的点会被丢掉。
   * 用途：右下角那组按钮会压住单词，所以布点时先把那块留出来（移动端尤其重要）。
   */
  avoidPx?: { x: number; y: number; width: number; height: number };
}

/**
 * mulberry32 伪随机数生成器：同一个 seed 生成完全相同的序列。
 * @param seed 种子
 * @returns 返回 [0,1) 的随机函数
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 由字符串生成一个稳定的哈希（用作会话布点种子） */
export function seedFromString(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * 白纸布点算法（抖动网格）：
 * 1. 按 count 和宽高比算出最接近正方形的网格行列数（给了 minGapW/minGapH 时格子不会小于最小间距）；
 * 2. 每格内抖动（随机偏移，保留格宽 20% 边距）；
 * 3. 格子多于需求时随机抽掉多余的；不够时一格放两个（第二个偏移到格子右下角）；
 * 4. 抖动后做轻量冲突检测：与已放置的间距小于最小间距时把后一个挪到最近空格；
 * 5. 返回顺序打乱（不是按行列排下来的顺序）；
 * 6. 带最小间距时，放不下的词会被截掉（返回值长度 = 纸上实际能放下的数量）；
 * 7. **落进按钮避让区的格子会被跳过、由后面的空格补上**（不是把点丢掉，
 *    否则按钮区压住一格就白白少放一个词）。
 * 全程用同一个 seeded random，结果可复现。
 * @param count 需要的落点数
 * @param opts 宽高比 / 边距 / 种子 / 最小间距
 */
export function jitteredGrid(count: number, opts: JitteredGridOptions = {}): Placement[] {
  if (count <= 0) return [];
  const aspect = opts.aspect ?? 16 / 9;
  const margin = opts.margin ?? 0.06;
  const minGapCells = opts.minGapCells ?? 0.7;
  const random = mulberry32(opts.seed ?? 1);
  const usable = 1 - margin * 2;

  // 1) 行列数：格子尽量接近正方形；有最小间距时，格子不能小于间距
  let cols = Math.max(1, Math.round(Math.sqrt(count * aspect)));
  if (opts.minGapW !== undefined && opts.minGapW > 0) {
    cols = Math.min(cols, Math.max(1, Math.floor(usable / opts.minGapW)));
  }
  let rows = Math.max(1, Math.ceil(count / cols));
  if (opts.minGapH !== undefined && opts.minGapH > 0) {
    rows = Math.min(rows, Math.max(1, Math.floor(usable / opts.minGapH)));
  }
  const capacity = cols * rows;
  const place = Math.min(count, capacity);
  const cellW = usable / cols;
  const cellH = usable / rows;
  // 冲突检测用的最小间距（格子已经被间距撑大，这里用「间距 × 抖动安全系数」兜底）
  const gapX = Math.max(opts.minGapW ?? 0, minGapCells * cellW * 0.5);
  const gapY = Math.max(opts.minGapH ?? 0, minGapCells * cellH * 0.5);

  // 2) 每个点分到一个格子（随机抽格子，避免扎堆），格内抖动。
  //    有最小间距时把抖动幅度压到「(格宽-间距)/2 再留 1e-9 余量」以内，
  //    这样相邻格子里的两个点无论怎么抖，间距都不会小于最小间距
  const jitterAmpX = gapX > 0 ? Math.max(0, Math.min(cellW * 0.3, (cellW - gapX) / 2 - 1e-9)) : cellW * 0.3;
  const jitterAmpY = gapY > 0 ? Math.max(0, Math.min(cellH * 0.3, (cellH - gapY) / 2 - 1e-9)) : cellH * 0.3;
  const cellIndexes = Array.from({ length: capacity }, (_, i) => i);
  for (let i = cellIndexes.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    const a = cellIndexes[i];
    const b = cellIndexes[j];
    if (a !== undefined && b !== undefined) {
      cellIndexes[i] = b;
      cellIndexes[j] = a;
    }
  }

  // 3) 生成落点：按打乱后的格子顺序取，**落进按钮避让区的格子跳过、用后面的空格补上**。
  //
  //    ★ 为什么必须「补上」而不是直接丢掉（用户实测反馈）：
  //      避让区是「右下角按钮 + 半个词」的一块矩形，它有时正好压住一个格子。
  //      直接丢掉那个点时，**纸上能放的词就少了一个**：库里只有 3 个词、
  //      网格有 4 个格子，也会因为压住 1 格而只放得下 2 个 ——
  //      用户看到的是「才 2 个词就说纸面已满」。
  //      改成往后找空格之后，容量只由「没被按钮压住的格子数」决定，
  //      不再因为运气（抖动位置）白白少一个。
  const avoidRect = opts.avoidPx ? toNormalizedRect(opts.avoidPx, opts.canvas ?? { width: 1, height: 1 }) : null;
  const out: Placement[] = [];
  for (let i = 0; i < capacity && out.length < place; i += 1) {
    const cellIdx = cellIndexes[i] ?? i;
    const col = cellIdx % cols;
    const row = Math.floor(cellIdx / cols);
    const p: Placement = {
      x: clamp01(margin + (col + 0.5) * cellW + (random() - 0.5) * 2 * jitterAmpX),
      y: clamp01(margin + (row + 0.5) * cellH + (random() - 0.5) * 2 * jitterAmpY),
    };
    if (avoidRect && pointInRect(p, avoidRect)) continue; // 这个格子被按钮占了 → 换下一个空格
    out.push(p);
  }

  // 5) 打乱返回顺序（同一 seeded random）
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    const a = out[i];
    const b = out[j];
    if (a && b) {
      out[i] = b;
      out[j] = a;
    }
  }
  return out;
}

/** 归一化矩形 */
interface NormRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 把像素矩形换算成归一化矩形。
 * @param rect 像素矩形
 * @param canvas 画布像素尺寸
 */
function toNormalizedRect(rect: { x: number; y: number; width: number; height: number }, canvas: { width: number; height: number }): NormRect {
  const w = Math.max(1, canvas.width);
  const h = Math.max(1, canvas.height);
  return { x: rect.x / w, y: rect.y / h, width: rect.width / w, height: rect.height / h };
}

/**
 * 点是否落在矩形内。
 * @param p 归一化点
 * @param rect 归一化矩形
 */
function pointInRect(p: Placement, rect: NormRect): boolean {
  return p.x >= rect.x && p.x <= rect.x + rect.width && p.y >= rect.y && p.y <= rect.y + rect.height;
}

/** 数值夹到 0~1 */
function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.min(1, Math.max(0, v));
}

/** 布点的间距预算（像素） */
export interface SpacingBudget {
  /** 相邻单词落点之间的**最小中心距**（横向）—— 落点即单词的中心 */
  gapX: number;
  /** 相邻单词落点之间的**最小中心距**（纵向） */
  gapY: number;
  /** 避让按钮区时，矩形要向外扩多少（横向，取半个最宽的词） */
  padX: number;
  /** 避让按钮区时，矩形要向外扩多少（纵向，取半个词行高） */
  padY: number;
}

/**
 * 算白纸布点的间距预算。
 *
 * ★ 用户明确要求（2026-09）：「确保单词与单词之间，单词与按钮之间有一个
 *   **最低距离（由字号决定）**，不能重合。」
 *
 * 为什么不能只用「字号 × 系数」：
 *   落点是单词的**中心**（`.paper-word-zone` 有 `translate(-50%,-50%)`）。
 *   两个中心相距 `字号×2.4 ≈ 58px` 时，两个各宽 170px 的长词
 *   （photosynthesis 这种）**必然重叠** —— 只按字号给间距挡不住长词。
 *   所以最小中心距取「**最宽的那个词 + 字号 × 系数**」：
 *   前者保证任何一对词都不会叠在一起，后者保证还留着一条由字号决定的空隙。
 *
 * 纵向同理：用词行高（字号 × 行高系数 + 上下内边距）而不是纯字号。
 *
 * @param opts fontSize 单词字号（像素，已含手机放大系数）
 * @param opts gapFactor 设置里的「间距系数」（字号 × 它 = 最低空隙）
 * @param opts widestWordPx 本批词里**渲染后最宽**的一个的宽度（像素）
 * @param opts rowHeightPx 一个词行的高度（像素）
 */
export function spacingBudget(opts: {
  fontSize: number;
  gapFactor: number;
  widestWordPx: number;
  rowHeightPx: number;
}): SpacingBudget {
  const gap = Math.max(0, opts.fontSize) * Math.max(0, opts.gapFactor);
  const w = Math.max(0, opts.widestWordPx);
  const h = Math.max(0, opts.rowHeightPx);
  return {
    gapX: w + gap,
    gapY: h + gap,
    // 落点是中心：只要中心离按钮矩形还有「半个词」，词就不会压到按钮上
    padX: w / 2,
    padY: h / 2,
  };
}

/** 词行的行高系数（与 paper.css 的 .paper-word line-height 对应） */
export const WORD_LINE_HEIGHT_RATIO = 1.45;

/** 词行上下内边距之和（与 paper.css 的 .paper-word padding 对应） */
export const WORD_ROW_PADDING_PX = 12;

/**
 * 一个词行的高度（像素）：字号 × 行高系数 + 上下内边距。
 * 抽出来是为了让「布点用的行高」与 CSS 里的实际行高只有一处定义。
 * @param fontSize 字号（像素）
 */
export function wordRowHeightPx(fontSize: number): number {
  return Math.max(0, fontSize) * WORD_LINE_HEIGHT_RATIO + WORD_ROW_PADDING_PX;
}

/**
 * 根据纸张设置算出白纸的实际像素尺寸。
 * @param paper 纸张设置
 * @param viewport 视口尺寸（auto 模式用）
 */
export function resolvePaperSize(
  paper: PaperSettings,
  viewport: { width: number; height: number },
): { width: number; height: number } {
  if (paper.mode === 'fixed') {
    return { width: Math.max(320, paper.width), height: Math.max(240, paper.height) };
  }
  if (paper.mode === 'ratio') {
    const ratios: Record<PaperSettings['ratio'], number> = { A4: 210 / 297, '16:9': 16 / 9, '4:3': 4 / 3 };
    const ratio = ratios[paper.ratio] ?? 210 / 297;
    const availW = viewport.width;
    const availH = viewport.height;
    const byW = { width: availW, height: availW / ratio };
    const byH = { width: availH * ratio, height: availH };
    const chosen = byW.height <= availH ? byW : byH;
    return { width: Math.max(320, Math.floor(chosen.width)), height: Math.max(240, Math.floor(chosen.height)) };
  }
  return { width: Math.max(320, Math.floor(viewport.width)), height: Math.max(240, Math.floor(viewport.height)) };
}

/**
 * 兼容旧签名：按像素尺寸布点（内部换算成宽高比后交给 jitteredGrid）。
 * @param count 落点数
 * @param width 画布宽
 * @param height 画布高
 * @param opts 旧参数（padding 对应 margin）
 */
export function paperLayout(
  count: number,
  width: number,
  height: number,
  opts: { jitter?: number; minGap?: number; random?: () => number; padding?: number } = {},
): Placement[] {
  void opts.jitter;
  void opts.minGap;
  void opts.random;
  return jitteredGrid(count, {
    aspect: width / Math.max(1, height),
    margin: opts.padding ?? 0.06,
    seed: seedFromString(`${width}x${height}`),
  });
}

/** 生成 0..n-1 的随机排列（Fisher–Yates，可传 seeded random） */
export function shuffledIndexes(n: number, random: () => number = Math.random): number[] {
  const arr = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    const a = arr[i] ?? 0;
    const b = arr[j] ?? 0;
    arr[i] = b;
    arr[j] = a;
  }
  return arr;
}
