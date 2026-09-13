/**
 * 出题环节的**数据准备**：决定「给这张卡出哪种题型」+ 收集出题需要的四样材料。
 *
 * 从页面里拆出来的原因：单文件 ≤ 300 行；而且这段逻辑**可以在 Node 里测**
 * （不碰 DOM、不发请求），是「防重复 / 题库参考 / 出题量」三条验收标准的落点。
 */
import { getSettings } from '../../../core/config';
import type { KcSession, KnowledgeCard } from '../../../core/kcTypes';
import * as dao from '../../../dao';
import { usableExamTypes } from '../../../services/kcExamParse';

/**
 * 续跑一个保存过的会话：把会话里的卡片重新取出来，并修正进度下标。
 *
 * 为什么要修正下标：会话存的是「第几张」，但两次打开之间用户可能
 * 斩掉/删掉了其中一些卡片。如果不修正，续跑会跳卡或越界。
 * 学习流程与复习流程共用这一份。
 *
 * @param open 保存过的会话
 * @returns `cards` = 还存在的卡片（顺序不变）；`session` = 修正后的会话；`empty` = 卡片全没了
 */
export async function resumeSession(open: KcSession): Promise<{
  cards: KnowledgeCard[];
  session: KcSession;
  empty: boolean;
}> {
  const all = await dao.kc.getAll();
  const byId = new Map(all.map((c) => [c.id, c]));
  const kept: KnowledgeCard[] = [];
  let newIndex = 0;
  open.cardIds.forEach((id, i) => {
    const card = byId.get(id);
    if (card === undefined || card.deleted === 1) return;
    kept.push(card);
    if (i < open.currentIndex) newIndex += 1;
  });
  if (kept.length === 0) return { cards: [], session: open, empty: true };
  const session: KcSession = {
    ...open,
    cardIds: kept.map((c) => c.id),
    currentIndex: Math.min(newIndex, kept.length),
  };
  return { cards: kept, session, empty: false };
}

/**
 * 取「未学」的卡片（`createdAt` 升序 = 先录入先学）。
 *
 * 学习流程的抽卡规则：`status === 'unlearned'` 且不是墓碑，
 * 与一期的「先录入先背」同一个口径。学习页与复习页共用这一份。
 *
 * @param count 最多几张
 */
export async function pickUnlearned(count: number): Promise<KnowledgeCard[]> {
  const all = await dao.kc.getAll();
  const unlearned = all
    .filter((c) => c.deleted !== 1 && c.status === 'unlearned')
    .sort((a, b) => a.createdAt - b.createdAt);
  return unlearned.slice(0, count);
}

/** 一次出题需要的材料 */
export interface ExamMaterials {
  /** 本次题型 id */
  type: string;
  /** 今日已确认的语境词（未确认则为空数组） */
  contextWords: string[];
  /** 近 N 天已出过的题（防重复） */
  recentQuestions: string[];
  /** 同题型参考样题（随机 3~5 条） */
  bankSamples: Awaited<ReturnType<typeof dao.examBank.listBankQuestions>>;
}

/** 一轮共用的出题材料（与具体题目无关的那部分） */
export interface RoundMaterials {
  /** 今日已确认的语境词（未确认则为空数组） */
  contextWords: string[];
  /** 近 N 天已出过的题（防重复） */
  recentQuestions: string[];
}

/**
 * 取「整轮共用」的出题材料：语境词 + 近期题干。
 *
 * 为什么单独拆出来：批量出题时一轮要出好几道题，这两项**每道题都一样**。
 * 每道题各读一次库不但浪费，还可能因为中途有题落库而让同一轮的
 * 「近期题干」前后不一致（前几道看到的和后几道看到的不一样）。
 */
export async function collectRoundMaterials(): Promise<RoundMaterials> {
  const settings = getSettings().kc;
  // 语境词：**只有用户确认过的才用**（用户明确要求「确认后才生效」）
  const today = await dao.contextWords.getForDate();
  const contextWords = today !== null && today.confirmed ? today.words : [];
  // 近 N 天历史题目（防重复）
  const recentQuestions = await dao.examBank.recentQuestions(settings?.examDedupeLookbackDays);
  return { contextWords, recentQuestions };
}

/**
 * 出题量：按 `examLoad.types` 决定出几道（如 fill+choice = 2 道）。
 *
 * 兜底很重要：卡片如果两个字段都空（用户手建的卡没标考法），
 * 这里必须给一个默认题型 —— 否则这张卡**一道题都出不了**，
 * 「学习 → 做题」会在它身上直接跳过（用户会以为漏了）。
 */
export function questionTypesFor(card: KnowledgeCard): string[] {
  const fromLoad = usableExamTypes(card.examLoad.types);
  const fromTags = usableExamTypes(card.examTags);
  // 优先用 examLoad.types（录入时 AI 给的建议组合），它为空才退回 examTags
  const types = card.examLoad.types.length > 0 ? fromLoad : fromTags;
  // 去重；上限 3 道（再多就超过「3~5 分钟」的心理预期了）
  const picked = [...new Set(types)].slice(0, 3);
  return picked.length > 0 ? picked : ['fill'];
}

/**
 * 从一批题型里抽一个（**随机**，让同一张卡多轮复习时考法不固定）。
 * @param types 候选题型
 * @param index 第几道题（保证同一轮内不重复用同一题型）
 */
export function pickType(types: string[], index: number): string {
  if (types.length === 0) return 'fill';
  if (index < types.length) return types[index] as string;
  return types[Math.floor(Math.random() * types.length)] as string;
}

/**
 * 随机抽几条同题型样题（**题库参考**的落点）。
 * @param type 题型
 * @param max 最多几条
 */
export async function pickBankSamples(
  type: string,
  max = 5,
): Promise<Awaited<ReturnType<typeof dao.examBank.listBankQuestions>>> {
  const all = await dao.examBank.listBankQuestions(type);
  if (all.length === 0) return [];
  // 洗牌后取前 max 条（同一题型下换着给，避免每次都用同样几条）
  const pool = [...all];
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const a = pool[i] as (typeof pool)[number];
    const b = pool[j] as (typeof pool)[number];
    pool[i] = b;
    pool[j] = a;
  }
  return pool.slice(0, max).reverse();
}

/**
 * 收集出题材料。
 *
 * @param card 卡片
 * @param index 第几道题（决定题型）
 */
export async function collectMaterials(card: KnowledgeCard, index: number): Promise<ExamMaterials> {
  const types = questionTypesFor(card);
  const type = pickType(types, index);
  const { contextWords, recentQuestions } = await collectRoundMaterials();
  const bankSamples = await pickBankSamples(type);
  return { type, contextWords, recentQuestions, bankSamples };
}

/**
 * 把一道题存档（`ExamRecord`），并同步更新卡片的考核分与掌握度。
 *
 * ★ 这一步是**评估闭环**的关键：
 * 1. 写 `ExamRecord`（防重复 + 复盘用）；
 * 2. 写 `card.attrs.lastExamScore` → 触发 `mastery` 与 `reviewPriority` 重算
 *    （用户明确要求：评分后掌握度要变）；
 * 3. 全部题答完后由调用方把状态置为 `learned`。
 *
 * @param args 存档参数
 */
export async function saveExamRecord(args: {
  cardId: string;
  type: string;
  question: string;
  userAnswer: string;
  score: number;
  reason: string;
  contextWord: string;
}): Promise<string> {
  const record = await dao.examBank.addRecord({
    cardId: args.cardId,
    date: dao.contextWords.localDate(),
    type: args.type,
    question: args.question,
    userAnswer: args.userAnswer,
    aiScore: args.score,
    aiReason: args.reason,
    contextWord: args.contextWord,
  });
  // 写考核分（同时在库与内存里算 mastery / reviewPriority）
  await dao.kc.updateAttrs(args.cardId, { lastExamScore: args.score });
  return record.id;
}

/**
 * 手动改分：更新已存档的记录的分数（用户明确要求保留改分入口）。
 * @param recordId 记录 id
 * @param score 新分数
 */
export async function regradeRecord(recordId: string, score: number): Promise<void> {
  await dao.examBank.updateRecordScore(recordId, score);
}
