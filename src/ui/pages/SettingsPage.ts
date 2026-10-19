import { DEFAULT_SETTINGS } from '../../core/config';
import { appVersionLabel } from '../../core/version';
import { button, details, h } from '../dom';
import { renderAiSection } from './settings/AiSection';
import { renderAppearanceSection } from './settings/AppearanceSection';
import { renderCloudSection } from './settings/CloudSection';
import { renderDataSection } from './settings/DataSection';
import { renderExamSection } from './settings/ExamSection';
import { renderSpeechSection } from './settings/SpeechSection';
import { patchSettings } from './settings/ctx';

/** 一个设置分组的定义 */
interface Section {
  /** 分组 id（`data-section`，测试与跳转锚点用） */
  id: string;
  /** 折叠标题 */
  title: string;
  /** 默认是否展开 */
  defaultOpen: boolean;
  /** 渲染分组内容；返回 `null` 表示「暂时留空」（只挂壳，不摆控件） */
  render: (() => HTMLElement) | null;
  /** 描述「重置该分组」会恢复什么（写在错误提示里，让用户知道点下去会变什么） */
  resetNote: string;
  /** 执行重置（**只动这一组的字段**） */
  reset: () => Promise<void>;
}

/**
 * 设置页（版本 0.0.19）。
 *
 * ★ **分区现在是五个：数据 / AI / 外观 / 背诵设置 / 音频设置**。
 *   - 「数据」「AI」：0.0.3 用户手动划分时的两个分区，内容一路保留；
 *   - 「外观」：0.0.3 时留空（用户说具体项由他手动划分），0.0.19 按提示词 10 装进
 *     **分辨率大小** 与 **字体大小** 两项（见 `settings/AppearanceSection.ts`）；
 *   - 「背诵设置」：0.0.19 新增（提示词 10），三项考核配置当前只存值
 *     （见 `settings/ExamSection.ts`）；
 *   - 「音频设置」：0.0.19 新增（提示词 10「完全按照旧版本的样子原封不动地恢复」），
 *     组件是归档 `已归档/11` 第 4 节 `SpeechSection.ts` 的原样写回，
 *     配套的整套语音朗读模块按 `已归档/12_语音朗读模块.md` 一字不改恢复。
 *
 * ── 与 0.0.1 的关系 ──
 * 0.0.1 曾把设置页砍到三项（同步 / AI 接口 / 复习优先度计算公式）。
 * 0.0.3 按用户的新划分**整段替换**：
 * - 「同步」→ 归入 **数据** 区（同一个 `CloudSection`，只是换了归属与标题）；
 * - 「AI 接口」→ **AI** 区（原 `AiSection`，一字未改）；
 * - 「复习优先度计算公式」→ **不给界面入口**（用户明确说「因为我要重做这个公式」）。
 *   注意：**代码与数据都还在**（`core/priority.ts`、`settings.priority`），只是界面上碰不到，
 *   等公式重做完再决定它挂在哪一区。
 *
 * ── 为什么每份被砍掉的分区都还有归档文档 ──
 * 0.0.1 归档的六个分区（星号参数 / 画面与纸张 / 布局参数 / 记忆与练习 / 语音 / 数据备份）
 * 完整源码在 `已归档/11_设置页被删除的分区.md`。本版按用户要求只恢复了**语音**那一区
 * （音频设置），其余仍**没有**装回来；将来若要其中的某几项，按那份文档单独还原即可。
 *
 * ── 骨架加固（沿用 0.0.1 的成果）──
 * 每个分区独立 `try/catch`：某一组渲染失败只影响它自己，其他分组照常可用，
 * 并给一个「重置该分组」的自救出口。
 */
export function renderSettingsPage(): HTMLElement {
  const page = h('div', { class: 'page settings-page' });
  page.appendChild(h('h2', { class: 'page-title', text: '设置' }));
  page.appendChild(h('p', { class: 'note' }, '设置改动即存，存在本机浏览器里。'));

  /** 三个分区（顺序即界面顺序：数据 / AI / 外观） */
  const sections: Section[] = [
    {
      id: 'data',
      title: '数据',
      defaultOpen: true,
      /**
       * ★ 版本 0.0.6：按用户要求**装回归档的「数据」分区设置项**
       *   （`已归档/11_设置页被删除的分区.md` 里的 `DataSection`）：
       *   统计行 / 导出备份 / 从备份恢复 / 清空数据 / 本地文件夹自动备份。
       *   「从备份恢复」就是用户说的「让之前归档的单词或数据恢复到正常列表」——
       *   它把备份文件里的词条与来源整体写回词库。
       *
       *   云同步（`CloudSection`）本来就在这一区，两段并排放在同一个折叠块里：
       *   上面「同步」、下面「备份与本地文件夹」。两者都是「数据」。
       */
      render: () => {
        const box = h('div', { class: 'stack' });
        box.appendChild(h('h4', { class: 'sub-title', text: '同步' }));
        box.appendChild(renderCloudSection());
        box.appendChild(h('h4', { class: 'sub-title', text: '备份与本地文件夹' }));
        box.appendChild(renderDataSection());
        return box;
      },
      resetNote: '只关掉云同步开关并清掉后端地址与同步码，本地数据一个都不删',
      reset: () => patchSettings({ cloud: { ...DEFAULT_SETTINGS.cloud } }),
    },
    {
      id: 'ai',
      title: 'AI',
      defaultOpen: true,
      render: renderAiSection,
      resetNote: '只清掉 AI 的接口地址与密钥，其他设置一个都不动',
      reset: () => patchSettings({ ai: { ...DEFAULT_SETTINGS.ai } }),
    },
    {
      id: 'appearance',
      title: '外观',
      defaultOpen: false,
      /**
       * ★ 版本 0.0.19（提示词 10 第 2 条）：外观区不再是空的，装了两项——
       *   分辨率大小（可调尺寸选项）/ 字体大小（只影响白纸界面本体，相对比例不变）。
       *   具体实现见 `settings/AppearanceSection.ts`。
       */
      render: renderAppearanceSection,
      resetNote: '把分辨率恢复成自适应窗口、字体大小恢复成默认值，其他设置一个都不动',
      reset: () =>
        patchSettings({ paper: { ...DEFAULT_SETTINGS.paper }, display: { ...DEFAULT_SETTINGS.display } }),
    },
    {
      id: 'exam',
      title: '背诵设置',
      defaultOpen: false,
      /**
       * ★ 版本 0.0.19（提示词 10 第 2 条）：新增主分类「背诵设置」——
       *   每出现几个单词进行一次考核（占位变量）/ 每次考核数 / 考核严格程度（低中高）。
       *   三项当前**只存值**，不参与任何判断（见 `settings/ExamSection.ts`）。
       */
      render: renderExamSection,
      resetNote: '把考核频率、每次考核数、严格程度恢复成默认值，其他设置一个都不动',
      reset: () => patchSettings({ exam: { ...DEFAULT_SETTINGS.exam } }),
    },
    {
      id: 'speech',
      title: '音频设置',
      defaultOpen: false,
      /**
       * ★ 版本 0.0.19（提示词 10 第 2 条）：新增主分类「音频设置」，
       *   用户要求「完全按照旧版本的样子原封不动地恢复」。
       *   → 组件是归档 `已归档/11` 第 4 节的 `SpeechSection.ts` **原样写回**，
       *     它依赖的整套语音朗读模块（`services/tts/` + `api/tts-proxy.ts`）也已按
       *     `已归档/12_语音朗读模块.md` 逐字恢复，所以这里只是把分区挂回设置页。
       *   ⚠️ 归档里那一分区的标题是「语音」，本版按用户提示词 10 叫「音频设置」。
       */
      render: renderSpeechSection,
      resetNote: '把语音来源、语速、口音、有道密钥恢复成默认值，语音缓存不删',
      reset: () => patchSettings({ speech: { ...DEFAULT_SETTINGS.speech } }),
    },
  ];

  for (const section of sections) {
    // ① 骨架先挂上：即使下面渲染失败，分组标题也一定在页面上
    const el = details(section.title, [], section.defaultOpen);
    el.dataset.section = section.id;
    page.appendChild(el);

    const body = el.querySelector('.section-body');
    if (!body) continue; // details() 一定建 body；真没有就只留骨架，不影响其他分组

    // ② 留空的分区：只挂壳，并说明为什么是空的
    if (section.render === null) {
      body.appendChild(
        h('p', { class: 'note' }, '本分区的具体设置项由用户手动划分，尚未确定，因此暂时留空。'),
      );
      continue;
    }

    // ③ 内容独立 try/catch
    try {
      body.appendChild(section.render());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[settings] 分组「${section.title}」渲染失败`, err);
      body.replaceChildren(failedSection(message, section.resetNote, section.reset));
    }
  }

  // 版本信息（不是设置项，是「我现在跑的是哪一版」的自报家门）
  page.appendChild(h('p', { class: 'note app-version-line', text: appVersionLabel() }));

  return page;
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
