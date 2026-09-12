/**
 * 设备形态判断（手机 / 平板 / 桌面）。
 *
 * 为什么要单独一个模块：布点密度、按钮尺寸、右下角避让区、卡片弹出方式
 * 都依赖「当前是什么设备」，散在各页面里判断会到处写 window.innerWidth。
 * 这里统一用视口宽度判断（比 UA 判断可靠，横竖屏切换也能跟上）。
 */
import { DEVICE } from '../core/config';

/** 设备形态 */
export type DeviceKind = 'phone' | 'tablet' | 'desktop';

/** 形态变化监听者 */
const listeners = new Set<(kind: DeviceKind) => void>();

/**
 * 当前设备形态。
 * @param width 视口宽度（默认读 window.innerWidth，测试可注入）
 */
export function deviceKind(width: number = window.innerWidth): DeviceKind {
  if (width <= DEVICE.phoneMaxWidth) return 'phone';
  if (width <= DEVICE.tabletMaxWidth) return 'tablet';
  return 'desktop';
}

/** 是否触摸为主的设备（手机 / 平板都算） */
export function isTouchDevice(): boolean {
  return deviceKind() !== 'desktop';
}

/**
 * 订阅形态变化（横竖屏切换、窗口缩放都会触发）。
 * 只在形态真的变了（手机↔平板↔桌面）时通知，避免频繁重排。
 * @param fn 回调
 */
export function onDeviceChange(fn: (kind: DeviceKind) => void): () => void {
  listeners.add(fn);
  let last = deviceKind();
  const handler = (): void => {
    const now = deviceKind();
    if (now === last) return;
    last = now;
    fn(now);
  };
  window.addEventListener('resize', handler);
  return () => {
    window.removeEventListener('resize', handler);
    listeners.delete(fn);
  };
}

/**
 * 右下角按钮区占用的屏幕区域（像素，相对视口左上角）。
 * 布点时要避开它，否则按钮会压住单词。
 * 说明：坐标按「屏幕」算而不是按纸面算——纸面可能是 A4 竖版居中，
 * 而按钮永远贴在视口右下角。
 */
export function controlsAvoidRect(): { x: number; y: number; width: number; height: number } {
  const kind = deviceKind();
  const size = kind === 'desktop' ? DEVICE.controlsTablet : kind === 'tablet' ? DEVICE.controlsTablet : DEVICE.controlsPhone;
  const margin = DEVICE.controlsMargin;
  const pad = DEVICE.controlsPadding;
  return {
    x: window.innerWidth - size.width - margin + pad,
    y: window.innerHeight - size.height - margin + pad,
    width: size.width,
    height: size.height,
  };
}
