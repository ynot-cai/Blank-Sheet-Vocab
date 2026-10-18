import { getSettings, HOME_UI } from '../../core/config';
import { computePriorities } from '../../core/priority';
import type { Word } from '../../core/types';
import * as dao from '../../dao';
import { h } from '../dom';
import { navigate } from '../router';

/**
 * 首页六个入口。
 *
 * ★ 版本 0.0.10（用户第 1 条）：**全部水平排列**、蓝框 + 白底 + 黑字、面积增大、
 *   **等宽等高**、字号大于白纸界面按钮（白纸按钮字号 = 单词字号）。
 *   宽屏 6 个一行；手机自动换行 2 列 × 3 排（仍是水平排列）。
 *
 * ⚠️ 顺序沿用上一版（先是会进入学习/练习的，再是数据与设置），
 *   只是把「分两排」改成「一个水平容器里自动换行」，**没有新增任何视觉元素**。
 */
const BUTTONS: { path: string; label: string }[] = [
  { path: '/import', label: '录入' },
  { path: '/learn', label: '背诵' },
  { path: '/review', label: '复习' },
  { path: '/spell', label: '拼写强化' },
  { path: '/list', label: '单词列表' },
  { path: '/settings', label: '设置' },
];

/**
 * 灰栏的统计口径（`逻辑与交互要求.md` §5.2.4）。
 *
 * ⚠️ **「未背」= unlearned + learning**：用户明确说灰栏**不需要「学习中」**这一项，
 * 灰栏只有四个位置（未背 / 已背 / 已斩 / 需复习）。把「学习中」并进「未背」，
 * 四个状态数才刚好等于全库总数（否则学习中的词会在所有计数里凭空消失）。
 *
 * ⚠️ **「需复习」= 复习优先度 > `HOME_UI.needReviewThreshold`**。
 * 优先度是**没有上界**的表达式值，阈值 100 目前的实际含义约等于
 * 「未背 + 200 天以上没复习」（默认 balanced 预设下从未复习的词约 499.5）。
 * 用户已说明以后会重做优先度公式，届时阈值要重新标定——它在这里是一个具名常量，
 * 就是为了那一天只改一处。
 * @param words 全库存活词条
 */
function computeStatLine(words: Word[]): string {
  let unlearned = 0;
  let learned = 0;
  let chopped = 0;
  for (const w of words) {
    if (w.status === 'learned') learned += 1;
    else if (w.status === 'chopped') chopped += 1;
    else unlearned += 1; // unlearned + learning
  }

  const settings = getSettings();
  const threshold = HOME_UI.needReviewThreshold;
  let needReview = 0;
  try {
    const priorities = computePriorities(words, settings);
    for (const p of priorities.values()) if (p > threshold) needReview += 1;
  } catch (err) {
    // 优先度算不出来不该让整条灰栏消失——那是「数字不对」，不是「页面坏了」
    console.warn('[home] 需复习统计失败', err);
    return `未背 ${unlearned} · 已背 ${learned} · 已斩 ${chopped} · 需复习 统计失败`;
  }

  return `未背 ${unlearned} · 已背 ${learned} · 已斩 ${chopped} · 需复习 ${needReview}`;
}

/**
 * 渲染首页。
 */
export function renderHomePage(): HTMLElement {
  const page = h('div', { class: 'page home-page' });

  // ── 六个按钮：一个水平容器，靠 CSS grid 等分；手机自动换成 2 列 × 3 排 ──
  const buttonsBox = h('div', { class: 'home-buttons' });
  for (const item of BUTTONS) {
    buttonsBox.appendChild(
      h('button', {
        class: 'home-card',
        type: 'button',
        text: item.label,
        dataset: { path: item.path },
        onclick: () => navigate(item.path),
      }),
    );
  }
  page.appendChild(buttonsBox);

  // ── 灰栏 ──
  const statText = h('span', { class: 'statbar-text', text: '统计读取中…' });
  const statbar = h('div', { class: 'statbar' }, statText);
  page.appendChild(statbar);

  void (async () => {
    try {
      const words = await dao.words.listAlive();
      statText.textContent = computeStatLine(words);
    } catch (err) {
      console.error('[home] 词库统计读取失败', err);
      statText.textContent = '统计读取失败（词库打不开？）';
    }
  })();

  return page;
}
