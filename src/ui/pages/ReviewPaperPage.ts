/**
 * 复习白纸界面（`#/review/paper?mode=all` / `#/review/paper?paper=<id>`）—— 版本 0.0.24。
 *
 * 用户要求（「三」「四」）：
 * - 复习卡片模式：「复习范围限定为该卡片中出现过的单词」；
 * - 默认复习模式：按「复习优先度 → 背诵优先级 → 首字母」逐个呈现；
 * - 「当所有单词复习完毕后，再点击『下一个』时，程序应给出提示，且不再呈现下一个单词」；
 * - 「单词的具体呈现机制（如展示方式、切换逻辑等）与『背诵』模块完全一致」。
 *
 * 所以本页和 `LearnPaperPage` 共用同一套底座：
 * `PaperStage`（布点/避让/逻辑分辨率）、`renderWordCard`（正中弹窗）、同款统计行、
 * 同款「下一个」逻辑（放不下 → 「这张纸放不下更多单词了」；没有词了 → 「没有单词了」）。
 *
 * 与背诵的**不同之处**（都是复习语义决定的）：
 * - 复习不产生白纸存档：队列在内存里，`placements` 只在本页会话内有效（不写库）；
 * - 按钮只有三个：下一个 / 复习完了 / 退出复习；
 * - 「复习完了」把复习结果写回词库：`reviewCount + 1`、`lastReviewAt = 现在`，
 *   并按当前公式**重算 `reviewPriority`**（这正是「复习优先度」这个属性被更新的时候）。
 */
import { PAPER_UI } from '../../core/config';
import { computePriority } from '../../core/priority';
import { buildReviewQueue, reviewCandidates, wordsOfPaper } from '../../core/reviewSelect';
import { withSpellFlag } from '../../core/model';
import type { Word } from '../../core/types';
import * as dao from '../../dao';
import { deviceKind } from '../device';
import { h } from '../dom';
import { toastOk, toastWarn } from '../components/Toast';
import { navigate, registerCleanup } from '../router';
import { renderWordCard } from '../components/WordCard';
import { mountSpeechGate } from '../components/SpeechGate';
import { currentSettings } from './settings/ctx';
import { createPaperStage, type PaperStageHandle } from './paper/PaperStage';
import { applyPaperButtonVars, paperButtonBox } from './paper/geometry';

/** 从 hash 里取查询参数 */
function readQuery(): URLSearchParams {
  const raw = window.location.hash.replace(/^#/, '');
  return new URLSearchParams(raw.split('?')[1] ?? '');
}

/**
 * 右上角提示（与背诵页同款）。
 *
 * RULES-R1: 这里只是 2.2 秒后自动淡出的提示条，**不是**答题倒计时，也不参与任何判分。
 * @param text 文案
 */
function toastTop(text: string): void {
  const box = h('div', { class: 'paper-toast-top' });
  box.appendChild(h('span', { text }));
  document.body.appendChild(box);
  window.setTimeout(() => box.remove(), 2200);
}

/**
 * 渲染复习白纸界面。
 */
export function renderReviewPaperPage(): HTMLElement {
  const isPhone = deviceKind() === 'phone';
  const q = readQuery();
  const onlyMode = q.get('mode') === 'all';
  const paperId = q.get('paper') ?? '';

  const page = h('div', { class: 'paper-page review-paper' });
  applyPaperButtonVars(page);

  const stage: PaperStageHandle = createPaperStage({
    onWordClick: (word) => stage.toggleMeaning(word.id),
    onMeaningClick: (word) => showWordCard(word),
  });
  page.appendChild(stage.root);
  mountSpeechGate(page, () => undefined);

  /** 复习队列（已按复习规则排序） */
  let queue: Word[] = [];
  /** 已出现过的词（本页会话内有效） */
  const shown = new Set<string>();
  const shownOrder: string[] = [];
  /** 布点种子：同一次复习内固定，位置就不会跳 */
  let seed = 'review';
  let destroyed = false;

  // ── 统计行（与背诵同一格式） ──
  const stats = h('div', { class: `paper-stats ${isPhone ? 'phone' : 'wide'}`, text: '当前：0 词，平均复习：0 遍' });
  page.appendChild(stats);

  const refreshStats = (): void => {
    const list = queue.filter((w) => shown.has(w.id));
    const avg = list.length === 0 ? 0 : list.reduce((s, w) => s + (w.attrs?.reviewCount ?? 0), 0) / list.length;
    stats.textContent = `当前：${list.length} 词，平均复习：${Math.round(avg * 10) / 10} 遍`;
  };

  /** 正中弹窗单词卡（与背诵页同一套行为：编辑 / 斩 / 拼写 / 仅拼写 / 关闭） */
  function showWordCard(word: Word): void {
    if (document.querySelector('.answer-card')) return;
    const card = h('div', { class: 'answer-card' });
    card.appendChild(
      renderWordCard(word, {
        editable: true,
        onClose: () => card.remove(),
        onChange: (next) => {
          void (async () => {
            await dao.words.put(next);
            stage.refreshWord(next);
            const i = queue.findIndex((w) => w.id === next.id);
            if (i >= 0) queue[i] = next;
            toastOk('已保存');
          })();
        },
        onChop: () => {
          void (async () => {
            await dao.words.chop(word.id);
            toastTop(`已斩「${word.en}」`);
            removeWord(word.id);
          })();
        },
        onSpell: (value) => {
          void (async () => {
            await dao.words.put(withSpellFlag(word, value));
          })();
        },
        onSpellOnly: (value) => {
          void (async () => {
            await dao.words.put({ ...word, spellOnly: value });
            // 与背诵一致：标记「仅拼写」的词立即从纸上消失
            if (value) removeWord(word.id);
          })();
        },
      }),
    );
    card.appendChild(h('div', { class: 'answer-hint', text: '点击卡片外部关闭；卡内可以直接修改' }));
    const onDocClick = (ev: MouseEvent): void => {
      const t = ev.target;
      if (t instanceof Element && t.closest('.answer-card') === null && t.closest('.sense-ctx-menu') === null) {
        document.removeEventListener('click', onDocClick, true);
        card.remove();
      }
    };
    document.addEventListener('click', onDocClick, true);
    document.body.appendChild(card);
  }

  /** 把一个词从纸上拿掉（斩 / 仅拼写 / 删除） */
  const removeWord = (id: string): void => {
    stage.removeWord(id);
    shown.delete(id);
    const idx = shownOrder.indexOf(id);
    if (idx >= 0) shownOrder.splice(idx, 1);
    refreshStats();
  };

  // ── 三个按钮 ──
  const controls = h('div', { class: `paper-controls ${isPhone ? 'phone' : 'wide'}` });
  const btnNext = h('button', { class: 'paper-btn paper-btn-primary', type: 'button', text: '下一个' });
  const btnDone = h('button', { class: 'paper-btn', type: 'button', text: '复习完了' });
  const btnExit = h('button', { class: 'paper-btn', type: 'button', text: '退出复习' });
  controls.appendChild(btnNext);
  controls.appendChild(btnDone);
  controls.appendChild(btnExit);
  page.appendChild(controls);

  if (!isPhone) {
    const box = paperButtonBox(undefined, 3);
    stats.style.bottom = `${window.innerHeight - box.group.y + PAPER_UI.statsGap}px`;
  }

  /**
   * 下一个：按队列顺序取第一个没出现过的词。
   *
   * 用户明确要求「所有单词复习完毕后，再点击『下一个』时，程序应给出提示，且不再呈现下一个单词」，
   * 所以这里的提示与分析口径与背诵页保持一致（同一句「没有单词了」）。
   */
  const revealNext = (): void => {
    const next = queue.find((w) => !shown.has(w.id));
    if (!next) {
      toastWarn('没有单词了');
      return;
    }
    const placements = stage.layout(queue, seed);
    const p = placements[next.id];
    if (!p) {
      toastWarn('这张纸放不下更多单词了');
      return;
    }
    shown.add(next.id);
    shownOrder.push(next.id);
    stage.addWord(next, p, true);
    refreshStats();
  };
  btnNext.addEventListener('click', () => revealNext());

  /** 复习完了：把复习结果写回词库（复习次数 / 上次复习时间 / 复习优先度） */
  btnDone.addEventListener('click', () => {
    void (async () => {
      if (shownOrder.length === 0) {
        toastWarn('还没有复习任何单词');
        return;
      }
      const settings = currentSettings();
      const now = Date.now();
      const list = queue.filter((w) => shown.has(w.id));
      for (const word of list) {
        const next: Word = {
          ...word,
          attrs: {
            ...word.attrs,
            reviewCount: word.attrs.reviewCount + 1,
            lastReviewAt: now,
            reviewPriority: Math.round(computePriority(word, settings, now) * 100) / 100,
          },
        };
        await dao.words.put(next);
      }
      toastOk(`已完成 ${list.length} 个单词的复习`);
      navigate('/review');
    })();
  });

  btnExit.addEventListener('click', () => navigate('/review'));

  // ── 初始化：按模式算队列 → 上纸第一张 ──
  void (async () => {
    try {
      const settings = currentSettings();
      const all = reviewCandidates(await dao.words.listAlive());

      if (onlyMode) {
        queue = buildReviewQueue(all, settings).map((e) => e.word);
        seed = 'review-all';
      } else {
        const paper = paperId === '' ? null : await dao.papers.get(paperId);
        if (!paper) {
          toastWarn('找不到这张卡片，请重新选择');
          navigate('/review');
          return;
        }
        // 用户：复习范围限定为该卡片中出现过的单词
        queue = buildReviewQueue(wordsOfPaper(paper, all), settings).map((e) => e.word);
        seed = `review-${paper.id}`;
      }

      if (queue.length === 0) {
        toastWarn(onlyMode ? '词库里还没有可以复习的单词' : '这张卡片里还没有出现过的单词');
        navigate('/review');
        return;
      }
      revealNext();
    } catch (err) {
      console.error('[review/paper] 初始化失败', err);
      toastWarn('读取复习数据失败');
    }
  })();

  registerCleanup(page, () => {
    destroyed = true;
    // 复习页没有常驻的全局监听，这里只留一个标记，方便以后加「离开时保存」之类的逻辑
    void destroyed;
  });

  return page;
}
