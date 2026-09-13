/**
 * 出题环节的**批量预生成**（用户明确要求：一口气出完所有题）。
 *
 * ══════════════════════════════════════════════════════════════
 * 为什么要单独一个文件（用户原话）
 * ══════════════════════════════════════════════════════════════
 * 「做完一道题，AI 改完后，出下一道题需要时间，请把所有 AI 出题时间放在
 *   开始第一题之前（让 AI 一口气出完所有题，而不是一个一个出）」
 *
 * 原来的做法是「答完一题 → 等 AI 出下一题」，用户每答完一题都要干等一次；
 * 现在改成**进入做题时一次性出完**：等的次数从 N 次变成 1 次，
 * 而且这一等发生在「还没开始答题」的时候，心理上完全可以接受。
 *
 * 与 `kcExamFlow` 的分工：那边回答「该出哪些题型、要哪些材料」，
 * 这边回答「怎么把它们一次性、并发地出出来」。
 */
import { KC } from '../../../core/config';
import type { KnowledgeCard } from '../../../core/kcTypes';
import type { AiConfig } from '../../../services/ai';
import { generateQuestion } from '../../../services/kcExamAi';
import type { KcQuestion } from '../../components/ExamTaker';
import { collectRoundMaterials, pickBankSamples, questionTypesFor } from './kcExamFlow';

/**
 * 一道题的位置（**先占位、后填内容**）。
 *
 * 为什么按「卡片 × 卡内第几题」两层来存：控制器里的题号是**全局序号**
 * （第 3 题 = 第 2 张卡的第 1 题），`locate()` 就是按这个规则换算的。
 * 这里保持同样的展开顺序，序号才对得上。
 */
export interface ExamSlot {
  /** 属于哪张卡 */
  cardId: string;
  /** 题型 id */
  type: string;
  /** 出好的题（失败时为 null） */
  question: KcQuestion | null;
  /** 出题失败的说明（成功时为空串） */
  error: string;
}

/** 预生成进度 */
export interface PrepareProgress {
  /** 已经出好几道 */
  done: number;
  /** 这次一共要出几道 */
  total: number;
}

/**
 * 本轮一共有几道题（= 每张卡的题型数之和）。
 * @param cards 本轮卡片
 */
export function totalQuestionCount(cards: KnowledgeCard[]): number {
  return cards.reduce((sum, c) => sum + questionTypesFor(c).length, 0);
}

/**
 * 把「第几题」换算成「第几张卡 + 卡内第几题」，找不到返回 null。
 * @param cards 本轮卡片
 * @param index 全局题号
 */
export function locateSlot(
  cards: KnowledgeCard[],
  index: number,
): { card: KnowledgeCard; typeIndex: number } | null {
  let left = index;
  for (const card of cards) {
    const n = questionTypesFor(card).length;
    if (left < n) return { card, typeIndex: left };
    left -= n;
  }
  return null;
}

/**
 * 建出本轮的**空槽位表**（题型先定下来，题目内容稍后填）。
 *
 * 题型在这里就定死而不是出题时再算，是为了让 `出题中的进度` 与
 * `第 x/y 题` 两个数字**从一开始就对得上**（用户会盯着这两个数字看）。
 * @param cards 本轮卡片
 */
export function buildSlots(cards: KnowledgeCard[]): ExamSlot[] {
  const slots: ExamSlot[] = [];
  for (const card of cards) {
    questionTypesFor(card).forEach((type) => {
      slots.push({ cardId: card.id, type, question: null, error: '' });
    });
  }
  return slots;
}

/**
 * 并发执行，最多 `limit` 个同时在跑。
 *
 * 为什么不用 `Promise.all(items.map(...))`：那等于同时打 15 个请求，
 * 模型服务很容易限流（一道题失败用户就得手动重试一次）。
 * @param items 待处理项
 * @param limit 并发上限
 * @param worker 单项处理
 */
async function withConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  const safeLimit = Math.max(1, Math.min(limit, items.length));
  let cursor = 0;
  const runners = Array.from({ length: safeLimit }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      const item = items[index];
      if (item === undefined) return;
      await worker(item);
    }
  });
  await Promise.all(runners);
}

/**
 * 一口气出完所有题。
 *
 * 失败处理：**某一道题出失败不影响其余的题**（只有它自己进 error 槽位，
 * 用户可以在那一题上单独「重试」）——串行时代一道题失败会让整轮停住，
 * 批量之后更不能这样。
 *
 * @param opts.cards 本轮卡片
 * @param opts.slots 槽位表（`buildSlots` 建好的，原地填充）
 * @param opts.indices 要出哪几道（续跑时只出没答过的；重试时只出那一道）
 * @param opts.cfg AI 配置（密钥只在本机）
 * @param opts.onProgress 进度回调
 */
export async function prepareQuestions(opts: {
  cards: KnowledgeCard[];
  slots: ExamSlot[];
  indices: number[];
  cfg: AiConfig;
  onProgress?: (p: PrepareProgress) => void;
}): Promise<void> {
  const { cards, slots, cfg, onProgress } = opts;
  const todo = opts.indices.filter((i) => i >= 0 && i < slots.length);
  const total = todo.length;
  let done = 0;
  onProgress?.({ done, total });

  // 整轮共用的材料只取一次（语境词 + 近期题干），逐题变的只有题型与题库样题
  const shared = await collectRoundMaterials();

  await withConcurrency(todo, KC.examGenConcurrency, async (index) => {
    const slot = slots[index];
    const at = locateSlot(cards, index);
    if (slot === undefined || at === null) return;
    try {
      const res = await generateQuestion({
        card: at.card,
        type: slot.type,
        contextWords: shared.contextWords,
        recentQuestions: shared.recentQuestions,
        // 题库样题按题型抽，同一题型不同题也会换着给（见 pickBankSamples 的洗牌）
        bankSamples: await pickBankSamples(slot.type),
        cfg,
      });
      if (res.question === null) {
        slot.error = res.error ?? '出题失败';
        slot.question = null;
      } else {
        slot.question = {
          type: slot.type,
          question: res.question.question,
          contextWord: res.question.contextWord,
          expected: res.question.expected,
        };
        slot.error = '';
      }
    } catch (err) {
      // generateQuestion 自己约定「失败不抛」，这里兜住意外（例如解析层的 bug）
      slot.question = null;
      slot.error = err instanceof Error ? err.message : String(err);
      console.warn('[kcExamPrepare] 出题意外失败', err);
    }
    done += 1;
    onProgress?.({ done, total });
  });
}
