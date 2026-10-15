import { DEFAULT_SETTINGS } from '../../core/config';
import { appVersionLabel } from '../../core/version';
import { button, details, h } from '../dom';
import { renderAiSection } from './settings/AiSection';
import { renderCloudSection } from './settings/CloudSection';
import { renderPrioritySection } from './settings/PrioritySection';
import { patchSettings } from './settings/ctx';

/** 一个设置分组的定义 */
interface Section {
  /** 分组 id（`data-section`，测试与跳转锚点用） */
  id: string;
  /** 折叠标题 */
  title: string;
  /** 默认是否展开 */
  open: boolean;
  /** 渲染分组内容 */
  render: () => HTMLElement;
  /** 描述「重置该分组」会恢复什么（写在错误提示里，让用户知道点下去会变什么） */
  resetNote: string;
  /** 执行重置（**只动这一组的字段**） */
  reset: () => Promise<void>;
}

/**
 * 设置页。
 *
 * ★ 版本 0.0.1「删除与归档行动」：**只保留三项**
 *   1. 同步（云同步：开关 / 后端地址 / 同步码 / 手动同步 / 强制覆盖）
 *   2. AI 接口（接口地址 / 模型名 / 密钥）
 *   3. 复习优先度计算公式（预设三档 + 自定义表达式）
 *   另外保留一个**空的「画面设置」分类外壳**（用户明确允许保留这类可展开收起的外壳，
 *   但壳里的具体设置项不属于保留项，已全部删除）。
 *
 * ── 被删掉的五个分区去哪了 ──
 *   A. 星号参数（背诵/记忆/复习的规模）
 *   C. 画面与纸张
 *   C2. 布局参数
 *   D. 记忆与练习
 *   H. 语音（朗读音色 / 有道 TTS / 缓存）
 *   G. 数据（备份 / 恢复 / 清空）—— 该分区的**全部内容**也已删除
 *   六份分区的完整源码见 已归档/11_设置页被删除的分区.md，可直接按原路径还原。
 *
 * ⚠️ 这些分区对应的**设置字段与默认值仍然完整保留在 `core/config.ts` 里**
 *   （数据层不动），所以把分区文件放回、在下面的 `sections` 数组里加回一行，
 *   功能立刻就能恢复，不需要改任何数据。
 *
 * ── 骨架加固（原 T1 的成果，保留）──
 * 每个分区独立 try/catch：某一组渲染失败只影响它自己，其他分组照常可用，
 * 并给一个「重置该分组」的自救出口。
 */
export function renderSettingsPage(): HTMLElement {
  const page = h('div', { class: 'page settings-page' });
  page.appendChild(h('h2', { class: 'page-title', text: '设置' }));
  page.appendChild(h('p', { class: 'note' }, '设置改动即存，存在本机浏览器里。'));

  /** 保留的三个分区（顺序即界面顺序） */
  const sections: Section[] = [
    {
      id: 'sync',
      title: '同步',
      open: true,
      render: renderCloudSection,
      resetNote: '只关掉云同步开关，本地数据一个都不删',
      reset: () => patchSettings({ cloud: { ...DEFAULT_SETTINGS.cloud } }),
    },
    {
      id: 'ai',
      title: 'AI 接口（接口地址 / 模型名 / 密钥自己填）',
      open: true,
      render: renderAiSection,
      resetNote: '只清掉 AI 的接口地址与密钥，其他设置一个都不动',
      reset: () => patchSettings({ ai: { ...DEFAULT_SETTINGS.ai } }),
    },
    {
      id: 'priority',
      title: '复习优先度计算公式',
      open: true,
      render: renderPrioritySection,
      resetNote: '恢复优先度公式的默认预设（不改任何学习记录）',
      reset: () => patchSettings({ priority: { ...DEFAULT_SETTINGS.priority } }),
    },
  ];

  for (const section of sections) {
    // ① 骨架先挂上：即使下面渲染失败，分组标题也一定在页面上
    const el = details(section.title, [], section.open);
    el.dataset.section = section.id;
    page.appendChild(el);

    const body = el.querySelector('.section-body');
    if (!body) continue; // details() 一定建 body；真没有就只留骨架，不影响其他分组

    // ② 内容独立 try/catch
    try {
      body.appendChild(section.render());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[settings] 分组「${section.title}」渲染失败`, err);
      body.replaceChildren(failedSection(message, section.resetNote, section.reset));
    }
  }

  // ③ 用户明确允许保留的「分类外壳」：只留一个可展开收起的空壳，壳内没有任何设置项
  page.appendChild(renderDisplayShell());

  // ④ 版本信息（不是设置项，是「我现在跑的是哪一版」的自报家门）。
  //    为什么放在设置页：主页按要求只剩「设置」一个按钮，版本号放在主页会变成多余元素；
  //    而排查问题时第一个打开的通常就是设置页。
  page.appendChild(h('p', { class: 'note app-version-line', text: appVersionLabel() }));

  return page;
}

/**
 * 「画面设置」空分类外壳。
 *
 * 为什么留一个空壳：用户明确说「允许保留『画面设置』这类可展开收起的分类外壳，
 * 但分类内具体设置项除非属于保留项，否则删除」。留壳的好处是**位置感**——
 * 一眼能看出这里原来有一整类设置、以及它现在在哪。
 */
function renderDisplayShell(): HTMLElement {
  const el = details('画面设置', [], false);
  el.dataset.section = 'display';
  const body = el.querySelector('.section-body');
  if (body) {
    body.appendChild(
      h(
        'p',
        { class: 'note' },
        '本分类下的具体设置项（字号 / 颜色 / 动画 / 纸张 / 布局参数 / 语音）已按版本 0.0.1 的要求删除，'
          + '完整源码与恢复方法见「已归档/11_设置页被删除的分区.md」。'
          + '这些设置字段与默认值仍完整保留在程序的数据层里，恢复分区文件后即可重新生效。',
      ),
    );
  }
  return el;
}

/**
 * 生成「这一组渲染失败」的占位内容。
 *
 * 只给两个动作：重置该分组 / 返回首页。不提供「展开看堆栈」——用户看不懂，
 * 而堆栈已经打到控制台了。
 * @param message 错误信息
 * @param resetNote 重置会恢复什么
 * @param reset 重置动作
 */
function failedSection(message: string, resetNote: string, reset: () => Promise<void>): HTMLElement {
  const box = h('div', { class: 'section-failed' });
  box.dataset.role = 'settings-section-failed';
  box.appendChild(h('div', { class: 'section-failed-title', text: `这一组读不出来了：${message}` }));
  box.appendChild(
    h('div', { class: 'section-failed-note', text: `其他分组不受影响，可以照常使用。「重置该分组」会${resetNote}。` }),
  );
  const actions = h('div', { class: 'section-failed-actions' });
  actions.appendChild(
    button(
      '重置该分组',
      () => {
        void reset()
          .then(() => window.location.reload())
          .catch((err: unknown) => {
            console.error('[settings] 重置分组失败', err);
            box.appendChild(h('div', { class: 'section-failed-note', text: '重置失败，可以试试点上面的「返回首页」。' }));
          });
      },
      { variant: 'primary', class: 'section-failed-reset' },
    ),
  );
  actions.appendChild(
    button(
      '返回首页',
      () => {
        window.location.hash = '#/home';
      },
      { variant: 'ghost' },
    ),
  );
  box.appendChild(actions);
  return box;
}
