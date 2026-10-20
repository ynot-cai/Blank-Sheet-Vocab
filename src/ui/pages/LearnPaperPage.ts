/**
 * 白纸界面（`#/learn/paper?paper=<id>`）—— 版本 0.0.21。
 *
 * 进入时按 `?paper=` 读回那张 `PaperArchive`（临时优先级表 + 种子 + 已出现名单 + 落点），
 * 「下一个」按临时优先级取词（同优先级首字母升序），「背完了」命名并永久存档。
 *
 * ★ 0.0.21：接上**考核（记忆过程）**——点 N 次「下一个」自动开始、或点「再次记忆」主动开始；
 *   一轮 = 英译中（AI 评分，0~5 分）+ 拼写（与旧版相同），结束后分数与次数直接写库。
 */
import { PAPER_UI } from '../../core/config';
import { selectExamWords } from '../../core/examSelect';
import { nextWord, orderByPriority, type PriorityTable } from '../../core/learnSelect';
import type { PaperArchive, Word } from '../../core/types';
import * as dao from '../../dao';
import { aiConfigFromSettings } from '../../services/ai';
import { speak } from '../../services/tts';
import { deviceKind } from '../device';
import { h } from '../dom';
import { confirmModal, promptModal } from '../components/Modal';
import { toastOk, toastWarn } from '../components/Toast';
import { navigate, registerCleanup } from '../router';
import { currentSettings } from './settings/ctx';
import { createPaperStage, type PaperStageHandle } from './paper/PaperStage';
import { applyPaperButtonVars, paperButtonBox } from './paper/geometry';
import { startExam, type ExamHandle, type ExamWordOutcome } from './paper/exam';
import { renderWordCard } from '../components/WordCard';
import { mountSpeechGate } from '../components/SpeechGate';

/** 朗读一个词（考核里的小喇叭；读设置页「音频设置」的语速/口音） */
function speakWord(word: Word): void {
  const speech = currentSettings().speech;
  speak(word.en, { rate: speech.rate, lang: speech.accent });
}

/** 从 hash 里取 `?paper=<id>` */
function readPaperId(): string {
  const raw = window.location.hash.replace(/^#/, '');
  const q = raw.split('?')[1] ?? '';
  return new URLSearchParams(q).get('paper') ?? '';
}

/** 今天（YYYY-MM-DD）——「背完了」不命名时用它 */
function today(): string {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/**
 * 渲染白纸界面。
 */
export function renderLearnPaperPage(): HTMLElement {
  const isPhone = deviceKind() === 'phone';
  const page = h('div', { class: 'paper-page' });
  applyPaperButtonVars(page);

  const stage: PaperStageHandle = createPaperStage({
    onWordClick: (word) => stage.toggleMeaning(word.id),
    onMeaningClick: (word) => showWordCard(word),
  });
  page.appendChild(stage.root);

  /**
   * ★ 版本 0.0.19：恢复归档的「语音解锁层」（iOS 首次朗读必须在用户手势里触发）。
   *
   * 它自己判断要不要出现：只有 iOS/iPadOS 这类有 WebKit 手势限制、且本设备还没解锁过时
   * 才盖一层「点击开始」；桌面/安卓**完全不出现**，不会成为多出来的视觉元素。
   * 做法照归档 `已归档/12` 第 12 节与 `已归档/02` 白纸流程的调用方式（挂在页面根上）。
   */
  mountSpeechGate(page, () => undefined);

  /**
   * ★ 版本 0.0.17（用户纠正）：单词卡 = **归档版的正中弹窗**。
   * 外壳照抄归档 `showAnswerCard` 的 `.answer-card`（fixed + 50%/50% 居中 + 点外部关），
   * 内容用仓库里还原的归档共享组件 `renderWordCard`（编辑 / SenseEditor / 拼 / 斩）。
   */
  function showWordCard(word: Word): void {
    if (document.querySelector('.answer-card')) return; // 同一时间只开一张
    const card = h('div', { class: 'answer-card' });
    /**
     * ★ 0.0.21（用户要求）：卡片上的 X 不再是「浮在卡角上」的独立按钮，
     *   而是由单词卡自己画在**与单词同一行**的最右端（见 WordCard 的 buildView）。
     *   所以这里把关闭动作交给卡片的 onClose，不再额外塞一颗 `paper-card-close`。
     */
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
        // ★ 0.0.21：斩 / 拼写 / 仅拼写 都变成真的标记（用户「三、选取逻辑」第 3 条）
        onChop: () => chopWord(word),
        onSpell: (value) => {
          void (async () => {
            const next: Word = { ...word, attrs: { ...word.attrs, needSpell: value } };
            await dao.words.put(next);
            const i = queue.findIndex((w) => w.id === next.id);
            if (i >= 0) queue[i] = next;
          })();
        },
        onSpellOnly: (value) => {
          void (async () => {
            const next: Word = { ...word, spellOnly: value };
            await dao.words.put(next);
            const i = queue.findIndex((w) => w.id === next.id);
            if (i >= 0) queue[i] = next;
            // 用户：标记「仅拼写」的单词立即从纸上消失
            if (value) await removeFromPaper(next.id);
          })();
        },
      }),
    );
    card.appendChild(h('div', { class: 'answer-hint', text: '点击卡片外部关闭；卡内可以直接修改' }));
    const onDocClick = (ev: MouseEvent): void => {
      const t = ev.target;
      /**
       * 点卡片外部关闭。
       *
       * ★ 0.0.20：义项的右键菜单（`.sense-ctx-menu`）挂在 `body` 上、**不在** `.answer-card` 里，
       *   所以必须一并排除——否则「右键 → 点删除」的第一下就把整张卡关掉了（实测踩过：
       *   删除菜单点了没反应，卡先没了）。菜单自己会在点任意处后关闭。
       */
      if (t instanceof Element && t.closest('.answer-card') === null && t.closest('.sense-ctx-menu') === null) {
        document.removeEventListener('click', onDocClick, true);
        card.remove();
      }
    };
    // 打开卡的那一下 click 已经派发完毕，现在挂监听不会把自己关掉
    document.addEventListener('click', onDocClick, true);
    document.body.appendChild(card);
  }

  /** 这张纸的存档 */
  let paper: PaperArchive | null = null;
  /** 本轮队列（已按临时优先级排好） */
  let queue: Word[] = [];
  /** 临时优先级表（来自存档） */
  let table: PriorityTable = {};
  const shownOrder: string[] = [];
  const shown = new Set<string>();
  let destroyed = false;

  // ── 统计行 ──
  const stats = h('div', { class: `paper-stats ${isPhone ? 'phone' : 'wide'}`, text: '当前：0 词，平均复习：0 遍' });
  page.appendChild(stats);

  const refreshStats = (): void => {
    const list = queue.filter((w) => shown.has(w.id));
    const avg = list.length === 0 ? 0 : list.reduce((s, w) => s + (w.attrs?.reviewCount ?? 0), 0) / list.length;
    stats.textContent = `当前：${list.length} 词，平均复习：${Math.round(avg * 10) / 10} 遍`;
  };

  /** 把当前进度写回存档（每次上纸都写，保证「继续背诵」里的词数是准的） */
  const persist = async (): Promise<void> => {
    if (!paper) return;
    paper.shownIds = [...shownOrder];
    await dao.papers.put(paper);
  };

  // ── 五个按钮 ──
  const controls = h('div', { class: `paper-controls ${isPhone ? 'phone' : 'wide'}` });
  const btnNext = h('button', { class: 'paper-btn paper-btn-primary', type: 'button', text: '下一个' });
  const btnAgain = h('button', { class: 'paper-btn', type: 'button', text: '再次记忆', title: '点它开始一轮考核' });
  const btnDone = h('button', { class: 'paper-btn', type: 'button', text: '背完了' });
  const btnSave = h('button', { class: 'paper-btn', type: 'button', text: '保存并退出' });
  const btnClear = h('button', { class: 'paper-btn paper-btn-danger', type: 'button', text: '删除这张纸' });

  /** 下一个：按临时优先级取，优先级为 0 就提示「没有单词了」 */
  const revealNext = async (): Promise<void> => {
    if (!paper) return;
    const next = nextWord(queue, table, shown);
    if (!next) {
      toastWarn('没有单词了');
      return;
    }
    const placements = stage.layout(queue, paper.seed);
    const p = placements[next.id];
    if (!p) {
      toastWarn('这张纸放不下更多单词了');
      return;
    }
    shown.add(next.id);
    shownOrder.push(next.id);
    paper.placements[next.id] = { x: p.x, y: p.y };
    stage.addWord(next, p, true);
    refreshStats();
    await persist();
  };

  // ══════════════════ 考核（记忆过程）—— 版本 0.0.21 ══════════════════
  /** 距离上一轮考核已经点了几次「下一个」 */
  let sinceExam = 0;
  /** 正在考核（防止重复进入） */
  let examRunning = false;
  /** 当前考核句柄（页面销毁时要中断） */
  let examHandle: ExamHandle | null = null;

  /**
   * 开始一轮考核（用户「二、触发机制」的两种入口都走这里）：
   * 1. 点 `exam.everyWords` 次「下一个」后自动开始；
   * 2. 点「再次记忆」主动开始。
   */
  const startExamRound = async (): Promise<void> => {
    if (!paper || examRunning) return;
    const settings = currentSettings();
    const onPaper = queue.filter((w) => shown.has(w.id) && w.status !== 'chopped' && w.spellOnly !== true);
    if (onPaper.length === 0) {
      toastWarn('纸上还没有可以考核的单词');
      return;
    }
    const selection = selectExamWords({
      pool: onPaper,
      memorizeCount: paper.memorizeCount ?? {},
      count: settings.exam.countPerExam,
      scoreThreshold: settings.exam.scoreThreshold,
      spellOnlyWords: queue.filter((w) => w.spellOnly === true && w.status !== 'chopped'),
    });
    if (selection.picked.length === 0 && selection.spellOnly.length === 0) {
      toastWarn('这一轮没有抽到要考核的单词');
      return;
    }

    examRunning = true;
    sinceExam = 0;
    const handle = startExam({
      words: selection.picked,
      spellIds: new Set(selection.spellIds),
      spellOnlyWords: selection.spellOnly,
      scoreThreshold: settings.exam.scoreThreshold,
      aiCfg: aiConfigFromSettings(settings),
      hintFails: settings.practice.hintFails,
      autoSpeak: settings.practice.autoSpeak,
      speak: (word) => speakWord(word),
      isAborted: () => destroyed,
      onChangeWord: (next) => {
        void (async () => {
          await dao.words.put(next);
          const i = queue.findIndex((w) => w.id === next.id);
          if (i >= 0) queue[i] = next;
          stage.refreshWord(next);
        })();
      },
      onChop: (word) => chopWord(word),
      onSpell: (word, value) => {
        void (async () => {
          const next: Word = { ...word, attrs: { ...word.attrs, needSpell: value } };
          await dao.words.put(next);
          const i = queue.findIndex((w) => w.id === next.id);
          if (i >= 0) queue[i] = next;
        })();
      },
      onSpellOnly: (word, value) => {
        void (async () => {
          const next: Word = { ...word, spellOnly: value };
          await dao.words.put(next);
          const i = queue.findIndex((w) => w.id === next.id);
          if (i >= 0) queue[i] = next;
          if (value) await removeFromPaper(next.id);
        })();
      },
    });
    examHandle = handle;
    try {
      const outcomes = await handle.done;
      await recordRound(outcomes, handle.isAborted());
    } finally {
      examRunning = false;
      examHandle = null;
    }
  };

  /**
   * 一轮考核结束：**直接写库**（用户「五、数据记录」）。
   * - 每个考到的词：考核次数 +1；有英译中分数的写 `examScore`；
   *   低于阈值或拼写错的记一次未通过（failCount / failCountTotal 各 +1，保持原有的失败率口径）；
   * - 这张纸的记忆次数：参与英译中的词各 +1（用户要求「记忆次数存入白纸存档」）。
   * @param outcomes 本轮每个词的结果
   * @param interrupted 这一轮是否被「返回白纸」中断
   */
  const recordRound = async (outcomes: ExamWordOutcome[], interrupted = false): Promise<void> => {
    if (!paper) return;
    const now = Date.now();
    for (const outcome of outcomes) {
      const word = queue.find((w) => w.id === outcome.id);
      if (!word) continue;
      const attrs = { ...word.attrs };
      attrs.examCount = (typeof attrs.examCount === 'number' ? attrs.examCount : 0) + 1;
      if (outcome.score !== null) attrs.examScore = outcome.score;
      if (outcome.failed) {
        attrs.failCount += 1;
        attrs.failCountTotal += 1;
      }
      const next: Word = { ...word, attrs, updatedAt: now };
      await dao.words.put(next);
      const i = queue.findIndex((w) => w.id === next.id);
      if (i >= 0) queue[i] = next;
    }
    const memorizeCount = { ...(paper.memorizeCount ?? {}) };
    for (const outcome of outcomes) {
      if (outcome.score === null) continue;
      memorizeCount[outcome.id] = (memorizeCount[outcome.id] ?? 0) + 1;
    }
    paper.memorizeCount = memorizeCount;
    await dao.papers.put(paper);
    if (outcomes.length === 0) {
      if (interrupted) toastWarn('已中断本轮考核（还没有考完的词）');
      return;
    }
    toastOk(
      interrupted
        ? `已中断本轮考核：已考完的 ${outcomes.length} 个词已记录`
        : `本轮考核完成：${outcomes.length} 个词，分数与次数已记录`,
    );
  };

  /**
   * 把一个词从这张纸上移除（用户：标记「仅拼写」或「斩」的单词**立即从纸上消失**）。
   * @param id 词 id
   */
  const removeFromPaper = async (id: string): Promise<void> => {
    stage.removeWord(id);
    shown.delete(id);
    const idx = shownOrder.indexOf(id);
    if (idx >= 0) shownOrder.splice(idx, 1);
    if (paper) {
      delete paper.placements[id];
      paper.shownIds = [...shownOrder];
      await dao.papers.put(paper);
    }
    refreshStats();
  };

  /** 斩：写库 + 右上角提示 + 立即从纸上消失 */
  const chopWord = (word: Word): void => {
    void (async () => {
      await dao.words.chop(word.id);
      toastTop(`已斩「${word.en}」`);
      await removeFromPaper(word.id);
    })();
  };

  btnNext.addEventListener('click', () => {
    void (async () => {
      await revealNext();
      sinceExam += 1;
      const every = currentSettings().exam.everyWords;
      if (sinceExam >= Math.max(1, every)) await startExamRound();
    })();
  });
  // 用户「二、触发机制」第 2 条：点「再次记忆」主动触发一轮考核
  btnAgain.addEventListener('click', () => void startExamRound());

  // ── 背完了：命名 → 清空临时优先级表 → 永久存档 ──
  btnDone.addEventListener('click', () => {
    void (async () => {
      if (!paper) return;
      const name = await promptModal('命名白纸', '给这张纸起个名字；不填就用今天的日期。', paper.name);
      if (name === null) return; // 关掉弹窗 = 取消
      const finalName = name.trim() === '' ? today() : name.trim();
      // 用户要求：永久存档时**清空临时优先级表**
      await dao.papers.put({ ...paper, name: finalName, priorityTable: {}, status: 'finished' });
      toastOk(`已存档「${finalName}」`);
      navigate('/home');
    })();
  });

  btnSave.addEventListener('click', () => {
    void (async () => {
      if (!paper) return;
      // 「保存并退出」= 记录这张 draft 存档（含种子与已出现名单），下次从「继续背诵」进来接着背。
      // ⚠️ 「并上传相关考核数据」本轮不做（用户第四节：成绩/考核后续实现）。
      await dao.papers.put(paper);
      toastOk(`已保存并退出（${shownOrder.length} 个词在纸上）`);
      navigate('/home');
    })();
  });

  btnClear.addEventListener('click', () => {
    void (async () => {
      if (!paper) return;
      const ok = await confirmModal(
        '删除这张纸',
        '会删除这张白纸存档（词库本身不受影响）。确定吗？',
        '确定删除',
        true,
      );
      if (!ok) return;
      await dao.papers.remove(paper.id);
      navigate('/home');
    })();
  });

  controls.appendChild(btnNext);
  controls.appendChild(btnAgain);
  controls.appendChild(btnDone);
  controls.appendChild(btnSave);
  controls.appendChild(btnClear);
  page.appendChild(controls);

  if (!isPhone) {
    const box = paperButtonBox();
    stats.style.bottom = `${window.innerHeight - box.group.y + PAPER_UI.statsGap}px`;
  }

  // ── 初始化：读存档 → 取词 → 还原已出现的词 ──
  void (async () => {
    try {
      const id = readPaperId();
      const found = id === '' ? null : await dao.papers.get(id);
      if (!found) {
        toastWarn('找不到这张白纸，请从「背诵」重新开始');
        navigate('/learn');
        return;
      }
      paper = found;
      table = found.priorityTable ?? {};

      const all = await dao.words.listAlive();
      const usable = all.filter((w) => w.status !== 'chopped');
      queue = orderByPriority(usable, table);
      if (queue.length === 0) {
        toastWarn('这张纸没有可选单词了');
        navigate('/learn');
        return;
      }

      // 还原已经出现的词：按存档里记的落点原位摆回，**不需要再点「下一个」**
      for (const wid of found.shownIds ?? []) {
        const w = usable.find((x) => x.id === wid);
        const p = found.placements?.[wid];
        if (w && p) {
          shown.add(wid);
          shownOrder.push(wid);
          stage.addWord(w, p, false);
        }
      }
      if (shownOrder.length > 0) stage.showMeaning(shownOrder[shownOrder.length - 1]);
      refreshStats();

      if (shownOrder.length === 0) await revealNext();
    } catch (err) {
      console.error('[learn/paper] 初始化失败', err);
      toastWarn('读取白纸存档失败');
    }
  })();

  registerCleanup(page, () => {
    destroyed = true;
    // ★ 0.0.21：页面被换掉时，如果正卡在考核里，先把考核界面拆掉（否则它会一直盖在屏幕上）
    examHandle?.abort();
    stage.destroy();
  });
  void destroyed;

  return page;
}


/** 右上角提示（用户要求把「斩」后的提示放右上角） */
function toastTop(text: string): void {
  const box = h('div', { class: 'paper-toast-top' });
  box.appendChild(h('span', { text }));
  document.body.appendChild(box);
  window.setTimeout(() => box.remove(), 2200);
}
