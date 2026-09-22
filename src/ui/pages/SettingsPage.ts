import { defaultTierCopy, DEFAULT_SETTINGS } from '../../core/config';
import { button, details, h } from '../dom';
import { renderAiSection } from './settings/AiSection';
import { renderCloudSection } from './settings/CloudSection';
import { renderDataSection } from './settings/DataSection';
import { renderDisplaySection } from './settings/DisplaySection';
import { renderLayoutSection, isLayoutDirty } from './settings/LayoutSection';
import { renderPracticeSection } from './settings/PracticeSection';
import { renderPrioritySection } from './settings/PrioritySection';
import { renderSpeechSection } from './settings/SpeechSection';
import { renderStarParamsSection } from './settings/StarParamsSection';
import { discardDraft } from './settings/layoutDraft';
import { patchSettings } from './settings/ctx';
import { clearTtsCache } from '../../services/tts';

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
 * 设置页：A~G 八个折叠分区，默认展开 A 和 G。
 *
 * ── T1：骨架加固（阶段文档 T1 任务 4）──
 * 以前这里是「一次性把八个分组全部渲染出来再挂上去」：
 * `renderLayoutSection()` 里只要抛一次（实测就是 `layout.mobile.button` 丢失导致的
 * `TypeError: Cannot read properties of undefined (reading 'diameterPx')`），
 * 整页就只剩 `router` 兜底的一行「页面渲染失败：…」——
 * 用户看到的是**所有设置都打不开**，连出事的那一项都碰不到，只能清数据自救。
 *
 * 现在改成三段式：
 * 1. **先渲染外壳**：标题 + 说明先挂上去，下面是八个分区的骨架（`details` + 标题），
 *    页面结构一定存在，任何一段内容失败都不会变成白屏；
 * 2. **每个分组独立 try/catch**：某一组抛错只影响它自己，其他分组照常可用；
 * 3. **崩溃组显示「重置该分组」**：给一个能自救的出口。
 *    重置只动这一组的字段，不碰词库 / 学习记录 / 同步码。
 */
export function renderSettingsPage(): HTMLElement {
  const page = h('div', { class: 'page settings-page' });
  page.appendChild(h('h2', { class: 'page-title', text: '设置' }));
  page.appendChild(
    h(
      'p',
      { class: 'note' },
      '设置改动即存，存在本机浏览器里。星号参数（A 区）会影响背诵/记忆/复习的行为，建议先按默认值用一阵子再调。',
    ),
  );

  /** 八个分组（顺序即界面顺序） */
  const sections: Section[] = [
    {
      id: 'A',
      title: 'A. 星号参数（背诵 / 记忆 / 复习的规模）',
      open: true,
      render: renderStarParamsSection,
      resetNote: '把规模参数恢复成默认值（词库与学习记录不受影响）',
      reset: () =>
        patchSettings({
          memorizeMaxPick: DEFAULT_SETTINGS.memorizeMaxPick,
          memorizeTargetCount: DEFAULT_SETTINGS.memorizeTargetCount,
          memorizeEvery: DEFAULT_SETTINGS.memorizeEvery,
          failCountCap: DEFAULT_SETTINGS.failCountCap,
          reviewGroupSize: DEFAULT_SETTINGS.reviewGroupSize,
        }),
    },
    {
      id: 'B',
      title: 'B. AI 解析（接口地址 / 模型名 / 密钥自己填）',
      open: false,
      render: renderAiSection,
      resetNote: '只清掉 AI 的接口地址与密钥，其他设置一个都不动',
      reset: () => patchSettings({ ai: { ...DEFAULT_SETTINGS.ai } }),
    },
    {
      id: 'C',
      title: 'C. 画面与纸张',
      open: false,
      render: renderDisplaySection,
      resetNote: '恢复字号 / 颜色 / 动画与纸张的默认值',
      reset: () => patchSettings({ display: { ...DEFAULT_SETTINGS.display }, paper: { ...DEFAULT_SETTINGS.paper } }),
    },
    {
      // ★ M2：布局参数独立成一节（手机一屏放几个词就靠它）
      id: 'C2',
      title: 'C2. 布局参数（手机一屏放几个词 / 按钮大小）',
      open: false,
      render: renderLayoutSection,
      resetNote: '把三档布点参数与列数恢复成默认值（词库与学习记录不受影响）',
      reset: () =>
        patchSettings({
          layout: {
            mobile: defaultTierCopy('mobile'),
            tablet: defaultTierCopy('tablet'),
            desktop: defaultTierCopy('desktop'),
          },
          layoutColsOverride: 'auto',
        }),
    },
    {
      id: 'D',
      title: 'D. 记忆与练习',
      open: false,
      render: renderPracticeSection,
      resetNote: '恢复朗读与练习相关设置的默认值',
      reset: () => patchSettings({ practice: { ...DEFAULT_SETTINGS.practice } }),
    },
    {
      id: 'E',
      title: 'E. 复习优先度',
      open: false,
      render: renderPrioritySection,
      resetNote: '恢复优先度公式的默认预设（不改任何学习记录）',
      reset: () => patchSettings({ priority: { ...DEFAULT_SETTINGS.priority } }),
    },
    {
      id: 'F',
      title: 'F. 云同步（多设备共用一份数据，可选）',
      open: false,
      render: renderCloudSection,
      resetNote: '只关掉云同步开关，本地数据一个都不删',
      reset: () => patchSettings({ cloud: { ...DEFAULT_SETTINGS.cloud } }),
    },
    {
      id: 'G',
      title: 'G. 数据（备份 / 恢复 / 清空）',
      open: true,
      render: renderDataSection,
      resetNote: '数据区不提供重置（避免误删词库），请用这一组里的导出 / 恢复按钮',
      reset: () => Promise.resolve(),
    },
    {
      /**
       * ★ T4：朗读设置。
       *
       * 为什么放在 G 之后而不是插进字母序列：`data-section` 的 id 被 UI 验收
       * (`test-t1-ui` 断言 8 个分组、`test-t2-ui`/`test-t3-ui` 按 id 找 E / D 区)
       * 当作锚点用，插队会让后面所有分组改字母、连带改测试。
       * 用语义 id `speech` 定住它，界面标题里的字母只影响观感。
       */
      id: 'speech',
      title: 'H. 语音（朗读音色 / 有道 TTS / 缓存）',
      open: false,
      render: renderSpeechSection,
      resetNote: '把朗读恢复到浏览器内置语音、自动挑音色、语速 0.9，并清空有道密钥（会一并清掉语音缓存）',
      reset: async () => {
        await patchSettings({ speech: { ...DEFAULT_SETTINGS.speech } });
        await clearTtsCache();
      },
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

  // ③ 有未应用的布局修改：显式提示（草稿只在内存里，刷新即丢，**不会**写坏设置）
  if (isLayoutDirty()) {
    const hint = h('div', { class: 'settings-dirty-hint' });
    hint.dataset.role = 'settings-dirty-hint';
    hint.appendChild(h('span', { text: '⚠ C2 布局参数里有未应用的修改（不会自动保存）。' }));
    hint.appendChild(
      button(
        '去应用或取消',
        () => {
          const target = page.querySelector('details[data-section="C2"]');
          if (target instanceof HTMLDetailsElement) {
            target.open = true;
            target.scrollIntoView({ block: 'start' });
          }
        },
        { variant: 'ghost' },
      ),
    );
    hint.appendChild(
      button(
        '丢弃这些修改',
        () => {
          discardDraft();
          window.location.reload();
        },
        { variant: 'ghost', class: 'settings-dirty-discard' },
      ),
    );
    page.appendChild(hint);
  }

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
