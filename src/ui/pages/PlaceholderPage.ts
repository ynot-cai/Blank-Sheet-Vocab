import { button, h } from '../dom';
import { currentPath } from '../router';

/**
 * 占位页（版本 0.0.3）。
 *
 * ── 为什么需要它 ──
 * 首页按用户要求放了六个按钮，但其中五项目前**没有实现**：
 * 录入 / 背诵 / 复习 / 单词列表在 0.0.1 的「删除与归档行动」里被归档删除，
 * 拼写强化是尚未开发的新功能（用户明确说「现在先别做，只做按钮」）。
 *
 * 如果不管它们，点了按钮会走路由兜底**回落首页**——用户的判断是「按钮坏了」，
 * 而真实原因是「功能被归档了」。这两件事必须能分辨，所以给一个明确的占位页：
 * **点得进去、说清现状、指向归档文档、给出下一步**。
 *
 * ── 这不是「假页面」──
 * 它不伪造任何功能，也不假装加载中；它只陈述事实。
 * 对应模块真正装回来之后，`App.ts` 里那一条 `registerRoute` 换掉即可，
 * 本文件与其余路由都不受影响。
 */
export interface PlaceholderSpec {
  /** 路由路径，如 `/import` */
  path: string;
  /** 按钮/页面名 */
  label: string;
  /** 第一排（学习练习类）还是第二排（数据与设置类） */
  row: 1 | 2;
  /** 状态：归档待恢复 / 尚未开发 */
  status: 'archived' | 'planned';
  /** 现状说明（一到两句） */
  note: string;
  /** 关于它的归档文档或需求出处 */
  reference: string;
}

/** 五个未实现入口的说明（顺序与首页按钮一致） */
export const PLACEHOLDER_SPECS: PlaceholderSpec[] = [
  {
    path: '/import',
    label: '录入',
    row: 1,
    status: 'archived',
    note: '把粘贴或上传的生词文本解析成词条。该页面及其四个子面板在版本 0.0.1 的「删除与归档行动」中被整体归档。它的解析管线（services/ai、core/model 等）仍在程序里，所以恢复代价不高。',
    reference: '已归档/04_录入功能.md',
  },
  {
    path: '/learn',
    label: '背诵',
    row: 1,
    status: 'archived',
    note: '白纸空间记忆：靠位置 + 语音建立记忆。它与背诵流程共用的「白纸画布」一起被归档，是本次归档里最大的一块。',
    reference: '已归档/05_背诵页.md ＋ 已归档/02_白纸流程_背诵与复习的核心画布.md',
  },
  {
    path: '/review',
    label: '复习',
    row: 1,
    status: 'archived',
    note: '按复习优先度抽词复习。它与背诵共用同一套白纸画布，所以恢复复习必然连带恢复白纸流程。注意：优先度公式本体（core/priority.ts）**没有被归档**，仍在程序里。',
    reference: '已归档/06_复习页.md ＋ 已归档/02_白纸流程_背诵与复习的核心画布.md',
  },
  {
    path: '/spell',
    label: '拼写强化',
    row: 1,
    status: 'planned',
    note: '全新的独立功能：只做拼写，不用白纸空间。用户已明确「现在先别做，只做按钮」，因此本页只说明状态——具体行为（题面给什么、抽哪些词、判分口径、一轮多少个）尚未确定，定义清楚之前不开工。',
    reference: '关于项目/版本更新日志.md 版本 0.0.3 第五节',
  },
  {
    path: '/list',
    label: '单词列表',
    row: 2,
    status: 'archived',
    note: '查看和访问单词数据：筛选、编辑属性、斩词与复活。它由用户点名归档（第 7 条要求）。数据层完好——dao/words.ts 的查询、统计、斩与复活**一个方法都没少**，缺的只是界面。',
    reference: '已归档/08_单词列表功能.md',
  },
];

/**
 * 渲染占位页。
 * @param spec 该入口的说明
 */
export function renderPlaceholderPage(spec: PlaceholderSpec): HTMLElement {
  const page = h('div', { class: 'page placeholder-page' });

  page.appendChild(h('h2', { class: 'page-title', text: spec.label }));
  page.appendChild(
    h('p', {
      class: 'note warn',
      text: spec.status === 'archived' ? '该功能已归档，当前版本里没有实现。' : '该功能尚未开发（按用户要求：先只做按钮）。',
    }),
  );
  page.appendChild(h('p', { class: 'note', text: spec.note }));
  page.appendChild(
    h('p', { class: 'note' }, `出处 / 恢复方法：${spec.reference}`),
  );
  page.appendChild(
    h(
      'p',
      { class: 'note' },
      spec.row === 1
        ? '它属于第一排（会进入学习或练习的功能）。'
        : '它属于第二排（数据查看与系统设置）。',
    ),
  );

  const row = h('div', { class: 'row' });
  row.appendChild(button('返回首页', () => (window.location.hash = '#/home'), { variant: 'primary' }));
  row.appendChild(button('打开设置', () => (window.location.hash = '#/settings')));
  page.appendChild(row);

  // 当前路径放在最后一行，排查时一眼能看出「按钮跳对了没有」
  page.appendChild(h('p', { class: 'note', text: `当前路由：${currentPath()}` }));

  return page;
}
