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
import { selectExamWords } from '../../core/examSelect';
import { withSpellFlag } from '../../core/model';
import type { PaperArchive, Word } from '../../core/types';
import * as dao from '../../dao';
import { aiConfigFromSettings } from '../../services/ai';
import { speak } from '../../services/tts';
import { deviceKind } from '../device';
import { h } from '../dom';
import { toastOk, toastWarn } from '../components/Toast';
import { navigate, registerCleanup } from '../router';
import { renderWordCard } from '../components/WordCard';
import { mountSpeechGate } from '../components/SpeechGate';
import { currentSettings } from './settings/ctx';
import { createPaperStage, type PaperStageHandle } from './paper/PaperStage';
import { startExam, type ExamHandle, type ExamWordOutcome } from './paper/exam';
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
            await dao.words.setSpellOnly(word.id, value);
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

  // ── 四个按钮（★ 0.0.28：补上「再次记忆」，与背诵页对齐） ──
  const controls = h('div', { class: `paper-controls ${isPhone ? 'phone' : 'wide'}` });
  const btnNext = h('button', { class: 'paper-btn paper-btn-primary', type: 'button', text: '下一个' });
  const btnAgain = h('button', { class: 'paper-btn', type: 'button', text: '再次记忆', title: '点它开始一轮考核（英译中 + 拼写）' });
  const btnDone = h('button', { class: 'paper-btn', type: 'button', text: '复习完了' });
  const btnExit = h('button', { class: 'paper-btn', type: 'button', text: '退出复习' });
  controls.appendChild(btnNext);
  controls.appendChild(btnAgain);
  controls.appendChild(btnDone);
  controls.appendChild(btnExit);
  page.appendChild(controls);

  if (!isPhone) {
    const box = paperButtonBox(undefined, 4);
    stats.style.bottom = `${window.innerHeight - box.group.y + PAPER_UI.statsGap}px`;
  }

  /**
   * 下一个：按队列顺序取第一个没出现过的词。
   *
   * 用户明确要求「所有单词复习完毕后，再点击『下一个』时，程序应给出提示，且不再呈现下一个单词」，
   * 所以这里的提示与分析口径与背诵页保持一致（同一句「没有单词了」）。
   *
   * ★ 0.0.28（用户）：「默认进入复习模式时，不要每次点击都弹出『没有单词了』提示。」
   *   所以这一轮只用提示**一次**（`exhaustedNotified`），之后再点就静默不动。
   */
  let exhaustedNotified = false;
  const revealNext = (): void => {
    const next = queue.find((w) => !shown.has(w.id));
    if (!next) {
      if (!exhaustedNotified) {
        exhaustedNotified = true;
        toastWarn('没有单词了');
      }
      return;
    }
    const placements = stage.layout(queue, seed);
    const p = placements[next.id];
    if (!p) {
      if (!exhaustedNotified) {
        exhaustedNotified = true;
        toastWarn('这张纸放不下更多单词了');
      }
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

  // ══════════════════ 再次记忆（考核）—— 版本 0.0.28 ══════════════════
  /** 卡片模式下的存档（默认模式没有存档） */
  let sourcePaper: PaperArchive | null = null;
  /** 本轮考核是否在跑（防重复进入） */
  let examRunning = false;
  /** 正在跑的考核句柄（离开页面要中断） */
  let examHandle: ExamHandle | null = null;

  /**
   * 点「再次记忆」开始一轮考核（与背诵页同一套：英译中 AI 评分 + 拼写，成绩直接写库）。
   *
   * 用户 0.0.28：「复习界面补全完整功能，包括之前遗漏的『再次记忆』按钮。」
   */
  const startExamRound = async (): Promise<void> => {
    if (examRunning) return;
    const settings = currentSettings();
    const onPaper = queue.filter((w) => shown.has(w.id) && w.status !== 'chopped' && w.spellOnly !== true);
    if (onPaper.length === 0) {
      const shownCount = queue.filter((w) => shown.has(w.id)).length;
      toastWarn(shownCount === 0 ? '纸上还没有可以考核的单词' : '纸上出现过的词都标记了「仅拼写」，没有可英译中的词');
      return;
    }
    const selection = selectExamWords({
      pool: onPaper,
      memorizeCount: sourcePaper?.memorizeCount ?? {},
      count: settings.exam.countPerExam,
      scoreThreshold: settings.exam.scoreThreshold,
      spellOnlyWords: queue.filter((w) => w.spellOnly === true && w.status !== 'chopped'),
    });
    if (selection.picked.length === 0 && selection.spellOnly.length === 0) {
      toastWarn('这一轮没有抽到要考核的单词');
      return;
    }
    examRunning = true;
    const handle = startExam({
      words: selection.picked,
      spellIds: new Set(selection.spellIds),
      spellOnlyWords: selection.spellOnly,
      scoreThreshold: settings.exam.scoreThreshold,
      aiCfg: aiConfigFromSettings(settings),
      hintFails: settings.practice.hintFails,
      autoSpeak: settings.practice.autoSpeak,
      scoreRubric: settings.exam.scoreRubric,
      speak: (word) => {
        const speech = settings.speech;
        speak(word.en, { rate: speech.rate, lang: speech.accent });
      },
      isAborted: () => destroyed,
      onChangeWord: (next) => {
        void (async () => {
          await dao.words.put(next);
          const i = queue.findIndex((w) => w.id === next.id);
          if (i >= 0) queue[i] = next;
          stage.refreshWord(next);
        })();
      },
      onChop: (word) => {
        void (async () => {
          await dao.words.chop(word.id);
          removeWord(word.id);
        })();
      },
      onSpell: (word, value) => {
        void dao.words.setNeedSpell(word.id, value);
      },
      onSpellOnly: (word, value) => {
        void (async () => {
          await dao.words.setSpellOnly(word.id, value);
          if (value) removeWord(word.id);
        })();
      },
    });
    examHandle = handle;
    try {
      const outcomes = await handle.done;
      await recordExamRound(outcomes);
    } finally {
      examRunning = false;
      examHandle = null;
    }
  };

  /** 一轮考核结束后写库：考核次数 / 分数 / 失败次数 / 记忆次数（与背诵同一口径） */
  const recordExamRound = async (outcomes: ExamWordOutcome[]): Promise<void> => {
    if (outcomes.length === 0) return;
    const now = Date.now();
    let changed = false;
    for (const outcome of outcomes) {
      const word = queue.find((w) => w.id === outcome.id);
      if (!word) continue;
      const next: Word = {
        ...word,
        attrs: {
          ...word.attrs,
          examCount: (word.attrs.examCount ?? 0) + 1,
          examScore: outcome.score ?? word.attrs.examScore ?? null,
          failCount: outcome.failed ? word.attrs.failCount + 1 : word.attrs.failCount,
          failCountTotal: outcome.failed ? word.attrs.failCountTotal + 1 : word.attrs.failCountTotal,
          lastReviewAt: now,
        },
      };
      await dao.words.put(next);
      const i = queue.findIndex((w) => w.id === next.id);
      if (i >= 0) queue[i] = next;
      changed = true;
    }
    // 卡片模式：把「记忆次数」记回存档（与背诵的白纸存档同一字段）
    if (sourcePaper !== null && changed) {
      const memorizeCount = { ...(sourcePaper.memorizeCount ?? {}) };
      for (const outcome of outcomes) memorizeCount[outcome.id] = (memorizeCount[outcome.id] ?? 0) + 1;
      sourcePaper = { ...sourcePaper, memorizeCount, updatedAt: now };
      await dao.papers.put(sourcePaper);
    }
    toastOk(`本轮考核完成：${outcomes.length} 个词，分数与次数已记录`);
  };
  btnAgain.addEventListener('click', () => void startExamRound());

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

  /**
   * ★ 0.0.27（用户「增加 Enter 相关快捷键」）：与背诵白纸同一口径——
   * 浏览模式按一次 Enter = 点一次「下一个」（长按只算一次，焦点在输入控件上不劫持）。
   */
  const onEnterNext = (ev: KeyboardEvent): void => {
    if (ev.repeat || ev.key !== 'Enter') return;
    const t = ev.target;
    if (t instanceof HTMLElement && t.closest('input, textarea, select, button, [contenteditable]') !== null) return;
    if (document.querySelector('.answer-card, .modal-mask') !== null) return;
    ev.preventDefault();
    btnNext.click();
  };
  document.addEventListener('keydown', onEnterNext);
  registerCleanup(page, () => document.removeEventListener('keydown', onEnterNext));
  registerCleanup(page, () => {
    destroyed = true;
    // 页面被换掉时把考核层拆掉（否则它会一直盖在屏幕上）
    examHandle?.abort();
    // 复习页没有常驻的全局监听，这里只留一个标记，方便以后加「离开时保存」之类的逻辑
    void destroyed;
  });

  return page;
}
