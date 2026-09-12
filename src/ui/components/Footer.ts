/**
 * 页面底部 footer（阶段 07）。
 *
 * 内容：应用名 + 版本号、「关于数据」入口、一行数据存放说明、备案号占位（默认隐藏）。
 * 说明：白纸页面是 fixed 全屏的，footer 会被它盖住——这是有意的，
 * 背单词时不该被页脚干扰。
 */
import { getSettings } from '../../core/config';
import { appVersionLabel } from '../../core/version';
import { h } from '../dom';
import { navigate } from '../router';

/**
 * 渲染 footer。
 */
export function renderFooter(): HTMLElement {
  const footer = h('footer', { class: 'app-footer' });

  const line1 = h('div', { class: 'footer-line' });
  line1.appendChild(h('span', { class: 'footer-name', text: '单词白纸' }));
  line1.appendChild(h('span', { class: 'footer-small', text: `版本 ${appVersionLabel()}` }));
  const aboutLink = h('button', {
    class: 'link-btn',
    type: 'button',
    text: '关于数据',
    title: '看数据存在哪、服务器存什么',
  });
  aboutLink.addEventListener('click', () => navigate('/about'));
  line1.appendChild(aboutLink);
  footer.appendChild(line1);

  footer.appendChild(h('div', { class: 'footer-small', text: '数据存储在你自己的浏览器和私有数据库' }));

  // 备案号占位：默认隐藏，设置 → 画面与纸张 → 备案号 里填了才显示
  const beian = (getSettings().display.beian ?? '').trim();
  if (beian !== '') footer.appendChild(h('div', { class: 'footer-small', text: beian }));

  return footer;
}
