/**
 * 白纸界面的「按钮几何」—— **唯一事实来源**。
 *
 * ★ 版本 0.0.9 的核心修复之一。上一版「按钮大小会不断变化」的根因是：
 *   - 屏幕上的按钮是自撑宽度的 `<button>再背一个 (Enter)</button>`，文案一变宽度就变；
 *   - 布点用的避让区却是按**常量**算的。
 *   两者一漂移，屏幕上就会出现「词压在按钮边上」或者「按钮旁边空一大块」。
 *
 * 现在：按钮的宽高**只由这里算**，CSS 通过由这里写出的 CSS 变量取同一份数字，
 * 布点也用这里算出的矩形。三处同源 → 按钮尺寸永远不变、避让区永远和它对齐。
 *
 * ★ 另一个修复：旧 `controlsAvoidRect()` 把避让矩形**向内缩**了 12px（`+controlsPadding`），
 *   而真实按钮比它大一圈 → 词落进那圈空隙就直接压住按钮。
 *   现在一律**向外扩** `PAPER_UI.avoidExtraPx`，扩出来的就是「词与按钮的最小间隙」。
 */
import { getSettings, PAPER_FONT_BASE_PX, PAPER_FONT_RATIOS, PAPER_UI } from '../../../core/config';
import { deviceKind, type DeviceKind } from '../../device';

/**
 * ★ 版本 0.0.19：白纸界面「字体大小」的派生字号（用户提示词 10 第 2 条）。
 *
 * 口径：外观里的「字体大小」= 单词字号（`display.fontSize`）；
 * 中文含义 / 义项数角标 / 统计信息按 `PAPER_FONT_RATIOS` **等比**跟着缩放，
 * 所以它们之间的相对比例永远不变；单词卡等弹窗不读这里，字号不受影响。
 */
export interface PaperFontMetrics {
  /** 单词字号（像素） */
  word: number;
  /** 中文含义字号（像素） */
  meaning: number;
  /** 义项数角标字号（像素） */
  badge: number;
  /** 统计信息字号（像素） */
  stats: number;
  /** 相对基准（24px）的缩放系数，用于中文盒子的最大宽度等派生量 */
  scale: number;
}

/**
 * 算当前设置下的白纸字号组。
 */
export function paperFontMetrics(): PaperFontMetrics {
  const word = Math.max(1, Math.round(getSettings().display.fontSize));
  const scale = word / PAPER_FONT_BASE_PX;
  /** 按比例缩放并保留一位小数（字号允许小数，四舍五入到 0.1 足够，避免累积误差） */
  const scaled = (ratio: number): number => Math.max(1, Math.round(ratio * word * 10) / 10);
  return {
    word,
    scale,
    meaning: scaled(PAPER_FONT_RATIOS.meaning),
    badge: scaled(PAPER_FONT_RATIOS.badge),
    stats: scaled(PAPER_FONT_RATIOS.stats),
  };
}

/**
 * ★ 版本 0.0.10（用户第 2 条）：白纸按钮的**字号与单词相同**、等宽等高、面积增大。
 *
 * 所以按钮尺寸不再写死像素，而是**由单词字号推导**：
 *   按钮高 = 单词字号 + 上下内边距；按钮宽 = 单词字号 × 系数（宽屏竖排时定宽）。
 * 这样用户把单词字号调大，按钮会跟着等比变大，不会出现「字把按钮撑破」。
 *
 * 与首页的关系（用户明确）：**首页按钮字号 > 单词字号 = 白纸按钮字号**。
 * 首页的字号写死在 `global.css`（宽屏 28px / 手机 26px），白纸按钮读这里的单词字号。
 * @returns 本设备形态下的按钮宽高与字号
 */
export function paperButtonMetrics(): { width: number; height: number; font: number } {
  const font = paperFontMetrics().word;
  const kind = deviceKind(window.innerWidth);
  if (kind === 'phone') {
    // 手机是等分宽度，width 只是参考值（CSS 用 flex:1 等分）
    return { width: 0, height: font + 22, font };
  }
  return { width: Math.round(font * 8), height: font + 20, font };
}

/** 白纸界面的按钮个数（下一个 / 再次记忆 / 背完了 / 保存并退出 / 删除这张纸） */
export const PAPER_BUTTON_COUNT = 5;

/** 一个矩形（视口坐标，像素） */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 按钮几何结果 */
export interface PaperButtonBox {
  /** 按钮组整体外框（视口坐标） */
  group: Box;
  /** 布点要避开的矩形 = group 向外扩 `PAPER_UI.avoidExtraPx` */
  avoid: Box;
  /** 这个设备形态下按钮是横排（手机）还是竖排（宽屏） */
  kind: DeviceKind;
}

/** 把矩形向外扩 n 像素（四个方向都扩） */
function expand(box: Box, n: number): Box {
  return { x: box.x - n, y: box.y - n, width: box.width + n * 2, height: box.height + n * 2 };
}

/**
 * 算出当前视口下按钮组的矩形与布点避让矩形。
 *
 * 手机：底部一整排 4 个，等分宽度、固定高度 —— 组框就是那条横带。
 * 平板/桌面：右下角竖排 4 个，固定宽高 —— 组框就是那一列方块。
 *
 * @param viewport 视口尺寸（默认读真实窗口；布局探针可传模拟尺寸）
 */
export function paperButtonBox(viewport?: { width: number; height: number }): PaperButtonBox {
  const vw = viewport?.width ?? window.innerWidth;
  const vh = viewport?.height ?? window.innerHeight;
  const kind = deviceKind(vw);

  let group: Box;
  const m = paperButtonMetrics();
  if (kind === 'phone') {
    const { bottomPad } = PAPER_UI.phone;
    // 横带高度 = 按钮高 + 上下各一份 bottomPad
    const height = m.height + bottomPad * 2;
    group = { x: 0, y: Math.max(0, vh - height), width: vw, height };
  } else {
    const { gapY, margin, pad } = PAPER_UI.wide;
    const height = m.height * PAPER_BUTTON_COUNT + gapY * (PAPER_BUTTON_COUNT - 1) + pad * 2;
    const width = m.width + pad * 2;
    group = {
      x: Math.max(0, vw - margin - width),
      y: Math.max(0, vh - margin - height),
      width,
      height,
    };
  }

  return { group, avoid: expand(group, PAPER_UI.avoidExtraPx), kind };
}

/**
 * 把按钮尺寸写成 CSS 变量，供 `paper.css` 取用。
 *
 * 为什么要走 CSS 变量而不是两边各写一份数字：一旦两处不一致，
 * 屏幕上按钮的大小就和布点避让区对不上——这正是上一版的 bug。
 * @param root 挂载这些变量的元素（通常是白纸页根节点）
 */
export function applyPaperButtonVars(root: HTMLElement): void {
  const s = root.style;
  const m = paperButtonMetrics();
  const f = paperFontMetrics();
  s.setProperty('--paper-btn-h', `${m.height}px`);
  s.setProperty('--paper-btn-w', `${m.width}px`);
  // ★ 字数与单词相同（用户第 2 条）
  s.setProperty('--paper-btn-font', `${m.font}px`);
  // ★ 0.0.19：白纸本体其余文字的字号（等比于单词字号；弹窗不读这些变量）
  s.setProperty('--paper-meaning-font', `${f.meaning}px`);
  s.setProperty('--paper-badge-font', `${f.badge}px`);
  s.setProperty('--paper-stats-font', `${f.stats}px`);
  s.setProperty('--paper-btn-gap-x', `${PAPER_UI.phone.gapX}px`);
  s.setProperty('--paper-btn-side-pad', `${PAPER_UI.phone.sidePad}px`);
  s.setProperty('--paper-btn-bottom-pad', `${PAPER_UI.phone.bottomPad}px`);
  s.setProperty('--paper-btn-gap-y', `${PAPER_UI.wide.gapY}px`);
  s.setProperty('--paper-btn-margin', `${PAPER_UI.wide.margin}px`);
  s.setProperty('--paper-btn-pad', `${PAPER_UI.wide.pad}px`);
  s.setProperty('--paper-stats-gap', `${PAPER_UI.statsGap}px`);
}
