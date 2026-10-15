import { button, h } from '../dom';
import { navigate } from '../router';

/**
 * 主页。
 *
 * ★ 版本 0.0.1「删除与归档行动」：主页**只保留「设置」一个按钮**。
 *
 * ── 原来是什么样 ──
 * 原来这里是一个五宫格入口（录入 / 背诵 / 单词列表 / 复习 / 设置）
 * 加一行词库概览（总词数 / 未背 / 学习中 / 已背 / 已斩）加未完成会话角标。
 *
 * ── 为什么删掉 ──
 * 用户要求「主界面仅保留设置按钮」，并且要归档「单词列表」这个
 * 「查看和访问单词数据的功能」。词库概览那一行统计数字属于「查看单词数据」，
 * 所以按同一条口径一并去掉 —— 现在主页上没有任何词库信息。
 *
 * ── 归档去哪了 ──
 * 五个入口页面的源码与说明见 已归档/04~08 号模块文档；
 * 词库概览与未完成会话角标是 HomePage 自己的代码，随本文件一起被改写，
 * 旧版本完整源码见 已归档/02_白纸流程… 与 05/06 号文档中的调用方说明。
 *
 * ── 数据层没有动 ──
 * `dao.words.stats()` 这类统计接口仍然完整保留在 `src/dao/words.ts` 里，
 * 只是主页不再调用它。将来要做新界面时直接调用即可。
 */
export function renderHomePage(): HTMLElement {
  const page = h('div', { class: 'page home-page' });
  page.appendChild(h('h2', { class: 'page-title', text: '白纸单词' }));
  page.appendChild(
    h(
      'p',
      { class: 'note' },
      '本地离线、单用户的背单词工具。词库存在本机浏览器里（IndexedDB），可选用云同步在多设备间共用一份数据。',
    ),
  );

  const row = h('div', { class: 'row' });
  row.appendChild(button('设置', () => navigate('/settings'), { variant: 'primary' }));
  page.appendChild(row);

  return page;
}
