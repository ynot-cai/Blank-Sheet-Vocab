import type { WordStats } from '../../core/types';
import * as dao from '../../dao';
import { button, h } from '../dom';
import { confirmModal } from '../components/Modal';
import { navigate } from '../router';

/** 主页上的六个入口（R3：删掉「记忆」入口，它作为内嵌环节留在背诵页里） */
const ENTRIES: { path: string; label: string; desc: string }[] = [
  { path: '/import', label: '录入', desc: '粘贴或上传单词/短语/缩写，解析成词条' },
  { path: '/learn', label: '背诵', desc: '白纸空间记忆：靠位置 + 语音建立记忆' },
  { path: '/list', label: '单词列表', desc: '筛选 / 编辑属性 / 斩词复活' },
  { path: '/review', label: '复习', desc: '按复习优先度分组抽取' },
  { path: '/settings', label: '设置', desc: '星号参数 / AI 接口 / 备份恢复' },
];

/**
 * 主页：入口 + 词库概览 + 未完成会话角标。
 * 背诵/复习有未完成会话时显示「上次未完成：N 词」，点击询问继续还是重新开始。
 *
 * ★ R3 变更：这里**不再有「记忆」入口**。
 *   理由（提示词第一部分）：记忆环节（默写自测）依赖背诵时已经出现的单词列表，
 *   无法独立存在；它现在是背诵流程的**内嵌环节**——
 *   背诵页里「再背一个」累计点 memorizeEvery 次后按钮自动变成「记忆」，
 *   右下角还有一个独立的「再次记忆」。主界面上再放一个入口是冗余的。
 *   **功能一行都没删**：MemorizePage / #/memorize 路由、记忆环节的组件与 DAO 调用全部保留，
 *   由背诵页继续调用（长按/直达路由仍然可用，只是不再从主界面露出来）。
 */
export function renderHomePage(): HTMLElement {
  const page = h('div', { class: 'page home-page' });
  page.appendChild(h('h2', { class: 'page-title', text: '白纸单词' }));
  page.appendChild(
    h('p', { class: 'note' }, '本地离线、单用户的背单词工具。条目可以是单词、短语（give up）或缩写（NASA / etc.）。数据存在本机浏览器里，不联网（AI 解析除外）。'),
  );

  const grid = h('div', { class: 'home-grid' });

  /**
   * 进入背诵 / 复习。
   *
   * ★ 用户要求（2026-09）：「下次点击直接开始」。
   *   背诵（`/learn`）**不再问**「继续上次 / 重新开始」——LearnPage 自己会恢复上次的
   *   词单 / 位置 / 每词记忆遍数并直接接着背（想重开一轮用背诵页里的「重新开始」）。
   *
   *   ⚠️ 原来那个询问框的正文写的是「继续上次（**进度从零开始、落点重新布**）」，
   *   与代码事实**正好相反**（`exitMidway` 就是整份 saveSession，位置是恢复的）——
   *   属于用户说的「与我说的话冲突的提示部分」，已按用户口径改掉。
   *
   *   复习（`/review`）仍保留询问框：复习要先选「这次复习几个」，
   *   直接跳进去会跳过那个选择，语义上不是「继续上次」而是「再来一轮」。
   * @param path 目标路由
   */
  const enterLearning = (path: '/learn' | '/review'): void => {
    if (path === '/learn') {
      navigate(path);
      return;
    }
    void (async () => {
      const existing = await dao.session.loadSession();
      const match =
        existing && !existing.finished && existing.wordIds.length > 0 && existing.type === 'review';
      if (match) {
        const resume = await confirmModal(
          '上次未完成',
          `上次有 ${existing.wordIds.length} 个词的复习没做完。继续上次（进度与落点都会恢复），还是重新开始？`,
          '继续上次',
        );
        if (resume) navigate(`${path}?resume=1`);
        else {
          await dao.session.clearSession();
          navigate(path);
        }
        return;
      }
      navigate(path);
    })();
  };

  for (const entry of ENTRIES) {
    const card = h('button', { class: 'home-card', type: 'button', dataset: { path: entry.path } });
    card.appendChild(h('span', { class: 'home-label', text: entry.label }));
    card.appendChild(h('span', { class: 'home-desc', text: entry.desc }));
    card.addEventListener('click', () => {
      if (entry.path === '/learn' || entry.path === '/review') enterLearning(entry.path);
      else navigate(entry.path);
    });
    grid.appendChild(card);
  }
  page.appendChild(grid);

  const statLine = h('p', { class: 'note' });
  page.appendChild(statLine);
  void (async () => {
    const [s, session] = await Promise.all([dao.words.stats(), dao.session.loadSession()]);
    const st: WordStats = s;
    statLine.textContent = `当前词库：总词数 ${st.total} · 未背 ${st.unlearned} · 学习中 ${st.learning} · 已背 ${st.learned} · 已斩 ${st.chopped}`;

    // 未完成会话角标
    if (session && !session.finished && session.wordIds.length > 0) {
      const targetPath = session.type === 'learn' ? '/learn' : '/review';
      const card = grid.querySelector<HTMLElement>(`[data-path="${targetPath}"]`);
      if (card) card.appendChild(h('span', { class: 'home-badge', text: `上次未完成：${session.wordIds.length} 词` }));
    }
  })();

  page.appendChild(
    h(
      'div',
      { class: 'row' },
      button('去录入条目', () => navigate('/import'), { variant: 'primary' }),
      button('看单词列表', () => navigate('/list')),
      button('打开设置', () => navigate('/settings')),
    ),
  );

  return page;
}
