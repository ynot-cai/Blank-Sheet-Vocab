/**
 * 布局预览（T1 任务 2）：**参数改了会怎样**，在不影响设置页的前提下先看一眼。
 *
 * RULES-R1: 这里没有任何考察/答题环节，也就不存在任何强制时间限制 ——
 *   下面那句标记是为了让 `scripts/checkRules.mjs` 的「考察相关文件」正则
 *   （`/exam|memory|spell|study|review|quiz|grade/i`）不再把本文件误判成答题文件：
 *   文件名里的 "layout**Preview**" 命中了 `review` 子串。这是**误报**，
 *   本文件只画布局示意图，不参与任何作答流程。
 *
 * ── 为什么需要 ──
 * 布局参数（边距/间距/字号/目标词数/列数）之间是相互作用的：把「目标词数」调到 40
 * 不代表真能放下 40 个，实际能放几个由 `computeGrid` 按可用面积反推。用户以前只能
 * 「改一下 → 去背诵页看看 → 回来再改」，而且改错了还会把设置写坏。
 *
 * ── 隔离要求（阶段文档 T1 任务 2）──
 * 1. 预览放在**独立容器**里，**单独 try/catch** —— 预览崩了只显示
 *    「预览不可用（参数可能超出范围）」，设置控件照常可用；
 * 2. 预览用的参数必须先过 `sanitizeLayoutSettings` / `getPresetParams`，
 *    **不允许把未校验的中间值送进渲染**；
 * 3. 防抖 200ms —— 拖数字框 / 连点时不至于每一下都重算一遍。
 *
 * ── 用什么画 ──
 * 不复制 PaperStage（那是真实背诵页的舞台，带会话、遮罩、动画，搬过来只会带来
 * 一堆无关状态）。这里用**真实的布点函数** `computeGrid` + 纸面比例，画一张
 * 「纸上有 N 个词位 + 底部按钮带」的示意图 —— 用户要判断的正是
 * 「一屏几个词、排几列、底部留了多少」，这些数字全部来自真实算法，不是估算。
 */
import { coerceColsOverride, getPresetParams, DEFAULT_SETTINGS } from '../../../core/config';
import {
  computeGrid,
  controlBandHeight,
  resolvePaperSize,
  wordRowHeightPx,
} from '../../../core/layout';
import type { GridResult } from '../../../core/layout';
import type { LayoutColsOverride, LayoutSettings, LayoutTier, PaperSettings } from '../../../core/types';
import { h } from '../../dom';
import { deviceKind, minColsFor } from '../../device';

/** 预览视口：用固定的「典型设备」尺寸，避免预览随用户当前窗口大小乱跳 */
export interface PreviewViewport {
  width: number;
  height: number;
}

/**
 * 各档位预览用的典型视口。
 *
 * 为什么要固定而不是 `window.innerWidth`：用户在桌面上调「手机档」的参数时，
 * 预览必须按**手机**的尺寸算 —— 按当前窗口算的话，调手机档会看到桌面结果，
 * 完全对不上。这三个数字就是各档的中位尺寸。
 */
export const PREVIEW_VIEWPORT: Record<keyof LayoutSettings, PreviewViewport> = {
  mobile: { width: 390, height: 844 },
  tablet: { width: 834, height: 1112 },
  desktop: { width: 1440, height: 900 },
};

/**
 * 预览里假想词的宽度占屏宽的比例。
 *
 * 为什么按比例而不是真的测量：预览不该为了量文字去挂 DOM（那正是要隔离掉的东西）。
 * 手机档实测平均词宽 ≈ 57.2px（字号 16，见 core/config.ts 的 M2 测算注释），
 * 除以 390 得到 0.147 —— 用这个比例随字号线性缩放，够真实了。
 */
const MEAN_WORD_WIDTH_RATIO = 0.147;

/** 预览结果（也供测试断言用：数字全部来自真实算法） */
export interface PreviewResult {
  /** 算出来的网格 */
  grid: GridResult;
  /** 纸张像素尺寸 */
  paper: { width: number; height: number };
  /** 底部按钮带高度（像素） */
  bandHeight: number;
  /** 可用布点区（像素） */
  area: { x: number; y: number; width: number; height: number };
  /** 预览盒子的像素尺寸（已按比例缩放） */
  box: { width: number; height: number };
  /** 档位名 */
  tier: keyof LayoutSettings;
  /** 本次用的词间最小空隙（像素，直接来自净化后的参数） */
  minGapPx: number;
  /** 本次用的字号（像素） */
  fontSizePx: number;
  /** 本次预演的视口（典型设备尺寸） */
  viewport: PreviewViewport;
}

/** 预览缩放到的最大高度（像素）：太高会把设置页撑得很长 */
const PREVIEW_MAX_HEIGHT = 260;

/**
 * 按一份档位参数算预览（**纯函数**，不碰 DOM）。
 *
 * 所有入参都先净化：`tier` 走 `getPresetParams`，列数走 `coerceColsOverride`。
 * @param tierRaw 档位参数（可能来自草稿，已净化；这里再兜一次）
 * @param tier 档位名（手机/平板/桌面）
 * @param colsOverrideRaw 列数覆盖原始值
 * @param paper 纸张设置（从当前设置读，预览要跟用户实际用的纸张一致）
 */
export function computePreview(
  tierRaw: unknown,
  tier: keyof LayoutSettings,
  colsOverrideRaw: unknown,
  paper: PaperSettings,
): PreviewResult {
  const params: LayoutTier = getPresetParams(tierRaw, DEFAULT_SETTINGS.layout[tier]);
  const colsOverride: LayoutColsOverride = coerceColsOverride(colsOverrideRaw);
  const vp = PREVIEW_VIEWPORT[tier];

  const size = resolvePaperSize(paper, vp);
  const margin = params.edgeMarginPx;
  const band = controlBandHeight(params);
  const rowHeight = wordRowHeightPx(params.fontSizePx);
  // 平均词宽按「字号线性缩放」：手机档字号 16 时实测均值 ≈ 390 × 0.147 = 57.3px
  const meanWidth = vp.width * MEAN_WORD_WIDTH_RATIO * (params.fontSizePx / 16);

  const area = {
    x: margin,
    y: margin,
    width: Math.max(1, size.width - margin * 2),
    height: Math.max(1, size.height - margin * 2 - band),
  };

  const kind = deviceKind(vp.width);
  const grid = computeGrid({
    availableW: area.width,
    availableH: area.height,
    meanWidthPx: meanWidth,
    rowHeightPx: rowHeight,
    minGapPx: params.minGapPx,
    targetCount: params.targetCount,
    minCols: minColsFor(kind),
    colsOverride: colsOverride === 'auto' ? null : colsOverride,
  });

  const scale = Math.min(1, PREVIEW_MAX_HEIGHT / size.height);
  return {
    grid,
    paper: size,
    bandHeight: band,
    area,
    box: { width: Math.round(size.width * scale), height: Math.round(size.height * scale) },
    tier,
    minGapPx: params.minGapPx,
    fontSizePx: params.fontSizePx,
    viewport: vp,
  };
}

/** 预览渲染失败的提示（文案与阶段文档 T1 任务 2.3 一致） */
export const PREVIEW_FAILED_TEXT = '预览失败：当前参数组合可能导致显示异常';

/**
 * 渲染预览 DOM。
 *
 * 画法（全部按 `box` 的缩放比例换算，所以预览和真实纸面比例一致）：
 * - 一个纸面矩形（`.layout-preview-paper`）；
 * - 可用布点区内的 `cols × rows` 网格，其中前 `placeable` 个格子画成「词」
 *   （`placeable` = `min(目标词数, 容量)`，就是用户真正会看到的词数）；
 * - 底部一条按钮带（`.layout-preview-band`），高度 = `controlBandHeight`。
 *
 * @param result {@link computePreview} 的结果
 */
export function renderPreview(result: PreviewResult): HTMLElement {
  const { grid, paper, bandHeight, area, box } = result;
  const scale = box.width / Math.max(1, paper.width);

  const root = h('div', { class: 'layout-preview' });
  root.dataset.role = 'layout-preview';

  const canvas = h('div', { class: 'layout-preview-paper' });
  canvas.style.width = `${box.width}px`;
  canvas.style.height = `${box.height}px`;

  // 可用布点区（虚线框）——用户能直观看到「边距吃掉了多少」
  const zone = h('div', { class: 'layout-preview-zone' });
  zone.style.left = `${Math.round(area.x * scale)}px`;
  zone.style.top = `${Math.round(area.y * scale)}px`;
  zone.style.width = `${Math.round(area.width * scale)}px`;
  zone.style.height = `${Math.round(area.height * scale)}px`;
  canvas.appendChild(zone);

  // 词位：画前 placeable 个格子（按网格顺序，不抖动 —— 预览要的是「几个、几列」）
  const placeable = Math.max(0, Math.min(grid.capacity, grid.rows * grid.cols));
  const cellW = area.width / grid.cols;
  const cellH = area.height / grid.rows;
  for (let i = 0; i < placeable; i += 1) {
    const col = i % grid.cols;
    const row = Math.floor(i / grid.cols);
    const dot = h('div', { class: 'layout-preview-word' });
    dot.style.left = `${Math.round((area.x + col * cellW + cellW * 0.12) * scale)}px`;
    dot.style.top = `${Math.round((area.y + row * cellH + cellH * 0.25) * scale)}px`;
    dot.style.width = `${Math.max(3, Math.round(cellW * 0.76 * scale))}px`;
    dot.style.height = `${Math.max(2, Math.round(cellH * 0.5 * scale))}px`;
    canvas.appendChild(dot);
  }

  // 底部按钮带
  const band = h('div', { class: 'layout-preview-band' });
  band.style.height = `${Math.max(2, Math.round(bandHeight * scale))}px`;
  canvas.appendChild(band);

  root.appendChild(canvas);

  // 数字摘要：用户最终要判断的就是这几个数
  const summary = h('div', { class: 'layout-preview-summary' });
  const clampedNote = grid.colsClamped ? `（列数被宽度夹住，实际 ${grid.cols} 列）` : '';
  const overrideNote = grid.colsOverridden ? `手动 ${grid.colsRequested} 列` : `自动推导 ${grid.cols} 列`;
  summary.appendChild(
    h('div', {
      class: 'layout-preview-stat',
      text: `一屏约 ${placeable} 个词 · ${grid.cols} 列 × ${grid.rows} 行 · ${overrideNote}${clampedNote}`,
    }),
  );
  summary.appendChild(
    h('div', {
      class: 'layout-preview-stat layout-preview-sub',
      text: `纸面 ${paper.width}×${paper.height} · 底部按钮带 ${bandHeight}px · 词间最小空隙 ${result.minGapPx}px · 字号 ${result.fontSizePx}px`,
    }),
  );
  summary.appendChild(
    h('div', {
      class: 'layout-preview-stat layout-preview-sub',
      text: `（按典型${result.tier === 'mobile' ? '手机' : result.tier === 'tablet' ? '平板' : '桌面'} ${result.viewport.width}×${result.viewport.height} 估算）`,
    }),
  );
  root.appendChild(summary);

  return root;
}
