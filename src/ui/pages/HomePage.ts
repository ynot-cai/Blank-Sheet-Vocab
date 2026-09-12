import type { WordStats } from '../../core/types';
import * as dao from '../../dao';
import { button, h } from '../dom';
import { confirmModal } from '../components/Modal';
import { toastWarn } from '../components/Toast';
import { navigate } from '../router';

/** 主页上的六个入口 */
const ENTRIES: { path: string; label: string; desc: string }[] = [
  { path: '/import', label: '录入', desc: '粘贴或上传单词/短语/缩写，解析成词条' },
  { path: '/learn', label: '背诵', desc: '白纸空间记忆：靠位置 + 语音建立记忆' },
  { path: '/memorize', label: '记忆', desc: '默写自测，未通过优先再抽，接拼写环节' },
  { path: '/list', label: '单词列表', desc: '筛选 / 编辑属性 / 斩词复活' },
  { path: '/review', label: '复习', desc: '按复习优先度分组抽取' },
  { path: '/settings', label: '设置', desc: '星号参数 / AI 接口 / 备份恢复' },
];

/**
 * 主页：6 个入口 + 词库概览 + 未完成会话角标。
 * 背诵/复习有未完成会话时显示「上次未完成：N 词」，点击询问继续还是重新开始。
 */
export function renderHomePage(): HTMLElement {
  const page = h('div', { class: 'page home-page' });
  page.appendChild(h('h2', { class: 'page-title', text: '单词白纸' }));
  page.appendChild(
    h('p', { class: 'note' }, '本地离线、单用户的背单词工具。条目可以是单词、短语（give up）或缩写（NASA / etc.）。数据存在本机浏览器里，不联网（AI 解析除外）。'),
  );

  const grid = h('div', { class: 'home-grid' });

  /** 进入背诵/复习：检查是否有未完成会话 */
  const enterLearning = (path: '/learn' | '/review'): void => {
    void (async () => {
      const existing = await dao.session.loadSession();
      const match =
        existing &&
        !existing.finished &&
        existing.wordIds.length > 0 &&
        ((path === '/learn' && existing.type === 'learn') || (path === '/review' && existing.type === 'review'));
      if (match) {
        const resume = await confirmModal(
          '上次未完成',
          `上次有 ${existing.wordIds.length} 个词的会话没做完。继续上次（进度从零开始、落点重新布），还是重新开始？`,
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
      else if (entry.path === '/memorize') {
        void (async () => {
          const session = await dao.session.loadSession();
          if (!session || session.finished || session.type !== 'learn' || session.wordIds.length === 0) {
            toastWarn('请先开始一轮背诵');
            navigate('/learn');
            return;
          }
          navigate('/memorize');
        })();
      } else navigate(entry.path);
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
