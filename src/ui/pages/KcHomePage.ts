/**
 * 二期首页（`#/kc`）。
 *
 * 阶段 02 只做「录入」这一个真入口 + 其余入口的占位按钮
 * （阶段 03 做卡片列表、04 学习、05 题库、06 复习、07 设置）。
 *
 * 之所以现在就把 6 个按钮摆出来：用户从一期主界面点「知识点」进来以后，
 * 应该立刻看到二期**是什么形状**（学和复习是主线），而不是面对一个孤零零的录入按钮。
 * 未实现的按钮点了给一句明确提示，不假装能用。
 */
import * as dao from '../../dao';
import { h } from '../dom';
import { navigate } from '../router';
import { toastWarn } from '../components/Toast';
import { renderKcContextBar } from '../components/KcContextBar';
import { bankAddButton, createKcContextManager } from '../components/KcContextManager';

/** 一个入口按钮的描述 */
interface KcEntry {
  key: string;
  label: string;
  desc: string;
  /** 已实现的入口给路由；未实现的给 null（点了弹提示） */
  path: string | null;
  /** 未实现时提示里说的阶段 */
  stage?: string;
}

/** 入口（顺序 = 用户建议的使用顺序） */
const ENTRIES: KcEntry[] = [
  { key: 'import', label: '录入', desc: '说说你哪里不行，AI 帮你拆成知识点卡片', path: '/kc/import' },
  { key: 'list', label: '卡片列表', desc: '查看、编辑、斩掉知识点', path: '/kc/list' },
  { key: 'study', label: '学习', desc: '逐张看卡片 + 自评，看完直接接着做题', path: '/kc/study' },
  { key: 'review', label: '复习', desc: '看卡片 → 背 5 个单词 → 做题', path: '/kc/review' },
  { key: 'bank', label: '题库', desc: '存参考样题，让 AI 出题更像真题', path: '/kc/bank' },
  { key: 'settings', label: '设置', desc: '掌握度公式与复习优先度', path: '/kc/settings' },
];
// ⚠️ 这里**故意没有「做题」入口**（用户明确要求删掉）：做题是学习/复习流程里的一步，
// 单独摆一个按钮会让用户面对「没有进行中的学习」的空页面 ——
// 中途退出后再点「学习」会自然回到那道题（见 KcStudyPage 启动逻辑）。

/**
 * 渲染二期首页。
 */
export function renderKcHomePage(): HTMLElement {
  const page = h('div', { class: 'page kc-home' });

  page.appendChild(
    h(
      'header',
      { class: 'kc-home-head' },
      h('h1', { class: 'kc-home-title', text: '知识点精学' }),
      h('p', {
        class: 'kc-home-sub',
        text: '一期泛背单词（量大、浅层），二期精学知识点（量少、深层）：看卡片 → 自评 → 做题 → 复习。',
      }),
    ),
  );

  // 统计条：先给个「现在有多少张卡」的实数，比空页面有信息量
  const statsBox = h('div', { class: 'kc-home-stats' }, h('span', { class: 'kc-home-stats-loading', text: '正在统计…' }));
  page.appendChild(statsBox);

  // ── 今日语境词（阶段 05）：出题时会从这 5 个词里挑一个融入题目 ──
  const contextBox = h('div', { class: 'kc-home-context' });
  page.appendChild(contextBox);
  /** 语境词管理器（生成 / 编辑 / 确认） */
  const ctxManager = createKcContextManager(() => void paintContext());
  /** 重画语境词区 */
  const paintContext = async (): Promise<void> => {
    const today = await dao.contextWords.getForDate();
    contextBox.replaceChildren(
      renderKcContextBar(today, ctxManager.isLoading(), {
        onGenerate: () => void ctxManager.generate(),
        onEdit: () => void ctxManager.edit(),
        onConfirm: () => void ctxManager.confirm(),
      }),
    );
  };
  void paintContext();

  // ── 题库快捷入口（阶段 05）：出题时会参考题库样题 ──
  const bankRow = h('div', { class: 'kc-home-bankrow' });
  bankRow.appendChild(h('span', { class: 'kc-hint-dim', text: '题库：让 AI 出的题更像真题' }));
  bankRow.appendChild(bankAddButton(() => void toastWarn('已加入题库，去「题库」页可以看')));
  page.appendChild(bankRow);

  const grid = h('div', { class: 'kc-home-grid' });
  for (const entry of ENTRIES) {
    const ready = entry.path !== null;
    const card = h('button', {
      class: `kc-entry${ready ? '' : ' kc-entry--todo'}`,
      type: 'button',
      onclick: () => {
        if (entry.path !== null) navigate(entry.path);
        else toastWarn(`「${entry.label}」还没做，等${entry.stage ?? '后续阶段'}`);
      },
    });
    card.appendChild(h('span', { class: 'kc-entry-label', text: entry.label }));
    card.appendChild(h('span', { class: 'kc-entry-desc', text: entry.desc }));
    if (!ready) card.appendChild(h('span', { class: 'kc-entry-todo', text: `${entry.stage ?? '后续'} · 待做` }));
    grid.appendChild(card);
  }
  page.appendChild(grid);

  // 统计是异步的：先渲染页面骨架，数字回来再填（避免整页等数据库）
  void (async () => {
    try {
      const [kcStats, wordStats] = await Promise.all([dao.kc.stats(true), dao.words.stats()]);
      statsBox.replaceChildren(
        h('span', { class: 'kc-stat', text: `知识点 ${kcStats.total} 张` }),
        h('span', { class: 'kc-stat', text: `未学 ${kcStats.unlearned}` }),
        h('span', { class: 'kc-stat', text: `学习中 ${kcStats.learning}` }),
        h('span', { class: 'kc-stat', text: `已学 ${kcStats.learned}` }),
        h('span', { class: 'kc-stat', text: `已斩 ${kcStats.chopped}` }),
        h('span', { class: 'kc-stat kc-stat--dim', text: `（一期词库 ${wordStats.total} 个词）` }),
      );
    } catch (err) {
      console.warn('[KcHomePage] 统计失败', err);
      statsBox.replaceChildren(h('span', { class: 'kc-stat kc-stat--dim', text: '统计读不出来，不影响使用' }));
    }
  })();

  return page;
}
