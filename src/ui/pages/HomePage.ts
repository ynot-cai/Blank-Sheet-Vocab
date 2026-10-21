import type { WordStats } from '../../core/types';
import * as dao from '../../dao';
import { h } from '../dom';
import { navigate } from '../router';

/**
 * 主页（版本 0.0.11）—— **视觉恢复为归档旧版风格**，只做用户点名的 6 处修改。
 *
 * 依据：`git show e266e72:src/ui/pages/HomePage.ts`（旧版源码）与旧版 `global.css` 里
 * 仍然保留的 `.home-grid` / `.home-card` / `.home-label` / `.home-desc` 规则。
 * 任何没点名的参数（间距、圆角、阴影、字号）一律沿用旧版那几条 CSS，**不自己另写一套**。
 *
 * 六处修改：
 *   ① 底色 `--bg` 从 `#f5f6f8` 小幅提亮（在 global.css 的 :root 里改）；
 *   ② 底部新增横条（`ui/components/Footer.ts`，在 App.ts 里全局挂载）；
 *   ③ **取消蓝框**：按钮回到旧版 `1px solid var(--line)`，不再有蓝色边框/蓝色悬停；
 *   ④ 统计项目与旧版一致，并在前面加前缀「当前词库：」；
 *   ⑤ 上方白条里、标题左侧加一行不加深的说明文字（在 App.ts 里渲染）；
 *   ⑥ 整体沿用 `.page` / `.note` 这些与录入页共享的类，观感与录入页一致。
 *
 * 入口沿用旧版的五个（录入/背诵/复习/单词列表/设置），另外保留「拼写强化」——
 * 那是用户 0.0.3 要求加、且当前仍在首页上的入口，**没有删**。
 */
const ENTRIES: { path: string; label: string; desc: string }[] = [
  { path: '/import', label: '录入', desc: '粘贴或上传单词/短语/缩写，解析成词条' },
  { path: '/learn', label: '背诵', desc: '白纸空间记忆：靠位置 + 语音建立记忆' },
  { path: '/review', label: '复习', desc: '默认按复习优先度排序，或选一张卡片复习' },
  { path: '/spell', label: '拼写强化', desc: '只做拼写，不用白纸空间' },
  { path: '/list', label: '单词列表', desc: '筛选 / 编辑属性 / 斩词复活' },
  { path: '/settings', label: '设置', desc: '同步 / AI 接口 / 数据' },
];

/**
 * 渲染主页。
 */
export function renderHomePage(): HTMLElement {
  const page = h('div', { class: 'page home-page' });
  page.appendChild(h('h2', { class: 'page-title', text: '白纸单词' }));
  page.appendChild(
    h(
      'p',
      { class: 'note' },
      '本地离线、单用户的背单词工具。条目可以是单词、短语（give up）或缩写（NASA / etc.）。数据存在本机浏览器里，不联网（AI 解析除外）。',
    ),
  );

  const grid = h('div', { class: 'home-grid' });
  for (const entry of ENTRIES) {
    const card = h('button', { class: 'home-card', type: 'button', dataset: { path: entry.path } });
    card.appendChild(h('span', { class: 'home-label', text: entry.label }));
    card.appendChild(h('span', { class: 'home-desc', text: entry.desc }));
    card.addEventListener('click', () => navigate(entry.path));
    grid.appendChild(card);
  }
  page.appendChild(grid);

  // ── 统计：项目与旧版一致（总词数 / 未背 / 学习中 / 已背 / 已斩），加前缀「当前词库：」──
  const statLine = h('p', { class: 'note', text: '当前词库：读取中…' });
  page.appendChild(statLine);
  void (async () => {
    try {
      const st: WordStats = await dao.words.stats();
      statLine.textContent = `当前词库：总词数 ${st.total} · 未背 ${st.unlearned} · 学习中 ${st.learning} · 已背 ${st.learned} · 已斩 ${st.chopped}`;
    } catch (err) {
      console.error('[home] 词库统计读取失败', err);
      statLine.textContent = '当前词库：统计读取失败';
    }
  })();

  return page;
}
