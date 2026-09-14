/**
 * 做题环节的**状态机**（与界面分开，方便单测）。
 *
 * 为什么从页面里拆出来：单文件 ≤ 300 行；而且「第几题 / 当前答到哪 / 分数记在哪」
 * 这套推进逻辑是纯逻辑（只依赖 DAO 与 AI 服务，不碰 DOM），
 * 放在页面里就只能靠点浏览器才能测。
 *
 * 状态变化：
 * ```
 * preparing（一口气出完所有题）→ answering → grading → graded → (下一题) answering … → done
 *                              ↘ error（出题或评分失败，只影响当前这一题）
 * ```
 *
 * ⚠️ 「出题」与「评分」是两件事，**别混**：
 * 出题（`prepareQuestions`）在用户答第一题之前一次性全部做完（用户明确要求，
 * 免得每答完一题都要等一次）；评分仍然只能一题一题来（用户提交了才能评）。
 */

// RULES-R1: 此处禁止任何强制时间限制（无倒计时 / 无超时提交 / 无超时判错）
import type { KcSession, KnowledgeCard } from '../../../core/kcTypes';
import * as dao from '../../../dao';
import { aiConfigFromSettings } from '../../../services/ai';
import { gradeAnswer } from '../../../services/kcExamAi';
import { regradeRecord, saveExamRecord } from './kcExamFlow';
import { buildSlots, locateSlot, prepareQuestions, type ExamSlot } from './kcExamPrepare';
import type { ExamController, ExamState } from './kcExamState';
import { finishReview } from '../kcReview/kcReviewFlow';

// 类型从这里再导出一次：界面/测试的 `from './kcExamController'` 不用改
export type { ExamController, ExamPhase, ExamState } from './kcExamState';

/**
 * 建一个做题控制器。
 * @param opts 选项
 */
export function createExamController(opts: {
  cards: KnowledgeCard[];
  session: KcSession;
  /** 起始题号（续跑时用） */
  startIndex: number;
  /** 一轮结束时回调（页面用它更新卡片状态） */
  onFinish?: () => Promise<void>;
}): ExamController {
  const cards = opts.cards;
  const session = opts.session;
  /** 订阅者 */
  const listeners = new Set<(s: ExamState) => void>();
  /** 本轮的题目槽位（`start()` 时一次性填好，之后只是读） */
  const slots: ExamSlot[] = buildSlots(cards);

  const state: ExamState = {
    phase: 'preparing',
    questionIndex: Math.max(0, opts.startIndex),
    total: slots.length,
    preparing: { done: 0, total: 0 },
    question: null,
    card: null,
    answer: '',
    grade: null,
    error: '',
    recordId: '',
  };

  /** 通知订阅者 */
  const emit = (): void => {
    for (const fn of listeners) {
      try {
        fn({ ...state });
      } catch (err) {
        console.warn('[examController] 监听器出错', err);
      }
    }
  };

  /** 会话里记一条分数（key 带上题号，同一张卡多题不会互相覆盖） */
  const rememberScore = async (cardId: string, index: number, score: number): Promise<void> => {
    session.examScores[`${cardId}#${index}`] = score;
    session.examIndex = index;
    await dao.kcSession.save(session);
  };

  /** 出题前先确认 AI 配置在（不然每一道题都会白等一个来回） */
  const aiReady = async (): Promise<string> => {
    const cfg = aiConfigFromSettings(await dao.settings.get());
    if (cfg.key.trim() === '' || cfg.endpoint.trim() === '') {
      return '还没配置 AI 接口（设置 → B 区），做题需要 AI 出题与评分。';
    }
    return '';
  };

  /** 只出当前这一道题（「重试」用，不走批量） */
  const regenerate = async (index: number): Promise<void> => {
    const slot = slots[index];
    if (slot === undefined) return;
    slot.question = null;
    slot.error = '';
    const cfg = aiConfigFromSettings(await dao.settings.get());
    await prepareQuestions({ cards, slots, indices: [index], cfg });
  };

  /** 还没出过的题号（续跑时前面答过的不再重复出：省时间也省 token） */
  const pendingIndices = (): number[] => {
    const out: number[] = [];
    for (let i = state.questionIndex; i < slots.length; i += 1) {
      const slot = slots[i];
      if (slot !== undefined && slot.question === null && slot.error === '') out.push(i);
    }
    return out;
  };

  return {
    getState: () => ({ ...state }),
    subscribe(fn) {
      listeners.add(fn);
      fn({ ...state });
    },
    getSession: () => session,
    getCards: () => cards,

    async start(): Promise<void> {
      state.phase = 'preparing';
      const todo = pendingIndices();
      state.preparing = { done: 0, total: todo.length };
      emit();

      const notReady = await aiReady();
      if (notReady !== '') {
        state.phase = 'error';
        state.error = notReady;
        emit();
        return;
      }
      const cfg = aiConfigFromSettings(await dao.settings.get());
      await prepareQuestions({
        cards,
        slots,
        indices: todo,
        cfg,
        onProgress: (p) => {
          state.preparing = p;
          emit();
        },
      });
      await load();
    },

    async submit(answer: string): Promise<void> {
      // 评分中再按一次 Enter 不能重复提交（否则同一题会落两条记录、扣两次分）
      if (state.phase === 'grading') return;
      const at = locateSlot(cards, state.questionIndex);
      if (state.question === null || at === null) return;
      state.answer = answer.trim();
      state.phase = 'grading';
      state.error = '';
      emit();

      const settings = await dao.settings.get();
      const res = await gradeAnswer({
        type: state.question.type,
        question: state.question.question,
        expected: state.question.expected,
        userAnswer: state.answer,
        cfg: aiConfigFromSettings(settings),
      });

      if (res.grade === null) {
        // 评分失败**不阻断**：给一个默认分让用户手动改（用户明确要求保留改分入口）
        state.grade = { score: 2, reason: '（AI 评分失败，这是默认分，请手动改成你认为的分数）' };
        state.error = `${res.error ?? 'AI 评分失败'}；你可以手动打分后继续。`;
      } else {
        state.grade = res.grade;
      }

      state.recordId = await saveExamRecord({
        cardId: at.card.id,
        type: state.question.type,
        question: state.question.question,
        userAnswer: state.answer,
        score: state.grade.score,
        reason: state.grade.reason,
        contextWord: state.question.contextWord,
      });
      await rememberScore(at.card.id, state.questionIndex, state.grade.score);
      state.phase = 'graded';
      emit();
    },

    async regrade(score: number): Promise<void> {
      const at = locateSlot(cards, state.questionIndex);
      if (state.grade === null || state.recordId === '' || at === null) return;
      state.grade = { ...state.grade, score };
      await regradeRecord(state.recordId, score);
      // 卡片上的考核分也要跟着变（mastery 是按它算的）
      await dao.kc.updateAttrs(at.card.id, { lastExamScore: score });
      await rememberScore(at.card.id, state.questionIndex, score);
      emit();
    },

    async next(): Promise<void> {
      state.questionIndex += 1;
      session.examIndex = state.questionIndex;
      await dao.kcSession.save(session);
      if (state.questionIndex >= state.total) {
        await finish();
        return;
      }
      await load();
    },

    async retry(): Promise<void> {
      state.phase = 'loading';
      state.error = '';
      emit();
      await regenerate(state.questionIndex);
      await load();
    },
  };

  /**
   * 从槽位里把当前这一题拿出来显示。
   *
   * 这里**不再调用 AI**：题目在 `start()` 时已经出好了，
   * 所以「上一题评分完 → 下一题出现」是瞬间的（这正是用户要的）。
   */
  async function load(): Promise<void> {
    state.answer = '';
    state.grade = null;
    state.error = '';
    state.recordId = '';

    const at = locateSlot(cards, state.questionIndex);
    if (at === null) {
      await finish();
      return;
    }
    state.card = at.card;
    const slot = slots[state.questionIndex];
    if (slot === undefined || slot.question === null) {
      // 这一道没出出来（批量出题时它失败了）：只让这一题进错误态，别的题照常
      state.phase = 'error';
      state.error = slot?.error !== undefined && slot.error !== '' ? slot.error : '出题失败';
      emit();
      return;
    }
    state.question = slot.question;
    state.phase = 'answering';
    emit();
  }

  /** 一轮结束 */
  async function finish(): Promise<void> {
    state.phase = 'done';
    // 复习的收尾与学习不同：复习要更新 lastReviewAt / reviewCount 并重算 mastery 与优先度
    // （阶段 06 §5）。学习流程只把状态置 learned。
    if (session.type === 'review') {
      state.finishedCards = await finishReview(cards.map((c) => c.id));
    } else {
      for (const card of cards) {
        if (card.status !== 'chopped') await dao.kc.updateMeta(card.id, { status: 'learned' });
      }
    }
    emit();
    session.stage = 'done';
    session.finished = true;
    await dao.kcSession.save(session);
    await dao.kcSession.remove(session.id);
    await opts.onFinish?.();
    emit();
  }
}
