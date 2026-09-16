/**
 * 布局测量核心（阶段 M1：只用机器数字说话）。
 *
 * 为什么要有这个文件：
 *   手机上一屏只显示 10~12 个单词，而「哪里浪费了空间」靠肉眼和形容词是查不出来的
 *   （之前出现过「AI 说完成了但实际没生效」）。所以这里把真实 DOM 的
 *   `getBoundingClientRect()` 全部量一遍，输出一份**可断言**的 JSON，
 *   由 `probeLayout.mjs` 无头浏览器抓走去判 PASS/FAIL。
 *
 * 三条纪律：
 * 1. **只测不改**：本文件不参与任何布点计算，只读 DOM 与诊断快照；
 * 2. **数字优先**：每一项要么是数，要么是能定位问题的列表（如「哪几对重叠」）；
 * 3. **真实测量**：所有坐标来自 `getBoundingClientRect()`，不许用算法参数反推。
 */
import type { LayoutInfo } from '../core/layout';

/** 一个矩形（视口坐标，像素） */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 测量到的单词盒子 */
export interface WordBox {
  x: number;
  y: number;
  w: number;
  h: number;
  /** 盒子中心（聚类成行列用） */
  cx: number;
  cy: number;
  /** 单词本身（正常只有一个；同一元素里出现多行就是数据异常） */
  text: string;
}

/** 两点之间的最小边缘距离（负数 = 重叠） */
export interface GapPair {
  from: string;
  to: string;
  gapX: number;
  gapY: number;
}

/** 给界面/报告用的算法自述信息（结构定义在 core/layout.ts，与算法放在一起） */
export type { LayoutInfo } from '../core/layout';

/** `window.__layoutProbe()` 的返回结构 */
export interface LayoutProbeResult {
  viewport: [number, number];
  /** 设备像素比 / 视口里的单词元素数 */
  dpr: number;
  wordCount: number;
  columns: number;
  rows: number;
  /** 跨簇的盒子数（列/行聚类可疑时会 > 0） */
  crossClusterBoxes: number;
  /** 重叠对数（必须 0） */
  overlapPairs: number;
  /** 重叠的每一对（失败时给具体是哪几对） */
  overlapList: GapPair[];
  /** 与按钮避让区相交的词数（必须 0） */
  buttonOverlaps: number;
  /** 与按钮避让区相交的具体词 */
  buttonOverlapList: string[];
  /** 超出视口的词数（必须 0） */
  outOfBounds: number;
  /** 超出纸张容器的词数（必须 0） */
  outOfSheet: number;
  /** 越界的具体词 */
  outOfBoundsList: string[];
  /** 最小边缘间距（正数 = 实际空隙；负数 = 重叠了多少像素） */
  minGap: number;
  /** 造成最小间距的那一对 */
  minGapPair: GapPair | null;
  /** 前若干个最小的间距（排查用） */
  smallestGaps: GapPair[];
  boxes: WordBox[];
  avoidRects: ({ label: string } & Rect)[];
  /** 算法自述信息（可能为 null：还没布点） */
  layout: LayoutInfo | null;
  /**
   * 算法真正吐出来的**归一化落点**（调试页写入；核对「报告 vs DOM」用）。
   *
   * 为什么诊断要带上它：如果 DOM 里单词的横向铺开程度与 `layout.cols` 对不上，
   * 那就不是布局算法的问题，而是「谁在什么时候用哪份设置布的」对不上——
   * 这类问题只看最终坐标永远查不出来。
   */
  placements: { id: string; x: number; y: number }[];
  /** 第一个单词元素的实际尺寸与计算样式（排查矩形对不上） */
  wordMetrics: {
    wordH: number;
    wordW: number;
    fontSize: string;
    lineHeight: string;
    padding: string;
    rowH: number;
  } | null;
}

/** 分组容差（像素）：中心差小于它的算同一行/列 */
const CLUSTER_TOLERANCE = 20;
/** `smallestGaps` 最多保留多少条 */
const GAP_LIST_LIMIT = 10;

/**
 * 把盒子按中心坐标聚成行列。
 * 为什么要聚类而不是直接数：落点是抖动过的，同一列的中心 x 并不完全相等，
 * 但差距远小于列间距（手机上一列约 130~190px），用 20px 容差能稳定分开。
 * @param boxes 盒子
 * @param axis 按哪个中心聚类
 */
function clusterCount(boxes: WordBox[], axis: 'cx' | 'cy'): { groups: WordBox[][]; cross: number } {
  const sorted = [...boxes].sort((a, b) => a[axis] - b[axis]);
  const groups: WordBox[][] = [];
  for (const box of sorted) {
    const last = groups[groups.length - 1];
    const ref = last?.[0];
    if (last && ref && box[axis] - ref[axis] <= CLUSTER_TOLERANCE) last.push(box);
    else groups.push([box]);
  }
  // 「跨簇」= 既和前一组沾边、又和后一组沾边（容差太大或排版异常的信号）
  let cross = 0;
  for (let i = 1; i < sorted.length - 1; i += 1) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    const next = sorted[i + 1];
    if (!prev || !cur || !next) continue;
    const nearPrev = cur[axis] - prev[axis] <= CLUSTER_TOLERANCE;
    const nearNext = next[axis] - cur[axis] <= CLUSTER_TOLERANCE;
    if (nearPrev && nearNext) cross += 1;
  }
  return { groups, cross };
}

/**
 * 两个盒子的边缘距离。
 * 定义：`gapX` = 横向缝隙（A 右边缘到 B 左边缘），`gapY` = 纵向缝隙。
 * 任一方向为负说明该方向重叠；**两个方向都为负才是真的矩形相交**。
 * @param a 盒子 A
 * @param b 盒子 B
 */
function edgeGap(a: WordBox, b: WordBox): { gapX: number; gapY: number } {
  const dx = Math.max(a.x, b.x) - Math.min(a.x + a.w, b.x + b.w);
  const dy = Math.max(a.y, b.y) - Math.min(a.y + a.h, b.y + b.h);
  return { gapX: Math.round(dx * 100) / 100, gapY: Math.round(dy * 100) / 100 };
}

/** 两个矩形是否相交（边界相接不算） */
function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** 盒子的短标签（报告里用，别把整篇文字塞进去） */
function shortLabel(box: WordBox): string {
  return box.text.length > 18 ? `${box.text.slice(0, 18)}…` : box.text;
}

/** 取调试页挂上的算法自述信息（没挂就返回 null） */
function readLayoutInfo(): LayoutInfo | null {
  const info = window.__layoutInfo;
  return info ?? null;
}

/**
 * 采集一次测量结果（真实 DOM，同步执行）。
 *
 * 依赖两处「测量接口」：
 * - 单词元素：`[data-word-box]`（由 PaperStage 打在落点容器 `.paper-word-zone` 上）；
 * - 算法自述：`window.__layoutInfo`（由调试页在布点后写入）。
 * 两者都是只增不改变行为的诊断设施。
 * @param avoidRects 要检查的避让区（视口坐标；调试页传入算法真正用的那个矩形）
 */
export function collectLayoutProbe(avoidRects: ({ label: string } & Rect)[]): LayoutProbeResult {
  const nodes = Array.from(document.querySelectorAll<HTMLElement>('[data-word-box]'));
  const boxes: WordBox[] = [];
  for (const el of nodes) {
    // ★ 量 `.paper-word-row`（单词那一行）而不是整个落点容器：
    //   容器里还有「词下中文意思」，它可能显示、也可能隐藏，
    //   而布点算法算的是**单词**的矩形。量容器会让「隐藏的意思」凭空多算高度，
    //   所有间距都被高估（M2 实测：配置 12px 的间隙被量成 6.7px）。
    const target = el.querySelector<HTMLElement>('.paper-word-row') ?? el;
    const r = target.getBoundingClientRect();
    // 隐藏元素（记忆环节用 display:none 藏词）尺寸为 0，不算数
    if (r.width <= 0 || r.height <= 0) continue;
    boxes.push({
      x: Math.round(r.left * 100) / 100,
      y: Math.round(r.top * 100) / 100,
      w: Math.round(r.width * 100) / 100,
      h: Math.round(r.height * 100) / 100,
      cx: Math.round((r.left + r.width / 2) * 100) / 100,
      cy: Math.round((r.top + r.height / 2) * 100) / 100,
      text: (el.textContent ?? '').trim().replace(/\s+/g, ' '),
    });
  }

  const cols = clusterCount(boxes, 'cx');
  const rows = clusterCount(boxes, 'cy');

  // 两两求缝隙：相交算重叠，其余进候选池取最小
  const gaps: GapPair[] = [];
  const overlapList: GapPair[] = [];
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const a = boxes[i];
      const b = boxes[j];
      if (!a || !b) continue;
      const { gapX, gapY } = edgeGap(a, b);
      const pair: GapPair = { from: shortLabel(a), to: shortLabel(b), gapX, gapY };
      if (gapX < 0 && gapY < 0) overlapList.push(pair);
      // 只有「同一行或同一列」的邻居才谈得上最小间距（对角线距离没有意义）
      else if (Math.abs(a.cy - b.cy) <= CLUSTER_TOLERANCE || Math.abs(a.cx - b.cx) <= CLUSTER_TOLERANCE) {
        gaps.push(pair);
      }
    }
  }
  gaps.sort((p, q) => Math.max(p.gapX, p.gapY) - Math.max(q.gapX, q.gapY));
  const best = gaps[0] ?? null;
  const minGap = best ? Math.round(Math.max(best.gapX, best.gapY) * 100) / 100 : 0;

  // 单词元素自身的尺寸快照（排查「算法算的矩形与 DOM 实际尺寸对不上」用）
  const firstBox = nodes[0];
  const wordEl = firstBox?.querySelector<HTMLElement>('.paper-word') ?? null;
  const wordRect = wordEl?.getBoundingClientRect() ?? null;
  const wordMetricsSnapshot = wordRect
    ? {
        wordH: Math.round(wordRect.height * 100) / 100,
        wordW: Math.round(wordRect.width * 100) / 100,
        fontSize: wordEl ? getComputedStyle(wordEl).fontSize : '',
        lineHeight: wordEl ? getComputedStyle(wordEl).lineHeight : '',
        padding: wordEl ? getComputedStyle(wordEl).padding : '',
        rowH: firstBox ? Math.round((firstBox.querySelector('.paper-word-row')?.getBoundingClientRect().height ?? 0) * 100) / 100 : 0,
      }
    : null;

  // 越界与避让区
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const sheet = document.querySelector<HTMLElement>('.paper-sheet')?.getBoundingClientRect() ?? null;
  const outOfBoundsList: string[] = [];
  let outOfSheet = 0;
  for (const b of boxes) {
    if (b.x < -0.5 || b.y < -0.5 || b.x + b.w > vw + 0.5 || b.y + b.h > vh + 0.5) {
      outOfBoundsList.push(`${shortLabel(b)}@${Math.round(b.x)},${Math.round(b.y)}`);
    }
    if (sheet) {
      const inside =
        b.x >= sheet.left - 0.5 &&
        b.y >= sheet.top - 0.5 &&
        b.x + b.w <= sheet.right + 0.5 &&
        b.y + b.h <= sheet.bottom + 0.5;
      if (!inside) outOfSheet += 1;
    }
  }
  const buttonOverlapList: string[] = [];
  for (const b of boxes) {
    for (const ar of avoidRects) {
      if (rectsIntersect({ x: b.x, y: b.y, width: b.w, height: b.h }, ar)) {
        buttonOverlapList.push(`${shortLabel(b)} ∩ ${ar.label}`);
        break;
      }
    }
  }

  return {
    viewport: [vw, vh],
    dpr: Math.round((window.devicePixelRatio || 1) * 100) / 100,
    wordCount: boxes.length,
    columns: cols.groups.length,
    rows: rows.groups.length,
    crossClusterBoxes: Math.max(cols.cross, rows.cross),
    overlapPairs: overlapList.length,
    overlapList: overlapList.slice(0, 20),
    buttonOverlaps: buttonOverlapList.length,
    buttonOverlapList,
    outOfBounds: outOfBoundsList.length,
    outOfSheet,
    outOfBoundsList,
    minGap,
    minGapPair: best,
    smallestGaps: gaps.slice(0, GAP_LIST_LIMIT),
    boxes,
    avoidRects,
    layout: readLayoutInfo(),
    placements: window.__layoutPlacements ?? [],
    wordMetrics: wordMetricsSnapshot,
  };
}

/**
 * 测量一次，并把结果写到两个地方（`probeLayout.mjs` 抓 `<pre id="probe-result">`）。
 * @param avoidRects 要检查的避让区（视口坐标）
 */
export function runLayoutProbe(avoidRects: ({ label: string } & Rect)[] = []): LayoutProbeResult {
  const result = collectLayoutProbe(avoidRects);
  // 控制台一份：人肉打开调试页时直接看控制台更快
  console.log('__LAYOUT_PROBE__ = ' + JSON.stringify(result));
  const pre = document.getElementById('probe-result');
  if (pre) {
    // 必须转义：JSON 里的 < > & 会被无头浏览器 --dump-dom 抓成 HTML 标签
    pre.textContent = JSON.stringify(result, null, 2)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }
  return result;
}

/**
 * 把 `window.__layoutProbe` 挂上（幂等）。
 * 无头脚本靠 `--dump-dom` 抓页面，所以必须挂在 window 上而不是模块导出。
 *
 * 不带参数调用时用**当前避让区快照**（`window.__layoutAvoidRects`，由调试页写入）——
 * 否则外部脚本 `await page.evaluate('window.__layoutProbe()')` 量出来的结果里
 * `avoidRects` 是空的，「单词有没有压住按钮」这条最关键的检查就没法验（M2 实测踩到）。
 */
export function attachLayoutProbe(): void {
  window.__layoutProbe = (avoidRects?: ({ label: string } & Rect)[]): LayoutProbeResult =>
    runLayoutProbe(avoidRects ?? window.__layoutAvoidRects ?? []);
}

declare global {
  interface Window {
    /** 测量当前白纸布局（真实 DOM 坐标） */
    __layoutProbe?: (avoidRects?: ({ label: string } & Rect)[]) => LayoutProbeResult;
    /** 调试页写入的算法自述信息（供测量结果附带） */
    __layoutInfo?: LayoutInfo;
    /** 调试页写入的归一化落点（核对报告与 DOM 是否一致） */
    __layoutPlacements?: { id: string; x: number; y: number }[];
    /**
     * 调试页注入的「模拟真机视口」。
     *
     * 无头浏览器最小窗宽 504px，`--window-size=390,844` 拿不到 390 宽，
     * 所以调试页把 390×844 注入到这里，`PaperStage` 用它算纸张 / 字号 / 避让区。
     * 生产环境下**永远不设置**，行为与以前完全一致。
     */
    __layoutViewport?: { width: number; height: number };
    /** 调试页写入的当前避让区（外部脚本直接调 __layoutProbe() 时用它判交） */
    __layoutAvoidRects?: ({ label: string } & Rect)[];
    /**
     * 调试页挂的**题干遮罩**测量钩子（只量几何，不改业务逻辑）。
     * 用来验「记忆/拼写题干弹在哪、会不会被底部按钮带压住」。
     * @param mode 'centered' 居中偏上 / 'origin' 第一个词的原落点 /
     *   'originBottom' 最后一个词（最靠下）的原落点 / 'hide' 收起
     */
    __devOverlay?: (mode: 'centered' | 'origin' | 'originBottom' | 'hide') => {
      mode: string;
      x: number;
      y: number;
      w: number;
      h: number;
      centerX: number;
      centerY: number;
      bottom: number;
      right: number;
      zIndex: string;
      position: string;
      viewport: number[];
      word: string | null;
      placement: { x: number; y: number } | null;
    } | null;
  }
}
