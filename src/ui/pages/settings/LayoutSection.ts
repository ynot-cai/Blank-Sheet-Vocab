/**
 * 设置页 · 布局参数（阶段 M2 建立，S3 扩展，**T1 改为确认制**）。
 *
 * 为什么要有这一节：一屏放几个词、怎么排，完全由这几个数字决定——
 * 边距 / 间距 / 字号 / 目标数 / 按钮直径 / 按钮间距，外加 S3 的**列数覆盖**。
 *
 * ── T1 改了什么（以及为什么）──
 * 以前这里每一处改动都是「改一下立刻写库 + 全应用重算」。T1 诊断实测到这条路
 * 会**把设置写坏**：改一次手机档「边距 px」让 `layout.mobile` 变成
 * `{ edgeMarginPx: 18 }`（`button` 子树丢失），设置页当场弹致命页，
 * 而这份残缺数据已经落库 → **每次打开设置页都白屏**。
 *
 * 现在改成「**编辑 → 确认 → 应用**」：
 * - 改控件 → 只更新内存草稿（见 `layoutDraft.ts`）+ 刷新预览，
 *   不写 settings、不写库、不触发全局重算；
 * - 出现「⚠ 有未应用的修改」+ [取消] [应用并预览]；
 * - 点「应用并预览」→ 一次性写完整（已净化）的布局 → 进入 8 秒观察期（见 `layoutObserve.ts`）；
 * - 点「取消」→ 丢弃草稿，控件回到已保存值；
 * - 未应用就离开 → 草稿在内存里，天然不落盘（验收项「未应用不落盘」）。
 *
 * ★ 只在「会触发布局重算」的项上加确认：AI 配置、同步码、备份那些分组保持即时生效。
 *
 * 另外两道防线也在这里落地：
 * - **预览隔离**：预览在独立容器里单独渲染 + 单独 try/catch + 200ms 防抖，
 *   预览崩了只显示「预览不可用」，控件照常能用（见 `layoutPreview.ts`）；
 * - **渲染前净化**：所有数字都过 `getPresetParams` / `clampNum`，
 *   残缺或越界的数据不可能进到 DOM 与算法里。
 */
import {
  clampNum,
  coerceColsOverride,
  defaultTierCopy,
  getPresetParams,
  LAYOUT_COLS_OPTIONS,
  layoutRangeOf,
} from '../../../core/config';
import { controlBandHeight } from '../../../core/layout';
import { button, debounce, h, numberInput, select } from '../../dom';
import { currentSettings } from './ctx';
import {
  currentDraft,
  discardDraft,
  editButtonField,
  editColsOverride,
  editTierField,
  isDirty,
  resetTierToDefault,
  type LayoutButtonFieldKey,
  type LayoutFieldKey,
  type LayoutTierKey,
} from './layoutDraft';
import { applyLayoutWithObserve } from './layoutObserve';
import { computePreview, PREVIEW_FAILED_TEXT, renderPreview } from './layoutPreview';

/** 预览防抖时长（毫秒）：阶段文档 T1 任务 2.1 指定 200ms */
const PREVIEW_DEBOUNCE_MS = 200;

/** 可调项的说明（写在输入框下方，避免用户不知道该调大还是调小） */
const HINTS: Record<LayoutFieldKey | LayoutButtonFieldKey, string> = {
  edgeMarginPx: '与纸面边界的最小距离（像素）。调小能多放词，太小会显得挤。',
  minGapPx: '相邻单词之间的最小空隙（像素）。这就是「不重叠」的底线，调小能多塞词。',
  fontSizePx: '这一档单词的字号（像素）。调小能多放词，但别低于 14。',
  targetCount: '希望一屏出现几个词。算法会尽量放下这么多，放不下时按实际最大容量。',
  diameterPx: '底部圆形按钮的直径（像素）。至少 44 才好点。',
  gapPx: '底部按钮之间的横向间距（像素）。',
  labelFontPx: '按钮下方小字的字号（像素）。',
};

/** 档位元信息 */
const TIERS: { key: LayoutTierKey; label: string; note: string }[] = [
  { key: 'mobile', label: '手机（<768px）', note: '★ M2 重构的就是这一档：按平均词宽定列数 + 底部圆形按钮' },
  { key: 'tablet', label: '平板（768~1024px）', note: 'S3 起手机/平板/桌面共用同一套自然列数算法（下限 4 列）' },
  { key: 'desktop', label: '桌面（>1024px）', note: 'S3 起桌面也用自然列数（下限 4 列）；右下角按钮布局不变' },
];

/** 列数选项的文案（'auto' 之外显示成「N 列」） */
function colsOptionText(value: (typeof LAYOUT_COLS_OPTIONS)[number]): string {
  return value === 'auto' ? '自动（按屏幕宽度推导）' : `${value} 列`;
}

/**
 * 生成一个「标签 + 数字输入框 + 说明」的表单行。
 *
 * ★ min/max 与文案里的区间都取自 `LAYOUT_LIMITS`（唯一真源）：以前这里手写
 *   `min: 0, max: 80`，与别处的校验各写一份，改一处漏一处就会出现
 *   「输入框允许填、实际却被夹掉」的困惑。
 *
 * @param label 中文标签
 * @param key 字段名（决定区间与说明文案，泛型保证回调收到同一个字面量类型）
 * @param value 当前值（已净化）
 * @param onChange 改动回调（入参就是 key，不用字符串拼装）
 */
function field<K extends LayoutFieldKey | LayoutButtonFieldKey>(
  label: string,
  key: K,
  value: number,
  onChange: (field: K, v: number) => void,
): HTMLElement {
  const range = layoutRangeOf(key);
  return h(
    'label',
    { class: 'field' },
    h('span', { class: 'field-label', text: label }),
    numberInput(value, (v) => {
      // 输入框的 min/max 只是**界面提示**：用户可以粘贴、可以输 1e9，
      // 真正的夹取由草稿层的 clampNum 做，所以这里把原值传下去。
      (onChange)(key, v);
    }, { min: range.min, max: range.max, step: 1 }),
    h('span', { class: 'field-hint', text: `${HINTS[key]}（可填 ${range.min}~${range.max}）` }),
  );
}

/**
 * 渲染「布局参数」折叠块。
 *
 * ★ T1 起这里**不再直接写设置**：所有改动先落到内存草稿，由
 *   「应用并预览」一次性提交。控件渲染读的全是草稿，所以「改了没应用」时
 *   界面显示草稿值、而背诵页用的仍是已保存值 —— 这正是确认制的意义。
 */
export function renderLayoutSection(): HTMLElement {
  const wrap = h('div', { class: 'stack' });
  wrap.appendChild(
    h(
      'p',
      { class: 'note' },
      '这些数字直接决定「一屏能放几个词」。改动**不会立刻生效**：先在这里调好、看一眼预览，' +
        '再点下面的「应用并预览」。想边看边调真实效果就用调试页：地址栏访问 #/dev/layout。',
    ),
  );

  // ── 预览容器：独立渲染 + 独立 try/catch（T1 任务 2）──
  const previewBox = h('div', { class: 'layout-preview-host' });
  previewBox.dataset.role = 'layout-preview-host';

  /**
   * ★ 验收用的「预览崩坏注入」开关。
   *
   * 为什么必须留这么一个口子：T1 的验收项写着「让预览 renderFn 抛异常 → 设置页其他分组
   * 照常显示，预览区显示『预览不可用』」。预览是纯函数 + 纯 DOM，**正常路径下永远不会抛**，
   * 没有注入点就只能靠「改代码去炸一下再改回来」来验 —— 那种验法既不可重复、
   * 也没法写进回归套件。所以这里挂一个显式开关，默认关闭，只有地址栏带
   * `?bustPreview=1`（放在 `#` **之前**，因为 hash 里的那一段是路由自己的 query）才会打开。
   * 对正常用户零影响：不打这个参数，这段代码不生效。
   */
  const bustPreview = new URLSearchParams(window.location.search).get('bustPreview') === '1';
  if (bustPreview) {
    window.__bustLayoutPreview = true;
    console.warn('[settings/layout] 预览崩坏注入已开启（验收用）');
  }

  // ── 未应用提示条 + 应用/取消（T1 任务 1）──
  const actionBar = h('div', { class: 'layout-action-bar' });
  actionBar.dataset.role = 'layout-action-bar';

  /** 控件区的重画函数（每个档位注册进来，改一处只重画那一档） */
  const tierRedraws = new Map<LayoutTierKey, () => void>();
  /**
   * 三个重画入口先声明后赋值。
   *
   * 为什么要这么写：`redrawAll()` 要调用 `drawPreview` / `drawActionBar`，
   * 而它俩又（间接）调用 `redrawAll` —— 用 `const` 箭头函数会撞上
   * 「声明前使用」的暂时性死区（运行时报 `Cannot access before initialization`）。
   * 声明成 `let` + 先给一个空实现，互相引用就安全了。
   */
  let drawPreview: () => void = () => undefined;
  let drawActionBar: () => void = () => undefined;
  let drawCols: () => void = () => undefined;

  /** 全量重画（控件 + 预览 + 提示条） */
  const redrawAll = (): void => {
    for (const fn of tierRedraws.values()) fn();
    drawCols();
    drawActionBar();
    drawPreview();
  };

  /**
   * 重画预览。
   *
   * ★ 这是「预览隔离」的落点：整段渲染包在 try/catch 里，
   *   失败只把预览容器换成一行提示 —— 设置控件完全不受影响。
   *   参数在进 `computePreview` 之前已经是净化过的草稿值。
   */
  drawPreview = (): void => {
    previewBox.replaceChildren();
    try {
      // 验收注入点（默认不生效；只有 ?bustPreview=1 才会打开）
      if (window.__bustLayoutPreview === true) throw new Error('（注入）预览渲染故意抛错');
      const draft = currentDraft();
      for (const tier of TIERS) {
        const result = computePreview(draft.layout[tier.key], tier.key, draft.colsOverride, currentSettings().paper);
        const card = h('div', { class: 'layout-preview-card' });
        card.appendChild(h('div', { class: 'layout-preview-title', text: tier.label }));
        card.appendChild(renderPreview(result));
        previewBox.appendChild(card);
      }
    } catch (err) {
      console.error('[settings/layout] 预览渲染失败', err);
      // 预览崩了 → 只显示不可用提示，并给两个脱身出口（T1 任务 2.3）
      const box = h('div', { class: 'layout-preview-failed' });
      box.dataset.role = 'layout-preview-failed';
      box.appendChild(h('div', { class: 'layout-preview-failed-title', text: PREVIEW_FAILED_TEXT }));
      box.appendChild(
        h(
          'div',
          { class: 'layout-preview-failed-actions' },
          button(
            '改用适中预设',
            () => {
              // 「适中」= 三档的默认值（defaultTierCopy 取的是副本，不会改到全局默认）
              for (const t of TIERS) resetTierToDefault(t.key);
              editColsOverride('auto');
              redrawAll();
            },
            { variant: 'ghost', class: 'layout-preview-fix' },
          ),
          button(
            '取消修改',
            () => {
              discardDraft();
              redrawAll();
            },
            { variant: 'ghost', class: 'layout-preview-discard' },
          ),
        ),
      );
      previewBox.appendChild(box);
    }
  };

  // 防抖：拖滑块 / 连点数字框时不必每一下都重算重画
  const drawPreviewDebounced = debounce(drawPreview, PREVIEW_DEBOUNCE_MS);

  /** 重画提示条（「有未应用的修改」+ 取消/应用） */
  drawActionBar = (): void => {
    actionBar.replaceChildren();
    const dirty = isDirty();
    actionBar.classList.toggle('layout-action-bar-dirty', dirty);
    if (!dirty) {
      actionBar.appendChild(
        h('span', { class: 'layout-action-hint', text: '改动会在点「应用并预览」后生效（当前没有未应用的修改）。' }),
      );
      return;
    }
    actionBar.appendChild(h('span', { class: 'layout-action-warn', text: '⚠ 有未应用的修改' }));
    actionBar.appendChild(
      button(
        '取消',
        () => {
          discardDraft();
          redrawAll();
        },
        { variant: 'ghost', class: 'layout-action-cancel' },
      ),
    );
    actionBar.appendChild(
      button(
        '应用并预览',
        () => {
          void applyAndObserve();
        },
        { variant: 'primary', class: 'layout-action-apply' },
      ),
    );
  };

  /**
   * 应用草稿：写设置 → 进入 8 秒观察期。
   *
   * 应用成功后**立即清空草稿**（界面就不再显示「有未应用的修改」），
   * 之后由观察期决定是「确认」还是「回滚」；回滚后重画，让控件显示回滚后的值。
   */
  const applyAndObserve = async (): Promise<void> => {
    const draft = currentDraft();
    const layout = draft.layout;
    const colsOverride = coerceColsOverride(draft.colsOverride);
    discardDraft();
    redrawAll();
    await applyLayoutWithObserve({
      layout,
      colsOverride,
      onSettled: () => redrawAll(),
      onRolledBack: () => redrawAll(),
    });
  };

  // ── ★ S3：列数覆盖（算法兜底之外的人工兜底）──
  const colsBox = h('div', { class: 'stack' });
  drawCols = (): void => {
    colsBox.replaceChildren();
    const current = currentDraft().colsOverride;
    colsBox.appendChild(
      h(
        'label',
        { class: 'field' },
        h('span', { class: 'field-label', text: '列数' }),
        select(
          LAYOUT_COLS_OPTIONS.map((v) => ({ value: String(v), label: colsOptionText(v) })),
          String(current),
          (v) => {
            // 选项值来自 LAYOUT_COLS_OPTIONS，editColsOverride 内部还会再 coerce 一次
            editColsOverride(v);
            drawCols();
            drawActionBar();
            drawPreviewDebounced();
          },
        ),
        h(
          'span',
          { class: 'field-hint' },
          '自动 = 按屏幕宽度自然推导（手机 ≥3 列 / 平板与桌面 ≥4 列）。' +
            '万一自动布局不合适（列太少、太挤、排得像手机），在这里指定列数即可 —— ' +
            '背诵页右下角（手机上在底部按钮带左侧）还有一个 ⊞ 快捷按钮，那个是**即时生效**的。',
        ),
      ),
    );
  };
  drawCols();
  wrap.appendChild(h('h4', { class: 'sub-title', text: '列数（覆盖自动布局）' }));
  wrap.appendChild(colsBox);

  for (const tier of TIERS) {
    const box = h('div', { class: 'stack' });
    wrap.appendChild(h('h4', { class: 'sub-title', text: tier.label }));
    wrap.appendChild(h('p', { class: 'field-hint', text: tier.note }));
    wrap.appendChild(box);

    /**
     * 重画这一档的控件。
     *
     * ★ 每个档位一个 try/catch：某一档的参数脏到画不出来时，只把这一档换成
     *   「重置该档」提示，其他档位与预览照常（T1 任务 4 的分组隔离）。
     */
    const draw = (): void => {
      box.replaceChildren();
      try {
        // 净化后再渲染：残缺/越界的数据到这里已经被补成默认值或夹进区间
        const current = getPresetParams(currentDraft().layout[tier.key], defaultTierCopy(tier.key));

        /** 一次改动之后的统一收尾 */
        const afterChange = (): void => {
          // 重画控件这步不能省：用户输入 999999 会被夹到上限，
          // 输入框必须立刻显示夹住后的数字，否则界面显示的和真正生效的不一致。
          draw();
          drawActionBar();
          drawPreviewDebounced();
        };

        /** 改一个数值字段（只进草稿） */
        const patch = (f: LayoutFieldKey, v: number): void => {
          editTierField(tier.key, f, v);
          afterChange();
        };
        /** 改按钮里的一个字段（只进草稿） */
        const patchButton = (f: LayoutButtonFieldKey, v: number): void => {
          editButtonField(tier.key, f, v);
          afterChange();
        };

        const row1 = h('div', { class: 'row' });
        row1.appendChild(field('边距 px', 'edgeMarginPx', current.edgeMarginPx, patch));
        row1.appendChild(field('间距 px', 'minGapPx', current.minGapPx, patch));
        box.appendChild(row1);

        const row2 = h('div', { class: 'row' });
        row2.appendChild(field('字号 px', 'fontSizePx', current.fontSizePx, patch));
        row2.appendChild(field('目标词数', 'targetCount', current.targetCount, patch));
        box.appendChild(row2);

        const row3 = h('div', { class: 'row' });
        row3.appendChild(field('按钮直径 px', 'diameterPx', current.button.diameterPx, patchButton));
        row3.appendChild(field('按钮间距 px', 'gapPx', current.button.gapPx, patchButton));
        box.appendChild(row3);

        // 按钮带占多高 = 布点要避让多少，直接显示出来（用户能看懂「为什么底部不能放词」）
        const band = controlBandHeight(current);
        box.appendChild(
          h('p', { class: 'field-hint' }, `底部按钮带占 ${band}px 高、整屏宽 —— 这条带子里不会布点，其余区域都能放词。`),
        );
        box.appendChild(
          button(
            '恢复这一档的默认值',
            () => {
              resetTierToDefault(tier.key);
              draw();
              drawActionBar();
              drawPreviewDebounced();
            },
            { variant: 'ghost' },
          ),
        );
      } catch (err) {
        // 这一档彻底画不出来：给一个能自救的出口，不影响其他档位
        console.error(`[settings/layout] 档位 ${tier.key} 渲染失败`, err);
        const failed = h('div', { class: 'section-failed' });
        failed.dataset.role = 'layout-tier-failed';
        failed.appendChild(h('div', { text: `这一档的参数读取失败：${err instanceof Error ? err.message : String(err)}` }));
        failed.appendChild(
          button(
            '重置该档为默认值',
            () => {
              resetTierToDefault(tier.key);
              redrawAll();
            },
            { variant: 'primary' },
          ),
        );
        box.replaceChildren(failed);
      }
    };
    tierRedraws.set(tier.key, draw);
    draw();
  }

  // 组装顺序：预览在最上面（改完先看结果），然后是提示条 + 应用按钮，最后是各档控件
  wrap.appendChild(h('h4', { class: 'sub-title', text: '预览（用真实布点算法算出来的结果）' }));
  wrap.appendChild(previewBox);
  wrap.appendChild(actionBar);
  // 首次渲染：预览与提示条都要有一版
  drawActionBar();
  drawPreview();

  return wrap;
}

/** 供设置页做「未应用就离开」判断用 */
export { isDirty as isLayoutDirty };

/**
 * 把越界值夹进区间的公开入口（设置页与测试可直接用）。
 *
 * 之所以要导出：验收里要能独立证明「护栏真的在夹」，
 * 而不是只能靠「改完没崩」间接推断。
 * @param key 字段名
 * @param value 原始值
 */
export function clampLayoutValue(key: LayoutFieldKey | LayoutButtonFieldKey, value: unknown): number {
  const range = layoutRangeOf(key);
  return clampNum(value, range, range.min);
}
