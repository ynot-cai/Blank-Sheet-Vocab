/**
 * 拼写强化的**专属优先级公式**与**队列调度**（版本 0.0.25）。
 *
 * 用户「四、选词与复习调度」：
 * - 「系统根据单词的若干属性计算复习优先级。属性名与主背诵程序完全一致，复用现有数据模型；
 *    但计算公式是专属于本功能的加权公式，与主程序的复习优先级公式不同。权重参数应做成可配置。」
 * - 「每次生成复习队列前，按优先级从高到低排序选词；队列长度可配置，词库不足时取实际数量。」
 * - 「得满分的单词本次队列中不再出现……未拿到满分的单词，在间隔 5 个单词后再次出现：
 *    即插回到当前队列中第 5 个单词之后；若队列剩余不足 5 个单词，则追加到队列末尾。」
 *
 * ⚠️ 本文件是**纯函数**（不碰 DOM、不碰库），能被 node 直接测（见 `api/_dev/test-spell.mjs`）。
 * RULES-R1: 这里只有排序与插队，没有任何时间限制 / 倒计时 / 超时判错。
 */
import { getFailRate } from './priority';
import { wordPriorityOf } from './model';
import type { SpellRecord, SpellSettings, Word } from './types';

/** 本题满分的固定值（用户「五、计分规则」：每题满分为 5 分） */
export const SPELL_MAX_SCORE = 5;
/** 未拿满分的词间隔几个单词后再出现（用户：间隔 5 个单词） */
export const SPELL_REPEAT_GAP = 5;

/** 一个待强化条目：词 + 现算的优先级 + 记录 */
export interface SpellEntry {
  word: Word;
  /** 本功能专属优先级（越大越先复习） */
  priority: number;
  /** 本功能的历史记录（没有就当作「从没出现过」） */
  record: SpellRecord | null;
}

/**
 * 距上次复习天数（封顶 30 天，避免多年不练的词天文数字）。
 * @param lastReviewAt 上次复习时间戳（null = 从没复习过，按封顶算）
 * @param now 当前时间
 */
function daysSince(lastReviewAt: number | null, now: number): number {
  if (lastReviewAt === null) return 30;
  const days = (now - lastReviewAt) / 86_400_000;
  return Math.min(30, Math.max(0, days));
}

/**
 * 算一个词的**拼写强化优先级**（加权公式，权重来自设置）。
 *
 * 公式（用的全是主程序已有的属性名 + 本功能自己的记录）：
 * ```
 * priority = w.failRate    * 未通过率(failCount / failCountTotal)
 *          + w.days        * min(30, 距上次复习天数)
 *          + w.attempts    * 本功能出现次数
 *          + w.lowScore    * (5 - 上次得分)
 *          + w.wordPriority* 词级优先级
 * ```
 * 注意「上次得分」没有记录时按 0 分算（也就是 (5-0)=5，没练过的词更该练）。
 * @param word 词
 * @param record 本功能的历史记录（可为 null）
 * @param settings 设置（取权重）
 * @param now 当前时间
 */
export function computeSpellPriority(
  word: Word,
  record: SpellRecord | null,
  settings: SpellSettings,
  now: number = Date.now(),
): number {
  const w = settings.weights;
  const failRate = getFailRate(word.attrs);
  const attempts = record?.attempts ?? 0;
  const lastScore = record?.lastScore ?? 0;
  return (
    w.failRate * failRate +
    w.days * daysSince(word.attrs.lastReviewAt, now) +
    w.attempts * attempts +
    w.lowScore * (SPELL_MAX_SCORE - lastScore) +
    w.wordPriority * wordPriorityOf(word)
  );
}

/** 排序：优先级高的在前；相同则按单词首字母升序（保证结果稳定、可复现） */
export function compareSpellEntries(a: SpellEntry, b: SpellEntry): number {
  if (b.priority !== a.priority) return b.priority - a.priority;
  return a.word.en.localeCompare(b.word.en, 'en', { sensitivity: 'base' });
}

/**
 * 生成本次复习队列。
 *
 * 1. 候选 = 被标记「拼写易错」的词（`attrs.needSpell === true`），排除已斩；
 * 2. 全部按专属优先级从高到低排序；
 * 3. 取前 `settings.count` 个（不足就全取）。
 *
 * @param words 词库全量
 * @param records 本功能记录（id → 记录）
 * @param settings 设置
 * @param now 当前时间
 */
export function buildSpellQueue(
  words: Word[],
  records: Map<string, SpellRecord>,
  settings: SpellSettings,
  now: number = Date.now(),
): SpellEntry[] {
  const tagged = words
    .filter((w) => w.attrs.needSpell === true && w.status !== 'chopped')
    .map((word) => {
      const record = records.get(word.id) ?? null;
      return { word, record, priority: computeSpellPriority(word, record, settings, now) };
    });
  tagged.sort(compareSpellEntries);
  const count = Math.max(1, Math.round(settings.count));
  return tagged.slice(0, count);
}

/**
 * 算本题得分（用户「五、计分规则」）：满分 5，点一次小喇叭 −1、点一次提示 −1，下限 0。
 * @param hintClicks 点了几次「提示」
 * @param speakClicks 点了几次小喇叭
 */
export function spellScore(hintClicks: number, speakClicks: number): number {
  return Math.max(0, SPELL_MAX_SCORE - Math.max(0, hintClicks) - Math.max(0, speakClicks));
}

/**
 * 未拿满分的词要插回队列的位置（用户：间隔 5 个单词后再次出现）。
 *
 * `index` = 当前题在队列里的下标。插到「当前题之后第 6 位」= 中间隔着第 1~5 个后续单词；
 * 若剩余不足 5 个单词，就放到队列末尾。
 * @param queueLength 当前队列长度
 * @param index 当前题下标
 */
export function repeatInsertIndex(queueLength: number, index: number): number {
  const remaining = queueLength - index - 1;
  if (remaining < SPELL_REPEAT_GAP) return queueLength;
  return index + 1 + SPELL_REPEAT_GAP;
}

/**
 * 把没拿到满分的题插回队列（返回新数组，不改原数组）。
 * @param queue 队列
 * @param index 当前题下标
 * @param entry 要插回的条目
 */
export function reinsertEntry(queue: SpellEntry[], index: number, entry: SpellEntry): SpellEntry[] {
  const next = queue.slice();
  const at = Math.min(repeatInsertIndex(next.length, index), next.length);
  next.splice(at, 0, entry);
  return next;
}

/**
 * 提示按钮点第 n 次后要显示的字母串：首字母 + 之后依次追加。
 *
 * 用户「三」：「第一次点击后，在输入框下方显示答案的首字母；之后每点击一次，
 * 依次追加显示第二个、第三个字母，以此类推。」
 * @param answer 正确答案（英文单词）
 * @param clicks 已点击次数
 */
export function hintLetters(answer: string, clicks: number): string {
  const n = Math.min(answer.length, Math.max(0, Math.floor(clicks)));
  return answer.slice(0, n);
}
