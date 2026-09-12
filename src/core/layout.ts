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
 * 6. 带最小间距时，放不下的词会被截掉（返回值长度 = 纸上实际能放下的数量）。
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

  // 3) 生成落点（每个格子一个，放不下的直接不生成）
  const out: Placement[] = [];
  for (let i = 0; i < place; i += 1) {
    const cellIdx = cellIndexes[i] ?? i;
    const col = cellIdx % cols;
    const row = Math.floor(cellIdx / cols);
    const p: Placement = {
      x: clamp01(margin + (col + 0.5) * cellW + (random() - 0.5) * 2 * jitterAmpX),
      y: clamp01(margin + (row + 0.5) * cellH + (random() - 0.5) * 2 * jitterAmpY),
    };
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

  // 6) 避让区：落进「右下角按钮区」的点直接丢掉（放不下就少放几个，绝不压在按钮下面）
  if (!opts.avoidPx) return out;
  const canvas = opts.canvas ?? { width: 1, height: 1 };
  const avoid = toNormalizedRect(opts.avoidPx, canvas);
  return out.filter((p) => !pointInRect(p, avoid));
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
