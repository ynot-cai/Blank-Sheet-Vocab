/**
 * 布局调试页（阶段 M1 建立 / M2 扩展）：`#/dev/layout`
 *
 * 用途：把「手机上一屏放得下几个词」变成**可看见、可测量、可调参**的数字。
 * 页面做四件事：
 * 1. 用**真实的** `createPaperStage()` 布点并渲染（不是另写一份模拟算法，
 *    否则量出来的数字不代表用户看到的界面）；
 * 2. 暴露 `window.__layoutProbe()`：遍历 `[data-word-box]` 的真实
 *    `getBoundingClientRect()`，算出词数 / 行列 / 重叠 / 越界 / 最小间距；
 * 3. 参数面板（M2）：边距 / 间距 / 字号 / 目标数 / 按钮直径 / 按钮间距，
 *    拖动即重排 + 重测，并可**一键写进设置**（`settings.layout.mobile`）；
 * 4. 真机尺寸模拟：无头浏览器最小窗宽 504px，`390x844` 这种真机尺寸只能靠
 *    `dvw/dvh` 注入（见 PaperStage 的 `__layoutViewport`）。
 *
 * ⚠️ 本页只改**布局参数**，不动任何业务数据（词库 / 会话 / 云同步一概不碰）。
 */
import { DEFAULT_SETTINGS, isColsOverrideValue, LAYOUT_COLS_OPTIONS, setSettingsCache } from '../../core/config';
import { controlBandHeight } from '../../core/layout';
import type { LayoutColsOverride, LayoutTier, Word } from '../../core/types';
import * as dao from '../../dao';
import { appStore, emitDataChanged } from '../../state/store';
import {
  attachLayoutProbe,
  runLayoutProbe,
  type LayoutInfo,
  type LayoutProbeResult,
  type Rect,
} from '../../dev/layoutProbe';
import { controlsAvoidRect } from '../device';
import { button, h } from '../dom';
import { registerCleanup } from '../router';
import { buildRoundControls } from './paper/flow';
import { createPaperStage, type PaperStage } from './paper/PaperStage';

/** 固定随机种子：不同尺寸 / 不同参数测的是同一套落点，数字才可对比 */
const DEV_SEED = 20260501;

/** 演示词（M2 用固定词表，保证不同尺寸/不同参数测的是同一批词） */
interface DemoWord {
  en: string;
  zh: string;
}

/** 常规词：长度分布接近真实词库（5~9 个字母） */
const DEMO_WORDS: DemoWord[] = [
  { en: 'apple', zh: '苹果' },
  { en: 'river', zh: '河流' },
  { en: 'orange', zh: '橙子' },
  { en: 'silent', zh: '安静的' },
  { en: 'garden', zh: '花园' },
  { en: 'observe', zh: '观察' },
  { en: 'grateful', zh: '感激的' },
  { en: 'bicycle', zh: '自行车' },
  { en: 'mountain', zh: '山' },
  { en: 'discover', zh: '发现' },
  { en: 'practice', zh: '练习' },
  { en: 'mystery', zh: '神秘' },
  { en: 'language', zh: '语言' },
  { en: 'umbrella', zh: '雨伞' },
  { en: 'festival', zh: '节日' },
  { en: 'cultivate', zh: '培养' },
];

/** 长词对照表：用来量「最长词」对容量的杀伤力（M1 的核心怀疑对象） */
const LONG_WORDS: DemoWord[] = [
  { en: 'photosynthesis', zh: '光合作用' },
  { en: 'infrastructure', zh: '基础设施' },
  { en: 'responsibility', zh: '责任' },
  { en: 'pronunciation', zh: '发音' },
  { en: 'communication', zh: '交流' },
  { en: 'neighborhood', zh: '社区' },
  { en: 'onion', zh: '洋葱' },
  { en: 'milk', zh: '牛奶' },
  { en: 'cat', zh: '猫' },
  { en: 'sun', zh: '太阳' },
  { en: 'book', zh: '书' },
  { en: 'desk', zh: '书桌' },
  { en: 'pen', zh: '钢笔' },
  { en: 'window', zh: '窗户' },
  { en: 'umbrella', zh: '雨伞' },
  { en: 'knowledge', zh: '知识' },
];

/**
 * 模拟的真机尺寸。
 *
 * 为什么需要：Windows 无头 Edge/Chrome 的 `--window-size` **最小窗宽 504px**，
 * 要 390×844 只会得到 504×749 —— 真机列数根本量不到。
 * 注入之后 `PaperStage` 按这个尺寸算纸张/字号/避让区，量出来的才是真机布局。
 */
interface DeviceViewport {
  width: number;
  height: number;
}

/** 默认模拟的真机尺寸（iPhone 14 的逻辑像素） */
const DEFAULT_DEVICE_VIEWPORT: DeviceViewport = { width: 390, height: 844 };

/** 调试页状态 */
interface DevState {
  /** 当前在调的档位参数（直接就是 settings.layout.mobile 的形状） */
  tier: LayoutTier;
  tierName: 'mobile' | 'tablet' | 'desktop';
  /** 'normal' = 常规词表；'long' = 含超长词的对照词表 */
  wordSet: 'normal' | 'long';
  /** 参与布点的词数 */
  wordCount: number;
  showBoxes: boolean;
  /** 模拟的真机视口尺寸 */
  /** 模拟的真机视口尺寸；null = 不做模拟，直接用真实窗口 */
  deviceViewport: DeviceViewport | null;
  /** ★ S3：手动列数覆盖（'auto' = 自动推导；数字 = 强制列数） */
  colsOverride: LayoutColsOverride;
}

/**
 * 从查询串预置状态（给 `probeLayout.mjs` 做对照实验与验收用）。
 *
 * 这些开关必须能进 URL，因为验收是**机器跑的**（无头浏览器），不可能靠人点滑块：
 *
 *   `#/dev/layout?probe=1&words=long&count=16&font=18&dvw=390&dvh=844&cols=6`
 *
 * @param query 路由查询串
 * @param state 待预置的状态
 */
function applyQueryOverrides(query: URLSearchParams | undefined, state: DevState): void {
  if (!query) return;
  /**
   * 读一个可选的数字参数。
   * ★ 必须区分「没传」和「传了 0」：`Number(null)` 是 0，
   *   直接 Number(query.get(...)) 会让「没传 edge」变成 edgeMarginPx = 0
   *   （M2 实测踩过：可用区域算成 0 高，16 个词只放得下 7 个）。
   */
  const num = (name: string): number | null => {
    const raw = query.get(name);
    if (raw === null || raw.trim() === '') return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  };

  // ★ 档位必须**最先**处理：`tier=desktop` 要连那一档的参数一起换。
  //   踩过的坑：只改 `tierName` 不换 `tier`，于是探针传 `tier=desktop` 时
  //   量到的其实是**手机档**的参数（边距 8 / 目标 16 / 间距 8），
  //   而报告里写着 desktop —— 「报告与实际不符」是最难查的一类问题。
  //   放在最前面是为了让后面的 font/edge/gap/target 覆盖仍然生效。
  const tierName = query.get('tier');
  if (tierName === 'mobile' || tierName === 'tablet' || tierName === 'desktop') {
    state.tierName = tierName;
    state.tier = cloneTier(dao.settings.readMirror()?.layout[tierName] ?? DEFAULT_SETTINGS.layout[tierName]);
  }

  const words = query.get('words');
  if (words === 'long' || words === 'normal') state.wordSet = words;
  const count = num('count');
  if (count !== null && count >= 4) state.wordCount = Math.min(30, Math.floor(count));
  const font = num('font');
  if (font !== null && font > 0) state.tier.fontSizePx = font;
  const edge = num('edge');
  if (edge !== null && edge >= 0) state.tier.edgeMarginPx = edge;
  const gap = num('gap');
  if (gap !== null && gap > 0) state.tier.minGapPx = gap;
  const target = num('target');
  if (target !== null && target > 0) state.tier.targetCount = target;
  const diameter = num('diameter');
  if (diameter !== null && diameter > 0) state.tier.button.diameterPx = diameter;
  const btnGap = num('btnGap');
  if (btnGap !== null && btnGap > 0) state.tier.button.gapPx = btnGap;
  // ★ S3：手动列数覆盖（`cols=6`）——探针 `--cols-override` 就是把它塞进 URL 的。
  //   非法值（不在选项表里）一律忽略，避免把脏值带进布点。
  const colsParam = num('cols');
  const colsValue = colsParam === null ? null : Math.floor(colsParam);
  if (isColsOverrideValue(colsValue)) state.colsOverride = colsValue;
  const dvw = num('dvw');
  const dvh = num('dvh');
  if (dvw !== null && dvh !== null && dvw > 0 && dvh > 0) {
    state.deviceViewport = { width: Math.floor(dvw), height: Math.floor(dvh) };
  } else if (dvw === 0 || dvh === 0) {
    // `dvw=0` = 不做真机尺寸模拟，直接用真实窗口（用来验证桌面档的旧算法没被改坏）
    state.deviceViewport = null;
  }
}

/** 把演示词转成 Word（字段按 core/types.ts 的 Word 填齐，避免半成品对象） */
function toWords(list: DemoWord[], count: number): Word[] {
  const slice = list.slice(0, Math.max(1, Math.min(count, list.length)));
  return slice.map((item, i) => ({
    id: `dev-${i}-${item.en}`,
    en: item.en,
    phonetic: '',
    example: '',
    senses: [{ id: `dev-sense-${i}`, text: item.zh, aliases: [], enabled: true }],
    sourceId: 'dev',
    rawSources: [],
    attrs: {
      needSpell: false,
      failCount: 0,
      failCountTotal: 0,
      reviewCount: 0,
      lastReviewAt: null,
      learnedAt: null,
      reviewPriority: 0,
    },
    status: 'unlearned' as const,
    priority: 3,
    learnOrder: null,
    createdAt: 0,
    updatedAt: 0,
    deleted: 0 as const,
  }));
}

/** 深拷贝一份档位参数（避免直接改到 DEFAULT_SETTINGS 里的对象） */
function cloneTier(tier: LayoutTier): LayoutTier {
  return { ...tier, button: { ...tier.button } };
}

/**
 * 挂上「题干遮罩」的测量钩子（只在 `?probe=1` 时调用）。
 *
 * 遮罩用的是**真实的** `stage.showOverlay()`（所以 `settings.memorize.position`
 * 与 `clampOverlayTop()` 的实际效果都会被量到），内容用真实的 `.memorize-box` +
 * `.memorize-word` + `.mem-inputs` 结构，尺寸与记忆环节一致。
 *
 * 暴露 `window.__devOverlay(mode)`：
 * - `'centered'`   居中偏上（默认）
 * - `'origin'`     弹在**第一个词**的原落点
 * - `'originBottom'` 弹在**最后一个词**（最靠下那个）的原落点 —— 最容易压到按钮
 * - `'hide'`       收起
 * 返回遮罩的 getBoundingClientRect() 与关键尺寸，供脚本断言。
 * @param stage 当前舞台
 * @param words 当前在纸上的词
 */
function installOverlayProbe(stage: PaperStage, words: Word[]): void {
  const first = words[0];
  const last = words[words.length - 1];
  window.__devOverlay = (mode: 'centered' | 'origin' | 'originBottom' | 'hide') => {
    if (mode === 'hide') {
      stage.hideOverlay();
      return null;
    }
    const target = mode === 'origin' ? first : mode === 'originBottom' ? last : undefined;
    const placement = target ? stage.placementOf(target.id) : null;
    // 用 positionOverride 强制切换模式（不动用户设置），这样两种模式可以在同一次运行里对比
    const overlay = stage.showOverlay(placement, mode === 'centered' ? 'centerTop' : 'origin');
    overlay.dataset.devOverlay = mode;
    // 与记忆环节同样的结构（1 个义项 → 1 个输入框；这里故意用 2 个框压最大高度）
    const box = h('div', { class: 'memorize-box' });
    box.appendChild(h('div', { class: 'memorize-word', text: target?.en ?? 'photosynthesis' }));
    const inputs = h('div', { class: 'mem-inputs' });
    inputs.appendChild(h('input', { class: 'input mem-input', type: 'text', placeholder: '义项 1' }));
    inputs.appendChild(h('input', { class: 'input mem-input', type: 'text', placeholder: '义项 2' }));
    box.appendChild(inputs);
    box.appendChild(h('div', { class: 'row center' }, h('button', { class: 'btn btn-primary mem-submit', type: 'button', text: '提交' })));
    overlay.replaceChildren(box);
    // 内容填完再定位（与记忆/拼写环节完全一致的调用顺序）
    stage.repositionOverlay();
    const r = overlay.getBoundingClientRect();
    const cs = getComputedStyle(overlay);
    return {
      mode,
      x: r.left,
      y: r.top,
      w: r.width,
      h: r.height,
      centerX: r.left + r.width / 2,
      centerY: r.top + r.height / 2,
      bottom: r.bottom,
      right: r.right,
      zIndex: cs.zIndex,
      position: cs.position,
      viewport: [window.innerWidth, window.innerHeight],
      word: target?.en ?? null,
      placement: placement ? { x: placement.x, y: placement.y } : null,
    };
  };
}

/** 注入可视化样式（半透明包围盒 + 红色避让区） */
function ensureDebugStyles(): void {
  if (document.getElementById('dev-layout-style')) return;
  const style = h('style', { id: 'dev-layout-style' });
  style.textContent = `
.dev-box .paper-word-zone {
  outline: 1px solid rgba(30, 120, 255, 0.75);
  outline-offset: 1px;
}
.avoid-rect {
  position: fixed;
  z-index: 40;
  pointer-events: none;
  background: rgba(255, 0, 0, 0.10);
  border: 2px dashed rgba(255, 0, 0, 0.85);
}
.avoid-rect-label {
  position: absolute;
  left: 2px;
  top: 2px;
  font: 11px/1.2 system-ui, sans-serif;
  color: #c00;
  background: rgba(255, 255, 255, 0.85);
  padding: 1px 3px;
  border-radius: 3px;
  white-space: nowrap;
}
.dev-panel {
  position: fixed;
  left: 8px;
  top: 8px;
  z-index: 60;
  width: 342px;
  max-height: calc(100vh - 16px);
  overflow: auto;
  background: rgba(255, 255, 255, 0.97);
  border: 1px solid var(--line, #ddd);
  border-radius: 8px;
  padding: 10px 12px;
  font: 12px/1.5 system-ui, sans-serif;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15);
}
.dev-panel h3 { margin: 0 0 6px; font-size: 14px; }
.dev-panel h4 { margin: 10px 0 4px; font-size: 12px; color: #666; }
.dev-row { display: flex; align-items: center; gap: 8px; margin: 3px 0; }
.dev-row label { flex: 0 0 78px; color: #444; }
.dev-row input[type="range"] { flex: 1; min-width: 0; }
.dev-row .dev-val { flex: 0 0 52px; text-align: right; font-variant-numeric: tabular-nums; }
.dev-actions { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px; }
.dev-note { color: #888; font-size: 11px; margin: 6px 0 0; }
.dev-derived {
  background: #f1f7ff;
  border: 1px solid #cfe3ff;
  border-radius: 6px;
  padding: 6px 8px;
  margin: 6px 0 0;
  font-variant-numeric: tabular-nums;
}
#probe-result {
  margin: 8px 0 0;
  max-height: 300px;
  overflow: auto;
  background: #f6f8fa;
  border: 1px solid var(--line, #ddd);
  border-radius: 6px;
  padding: 8px;
  font: 11px/1.4 ui-monospace, Consolas, monospace;
  white-space: pre-wrap;
  word-break: break-all;
}
#probe-result.hidden { display: none; }
`;
  document.head.appendChild(style);
}

/**
 * 渲染布局调试页。
 * @param query 路由查询参数（支持 `?probe=1` 自动测量）
 */
export function renderDevLayoutPage(query?: URLSearchParams): HTMLElement {
  ensureDebugStyles();
  attachLayoutProbe();

  // 以**持久化的设置**为起点（不是 DEFAULT）：这样调试页看到的就是线上真正在用的参数
  const persisted = cloneTier(dao.settings.readMirror()?.layout.mobile ?? DEFAULT_SETTINGS.layout.mobile);
  const state: DevState = {
    tier: persisted,
    tierName: 'mobile',
    wordSet: 'normal',
    wordCount: 16,
    showBoxes: true,
    deviceViewport: { ...DEFAULT_DEVICE_VIEWPORT },
    colsOverride: 'auto',
  };
  applyQueryOverrides(query, state);

  const page = h('div', { class: 'page dev-layout-page' });
  /** 脚本带 `?probe=1` 打开时：每次重新布局后自动测一次（渲染落地后再量） */
  const autoProbe = query?.get('probe') === '1';
  /** `?controls=1`：同时挂上真实的底部圆形按钮带（验收「按钮位置 = 避让带」用） */
  const showControls = query?.get('controls') === '1';
  const infoLine = h('div', { class: 'dev-note' });
  const derivedBox = h('div', { class: 'dev-derived' });
  const resultPre = h('pre', { id: 'probe-result', class: 'hidden' });
  const actionRow = h('div', { class: 'dev-actions' });
  const sliderHost = h('div', {});
  const avoidHost = h('div', {});

  let activeStage: PaperStage | null = null;
  let avoidRects: ({ label: string } & Rect)[] = [];

  /** 测量 + 把结果同时写进页面与 console */
  const measure = (): LayoutProbeResult => {
    const result = runLayoutProbe(avoidRects);
    resultPre.classList.remove('hidden');
    return result;
  };

  /**
   * 交互触发的测量：`?probe=1` 时**不在这里量**——
   * 那种模式下 `relayout()` 已经排了一次「渲染落地后再量」，
   * 在这里再量一次就是量在 DOM 更新之前（数字会是 0），必须让它排队。
   */
  const probeAfterLayout = (): void => {
    if (!autoProbe) measure();
  };

  /**
   * 写进设置（`settings.layout.<档位>`）。
   *
   * ⚠️ 只在按「写入设置」时发生。注意**不要**在渲染路径里调它：
   *   `dao.settings.set()` 内部会 `get()` 后重刷 core 的内存缓存，
   *   而调试页在缓存里放的是**临时演示参数**，被它一刷就没了 ——
   *   实测后果：按钮的 CSS 变量在本页写的是 50px，刷新后变成别档的 44px。
   */
  const persist = (): void => {
    const patch = { layout: { [state.tierName]: cloneTier(state.tier) } };
    void dao.settings
      .set(patch)
      .then(async () => {
        // 写库之后缓存里已经是「真实设置」了；演示视口要重新注入，否则本页会按真实窗口重排
        relayout();
        const saved = await dao.settings.get();
        appStore.set({ settings: saved });
        emitDataChanged();
        statusLine.textContent = `已写入设置：layout.${state.tierName} = ${JSON.stringify(saved.layout[state.tierName])}`;
      })
      .catch((err: unknown) => {
        statusLine.textContent = `写入设置失败：${err instanceof Error ? err.message : String(err)}`;
      });
  };

  const statusLine = h('p', { class: 'dev-note' }, '参数只改内存；点「写入设置」才会保存到本机浏览器。');

  /**
   * 用真实 PaperStage 重新布点。
   *
   * 说明：`PaperStage.computePlacements()` 内部读的是 `getSettings()` 的内存缓存
   * （字号 / 纸张 / 布局档位），调试页只改缓存里的 `layout` 档位、**不写库**，
   * 所以滑块一拖就能立刻看到真实布局，而不会污染用户设置（要保存得点按钮）。
   */
  const relayout = (): void => {
    if (activeStage) activeStage.destroy();
    for (const el of document.querySelectorAll('.avoid-rect')) el.remove();

    // 真实窗口尺寸（`dvw=0` 时用它，用来验证桌面档没被改坏）
    const realViewport = { width: window.innerWidth, height: window.innerHeight };
    const viewport = state.deviceViewport ?? realViewport;
    // 把「当前在调的档位」塞进缓存：PaperStage 会按 deviceKind(注入宽度) 取对应档位。
    // 注意档位与宽度要匹配：dvw=390 → phone 档生效；dvw=0（真实窗口 1250 宽）→ desktop 档。
    setSettingsCache({
      ...DEFAULT_SETTINGS,
      layout: { ...DEFAULT_SETTINGS.layout, [state.tierName]: cloneTier(state.tier) },
      display: { ...DEFAULT_SETTINGS.display, animation: false },
      // ★ S3：列数覆盖也要进缓存（PaperStage 现读它；探针靠它验手动覆盖）
      layoutColsOverride: state.colsOverride,
    });
    // null = 不注入，PaperStage 就会用真实 window.innerWidth/innerHeight（= 走桌面旧算法）
    window.__layoutViewport = state.deviceViewport ? { ...state.deviceViewport } : undefined;

    const words = toWords(state.wordSet === 'long' ? LONG_WORDS : DEMO_WORDS, state.wordCount);

    const stage = createPaperStage({ onWordClick: () => undefined, onMeaningClick: () => undefined });
    activeStage = stage;
    stage.applySettings();
    // 舞台缩到模拟尺寸并钉在左上角。
    // ★ 必须把 `inset` 也钉住：`.paper-stage` 是 `position:fixed; inset:0`，
    //   只改 width/height 时它仍然**居中铺满真实窗口**（504 宽），
    //   于是「窗口左下角 = 纸面左下角」这个假设不成立，避让带会被算到纸外，
    //   可用高度被压成一百多像素（M2 实测：16 个词只放得下 7 个）。
    //   钉住之后舞台就是「真机屏幕」本身，纸面与之重合，坐标完全一致。
    stage.root.style.position = 'fixed';
    stage.root.style.inset = 'auto';
    stage.root.style.left = '0';
    stage.root.style.top = '0';
    stage.root.style.width = `${viewport.width}px`;
    stage.root.style.height = `${viewport.height}px`;
    stage.root.dataset.deviceViewport = `${viewport.width}x${viewport.height}`;
    avoidHost.replaceChildren(stage.root);
    const placements = stage.computePlacements(words, DEV_SEED);
    for (const w of words) {
      const p = placements[w.id];
      if (p) stage.addWord(w, p, { animate: false });
    }
    const published = window.__layoutInfo;
    if (!published) throw new Error('PaperStage 没有写出 __layoutInfo（诊断快照缺失）');
    // 调试用：把算法真正吐出来的落点也留在页面上，便于核对「报告 vs DOM」
    window.__layoutPlacements = words
      .map((w) => ({ id: w.id, x: placements[w.id]?.x ?? -1, y: placements[w.id]?.y ?? -1 }))
      .filter((p) => p.x >= 0);

    // 避让区在**视口坐标**下画出来（与 DOM 的 getBoundingClientRect 同一坐标系）。
    // ★ 必须按 `viewport`（模拟真机尺寸）而不是真实窗口算，否则画出来的红色矩形
    //   会跑到纸面右边去，与「算法实际避开的那块」不是同一个东西 —— 测量就不诚实了。
    const controls = controlsAvoidRect(viewport);
    const avoidRect: { label: string } & Rect = {
      label: 'controls-avoid(算法实际用的)',
      x: controls.x,
      y: controls.y,
      width: controls.width,
      height: controls.height,
    };
    avoidRects = [avoidRect];
    window.__layoutAvoidRects = avoidRects;
    const marker = h('div', {
      class: 'avoid-rect',
      style: {
        left: `${avoidRect.x}px`,
        top: `${avoidRect.y}px`,
        width: `${avoidRect.width}px`,
        height: `${avoidRect.height}px`,
      },
    });
    marker.appendChild(h('span', { class: 'avoid-rect-label', text: avoidRect.label }));
    document.body.appendChild(marker);

    // ★ `?controls=1`：把**真实的底部圆形按钮带**也挂上（复用背诵页那个组件）。
    //   为什么要挂真的而不是画个假方块：验收要证的是「按钮的实际位置 = 避让带」，
    //   用假方块就只是自己证明自己。挂真的之后，probe 可以直接量按钮的
    //   getBoundingClientRect() 与 avoidRect 对比。
    if (showControls) {
      const progress = h('div', { class: 'paper-round-progress', text: `已出现 ${words.length}/${published.capacity}` });
      const stubs = ['背完了', '保存并退出', '再次记忆', '再背一个 (Enter)', '重新开始'].map((label) =>
        button(label, () => undefined, { class: label === '背完了' ? 'paper-done hidden' : '' }),
      );
      for (const stub of stubs) stub.dataset.fullLabel = stub.textContent ?? '';
      const bandEl = buildRoundControls(progress, stubs);
      bandEl.dataset.devControls = '1';
      for (const el of document.querySelectorAll('[data-dev-controls]')) el.remove();
      document.body.appendChild(bandEl);
    }

    // ★ `?probe=1`：挂一个**真实几何的题干遮罩**（记忆/拼写那两种），并暴露测量钩子。
    //   为什么必须在这里测：「题干弹在原落点」这句在 M2 之后会紧贴底部按钮带，
    //   而这条只有把遮罩真的渲染出来、量它的 getBoundingClientRect() 才看得见。
    //   钩子：window.__devOverlay('centered' | 'origin' | 'originBottom' | 'hide')
    if (autoProbe) installOverlayProbe(stage, words);

    // ★ S3：网格行列数由**算法自己报**（PaperStage 写进 __layoutInfo），
    //   调试页不再按参数复刻一份推导 —— 复刻迟早会跟算法走偏，而「报告与 DOM 对不上」
    //   正是最难查的一类问题（M1 时就吃过这个亏）。
    const layoutInfo: LayoutInfo = published;
    window.__layoutInfo = layoutInfo;

    const cols = layoutInfo.cols;
    const rows = layoutInfo.rows;
    const band = Math.round(controlBandHeight(state.tier));
    infoLine.textContent =
      `模拟视口 ${viewport.width}×${viewport.height} · ${layoutInfo.deviceKind} · 字号 ${layoutInfo.fontSize}px · ` +
      `纸面 ${layoutInfo.paperW}×${layoutInfo.paperH} · 最宽词 ${layoutInfo.widestWordPx}px · 平均 ${layoutInfo.avgWordPx}px · ` +
      `算法 ${layoutInfo.algorithm ?? '-'} · 容量 ${layoutInfo.capacity} 个 · 传入 ${words.length} 个`;
    const colsLabel = layoutInfo.colsOverridden
      ? `手动覆盖 ${layoutInfo.colsRequested} 列${layoutInfo.colsClamped ? '（宽度放不下，已被夹住）' : ''}`
      : `自动推导（下限 ${layoutInfo.minCols ?? '-'} 列，宽度上限 ${layoutInfo.maxCols ?? '-'} 列）`;
    derivedBox.replaceChildren(
      h('div', { text: `网格 ${cols} 列 × ${rows} 行 = ${layoutInfo.gridCapacity} 个格子，放下 ${layoutInfo.capacity} 个（目标 ${layoutInfo.targetCount ?? state.tier.targetCount}）` }),
      h('div', { text: `列数：${colsLabel} · 每行 ${layoutInfo.wordsPerRow ?? cols} 个 · 空着的格子 ${layoutInfo.cellsUnused ?? 0} 个` }),
      h('div', { text: `单词间最小空隙 ${layoutInfo.gapX}px（参数 minGapPx=${state.tier.minGapPx}）` }),
      h('div', { text: `底部按钮带高 ${band}px（避让区 y=${Math.round(controls.y)}，高 ${Math.round(controls.height)}）` }),
      h('div', {
        text: layoutInfo.area
          ? `可用布点区 ${Math.round(layoutInfo.area.width)}×${Math.round(layoutInfo.area.height)} @(${Math.round(layoutInfo.area.x)},${Math.round(layoutInfo.area.y)})`
          : '（没有可用布点区数据）',
      }),
    );

    // ★ 测量必须**等这一轮渲染落地**再跑。
    //   踩过的坑：原来在 renderDevLayoutPage() 里同步调 measure()，
    //   那时单词元素还没进 DOM —— 量出来是 wordCount=0、boxes=[]，
    //   脚本只会说「提取不到数据」，看起来像调试页没实现，实际是量得太早。
    //   这里的 setTimeout(0) 只是等一次渲染（与动画/计时无关），
    //   不是任何形式的答题时间限制（RULES-R1）。
    if (autoProbe) window.setTimeout(() => measure(), 0);
  };

  // ── 参数滑块（六个参数全部可调，对应 settings.layout.mobile）──
  interface SliderSpec {
    label: string;
    min: number;
    max: number;
    step: number;
    get: () => number;
    set: (v: number) => void;
  }

  const sliders: SliderSpec[] = [
    { label: '边距 px', min: 0, max: 60, step: 1, get: () => state.tier.edgeMarginPx, set: (v) => (state.tier.edgeMarginPx = v) },
    { label: '间距 px', min: 0, max: 40, step: 1, get: () => state.tier.minGapPx, set: (v) => (state.tier.minGapPx = v) },
    { label: '字号 px', min: 10, max: 48, step: 1, get: () => state.tier.fontSizePx, set: (v) => (state.tier.fontSizePx = v) },
    { label: '目标数', min: 4, max: 40, step: 1, get: () => state.tier.targetCount, set: (v) => (state.tier.targetCount = v) },
    {
      label: '按钮直径',
      min: 32,
      max: 80,
      step: 1,
      get: () => state.tier.button.diameterPx,
      set: (v) => (state.tier.button.diameterPx = v),
    },
    { label: '按钮间距', min: 4, max: 40, step: 1, get: () => state.tier.button.gapPx, set: (v) => (state.tier.button.gapPx = v) },
  ];

  for (const spec of sliders) {
    const value = h('span', { class: 'dev-val', text: String(spec.get()) });
    const input = h('input', {
      type: 'range',
      min: String(spec.min),
      max: String(spec.max),
      step: String(spec.step),
      value: String(spec.get()),
    });
    input.addEventListener('input', () => {
      spec.set(Number(input.value));
      value.textContent = input.value;
      relayout();
      probeAfterLayout();
    });
    sliderHost.appendChild(h('div', { class: 'dev-row' }, h('label', { text: spec.label }), input, value));
  }

  // ── 词表 / 词数 ──
  const countInput = h('input', {
    type: 'range',
    min: '4',
    max: '30',
    step: '1',
    value: String(state.wordCount),
  });
  const countVal = h('span', { class: 'dev-val', text: String(state.wordCount) });
  countInput.addEventListener('input', () => {
    state.wordCount = Number(countInput.value);
    countVal.textContent = countInput.value;
    relayout();
    probeAfterLayout();
  });
  const setSelect = h('select', { class: 'input' });
  for (const [value, text] of [
    ['normal', '常规词（5~9 字母）'],
    ['long', '长词对照（含 photosynthesis）'],
  ] as const) {
    const opt = h('option', { value, text });
    if (value === state.wordSet) opt.selected = true;
    setSelect.appendChild(opt);
  }
  setSelect.addEventListener('change', () => {
    state.wordSet = setSelect.value === 'long' ? 'long' : 'normal';
    relayout();
    probeAfterLayout();
  });

  const tierSelect = h('select', { class: 'input' });
  for (const [value, text] of [
    ['mobile', 'mobile（手机 <768）'],
    ['tablet', 'tablet（768~1024）'],
    ['desktop', 'desktop（>1024）'],
  ] as const) {
    const opt = h('option', { value, text });
    if (value === state.tierName) opt.selected = true;
    tierSelect.appendChild(opt);
  }
  tierSelect.addEventListener('change', () => {
    state.tierName = tierSelect.value === 'mobile' ? 'mobile' : tierSelect.value === 'tablet' ? 'tablet' : 'desktop';
    const src = dao.settings.readMirror()?.layout[state.tierName] ?? DEFAULT_SETTINGS.layout[state.tierName];
    state.tier = cloneTier(src);
    rebuildSliders();
    relayout();
    probeAfterLayout();
  });

  // ── ★ S3：列数覆盖（自动 / 3 / 4 / 5 / 6 / 8 / 10）──
  //    与背诵页那个 32×32 的 ⊞ 快捷按钮、设置页的下拉读同一份设置。
  const colsSelect = h('select', { class: 'input' });
  for (const value of LAYOUT_COLS_OPTIONS) {
    const opt = h('option', { value: String(value), text: value === 'auto' ? '自动（按宽度推导）' : `${value} 列` });
    if (value === state.colsOverride) opt.selected = true;
    colsSelect.appendChild(opt);
  }
  colsSelect.addEventListener('change', () => {
    const raw = colsSelect.value;
    const numeric = Number(raw);
    state.colsOverride = raw === 'auto' ? 'auto' : isColsOverrideValue(numeric) ? numeric : 'auto';
    relayout();
    probeAfterLayout();
  });

  // ── 按钮 ──
  actionRow.appendChild(
    button('重新布局', () => {
      relayout();
      probeAfterLayout();
    }),
  );
  actionRow.appendChild(button('测量', () => measure(), { variant: 'primary' }));
  actionRow.appendChild(button('写入设置', () => persist(), { variant: 'danger' }));
  actionRow.appendChild(
    button('恢复默认', () => {
      state.tier = cloneTier(DEFAULT_SETTINGS.layout[state.tierName]);
      rebuildSliders();
      relayout();
      probeAfterLayout();
    }),
  );
  actionRow.appendChild(
    button('显示包围盒 ✓', (ev) => {
      state.showBoxes = !state.showBoxes;
      activeStage?.root.classList.toggle('dev-box', state.showBoxes);
      (ev.currentTarget as HTMLElement).textContent = `显示包围盒 ${state.showBoxes ? '✓' : '✗'}`;
    }),
  );

  /** 滑块重建（切换档位 / 恢复默认后，滑块位置要跟上新参数） */
  function rebuildSliders(): void {
    sliderHost.replaceChildren();
    for (const spec of sliders) {
      const value = h('span', { class: 'dev-val', text: String(spec.get()) });
      const input = h('input', {
        type: 'range',
        min: String(spec.min),
        max: String(spec.max),
        step: String(spec.step),
        value: String(spec.get()),
      });
      input.addEventListener('input', () => {
        spec.set(Number(input.value));
        value.textContent = input.value;
        relayout();
        probeAfterLayout();
      });
      sliderHost.appendChild(h('div', { class: 'dev-row' }, h('label', { text: spec.label }), input, value));
    }
  }

  const panel = h(
    'div',
    { class: 'dev-panel' },
    h('h3', { text: '布局调试 #/dev/layout' }),
    infoLine,
    derivedBox,
    h('h4', { text: '设置页里的那一档参数' }),
    h('div', { class: 'dev-row' }, h('label', { text: '档位' }), tierSelect),
    h('div', { class: 'dev-row' }, h('label', { text: '列数' }), colsSelect),
    sliderHost,
    h('h4', { text: '词表' }),
    h('div', { class: 'dev-row' }, h('label', { text: '词数' }), countInput, countVal),
    h('div', { class: 'dev-row' }, h('label', { text: '词表' }), setSelect),
    actionRow,
    statusLine,
    h(
      'p',
      { class: 'dev-note' },
      '说明：滑块只改内存；window.__layoutProbe() 返回真实 DOM 测量结果；真机尺寸靠 dvw/dvh 注入。',
    ),
    resultPre,
  );

  page.appendChild(panel);
  page.appendChild(avoidHost);

  rebuildSliders();
  relayout();

  /**
   * 窗口尺寸变了就重新布点。
   *
   * 为什么必须有：`dvw=0`（验证桌面档）时布点直接读真实窗口，
   * 而验收脚本是**先开页面再改视口**的（CDP 的 setDeviceMetricsOverride），
   * 没有这个监听就会拿旧的窗口尺寸去布点、量出一堆对不上的数字。
   * 有注入视口时重排是无害的（注入值优先，结果不变）。
   */
  const onResize = (): void => {
    relayout();
    probeAfterLayout();
  };
  window.addEventListener('resize', onResize);
  registerCleanup(page, () => window.removeEventListener('resize', onResize));

  return page;
}
