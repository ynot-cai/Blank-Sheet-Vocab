import type { LayoutTier, PaperSettings } from './types';

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
 * 布点的默认边距（相对纸张宽度的比例，0.06 = 左右各留 6%）。
 *
 * ★ 单独抽成常量是为了诊断（阶段 M1）：调试页与 `PaperStage` 都要报「边距是多少」，
 *   值散在两个文件里迟早对不上。**注意**：改这个值会改变线上布点结果，
 *   M1 只读阶段**不许改**（手机端要降到 8px 是 M2 的事）。
 */
export const DEFAULT_GRID_MARGIN = 0.06;

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
  const margin = opts.margin ?? DEFAULT_GRID_MARGIN;
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

/* ═══════════════ 阶段 M2：手机端布点核心（按平均词宽定网格 + 真实碰撞检测）═══════════════
 *
 * 为什么另起一套（M1 诊断结论，都是实测数字）：
 *   旧算法把「最小中心距」定成 `最宽的那个词 + 字号 × 2.4`，再用它去夹列数：
 *     390×844、字号 28 时 minGapW = 196.4/390 = 0.5036 → cols = floor(0.88/0.5036) = 1
 *     → 一屏只剩 1 列 5~6 个词（`capacity=5`）。
 *   而且它给的是**中心距**（词宽 + 字号系数），对平均词宽 100px 的词表来说，
 *   196.4px 的中心距等于每对相邻词之间白白扔掉 96px。
 *
 * 新算法三件事：
 *   ① 列数按**平均词宽**定（`mean × 1.15 + minGapPx`），不再按最宽词；
 *   ② 每个词按**自己的宽度**在格子里找位置，放不下就换一个格子（试满为止）；
 *   ③ 每次落点都做**真实矩形碰撞检测**（长词塞不进格子时会被挡下来，不会叠字）。
 * 结果：长词不再拖垮整屏容量，而「不重叠 / 不进按钮区 / 不越界」由 ③ 硬保证。
 */

/** 一个单词在纸上的实际占位（像素） */
export interface WordMetrics {
  /** 渲染宽度（像素） */
  widthPx: number;
  /** 渲染高度（行高，像素） */
  heightPx: number;
}

/** 网格推导结果 */
export interface GridResult {
  /** 列数（按平均词宽定） */
  cols: number;
  /** 行数（按可放下的行数定，够了就停） */
  rows: number;
  /** 列数 × 行数 */
  capacity: number;
  /** 格宽（像素） */
  cellW: number;
  /** 格高（像素） */
  cellH: number;
}

/**
 * 算布点网格：列数按**平均词宽**定，行数按可用高度定，容量不够就加行。
 *
 * 与旧 `jitteredGrid` 的关键差别：这里不再用「最宽词」推导列数
 * （那正是 M1 查出来的瓶颈：最宽词 129.2px → 最小中心距 196.4px → 只能 1 列）。
 * @param opts.availableW 可用宽度（已扣边距，像素）
 * @param opts.availableH 可用高度（已扣边距与底部按钮带，像素）
 * @param opts.meanWidthPx 本批词的**平均**渲染宽度（像素）
 * @param opts.rowHeightPx 一行词的实际高度（像素，含上下内边距）
 * @param opts.minGapPx 相邻单词的最小空隙（像素）
 * @param opts.targetCount 期望一屏放几个词
 */
export function computeGrid(opts: {
  availableW: number;
  availableH: number;
  meanWidthPx: number;
  rowHeightPx: number;
  minGapPx: number;
  targetCount: number;
}): GridResult {
  const availableW = Math.max(1, opts.availableW);
  const availableH = Math.max(1, opts.availableH);
  // 格宽 = 平均词宽 × 1.15（15% 余量给比平均宽的词）+ 最小空隙
  const cellWidthPx = Math.max(1, opts.meanWidthPx * 1.15 + opts.minGapPx);
  // 格高 = 行高 + 最小空隙；**不能再低**于行高，否则上下两行的词直接叠在一起
  const cellHeightPx = Math.max(1, opts.rowHeightPx + opts.minGapPx);
  const maxCols = Math.max(1, Math.floor(availableW / cellWidthPx));
  const rowsPerCols = (cols: number): number => Math.max(1, Math.floor(availableH / cellHeightPx));
  const target = Math.max(1, Math.floor(opts.targetCount));

  let best: GridResult | null = null;
  for (let cols = 1; cols <= maxCols; cols += 1) {
    const rows = rowsPerCols(cols);
    const capacity = cols * rows;
    const candidate: GridResult = { cols, rows, capacity, cellW: availableW / cols, cellH: cellHeightPx };
    // 取「第一个满足目标」的（列数从小到大 = 先横着铺，不是竖列）
    if (capacity >= target) return candidate;
    if (!best || capacity > best.capacity) best = candidate;
  }
  if (best) return best;
  const cols = 1;
  const rows = rowsPerCols(cols);
  return { cols, rows, capacity: cols * rows, cellW: availableW, cellH: cellHeightPx };
}

/**
 * 底部圆形按钮带的高度（像素）。
 *
 * 由参数算出，不写死：
 *   按钮带 = 直径（圆）+ max(小字字号, 10) + 小字上下的空隙（12）
 *   再乘 3 是因为「带高」要覆盖「圆 + 小字 + 一点余量」，同时给布点留出
 *   与按钮之间的一条安全空隙（M1 实测：避让区画小了，词会压在按钮上）。
 * @param tier 当前档位的布局参数
 * @param safeAreaBottom 底部安全区（iPhone 横条，像素）
 */
export function controlBandHeight(tier: LayoutTier, safeAreaBottom = 0): number {
  const label = Math.max(tier.button.labelFontPx, 10);
  return tier.button.diameterPx * 3 + label + 12 + Math.max(0, safeAreaBottom);
}

/** layoutWords 的入参 */
export interface WordLayoutOptions {
  /** 单词的实际尺寸（像素），顺序与要上纸的词一致 */
  metrics: WordMetrics[];
  /** 纸张像素尺寸 */
  canvas: { width: number; height: number };
  /** 可用区域（像素，相对纸张左上角）：已扣边距、已扣底部按钮带 */
  area: { x: number; y: number; width: number; height: number };
  /** 网格（computeGrid 的结果） */
  grid: GridResult;
  /** 相邻单词的最小空隙（像素，碰撞检测用） */
  minGapPx: number;
  /** 随机种子：同一 seed 结果完全稳定，便于调试与续跑 */
  seed?: number;
  /** 抖动幅度与格宽的比例（0 = 完全对齐网格），默认 0.22 */
  jitterRatio?: number;
  /**
   * 要避开的像素矩形（纸张坐标）。给了就按**真实矩形**判交，
   * 而不是只判中心点（M1 实测：只判中心点时，词的一半仍会压在按钮上）。
   */
  avoidPx?: { x: number; y: number; width: number; height: number };
}

/** 两个矩形是否相交（留 gap 的间隙；边界相接不算相交） */
function rectsOverlap(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
  gap: number,
): boolean {
  return a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;
}

/**
 * 把一批词放进网格（**每个词按自己的宽度**找格子，带真实碰撞检测）。
 *
 * 返回的落点是**归一化坐标**（相对纸张），与旧的 `jitteredGrid` 一致，
 * 所以上层（会话存档、续跑）不用改数据结构。
 *
 * 保证（由构造方式硬保证，不靠概率）：
 * - 任意两个落点上的词矩形不相交（含 `minGapPx` 间隙）；
 * - 每个词的完整矩形都在 `area` 内（不越界）；
 * - 每个词的完整矩形都不与 `avoidPx`（底部按钮带）相交。
 * 代价：容量受「试格次数」限制；实在放不下的词会从末尾开始被丢掉
 * （调用方用返回长度当容量，与旧行为一致）。
 * @param opts 见 WordLayoutOptions
 */
export function layoutWords(opts: WordLayoutOptions): Placement[] {
  const { canvas, area, grid, metrics, minGapPx } = opts;
  if (metrics.length === 0 || area.width <= 0 || area.height <= 0) return [];
  const random = mulberry32(opts.seed ?? 1);
  const jitterRatio = Math.max(0, opts.jitterRatio ?? 0.22);
  // 抖动幅度不超过「格子里剩的余量」，避免把词抖出格外
  const maxJitterX = Math.max(0, Math.min(grid.cellW * jitterRatio, Math.max(0, grid.cellW - 1)));
  const maxJitterY = Math.max(0, Math.min(grid.cellH * jitterRatio, Math.max(0, grid.cellH - 1)));

  // 格子顺序打乱（避免总是从左上角开始，词分布更自然）
  const order = shuffledIndexes(grid.cols * grid.rows, random);
  const placed: { x: number; y: number; w: number; h: number }[] = [];
  const out: Placement[] = [];

  for (const idx of order) {
    if (out.length >= metrics.length) break;
    const col = idx % grid.cols;
    const row = Math.floor(idx / grid.cols);
    // ★ 不做「列间交错（stagger）」：交错会让相邻两列的词落进同一个水平带，
    //   而它们既不在同一行也不在同一列 —— 碰撞检测管不到，屏幕上就出现
    //   「明明配置了 8px 空隙，实际只有 5.6px」这种量得出来、却查不到原因的缝隙。
    //   视觉上的自然感交给「格子顺序打乱 + 格内抖动」，不靠交错。
    const cellLeft = area.x + col * grid.cellW;
    const cellTop = area.y + row * grid.cellH;
    const metric = metrics[out.length];
    if (!metric) break;
    // 这个格子放不下整块词（越出可用高度）→ 换下一格，而不是硬塞
    if (cellTop < area.y || cellTop + metric.heightPx > area.y + area.height) continue;
    // 词在格内随机偏移（偏移空间 = 格宽 − 词宽）
    const slackX = Math.max(0, grid.cellW - metric.widthPx);
    const slackY = Math.max(0, grid.cellH - metric.heightPx);
    const jitterX = (random() - 0.5) * 2 * Math.min(maxJitterX, slackX / 2);
    const jitterY = (random() - 0.5) * 2 * Math.min(maxJitterY, slackY / 2);
    const rect = {
      x: cellLeft + slackX / 2 + jitterX,
      y: cellTop + slackY / 2 + jitterY,
      w: metric.widthPx,
      h: metric.heightPx,
    };

    // ★ ① 夹回可用区域（不越界）：整块矩形都必须在 area 内
    rect.x = Math.min(Math.max(rect.x, area.x), area.x + area.width - rect.w);
    rect.y = Math.min(Math.max(rect.y, area.y), area.y + area.height - rect.h);

    // ★ ② 不能进底部按钮带
    if (opts.avoidPx && rectsOverlap(rect, { ...opts.avoidPx, w: opts.avoidPx.width, h: opts.avoidPx.height }, 0)) {
      continue; // 这个格子被按钮占了 → 换下一个空格（不是把词丢掉）
    }
    // ★ ③ 真实碰撞检测 + **推开**（不是直接换格子）。
    //   为什么必须推开：格高只比词高多出 minGap（手机档 44.8 → 52.6），
    //   抖动几次就会压到邻居；直接 `continue` 换格子的话，格子被跳过几次就少放几个词
    //   （M2 实测：目标 16 只放得下 13）。推开是确定性的，不靠运气。
    const resolved = resolveOverlaps(rect, placed, area, minGapPx);
    if (!resolved) continue; // 这个格子真的放不下 → 换下一个空格
    placed.push(resolved);
    out.push({
      x: clamp01((resolved.x + resolved.w / 2) / Math.max(1, canvas.width)),
      y: clamp01((resolved.y + resolved.h / 2) / Math.max(1, canvas.height)),
    });
  }
  return out;
}

/** 一个已确定的矩形（像素，纸张坐标） */
interface PixelRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * 把一个候选矩形从已放好的词中间「推开」，推到不重叠为止。
 *
 * 规则（简单、确定、可复现）：
 * 1. 与谁相交，就把自己移到它**下方** `minGap` 处；下方出界就移到**上方**；
 * 2. 上下都出界 → 这个格子放不下，返回 null；
 * 3. 每次移动后再夹回可用区域，并重新检查（最多 `maxRounds` 轮）。
 *
 * 为什么要这样而不是「相交就换格子」：格子数有限（手机档 2 列 × 12 行），
 * 换几次就没格子了，用户看到的就是「明明还有空白，却少放了几个词」。
 * @param start 候选矩形
 * @param placed 已经放好的矩形
 * @param area 可用区域
 * @param gap 最小空隙
 * @param maxRounds 最多推几轮
 */
function resolveOverlaps(
  start: PixelRect,
  placed: PixelRect[],
  area: { x: number; y: number; width: number; height: number },
  gap: number,
  maxRounds = 8,
): PixelRect | null {
  let rect: PixelRect = { ...start };
  for (let round = 0; round < maxRounds; round += 1) {
    const hit = placed.find((p) => rectsOverlap(rect, p, gap));
    if (!hit) return rect;
    const below = hit.y + hit.h + gap;
    const above = hit.y - rect.h - gap;
    const canBelow = below + rect.h <= area.y + area.height + 0.001;
    const canAbove = above >= area.y - 0.001;
    if (canBelow) rect = { ...rect, y: below };
    else if (canAbove) rect = { ...rect, y: above };
    else return null;
  }
  // 推了 maxRounds 轮还在撞 → 判定放不下
  return placed.some((p) => rectsOverlap(rect, p, gap)) ? null : rect;
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

/**
 * 词行的行高系数（与 CSS 实际生效的 line-height 对应）。
 *
 * ★ 值必须等于 `global.css` 里 `body { line-height: 1.6 }`：
 *   `.paper-word` 自己没有写 line-height，所以它继承 body 的 1.6。
 *   原来这里写 1.45（想要的 44px 热区），而 CSS 实际是 1.6 ——
 *   两者差 `字号 × 0.15`（16px 字号下 2.4px）。M2 实测后果：
 *   算法以为一行词高 39.2，实际渲染 41.6，每行少算 2.4px，
 *   屏幕上配置 8px 的空隙只剩 5.6px（probe 直接量出来）。
 *   改常量而不是改 CSS：CSS 一动会连带影响桌面与 `.paper-meaning` 的行距。
 *   改这个值之前先用调试页量一次 `wordMetrics.lineHeight`。
 */
export const WORD_LINE_HEIGHT_RATIO = 1.6;

/** 词行上下内边距之和（与 paper.css 的 .paper-word padding 对应） */
export const WORD_ROW_PADDING_PX = 12;

/**
 * 单词元素的**点击热区内边距**（与 paper.css 的 `.paper-word` padding 对应）。
 *
 * ★ 为什么碰撞检测必须把它算进去（M2 实测踩到）：
 *   canvas 的 `measureText` 量的是**文字**宽度，而真正占位置的是
 *   `.paper-word` 这个带 padding 的元素。手机上 padding 是 `8px 4px`，
 *   也就是每个词的矩形比文字宽 **8px**、高 **16px**。
 *   不算进去的话，屏幕上词与词的间距会比配置的 minGap 小 8px
 *   （实测：配置 12px，DOM 量出来 6.76px）。
 *   桌面 padding 是 `6px 2px`（手机媒体查询只改手机）。
 */
export const WORD_H_PADDING_PHONE_PX = 8;
export const WORD_V_PADDING_PHONE_PX = 16;
export const WORD_H_PADDING_DESKTOP_PX = 4;
export const WORD_V_PADDING_DESKTOP_PX = 12;

/**
 * 一个词在纸上**真正占的矩形**（像素，含点击热区内边距）。
 * @param textWidthPx canvas 量出的文字宽度
 * @param textHeightPx 文字行盒高度（行高 × 字号）
 * @param isPhone 是否手机（手机的 padding 更大）
 */
export function wordBoxPx(
  textWidthPx: number,
  textHeightPx: number,
  isPhone: boolean,
): { widthPx: number; heightPx: number } {
  return {
    widthPx: Math.max(0, textWidthPx) + (isPhone ? WORD_H_PADDING_PHONE_PX : WORD_H_PADDING_DESKTOP_PX),
    heightPx: Math.max(0, textHeightPx) + (isPhone ? WORD_V_PADDING_PHONE_PX : WORD_V_PADDING_DESKTOP_PX),
  };
}

/**
 * 一次布点的**自述信息**（只读诊断数据，不参与任何计算）。
 *
 * 用途：手机端布局诊断（阶段 M1）要回答「算法到底按什么在算」——
 * 字号、最宽词、最小中心距、网格行列数、被按钮避让吃掉的格子数。
 * 这些数字原本只存在于函数内部，靠读代码反推容易算错，
 * 所以在这里定一份结构：`PaperStage.computePlacements()` 布完点后写一份快照，
 * 调试页的 `window.__layoutProbe()` 把它附在测量结果里一起输出。
 */
export interface LayoutInfo {
  /** 实际参与布点的单词数 */
  wordCountRequested: number;
  /** 避让后真正放得下的数量（= jitteredGrid 返回值长度，≤ wordCountRequested） */
  capacity: number;
  /** 纸张像素尺寸 */
  paperW: number;
  paperH: number;
  /** 纸张在视口里的居中偏移 */
  sheetOffsetX: number;
  sheetOffsetY: number;
  /** 布点用的字号（手机上含 phoneFontScale 放大系数） */
  fontSize: number;
  /** 设备形态 phone / tablet / desktop */
  deviceKind: string;
  /** 本批词里渲染最宽的一个（像素，canvas measureText 实测） */
  widestWordPx: number;
  /** 本批词的平均宽度（像素，canvas measureText 实测） */
  avgWordPx: number;
  shortestWordLen: number;
  longestWordLen: number;
  /** 横向 / 纵向最小中心距（像素，spacingBudget 的输出） */
  gapX: number;
  gapY: number;
  /** 避让按钮区时向外扩的半个词宽 / 半个词行高（像素） */
  padX: number;
  padY: number;
  /** 网格行列数 */
  cols: number;
  rows: number;
  /** 不考虑避让时的容量（cols × rows） */
  gridCapacity: number;
  /** 因为落进按钮避让区而被跳过的格子数 */
  cellsSkippedByAvoid: number;
  /** 布点边距（归一化，0.06 = 纸张宽度的 6%） */
  marginNorm: number;
  aspect: number;
  /** 实际落点数 */
  placements: number;
  /**
   * 以下三个只有**手机**（M2 新算法）会填：
   * - `algorithm`：本次用的是哪套布点（phone-grid / legacy-jitter）
   * - `wordsPerRow`：实际每行几个词（= ceil(容量 ÷ 行数)）
   * - `phoneArea`：可用区域像素（扣掉边距与底部按钮横带之后的那块）
   */
  algorithm?: 'phone-grid' | 'legacy-jitter';
  wordsPerRow?: number;
  phoneArea?: { x: number; y: number; width: number; height: number };
}

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
