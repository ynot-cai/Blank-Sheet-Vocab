/**
 * 背诵入口页（`#/learn`）—— 完整页面，不是小弹窗。
 *
 * 用户要求：页面上方沿用「录入 / 背诵 / 复习…」那一排全局入口（由 `App.ts` 的白栏提供），
 * 左下角放一个「开始背诵」，**点击后有动画**，然后进白纸界面。本轮到这里就够。
 *
 * ★ 版本 0.0.10（用户第 5 条「不要擅自添加未提到的视觉元素」）：
 *   删掉了原先我自己加的标题、说明文字与词库数量提示，**只留「开始背诵」按钮**。
 */
import { h } from '../dom';
import { navigate } from '../router';

/**
 * 渲染背诵入口页。
 */
export function renderLearnPage(): HTMLElement {
  const page = h('div', { class: 'page learn-entry' });

  // 左下角「开始背诵」：先播一下动画，再进白纸界面
  const start = h('button', { class: 'learn-start', type: 'button', text: '开始背诵' });
  start.addEventListener('click', () => {
    if (start.classList.contains('burst')) return;
    start.classList.add('burst');
    // 动画 520ms（见 paper.css 的 learn-burst），结束后跳转
    window.setTimeout(() => navigate('/learn/paper'), 380);
  });
  page.appendChild(start);

  return page;
}
