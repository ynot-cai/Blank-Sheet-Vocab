/**
 * 考核（记忆过程）的**抽词逻辑** —— 版本 0.0.21，用户「三、选取逻辑」。
 *
 * RULES-R1: 本文件只决定「考哪些词」，不参与任何作答判定，更没有任何时间限制 / 倒计时 /
 *   超时判错（考核本身也不计时）。
 *
 * 用户原文（逐条对应到实现）：
 * 1. 「每次选取的单词个数固定（可调）；若单词总数小于单次记忆数，则全部选中。」
 *    → `count` 由设置 `exam.countPerExam` 给；取 `min(count, 候选数)`。
 * 2. 「进入一次记忆过程时，优先选取该白纸中『记忆次数』低的单词（每个单词的记忆次数存入白纸存档）；
 *     若多个单词被选取次数相同，则随机挑选。」
 *    → 按 `memorizeCount[wordId]` 升序分组，组内随机打乱后依次取。
 * 3. 「标记『拼写』且被选中的单词，额外添加一次『拼写考察』；
 *     标记『仅拼写』或『斩』的单词，立即从纸上消失。」
 *    → 拼写名单 = 被选中且 `attrs.needSpell` 的词；`spellOnly` / `chopped` 的词由调用方排除在候选之外，
 *      另把「仅拼写」的词单独交给拼写环节（它们不在纸上，也就不会进英译中）。
 * 4. 「若某单词考核分数低于固定值（可调）且未被抽到，则无视设定的记忆次数，额外加入考核。」
 *    → `attrs.examScore` 有数字且 `< scoreThreshold` 的词，未被抽到时强制加进本轮。
 *
 * ⚠️ 本文件是**纯函数**（不碰 DOM、不碰库），所以能被 node 直接测（见 `api/_dev/test-exam.mjs`）。
 */
import type { Word } from './types';

/** 抽词参数 */
export interface ExamSelectOptions {
  /** 纸上的候选词（调用方负责先排除「已斩」「仅拼写」的词） */
  pool: Word[];
  /** 这张纸存档里的「记忆次数」表（缺省 = 0） */
  memorizeCount: Record<string, number>;
  /** 每次选取的固定个数（设置里可调） */
  count: number;
  /** 分数阈值（0~5，可调）：低于它且未被抽到的词强制加考 */
  scoreThreshold: number;
  /** 「仅拼写」的词（不在纸上，单独排拼写考察） */
  spellOnlyWords?: Word[];
  /** 随机源（默认 Math.random；测试可注入定值） */
  random?: () => number;
}

/** 抽词结果 */
export interface ExamSelection {
  /** 本轮英译中考量要考的「固定个数」词（按考核顺序） */
  picked: Word[];
  /** 其中因为「分数低于阈值」被强制加进来的词 */
  forced: Word[];
  /** 需要额外做一次拼写考察的词 id（被选中且标记了「拼写」的那些） */
  spellIds: string[];
  /** 仅拼写的词（只做拼写考察，不做英译中） */
  spellOnly: Word[];
}

/**
 * 取某个词当前的考核分数。
 * 只有**数字**才算分（`null` / 缺字段 = 还没考过，不参与「低于阈值强制加考」）。
 * @param word 词
 */
export function examScoreOf(word: Word): number | null {
  const value = word.attrs.examScore;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * 取某个词在这张纸上的记忆次数（没有记录 = 0）。
 * @param memorizeCount 存档里的记忆次数表
 * @param id 词 id
 */
export function memorizeCountOf(memorizeCount: Record<string, number>, id: string): number {
  const value = memorizeCount[id];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * 洗牌（Fisher–Yates，可注入随机源）。
 * @param list 原数组（不改原数组）
 * @param random 随机源
 */
function shuffled<T>(list: T[], random: () => number): T[] {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    const a = out[i] as T;
    const b = out[j] as T;
    out[i] = b;
    out[j] = a;
  }
  return out;
}

/**
 * 算一轮考核要考哪些词。
 * @param opts 抽词参数
 */
export function selectExamWords(opts: ExamSelectOptions): ExamSelection {
  const random = opts.random ?? Math.random;
  const count = Math.max(1, Math.floor(opts.count));
  const pool = opts.pool.slice();

  // ① 按「记忆次数」升序分桶，桶内随机 —— 同次数并列的随机挑（用户第 2 条）
  const buckets = new Map<number, Word[]>();
  for (const word of pool) {
    const key = memorizeCountOf(opts.memorizeCount, word.id);
    const list = buckets.get(key);
    if (list) list.push(word);
    else buckets.set(key, [word]);
  }
  const keys = Array.from(buckets.keys()).sort((a, b) => a - b);
  const order: Word[] = [];
  for (const key of keys) {
    const bucket = buckets.get(key) ?? [];
    order.push(...shuffled(bucket, random));
  }

  // ② 固定个数；不足就全选（用户第 1 条）
  const take = Math.min(count, order.length);
  const picked = order.slice(0, take);

  // ③ 分数低于阈值、又没被抽到的词：无视记忆次数强制加考（用户第 4 条）
  const pickedIds = new Set(picked.map((w) => w.id));
  const forced = order
    .slice(take)
    .filter((w) => {
      const score = examScoreOf(w);
      return score !== null && score < opts.scoreThreshold;
    })
    // 分数更低的更该补考；同分保持上面「记忆次数 + 随机」的顺序
    .sort((a, b) => (examScoreOf(a) ?? 0) - (examScoreOf(b) ?? 0));
  for (const word of forced) {
    if (pickedIds.has(word.id)) continue;
    pickedIds.add(word.id);
    picked.push(word);
  }

  // ④ 拼写考察名单：被选中且标记了「拼写」的词（用户第 3 条前半句）
  const spellIds = picked.filter((w) => w.attrs.needSpell === true).map((w) => w.id);

  // ⑤ 仅拼写的词：只做拼写考察（用户第 3 条后半句）
  const spellOnly = (opts.spellOnlyWords ?? []).filter((w) => w.spellOnly === true && w.status !== 'chopped');

  return { picked, forced, spellIds, spellOnly };
}
