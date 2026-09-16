/**
 * 设备形态判断（手机 / 平板 / 桌面）+ 按钮避让区 + 布局档位。
 *
 * 为什么要单独一个模块：布点密度、按钮尺寸、避让区、卡片弹出方式
 * 都依赖「当前是什么设备」，散在各页面里判断会到处写 window.innerWidth。
 * 这里统一用视口宽度判断（比 UA 判断可靠，横竖屏切换也能跟上）。
 *
 * ★ 阶段 M2：手机上的按钮改成**底部横排圆形**，避让区从「右下角方块」
 *   变成「底部一条横带」。这一改动就是 M1 诊断里「单词无法出现在按钮左侧」
 *   那个问题的解法：横带之外（左侧、中间、右侧）全部可布点。
 */
import { DEVICE, getSettings } from '../core/config';
import { controlBandHeight } from '../core/layout';
import type { LayoutTier } from '../core/types';

/** 设备形态 */
export type DeviceKind = 'phone' | 'tablet' | 'desktop';

/**
 * 当前设备形态。
 * @param width 视口宽度（默认读 window.innerWidth，测试可注入）
 */
export function deviceKind(width: number = window.innerWidth): DeviceKind {
  if (width <= DEVICE.phoneMaxWidth) return 'phone';
  if (width <= DEVICE.tabletMaxWidth) return 'tablet';
  return 'desktop';
}

/**
 * 当前形态对应的布局档位（`settings.layout.mobile / tablet / desktop`）。
 *
 * 说明：档位参数由用户在设置页/调试页改，所以必须**每次现读**，
 * 不能在模块加载时缓存一份。
 * @param width 视口宽度（默认真实窗口）
 */
export function controlTier(width?: number): LayoutTier {
  const kind = deviceKind(width);
  const layout = getSettings().layout;
  return kind === 'phone' ? layout.mobile : kind === 'tablet' ? layout.tablet : layout.desktop;
}

/** 当前手机按钮带的高度（像素，含底部安全区） */
export function mobileBandHeightPx(tier: LayoutTier): number {
  const safe = readSafeAreaBottomPx();
  return controlBandHeight(tier, safe);
}

/**
 * 读「底部安全区」的像素高度。
 *
 * 为什么要真读：避让区必须与 CSS 里按钮的实际位置一致，
 * 否则 iPhone 上避让带会比按钮矮一截，最下面一行词就被横条压住。
 * 拿不到（非浏览器 / 没注入样式）时按 0 处理，不影响桌面。
 */
function readSafeAreaBottomPx(): number {
  try {
    const raw = getComputedStyle(document.documentElement).getPropertyValue('--safe-bottom');
    const n = Number.parseFloat(raw);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

/**
 * 按钮避让区（像素，相对视口左上角）。布点时要避开它，否则按钮会压住单词。
 *
 * - **手机**：底部整条横带（`x=0`，宽 = 视口宽）。这是 M2 的核心改动：
 *   横带以上的区域全部可布点，单词可以出现在按钮左侧/右侧/上方。
 * - **平板 / 桌面**：保持原来的右下角方块（桌面行为不许变）。
 * @param viewport 视口尺寸（默认取真实窗口；布局调试页会传模拟的真机尺寸）
 */
export function controlsAvoidRect(viewport?: { width: number; height: number }): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  const vw = viewport?.width ?? window.innerWidth;
  const vh = viewport?.height ?? window.innerHeight;
  const kind = deviceKind(vw);
  if (kind === 'phone') {
    const band = mobileBandHeightPx(controlTier(vw));
    return { x: 0, y: Math.max(0, vh - band), width: vw, height: band };
  }
  const size = kind === 'tablet' ? DEVICE.controlsTablet : DEVICE.controlsTablet;
  const margin = DEVICE.controlsMargin;
  const pad = DEVICE.controlsPadding;
  return {
    x: vw - size.width - margin + pad,
    y: vh - size.height - margin + pad,
    width: size.width,
    height: size.height,
  };
}
