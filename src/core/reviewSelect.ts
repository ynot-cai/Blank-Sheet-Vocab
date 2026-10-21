/**
 * 复习的排序与范围逻辑（版本 0.0.24，用户「二、复习优先度与排序规则」「三、复习卡片模式」）。
 *
 * RULES-R1: 本文件只决定「复习时先看谁」，不参与任何作答判定，也没有任何时间限制 /
 *   倒计时 / 超时判错（复习本身不计时）。
 *
 * 用户原文：
 * - 「程序需实现一个『复习优先度计算公式』，每个单词均具有『复习优先度』属性。」
 * - 「选择『默认复习模式』时，按以下规则对所有单词排序：首先按『复习优先度』排序；
 *    复习优先度相同时，按『背诵优先级』排序；背诵优先级也相同时，按单词首字母排序。」
 * - 「选择『复习卡片』时……复习范围限定为该卡片中出现过的单词。」
 *
 * ── 复习优先度从哪来 ──
 * 公式本体在 `core/priority.ts`（`computePriority`：读设置里的预设/自定义表达式），
 * 结果落在 `word.attrs.reviewPriority`。这里**每次排序都按公式现算一遍**，
 * 而不是只读库里那份存值——存值可能还没重算过（列表页的「重算优先度」才负责写回），
 * 现算能保证「进复习时看到的就是当前该复习的顺序」。
 *
 * ⚠️ 本文件是**纯函数**（不碰 DOM、不碰库），所以能被 node 直接测（见 `api/_dev/test-review.mjs`）。
 */
import { computePriority } from './priority';
import { wordPriorityOf } from './model';
import type { PaperArchive, Settings, Word } from './types';

/** 一个待复习条目：词 + 现算出来的复习优先度 */
export interface ReviewEntry {
  word: Word;
  /** 现算的复习优先度（可能和 `word.attrs.reviewPriority` 的存值不同） */
  reviewPriority: number;
}

/**
 * 排序用的比较函数（用户规定的三级规则）：
 * 1. 复习优先度**高的在前**；
 * 2. 相同 → 背诵优先级（`word.priority`）**高的在前**；
 * 3. 再相同 → 单词首字母（A→Z，忽略大小写）。
 * @param a 条目 A
 * @param b 条目 B
 */
export function compareReviewEntries(a: ReviewEntry, b: ReviewEntry): number {
  if (b.reviewPriority !== a.reviewPriority) return b.reviewPriority - a.reviewPriority;
  const pa = wordPriorityOf(a.word);
  const pb = wordPriorityOf(b.word);
  if (pb !== pa) return pb - pa;
  return a.word.en.localeCompare(b.word.en, 'en', { sensitivity: 'base' });
}

/**
 * 给一批词算复习优先度并按用户规则排序。
 *
 * @param words 候选词（调用方已排除不该出现的词，例如已斩）
 * @param settings 当前设置（公式要用）
 * @param now 当前时间（公式里的「距上次复习天数」要用；测试可固定）
 */
export function buildReviewQueue(words: Word[], settings: Settings, now: number = Date.now()): ReviewEntry[] {
  const entries = words.map((word) => ({ word, reviewPriority: computePriority(word, settings, now) }));
  entries.sort(compareReviewEntries);
  return entries;
}

/**
 * 取一张白纸存档**出现过的词**（用户：复习范围限定为该卡片中出现过的单词）。
 *
 * 只认 `shownIds`：那是「已经在这张纸上出现过」的名单，按出现顺序存着。
 * 词库里已经没有的词（被删了）会被跳过。
 * @param paper 白纸存档
 * @param words 词库全量
 */
export function wordsOfPaper(paper: PaperArchive, words: Word[]): Word[] {
  const byId = new Map(words.map((w) => [w.id, w]));
  const out: Word[] = [];
  for (const id of paper.shownIds) {
    const hit = byId.get(id);
    if (hit) out.push(hit);
  }
  return out;
}

/**
 * 复习候选词：所有「活着」的词里排除已斩的。
 *
 * 为什么排除已斩：斩在本程序里的语义是「这个词不再出现」（背诵抽词、列表默认视图都排除它），
 * 复习同属「出现」，所以同样排除。卡片模式则是「卡片里出现过的词」再套同一层过滤。
 * @param words 词库全量（含已斩）
 */
export function reviewCandidates(words: Word[]): Word[] {
  return words.filter((w) => w.status !== 'chopped');
}
