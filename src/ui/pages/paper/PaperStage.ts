import { DEVICE, getSettings, parseColsOverride } from '../../../core/config';
import type { LayoutInfo, Placement } from '../../../core/layout';
import {
  computeGrid,
  layoutWords,
  resolvePaperSize,
  wordBoxPx,
  WORD_LINE_HEIGHT_RATIO,
  wordRowHeightPx,
  type WordMetrics,
} from '../../../core/layout';
import { activeSenses, formatSensesBrief } from '../../../core/model';
import type { MemorizeSettings, Word } from '../../../core/types';
import { speak } from '../../../services/tts';
import { controlsAvoidRect, controlTier, deviceKind, minColsFor } from '../../device';
import { h } from '../../dom';

/** 白纸舞台参数 */
export interface PaperStageOptions {
  /** 点击单词文字：切换该词下方的中文意思 */
  onWordClick: (word: Word) => void;
  /** 点击中文意思：打开单词卡 */
  onMeaningClick: (word: Word) => void;
}

/**
 * 布点用的视口尺寸。
 *
 * 正常情况就是真实的 `window.innerWidth/innerHeight`；**布局调试页**（阶段 M1）
 * 会注入一个「模拟真机尺寸」：无头浏览器的最小窗宽是 504px，`--window-size=390,844`
 * 只会得到 504×749，真机列数就永远量不到。注入之后纸张尺寸、字号放大系数、
 * 按钮避让区全部按注入尺寸算，量出来的才是 390 宽那一版布局。
 */
interface LayoutViewport {
  width: number;
  height: number;
}

/**
 * 取布点用的视口尺寸（调试页注入优先，没有就用真实窗口）。
 */
function layoutViewport(): LayoutViewport {
  const injected = window.__layoutViewport;
  if (injected && injected.width > 0 && injected.height > 0) return injected;
  return { width: window.innerWidth, height: window.innerHeight };
}

/**
 * 把题干遮罩的**横向**中心位置夹进视口。
 *
 * ★ 这是「记忆时卡片看不见」的真正原因（M2 实测）：
 *   遮罩是「以中心点定位 + translate(-50%)」的，宽度约 290~330px；
 *   而 M2 之后手机上词分两列、左列词的中心 x ≈ 65px —— 以它为中心时
 *   遮罩左边缘落在 **-30 ~ -77px**，大半个卡片直接跑到屏幕外，用户什么也看不到。
 *   所以横向必须按「整块卡片都要在视口内」来夹。
 * @param centerXRatio 归一化的目标中心 x（0=屏幕左，1=屏幕右）
 * @param overlayWidthPx 遮罩实际宽度（像素）
 * @param viewportWidthPx 视口宽度（像素）
 */
function clampOverlayLeft(centerXRatio: number, overlayWidthPx: number, viewportWidthPx: number): number {
  const margin = 8; // 两侧各留 8px，别贴着边
  const width = Math.min(overlayWidthPx, Math.max(1, viewportWidthPx - margin * 2));
  const desired = (Number.isFinite(centerXRatio) ? centerXRatio : 0.5) * viewportWidthPx;
  const min = margin + width / 2;
  const max = viewportWidthPx - margin - width / 2;
  const clamped = max < min ? viewportWidthPx / 2 : Math.min(max, Math.max(min, desired));
  return clamped / Math.max(1, viewportWidthPx);
}

/**
 * 题干遮罩纵向位置的**安全区**。
 *
 * 遮罩是「以中心点定位」的，高度约 1/3 屏，所以中心点太靠上会顶出屏幕、
 * 太靠下会被底部按钮带压住。这里把中心点夹在 `minTop ~ maxTop` 之间：
 * - 28%：再往上，长单词 + 多义项输入框会把标题顶出屏幕；
 * - 62%：再往下，遮罩下沿会进按钮带（按钮带顶部在 844 屏上约 670，即 79%）。
 * 之所以是「夹」而不是「直接改设置」：用户的 offsetY 是他们自己调的，
 * 保留他们的意图，只在真会出问题时兜一下。
 * @param ratio 归一化的目标中心位置（0=屏幕顶，1=屏幕底）
 */
function clampOverlayTop(ratio: number, overlayHeightPx: number, viewportHeightPx: number): number {
  const margin = 8;
  const height = Math.min(overlayHeightPx, Math.max(1, viewportHeightPx - margin * 2));
  const desired = (Number.isFinite(ratio) ? ratio : 0.3) * viewportHeightPx;
  // 上边界留 8px；下边界也不许贴到最底（8px）
  const min = margin + height / 2;
  const max = viewportHeightPx - margin - height / 2;
  const clamped = max < min ? viewportHeightPx / 2 : Math.min(max, Math.max(min, desired));
  return clamped / Math.max(1, viewportHeightPx);
}

/** 白纸舞台：纸张尺寸、布点、单词元素、义项序号、词下中文意思、记忆模式遮罩。 */
export interface PaperStage {
  root: HTMLElement;
  sheet: HTMLElement;
  /** 按当前设置重算纸张尺寸 */
  applySettings(): void;
  /** 为一组词计算落点（写入内部表并返回） */
  computePlacements(words: Word[], seed: number): Record<string, Placement>;
  /**
   * 按**当前设置**重新布点，并把已经上纸的词**就地移到新落点**
   * （不重建 DOM 元素，也就不闪、不丢点击态）。
   *
   * 用途：S3 的手动列数覆盖 —— 用户在背诵页点 ⊞ 选 6 列，当场就要看到重排结果。
   * @param words 当前队列（与 computePlacements 同一份）
   * @param seed 同一个种子（保证「同一批词、同一 seed」结果稳定）
   */
  relayout(words: Word[], seed: number): Record<string, Placement>;
  /** 纸上最多能放下的词数（由「字号 + 最宽的词 + 按钮避让」约束出来的容量） */
  capacity(): number;
  /** 用已保存的落点恢复（续跑用） */
  restorePlacements(placements: Record<string, Placement>): void;
  /** 把一个词放到落点上。opts.animate 控制淡入；opts.showMeaning 自动显示中文意思（仅最新词用） */
  addWord(word: Word, placement: Placement, opts?: { animate?: boolean; showMeaning?: boolean }): void;
  /** 该词是否已在纸上 */
  hasWord(id: string): boolean;
  /** 取某词的落点 */
  placementOf(id: string): Placement | null;
  /** 切换某词下方中文意思的显示/隐藏，返回切换后的可见状态 */
  toggleMeaning(id: string): boolean;
  /** 隐藏所有词（记忆环节） */
  hideWords(): void;
  /** 重新显示所有词 */
  showWords(): void;
  /** 移除一个词（斩掉） */
  removeWord(id: string): void;
  /** 显示记忆/拼写遮罩 */
  showOverlay(placement: Placement | null, positionOverride?: MemorizeSettings['position']): HTMLElement;
  /**
   * 按「上一次量到的遮罩尺寸」把当前遮罩位置夹进视口（见 clampOverlayLeft/Top）。
   * 调用方**填完内容之后**调一次即可（记忆/拼写环节都走这一步）。
   */
  repositionOverlay(): void;
  /** 收起遮罩 */
  hideOverlay(): void;
  /** 朗读 */
  speakWord(word: Word): void;
  /** 销毁 */
  destroy(): void;
}

/**
 * 创建白纸舞台。挂载后调用 applySettings() 完成初始化。
 * @param opts 回调
 */
export function createPaperStage(opts: PaperStageOptions): PaperStage {
  const settings = getSettings();
  const root = h('div', {
    class: `paper-stage${settings.display.animation ? '' : ' no-anim'}`,
    style: { background: settings.display.bgColor },
  });
  const sheet = h('div', { class: 'paper-sheet' });
  root.appendChild(sheet);

  const wordEls = new Map<string, HTMLElement>();
  const meaningEls = new Map<string, HTMLElement>();
  const placements: Record<string, Placement> = {};
  /** 最新一个自动显示意思的词（下一个词出现时自动收起它） */
  let lastAutoMeaning: HTMLElement | null = null;
  const overlay = h('div', { class: 'paper-overlay hidden' });
  /**
   * 题干遮罩的定位状态（记忆/拼写两个环节共用）。
   *
   * 为什么要单独存：`showOverlay()` 只是「把盒子亮出来」，位置要等调用方
   * **填完内容**（`repositionOverlay()`）才能算 —— 因为夹位置需要知道遮罩有多宽多高，
   * 而刚 `replaceChildren()` 完的盒子宽度是 0。所以：
   * - `overlayPlacement`：这次要弹在哪（null = 居中偏上）
   * - `overlaySize`：上一次量到的实际尺寸（首次按视口比例保守估）
   * - `overlayPositionOverride`：只给调试页用（一次调用临时改模式，不动设置）
   */
  let overlayPlacement: Placement | null = null;
  let overlaySize = { w: 0, h: 0 };
  let overlayPositionOverride: MemorizeSettings['position'] | null = null;
  root.appendChild(overlay);

  /**
   * 当前设备上单词的实际字号。
   *
   * ★ M2：手机上直接用 `layout.mobile.fontSizePx`（用户在设置页/调试页可调），
   *   不再用「基础字号 × phoneFontScale」推算——布点、渲染、CSS 三处必须同一个值，
   *   否则量出来的行高与实际渲染对不上，碰撞检测就会失效。
   */
  const effectiveFontSize = (): number => {
    const vp = layoutViewport();
    if (deviceKind(vp.width) === 'phone') return Math.max(10, Math.round(controlTier(vp.width).fontSizePx));
    return getSettings().display.fontSize;
  };

  /** 义项序号的字号：跟随单词字号等比缩小，但不小于可读下限 */
  const badgeFontSize = (): number =>
    Math.max(DEVICE.senseBadgeMinFontSize, Math.round(effectiveFontSize() * DEVICE.senseBadgeScale));

  const applySettings = (): void => {
    const s = getSettings();
    root.style.background = s.display.bgColor;
    root.classList.toggle('no-anim', !s.display.animation);
    const size = resolvePaperSize(s.paper, layoutViewport());
    sheet.style.width = `${size.width}px`;
    sheet.style.height = `${size.height}px`;
    const fontSize = effectiveFontSize();
    for (const el of wordEls.values()) {
      el.style.fontFamily = s.display.fontFamily;
      el.style.fontSize = `${fontSize}px`;
      el.style.color = s.display.wordColor;
      const badge = el.querySelector<HTMLElement>('.paper-badge');
      if (badge) {
        badge.style.fontSize = `${badgeFontSize()}px`;
        badge.style.color = DEVICE.senseBadgeColor;
      }
    }
  };

  const onResize = (): void => applySettings();
  window.addEventListener('resize', onResize);

  /** 朗读（带设置里的语速/语言） */
  const speakWord = (word: Word): void => {
    const s = getSettings();
    // ★ T4：语速与口音统一读 `speech`（朗读设置的家）。`speak()` 内部还会走
    //   「缓存 → 第三方 → 浏览器语音」三级降级，这里只管把词与参数交给它。
    speak(word.en, { rate: s.speech.rate, lang: s.speech.accent });
  };

  let placeCapacity = 0;

  /**
   * 量出每个词的**实际占位矩形**（像素）：文字宽（canvas）+ 点击热区 padding。
   *
   * ★ M2 的核心输入：新算法要按「每个词自己的宽度」找格子、做真实矩形碰撞检测。
   *   两条踩过的坑：
   *   1. 只取最宽词不行（M1 的瓶颈就是它）；
   *   2. canvas 量的是**文字**宽度，而占位置的是带 padding 的 `.paper-word`
   *      元素 —— 不把 padding 算进去，屏幕上词间距会比配置的 minGap 小 8px。
   * @param words 本批词
   */
  /** 量到的「一行文字占多高」缓存（键 = 字号+字体），避免每个词都摸一次 DOM */
  let textHeightCache: { key: string; heightPx: number } | null = null;

  /**
   * 量出「一行文字真正占的高度」（像素）。
   *
   * ★ 为什么不用 canvas 的 `fontBoundingBox` 估算（M2 实测踩到）：
   *   它与 CSS 实际渲染高度不是一回事，system-ui 下差 6.7px。
   *   估小 → 纵向碰撞检测失效（配置 12px 的间隙，DOM 只量到 6.6px）；
   *   估大 → 一屏少放好几个词。
   *
   * 做法：拿**行高 × 字号**作为基准（`.paper-word` 的 line-height 是 1.45），
   * 再用一个与 `.paper-word` 同样式、同样父级的探测元素**实测**一次取较大值。
   * 取较大值是有意的：宁可多留 1px 空隙，也不要让词叠在一起。
   * @param fontSize 当前字号
   * @param fontFamily 当前字体
   */
  const measureTextLineHeightPx = (fontSize: number, fontFamily: string): number => {
    const key = `${fontSize}|${fontFamily}`;
    if (textHeightCache && textHeightCache.key === key) return textHeightCache.heightPx;
    const cssLineHeight = fontSize * WORD_LINE_HEIGHT_RATIO;
    const probe = h('div', {
      class: 'paper-word',
      style: { fontFamily, fontSize: `${fontSize}px`, whiteSpace: 'nowrap', visibility: 'hidden', position: 'absolute' },
      text: 'Hg',
    });
    sheet.appendChild(probe);
    const measured = probe.getBoundingClientRect().height;
    probe.remove();
    const heightPx = Math.max(cssLineHeight, measured > 0 ? measured : 0);
    textHeightCache = { key, heightPx };
    return heightPx;
  };

  const wordMetrics = (words: Word[]): WordMetrics[] => {
    if (words.length === 0) return [];
    const fontSize = effectiveFontSize();
    const isPhone = deviceKind(layoutViewport().width) === 'phone';
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const s = getSettings();
    const lineBoxPx = measureTextLineHeightPx(fontSize, s.display.fontFamily);
    if (!ctx) {
      // 退化：英文平均字宽约 0.55 × 字号
      return words.map((w) => wordBoxPx(w.en.length * fontSize * 0.55, lineBoxPx, isPhone));
    }
    ctx.font = `${fontSize}px ${s.display.fontFamily}`;
    return words.map((w) => wordBoxPx(ctx.measureText(w.en).width, lineBoxPx, isPhone));
  };

  /**
   * 本批词的**平均**渲染宽度（像素）= 所有词宽之和 ÷ 词数。
   * M2 用它定列数（旧算法用的是最宽词，那正是 M1 查出来的瓶颈）。
   * @param metrics wordMetrics 的结果
   */
  const meanWidthPx = (metrics: WordMetrics[]): number => {
    if (metrics.length === 0) return 0;
    return metrics.reduce((sum, m) => sum + m.widthPx, 0) / metrics.length;
  };

  /**
   * 写一份「本次布点到底按什么在算」的只读快照（阶段 M1 诊断用）。
   *
   * 放在 `window.__layoutInfo` 上，供调试页 `#/dev/layout` 的
   * `window.__layoutProbe()` 附在测量结果里。**纯诊断**：不读回、不参与计算、
   * 不影响任何落点。报告里的「最宽词 205px → 网格只能 2 列」就是从这里来的。
   * ★ S3 起 cols / rows / gridCapacity 由**算法自己报**（不再由调试页按参数复刻一份）：
   *   复制一份推导迟早会跟算法本身走偏，而「报告与 DOM 对不上」正是最难查的一类问题。
   * @param info 完整快照
   */
  const publishLayoutInfo = (info: LayoutInfo): void => {
    window.__layoutInfo = info;
  };

  /**
   * 把某个词的元素移到新落点（落点变了**就地移动**，不重建 DOM 元素）。
   * 用途：手动列数覆盖后重新布点（`relayout()`）。
   */
  const applyPlacement = (id: string, p: Placement): void => {
    const el = wordEls.get(id);
    if (!el) return;
    el.style.left = `${p.x * 100}%`;
    el.style.top = `${p.y * 100}%`;
  };

  /**
   * 为一组词算落点（写入内部落点表并返回）。
   *
   * ★ S3 起**所有设备形态共用一套算法**：`computeGrid`（自然列数 + 目标行数）
   *   + `layoutWords`（随机落格 + 真实矩形碰撞检测）。
   *   为什么要统一：M2 只把手机换成了这套，平板/桌面仍在走 `jitteredGrid`，
   *   而后者用「最宽词 + 字号×2.4」当最小中心距去夹列数 —— 一个长词就能把
   *   桌面压成 2~3 列（用户实测：「电脑上出现的单词像手机一样只排成两列」）。
   * @param words 要布点的词（通常是整个队列）
   * @param seed 随机种子（同一 seed 结果稳定，续跑位置不变）
   */
  const computePlacements = (words: Word[], seed: number): Record<string, Placement> => {
    const s = getSettings();
    const vp = layoutViewport();
    const size = resolvePaperSize(s.paper, vp);
    const aspect = size.width / Math.max(1, size.height);
    const fontSize = effectiveFontSize();
    const metrics = wordMetrics(words);
    const widest = metrics.reduce((m, x) => Math.max(m, x.widthPx), 0);
    const average = meanWidthPx(metrics);
    const rowHeight = wordRowHeightPx(fontSize);
    // 纸张在视口里居中：算出纸面左上角相对视口的偏移，才能把「按钮避让区」换算到纸面坐标
    const offsetX = (vp.width - size.width) / 2;
    const offsetY = (vp.height - size.height) / 2;
    const controls = controlsAvoidRect(vp);
    const kind = deviceKind(vp.width);
    const tier = controlTier(vp.width);
    const margin = tier.edgeMarginPx;

    // ── 可用布点区 ──
    // 手机：下边界 = 底部按钮**横带**的顶边（M2 口径，横带以上整片都能放词）。
    //   写成 `size.height − margin − 带高` 是错的（带高会减两次，一屏只剩 7 个词），
    //   正确的量是「带顶边到纸面顶部的距离」。
    // 平板/桌面：整张纸扣掉四周边距 —— 右下角按钮是个**方块**，
    //   由 layoutWords 按真实矩形判交避开即可，不该把整条底部横带都封掉
    //   （否则按钮左边那一大片空白永远放不了词）。
    const bandTop = controls.y - offsetY;
    const areaBottom =
      kind === 'phone' ? Math.min(size.height - margin, Math.max(margin + 1, bandTop)) : size.height - margin;
    const area = {
      x: margin,
      y: margin,
      width: Math.max(1, size.width - margin * 2),
      height: Math.max(1, areaBottom - margin),
    };

    // 列数：自然推导（或用户在设置页/背诵页手动覆盖）；行数：按目标词数反推
    const colsOverride = parseColsOverride(s.layoutColsOverride);
    const minCols = minColsFor(kind);
    const grid = computeGrid({
      availableW: area.width,
      availableH: area.height,
      meanWidthPx: average,
      rowHeightPx: rowHeight,
      minGapPx: tier.minGapPx,
      targetCount: tier.targetCount,
      minCols,
      colsOverride,
    });

    // 落点：每个词按自己的宽度找格子，随机落格 + 真实碰撞检测
    const points = layoutWords({
      metrics,
      canvas: { width: size.width, height: size.height },
      area,
      grid,
      minGapPx: tier.minGapPx,
      seed,
      // 避让区一律按**真实矩形**判交：手机是整条横带，平板/桌面是右下角方块。
      // 旧算法要按「半个词」外扩是因为它只判中心点；新算法判整块矩形，不需要外扩。
      avoidPx: {
        x: controls.x - offsetX,
        y: controls.y - offsetY,
        width: controls.width,
        height: controls.height,
      },
    });

    placeCapacity = points.length; // 约束下纸上实际能放下的数量
    publishLayoutInfo({
      wordCountRequested: words.length,
      capacity: placeCapacity,
      paperW: size.width,
      paperH: size.height,
      sheetOffsetX: Math.round(offsetX),
      sheetOffsetY: Math.round(offsetY),
      fontSize,
      deviceKind: kind,
      widestWordPx: Math.round(widest * 10) / 10,
      avgWordPx: Math.round(average * 10) / 10,
      shortestWordLen: words.reduce((n, w) => Math.min(n, w.en.length), 99),
      longestWordLen: words.reduce((n, w) => Math.max(n, w.en.length), 0),
      // 保证值：任意两个词的中心距/边缘距都不会小于它（真实矩形碰撞检测按它判）
      gapX: Math.round(tier.minGapPx * 10) / 10,
      gapY: Math.round(tier.minGapPx * 10) / 10,
      // 新算法直接按真实矩形判交，不需要「半个词」的外扩量
      padX: 0,
      padY: 0,
      cols: grid.cols,
      rows: grid.rows,
      gridCapacity: grid.capacity,
      cellsUnused: grid.capacity - points.length,
      marginNorm: Math.round((margin / Math.max(1, size.width)) * 1000) / 1000,
      aspect: Math.round(aspect * 1000) / 1000,
      placements: placeCapacity,
      // 网格自述（诊断与验收都要看这几个数）
      algorithm: 'natural-grid',
      wordsPerRow: grid.cols,
      area,
      minCols,
      maxCols: grid.maxCols,
      maxRows: grid.maxRows,
      colsRequested: grid.colsRequested,
      colsOverridden: grid.colsOverridden,
      colsClamped: grid.colsClamped,
      targetCount: tier.targetCount,
    });
    // 落点表按新结果**整体重算**（清掉旧 key，避免换词/改列数后残留上批的落点）
    for (const key of Object.keys(placements)) delete placements[key];
    words.forEach((w, i) => {
      const p = points[i];
      if (p) placements[w.id] = p;
    });
    return placements;
  };

  const capacity = (): number => placeCapacity;

  const restorePlacements = (saved: Record<string, Placement>): void => {
    for (const [id, p] of Object.entries(saved)) {
      if (p) placements[id] = { x: p.x, y: p.y };
    }
    placeCapacity = Object.keys(saved).length;
  };

  /**
   * 构建一个词的落点元素：单词 +（浅灰）义项数 + 词下中文意思。
   *
   * 为什么不再有悬停工具条和发音按钮（阶段 05 的决定）：
   * 移动端没有 hover，鼠标移上去才出现的东西在手机/平板上等于不存在；
   * 而且手机上「单词旁边放个喇叭」很容易误触。朗读入口只保留两个：
   * 单词出现时自动朗读、单词卡里的喇叭。
   *
   * 义项数改成**主动显示的浅灰小数字**（平板和手机都显示，行为一致；
   * 桌面也一起显示，避免两套逻辑）；只有 1 个义项时不显示，免得满屏都是「1」。
   */
  const buildWordZone = (word: Word, placement: Placement): HTMLElement => {
    const zone = h('div', {
      class: 'paper-word-zone',
      // ★ 测量标记（阶段 M1）：布局调试页按这个属性遍历所有单词元素量真实坐标
      //   （`window.__layoutProbe()`）。不加类名、不加样式，对渲染结果零影响。
      dataset: { wordBox: word.en },
      style: { left: `${placement.x * 100}%`, top: `${placement.y * 100}%` },
    });

    const wordRow = h('div', { class: 'paper-word-row' });
    const el = h('div', {
      class: `paper-word${settings.display.animation ? ' anim-in' : ''}`,
      style: {
        fontFamily: settings.display.fontFamily,
        fontSize: `${effectiveFontSize()}px`,
        color: settings.display.wordColor,
      },
      text: word.en,
      title: '点击显示/隐藏中文意思',
    });
    // 点击单词：切换中文意思（点中文意思才开单词卡）
    el.addEventListener('click', (ev) => {
      ev.stopPropagation();
      opts.onWordClick(word);
    });
    wordRow.appendChild(el);

    const count = activeSenses(word).length;
    // 只有 1 个义项不显示序号（避免满屏「1」）
    if (count > 1) {
      wordRow.appendChild(
        h('span', {
          class: 'paper-badge',
          text: String(count),
          title: `该词有 ${count} 个义项`,
          style: { fontSize: `${badgeFontSize()}px`, color: DEVICE.senseBadgeColor },
        }),
      );
    }

    // 中文意思（只显示代表义项，不含近义词）：点它才打开单词卡
    const meaning = h('div', {
      class: 'paper-meaning hidden',
      text: formatSensesBrief(word.senses),
      title: '点击打开单词卡',
    });
    meaning.addEventListener('click', (ev) => {
      ev.stopPropagation();
      opts.onMeaningClick(word);
    });

    zone.appendChild(wordRow);
    zone.appendChild(meaning);
    meaningEls.set(word.id, meaning);
    return zone;
  };

  const addWord = (word: Word, placement: Placement, opts: { animate?: boolean; showMeaning?: boolean } = {}): void => {
    if (wordEls.has(word.id)) return;
    const zone = buildWordZone(word, placement);
    if (opts.animate === false) zone.querySelector('.paper-word')?.classList.remove('anim-in');
    sheet.appendChild(zone);
    wordEls.set(word.id, zone);
    if (opts.showMeaning) {
      // 只有最新出现的词自动显示意思：先收起上一个自动显示的
      if (lastAutoMeaning && lastAutoMeaning !== meaningEls.get(word.id)) lastAutoMeaning.classList.add('hidden');
      const m = meaningEls.get(word.id);
      if (m) {
        m.classList.remove('hidden');
        lastAutoMeaning = m;
      }
    }
  };

  return {
    root,
    sheet,
    applySettings,
    computePlacements,
    relayout(words, seed) {
      const next = computePlacements(words, seed);
      for (const [id, p] of Object.entries(next)) applyPlacement(id, p);
      return next;
    },
    restorePlacements,
    addWord,
    capacity,
    hasWord: (id) => wordEls.has(id),
    placementOf: (id) => placements[id] ?? null,
    toggleMeaning(id) {
      const m = meaningEls.get(id);
      if (!m) return false;
      const hidden = m.classList.toggle('hidden');
      return !hidden;
    },
    hideWords: () => root.classList.add('hidden-words'),
    showWords: () => root.classList.remove('hidden-words'),
    removeWord: (id) => {
      const el = wordEls.get(id);
      if (el) {
        el.remove();
        wordEls.delete(id);
        meaningEls.delete(id);
      }
    },
    showOverlay(placement, positionOverride) {
      overlay.replaceChildren(); // 每个词都要换新内容
      overlay.classList.remove('hidden');
      // 只记住「这次要弹在哪」：内容还没填、尺寸也不知道，位置等
      // 调用方填完内容调 repositionOverlay() 再算（见那个方法的注释）。
      overlayPlacement = placement;
      overlayPositionOverride = positionOverride ?? null;
      return overlay;
    },
    repositionOverlay() {
      if (overlay.classList.contains('hidden')) return;
      const s = getSettings();
      const vp = layoutViewport();
      // ★ 两种弹法（settings.memorize.position，设置页「D. 记忆与练习」里可切）：
      //   'origin'    = 弹在该词原来的落点（空间记忆感）
      //   'centerTop' = 弹在屏幕居中偏上（默认）
      // 为什么默认居中偏上：M2 之后手机上一屏铺 15~16 个词、分两列，
      // 「弹在原落点」时左列词会让整块卡片跑出屏幕左边（实测 left=-30.6 ~ -77.3px），
      // 用户看到的就是「记忆时卡片看不见了」。见 clampOverlayLeft 的注释。
      // ★ 尺寸必须取「上一次量到的」，不能现量：调用方刚 replaceChildren() 完，
      //   这一刻盒子是空的（宽 0），拿它去夹位置等于没夹（M2 实测踩到）。
      //   首次没有记录时按 92vw / 30vh 保守估，宁可先窄一点也不会跑出屏幕。
      const widthPx = overlaySize.w > 1 ? overlaySize.w : vp.width * 0.92;
      const heightPx = overlaySize.h > 1 ? overlaySize.h : vp.height * 0.3;
      const position = overlayPositionOverride ?? s.memorize.position;
      const useOrigin = position === 'origin' && overlayPlacement !== null;
      const centerX = useOrigin && overlayPlacement ? overlayPlacement.x : 0.5;
      const centerY = useOrigin && overlayPlacement ? overlayPlacement.y : s.memorize.offsetY;
      overlay.style.left = `${clampOverlayLeft(centerX, widthPx, vp.width) * 100}%`;
      overlay.style.top = `${clampOverlayTop(centerY, heightPx, vp.height) * 100}%`;
      overlay.classList.toggle('at-origin', useOrigin);
      // 量一次尺寸记下来，供下一次定位与验收脚本使用
      const r = overlay.getBoundingClientRect();
      overlaySize = { w: r.width, h: r.height };
    },
    hideOverlay() {
      overlay.classList.add('hidden');
      overlay.replaceChildren();
    },
    speakWord,
    destroy() {
      window.removeEventListener('resize', onResize);
    },
  };
}
