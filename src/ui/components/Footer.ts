/**
 * 页面底部横条（用户要求新增）。
 *
 * 规格：比上方白条更宽（**满宽、且更高**），内容居中两行：
 *   第一行：`白纸单词  版本 x.x.x` + 可点击按钮「关于数据」
 *   第二行：`by Tony-Cai`
 *
 * 样式沿用旧版全局观感（`--paper-bg` 底、`--line` 分隔线、`--fg` / `--fg-dim` 文字），
 * 不引入任何旧版没有的装饰。
 */
import { appVersion } from '../../core/version';
import { button, h } from '../dom';
import { navigate } from '../router';

/**
 * 渲染底部横条。
 */
export function renderFooter(): HTMLElement {
  const bar = h('footer', { class: 'site-footer' });

  const line1 = h('div', { class: 'site-footer-line' });
  line1.appendChild(h('span', { class: 'site-footer-brand', text: '白纸单词' }));
  line1.appendChild(h('span', { class: 'site-footer-version', text: `版本 ${appVersion()}` }));
  line1.appendChild(button('关于数据', () => navigate('/about'), { variant: 'ghost', class: 'site-footer-link' }));
  bar.appendChild(line1);

  bar.appendChild(h('div', { class: 'site-footer-line site-footer-by', text: 'by Tony-Cai' }));

  return bar;
}
