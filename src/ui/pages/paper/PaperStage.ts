/**
 * 白纸画布：把单词撒到纸上，并管「英文 / 义项数 / 中文」三个周边元素的显隐。
 *
 * 布点算法**直接复用归档的 `core/layout.ts`**（`computeGrid` + `layoutWords`），
 * 这一点按用户要求「单词分布的主体程序逻辑不变」。本文件只做三件事：
 *   1. 算出纸张尺寸与可用区域（这一步修了「与按钮重叠」）；
 *   2. 把布点结果变成 DOM；
 *   3. **改完中文能立刻刷新**（这一步修了「背诵期间改中文不立即显示」）。
 */
import { getSettings } from '../../../core/config';
import {
  computeGrid,
  layoutWords,
  resolvePaperSize,
  seedFromString,
  wordBoxPx,
  wordRowHeightPx,
  type Placement,
} from '../../../core/layout';
import { activeSenses, formatSensesBrief } from '../../../core/model';
import type { Word } from '../../../core/types';
import { controlTier, deviceKind, minColsFor } from '../../device';
import { h } from '../../dom';
import { paperButtonBox, paperFontMetrics } from './geometry';

/** 舞台句柄 */
export interface PaperStageHandle {
  /** 纸面元素（绝对定位基准） */
  root: HTMLElement;
  /** 纸面像素尺寸 */
  paperSize: { width: number; height: number };
  /** 算一遍布点，返回 id → 归一化中心坐标 */
  layout(words: Word[], seedText?: string): Record<string, Placement>;
  /** 把一个词放上纸 */
  addWord(word: Word, placement: Placement, showMeaning?: boolean): void;
  /** 切换某个词的中文显隐 */
  toggleMeaning(wordId: string): void;
  /** 让某个词显示中文（并收起上一个自动显示的） */
  showMeaning(wordId: string): void;
  /**
   * ★ 用最新的词数据**重画周边元素**（中文、义项数）。
   * 这就是修「背诵期间修改中文意思后不会立即显示」的入口：
   * 上一版把中文文本在 `buildWordZone` 时烘成静态文本，改完不会更新；
   * 现在卡片保存后调这里，按当前 `word.senses` 重新算文本。
   */
  refreshWord(word: Word): void;
  /** 纸面上已放几个词 */
  count(): number;
  destroy(): void;
}

/** 构造参数 */
export interface PaperStageOptions {
  /** 点英文：由页面决定是「切换中文」 */
  onWordClick: (word: Word) => void;
  /** 点中文：打开单词卡 */
  onMeaningClick: (word: Word) => void;
}

/**
 * 量一段文字渲染后的宽高（用 canvas，和屏幕同一套字体参数）。
 * @param text 文本
 * @param fontSize 字号（像素）
 * @param fontFamily 字体族
 */
function measureText(text: string, fontSize: number, fontFamily: string): { w: number; h: number } {
  try {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) return { w: text.length * fontSize * 0.6, h: fontSize };
    ctx.font = `${fontSize}px ${fontFamily}`;
    const m = ctx.measureText(text);
    return { w: m.width, h: fontSize };
  } catch {
    // 量不出来时按字符数粗估，保证不返回 0（否则布点会全挤在一起）
    return { w: text.length * fontSize * 0.6, h: fontSize };
  }
}

/**
 * 中英混排的宽度估算（不依赖 canvas）。
 *
 * ★ 为什么必须自己估：`measureText` 在某些字体串下会失败并回退到
 *   `字符数 × 字号 × 0.6`，而这个系数对**中文**严重偏小（中文一个字约 1 个字宽）。
 *   实测后果：中文盒子只给了 40px，`放弃` 被挤成「放」+「弃」两行。
 *   这里按字符类别逐字累加：CJK / 全角标点按 1 个字宽，其余按 0.55。
 * @param text 文本
 * @param fontSize 字号（像素）
 */
function estimateTextWidth(text: string, fontSize: number): number {
  let w = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    const wide =
      (code >= 0x2e80 && code <= 0x9fff) ||
      (code >= 0x3000 && code <= 0x303f) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xff00 && code <= 0xffef);
    w += wide ? fontSize : fontSize * 0.55;
  }
  return w;
}
/** 中文意思盒子的最大宽度（与 paper.css 的 max-width 一致；实际用值按字号等比缩放） */
const MEANING_MAX_W = 260;
/** 中文意思盒子的左右内边距之和（2px padding * 2 + 边框） */
const MEANING_PAD_X = 18;
/** 中文意思盒子的上下内边距 */
const MEANING_PAD_Y = 8;
/** 造一个白纸舞台 */
export function createPaperStage(opts: PaperStageOptions): PaperStageHandle {
  const settings = getSettings();
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  const paperSize = resolvePaperSize(settings.paper, viewport);
  /**
   * ★ 版本 0.0.19（外观 → 分辨率大小）：纸面按设置里的**逻辑分辨率**布点，
   *   再等比缩进窗口——调大分辨率就是「同样一屏塞下更多更小的字」。
   *   自适应窗口时 paperSize 就是窗口尺寸，缩放系数恒为 1（行为与本版之前完全一致）。
   *   只缩小、不放大（`Math.min(1, …)`）：小分辨率不该被拉大，否则这个选项失去意义。
   */
  const fitScale = Math.min(1, viewport.width / Math.max(1, paperSize.width), viewport.height / Math.max(1, paperSize.height));
  const kind = deviceKind(viewport.width);
  const isPhone = kind === 'phone';
  const tier = controlTier(viewport.width);
  /**
   * ★ 版本 0.0.19（外观 → 字体大小）：单词 / 中文 / 角标 / 统计的**同一份**字号组。
   *   相对比例由 `paperFontMetrics()` 统一算，这里不再各自写死。
   */
  const font = paperFontMetrics();
  const fontSize = font.word;
  /** 中文意思的最大宽度按字号等比缩放（否则字号一大就被挤成很多行） */
  const meaningMaxW = Math.round(MEANING_MAX_W * font.scale);

  const root = h('div', {
    class: `paper-sheet${settings.display.animation ? '' : ' paper-stage-no-anim'}`,
    style: {
      width: `${paperSize.width}px`,
      height: `${paperSize.height}px`,
      // 纸张在视口里居中：布点算的是「纸面坐标」，DOM 也贴在纸面上，所以只要让纸居中即可
      position: 'relative',
      // 逻辑分辨率 → 窗口：等比缩小（transform 不改变布局坐标，纸内一切仍是逻辑 px）
      transform: fitScale === 1 ? undefined : `scale(${fitScale})`,
      transformOrigin: 'center center',
    },
  });

  /** 词 id → 落点容器 / 中文元素，供刷新与切换显隐 */
  const zones = new Map<string, HTMLElement>();
  const meaningEls = new Map<string, HTMLElement>();
  /** 词 id → 当前词数据（refreshWord 时用来重算中文） */
  const wordMap = new Map<string, Word>();
  /** 上一个「自动显示中文」的元素，用于收起 */
  let lastAutoMeaning: HTMLElement | null = null;

  /**
   * 算一次布点。
   *
   * ★ 修复「与按钮重叠」的关键：`avoid` 现在是**向外扩过**的按钮矩形，
   *   并且手机端把可用区的下边界**收到 avoid 顶边**，两者严丝合缝。
   */
  /**
   * 算中文意思那块「盒子」的尺寸。
   *
   * ★ 用户第 3 条：上一版布点只按**英文**的宽高算占位矩形，中文比英文宽（最多 260px）
   *   时就会伸出纸边。现在把中文也量出来，宽度取 `min(260, 文本宽+内边距)`，
   *   高度按可能换行数估算；`buildZone` 里再把 `max-width` 设成这个宽度，
   *   中文就被强制约束在盒子里换行，不会溢出画面。
   * @param word 词
   */
  const meaningBox = (word: Word): { w: number; h: number } => {
    const text = formatSensesBrief(word.senses);
    const m = { w: estimateTextWidth(text, font.meaning) };
    const inner = meaningMaxW - MEANING_PAD_X;
    const lines = Math.max(1, Math.ceil(m.w / Math.max(1, inner)));
    return {
      w: Math.min(meaningMaxW, Math.max(Math.ceil(m.w), font.meaning * 2) + MEANING_PAD_X + 4),
      h: Math.ceil(font.meaning * 1.5 * lines) + MEANING_PAD_Y + 2,
    };
  };
  const doLayout = (words: Word[], seedText?: string): Record<string, Placement> => {
    const margin = tier.edgeMarginPx;
    const box = paperButtonBox(viewport);
    /**
     * 纸张居中偏移（视口 → 纸面坐标）。
     * ★ 0.0.19：纸面被 `fitScale` 等比缩过，所以视觉上的左/上边距是
     *   `(视口 - 纸面 × 缩放) / 2`，再除以缩放才能换算回**逻辑坐标**。
     */
    const offsetX = (viewport.width - paperSize.width * fitScale) / 2;
    const offsetY = (viewport.height - paperSize.height * fitScale) / 2;
    const avoid = {
      x: (box.avoid.x - offsetX) / fitScale,
      y: (box.avoid.y - offsetY) / fitScale,
      width: box.avoid.width / fitScale,
      height: box.avoid.height / fitScale,
    };

    // 可用区：减边距；手机再把下边界收到避让区顶边
    const areaBottom = isPhone
      ? Math.min(paperSize.height - margin, Math.max(margin + 1, avoid.y))
      : paperSize.height - margin;
    const area = {
      x: margin,
      y: margin,
      width: Math.max(1, paperSize.width - margin * 2),
      height: Math.max(1, areaBottom - margin),
    };

    const metrics = words.map((w) => {
      const m = measureText(w.en, fontSize, settings.display.fontFamily);
      const wordBox = wordBoxPx(m.w, m.h, isPhone);
      // ★ 用户第 3 条：占位矩形 = 英文盒子 ∪ 中文盒子，否则中文会伸出纸边
      const mb = meaningBox(w);
      return { widthPx: Math.max(wordBox.widthPx, mb.w), heightPx: wordBox.heightPx + mb.h };
    });
    const meanW = metrics.length > 0 ? metrics.reduce((s, m) => s + m.widthPx, 0) / metrics.length : 0;
    const rowH = wordRowHeightPx(fontSize);

    const grid = computeGrid({
      availableW: area.width,
      availableH: area.height,
      meanWidthPx: meanW,
      rowHeightPx: rowH,
      minGapPx: tier.minGapPx,
      targetCount: tier.targetCount,
      minCols: minColsFor(kind),
    });

    const points = layoutWords({
      metrics,
      canvas: paperSize,
      area,
      grid,
      minGapPx: tier.minGapPx,
      seed: seedFromString(`${words.map((w) => w.id).join(',')}#${paperSize.width}x${paperSize.height}`),
      avoidPx: avoid,
    });

    const out: Record<string, Placement> = {};
    words.forEach((w, i) => {
      const p = points[i];
      if (p) out[w.id] = p;
    });
    return out;
  };

  /** 建一个词的落点元素：英文 +（右上角）义项数 + 中文 */
  const buildZone = (word: Word, placement: Placement): HTMLElement => {
    const zone = h('div', {
      class: 'paper-word-zone',
      dataset: { wordBox: word.en },
      style: { left: `${placement.x * 100}%`, top: `${placement.y * 100}%` },
    });
    const row = h('div', { class: 'paper-word-row' });

    const wordEl = h('div', {
      class: `paper-word${settings.display.animation ? ' anim-in' : ''}`,
      style: {
        fontFamily: settings.display.fontFamily,
        fontSize: `${fontSize}px`,
        color: settings.display.wordColor,
      },
      text: word.en,
      title: '点击显示/隐藏中文意思',
    });
    wordEl.addEventListener('click', (ev) => {
      ev.stopPropagation();
      opts.onWordClick(word);
    });
    row.appendChild(wordEl);

    // 义项数：右上角浅灰小数字，只有 >1 才显示
    const senseCount = activeSenses(word).length;
    if (senseCount > 1) {
      row.appendChild(h('span', { class: 'paper-badge', text: String(senseCount), title: `该词有 ${senseCount} 个义项` }));
    }

    const meaning = h('div', {
      class: 'paper-meaning hidden',
      text: formatSensesBrief(word.senses),
      title: '点击打开单词卡',
      // ★ 用户第 3 条：宽度直接约束到布点预算的盒子里，中文永远不会伸出画面
      style: { maxWidth: `${meaningBox(word).w}px` },
    });
    meaning.addEventListener('click', (ev) => {
      ev.stopPropagation();
      opts.onMeaningClick(word);
    });
    meaningEls.set(word.id, meaning);

    zone.appendChild(row);
    zone.appendChild(meaning);
    return zone;
  };

  return {
    root,
    paperSize,
    layout: doLayout,

    addWord(word, placement, showMeaning = false) {
      if (zones.has(word.id)) return;
      const zone = buildZone(word, placement);
      root.appendChild(zone);
      zones.set(word.id, zone);
      wordMap.set(word.id, word);
      if (showMeaning) this.showMeaning(word.id);
    },

    showMeaning(wordId) {
      const el = meaningEls.get(wordId);
      if (!el) return;
      if (lastAutoMeaning && lastAutoMeaning !== el) lastAutoMeaning.classList.add('hidden');
      el.classList.remove('hidden');
      lastAutoMeaning = el;
    },

    toggleMeaning(wordId) {
      const el = meaningEls.get(wordId);
      if (!el) return;
      el.classList.toggle('hidden');
      if (!el.classList.contains('hidden')) lastAutoMeaning = el;
    },

    /**
     * ★ 用最新数据重画周边元素。
     *
     * 只重算**中文文本**和**义项数**，不动英文与位置——
     * 因为改的是「中文意思」，英文和落点没变，重排整张纸反而是错的。
     */
    refreshWord(word) {
      const el = meaningEls.get(word.id);
      if (el) el.textContent = formatSensesBrief(word.senses);
      const zone = zones.get(word.id);
      const badge = zone?.querySelector('.paper-badge');
      const count = activeSenses(word).length;
      if (badge) {
        // 义项数也一起更新：删掉一个义项后角标要跟着变
        if (count > 1) badge.textContent = String(count);
        else badge.remove();
      } else if (zone && count > 1) {
        zone.querySelector('.paper-word-row')?.appendChild(
          h('span', { class: 'paper-badge', text: String(count), title: `该词有 ${count} 个义项` }),
        );
      }
      wordMap.set(word.id, word);
    },

    count() {
      return zones.size;
    },

    destroy() {
      zones.clear();
      meaningEls.clear();
      wordMap.clear();
      root.replaceChildren();
    },
  };
}
