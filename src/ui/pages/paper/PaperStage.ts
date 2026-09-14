import { DEVICE, getSettings } from '../../../core/config';
import type { Placement } from '../../../core/layout';
import { jitteredGrid, resolvePaperSize, spacingBudget, wordRowHeightPx } from '../../../core/layout';
import { activeSenses, formatSensesBrief } from '../../../core/model';
import type { Word } from '../../../core/types';
import { speak } from '../../../services/tts';
import { controlsAvoidRect, deviceKind } from '../../device';
import { h } from '../../dom';

/** 白纸舞台参数 */
export interface PaperStageOptions {
  /** 点击单词文字：切换该词下方的中文意思 */
  onWordClick: (word: Word) => void;
  /** 点击中文意思：打开单词卡 */
  onMeaningClick: (word: Word) => void;
}

/** 白纸舞台：纸张尺寸、布点、单词元素、义项序号、词下中文意思、记忆模式遮罩。 */
export interface PaperStage {
  root: HTMLElement;
  sheet: HTMLElement;
  /** 按当前设置重算纸张尺寸 */
  applySettings(): void;
  /** 为一组词计算落点（写入内部表并返回） */
  computePlacements(words: Word[], seed: number): Record<string, Placement>;
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
  showOverlay(placement: Placement | null): HTMLElement;
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
  root.appendChild(overlay);

  /**
   * 当前设备上单词的实际字号。
   * 手机上放大一点，配合「布点密度降低」让每屏词更少、更好点。
   */
  const effectiveFontSize = (): number => {
    const s = getSettings();
    return deviceKind() === 'phone' ? Math.round(s.display.fontSize * DEVICE.phoneFontScale) : s.display.fontSize;
  };

  /** 义项序号的字号：跟随单词字号等比缩小，但不小于可读下限 */
  const badgeFontSize = (): number =>
    Math.max(DEVICE.senseBadgeMinFontSize, Math.round(effectiveFontSize() * DEVICE.senseBadgeScale));

  const applySettings = (): void => {
    const s = getSettings();
    root.style.background = s.display.bgColor;
    root.classList.toggle('no-anim', !s.display.animation);
    const size = resolvePaperSize(s.paper, { width: window.innerWidth, height: window.innerHeight });
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
    speak(word.en, { rate: s.practice.speakRate, lang: s.practice.speakLang });
  };

  let placeCapacity = 0;

  /**
   * 量出本批词里**渲染后最宽**的那个的宽度（像素）。
   *
   * 为什么要真的量：落点是单词中心，只按字号给间距挡不住长词——
   * 两个各宽 170px 的词，中心只隔 58px 时会直接叠在一起（用户实测反馈）。
   * 用 canvas 的 measureText 拿真实宽度，字体与字号跟白纸上的完全一致。
   * @param words 本批词
   */
  const widestWordPx = (words: Word[]): number => {
    if (words.length === 0) return 0;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      // 拿不到 2D 上下文（极罕见）→ 退化成一个保守估计：按最长英文 × 0.6 字号
      const longest = words.reduce((n, w) => Math.max(n, w.en.length), 0);
      return longest * effectiveFontSize() * 0.6;
    }
    const s = getSettings();
    ctx.font = `${effectiveFontSize()}px ${s.display.fontFamily}`;
    return words.reduce((max, w) => Math.max(max, ctx.measureText(w.en).width), 0);
  };

  const computePlacements = (words: Word[], seed: number): Record<string, Placement> => {
    const size = resolvePaperSize(settings.paper, { width: window.innerWidth, height: window.innerHeight });
    const aspect = size.width / Math.max(1, size.height);
    // ★ 相邻单词的最小中心距**由字号 + 最宽的那个词共同决定**（见 core/layout.ts 的 spacingBudget）：
    //   只用字号的话，长词之间必然会叠在一起。
    const budget = spacingBudget({
      fontSize: effectiveFontSize(),
      gapFactor: getSettings().paperWordGapFactor,
      widestWordPx: widestWordPx(words),
      rowHeightPx: wordRowHeightPx(effectiveFontSize()),
    });
    const minGapW = budget.gapX / Math.max(1, size.width);
    const minGapH = budget.gapY / Math.max(1, size.height);
    // 纸张在视口里居中：算出纸面左上角相对视口的偏移，才能把「右下角按钮区」换算到纸面坐标
    const offsetX = (window.innerWidth - size.width) / 2;
    const offsetY = (window.innerHeight - size.height) / 2;
    const controls = controlsAvoidRect();
    const points = jitteredGrid(words.length, {
      aspect,
      seed,
      minGapW,
      minGapH,
      canvas: { width: size.width, height: size.height },
      // ★ 按钮避让区要**按半个词向外扩**：落点是词的中心，
      //   中心刚好落在矩形外面时，词的一半仍然压在按钮上（用户实测反馈）。
      avoidPx: {
        x: controls.x - offsetX - budget.padX,
        y: controls.y - offsetY - budget.padY,
        width: controls.width + budget.padX * 2,
        height: controls.height + budget.padY * 2,
      },
    });
    placeCapacity = points.length; // 间距与避让约束下纸上实际能放下的数量
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
    showOverlay(placement) {
      overlay.replaceChildren(); // 每个词都要换新内容
      overlay.classList.remove('hidden');
      if (placement) {
        overlay.style.left = `${placement.x * 100}%`;
        overlay.style.top = `${placement.y * 100}%`;
        overlay.classList.add('at-origin');
      } else {
        const s = getSettings();
        overlay.style.left = '50%';
        overlay.style.top = `${s.memorize.offsetY * 100}%`;
        overlay.classList.remove('at-origin');
      }
      return overlay;
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
