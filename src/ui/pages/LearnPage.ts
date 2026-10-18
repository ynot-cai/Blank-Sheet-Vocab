/**
 * 背诵入口页（`#/learn`）—— 完整页面，不是小弹窗。
 *
 * 用户要求：页面上方沿用「录入 / 背诵 / 复习…」那一排全局入口（由 `App.ts` 的白栏提供），
 * 左下角放一个「开始背诵」，**点击后有动画**，然后进白纸界面。
 * 本轮到这里就够：点进去即可，不需要其余逻辑。
 */
import type { Word } from '../../core/types';
import * as dao from '../../dao';
import { h } from '../dom';
import { navigate } from '../router';

/**
 * 渲染背诵入口页。
 */
export function renderLearnPage(): HTMLElement {
  const page = h('div', { class: 'page learn-entry' });

  page.appendChild(h('h2', { class: 'learn-entry-title', text: '背诵' }));
  page.appendChild(
    h('p', {
      class: 'learn-entry-sub',
      text: '白纸空间记忆：单词会随机撒在纸上，靠位置建立记忆。点「开始背诵」进入白纸。',
    }),
  );

  const info = h('p', { class: 'learn-entry-sub', text: '正在读取词库…' });
  page.appendChild(info);

  void (async () => {
    try {
      const all: Word[] = await dao.words.listAlive();
      const usable = all.filter((w) => w.status !== 'chopped');
      info.textContent = usable.length === 0
        ? '词库还是空的，先去「录入」加几个词吧。'
        : `词库里有 ${usable.length} 个词可背。`;
    } catch (err) {
      console.error('[learn] 读取词库失败', err);
      info.textContent = '读取词库失败（数据库打不开？）';
    }
  })();

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
