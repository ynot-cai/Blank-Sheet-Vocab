import { createSense, normalizeWordPriority, uid } from '../../../core/model';
import type { Sense, Word } from '../../../core/types';
import type { MergeSuggestion, ParsedWord } from '../../../services/ai';

/** 合并页里的一版草稿词（还没入库） */
export interface DraftWord {
  key: string;
  en: string;
  phonetic: string;
  example: string;
  senses: Sense[];
  /** 「斩掉此词（不入库）」被勾上 */
  dropped: boolean;
  /** AI 给的合并建议（只展示，用户点接受才生效） */
  hints: MergeSuggestion[];
}

/** 草稿统计 */
export interface DraftStats {
  words: number;
  senses: number;
  multiSense: number;
  dropped: number;
}

/**
 * 把解析结果转成草稿词。
 * @param entries 解析出的词
 */
export function draftsFromEntries(entries: ParsedWord[]): DraftWord[] {
  return entries.map((entry) => ({
    key: uid(),
    en: entry.en,
    phonetic: entry.phonetic,
    example: entry.example,
    senses:
      entry.senses.length > 0
        ? entry.senses.map((s) => createSense(s.text, s.aliases))
        : [createSense('')],
    dropped: false,
    hints: [],
  }));
}

/**
 * 草稿 → 正式 Word（属性全默认、状态 unlearned）。
 *
 * @param draft 草稿
 * @param sourceId 来源 id
 * @param priority ★ 本次录入批次的**词级优先级**（R1）。
 *   刻意做成必传参数：优先级是「这一批词」的属性，不是草稿自己的属性，
 *   给默认值的话很容易出现「某条调用路径忘了传 → 全部悄悄变成 3」这种
 *   界面完全看不出来的错误。
 */
export function draftToWord(draft: DraftWord, sourceId: string, priority: number): Word {
  const now = Date.now();
  return {
    id: uid(),
    en: draft.en.trim(),
    phonetic: draft.phonetic.trim(),
    example: draft.example.trim(),
    senses: draft.senses
      .filter((s) => s.text.trim() !== '')
      .map((s) => ({ ...s, text: s.text.trim(), aliases: s.aliases.map((a) => a.trim()).filter(Boolean) })),
    sourceId,
    rawSources: [],
    attrs: {
      needSpell: false,
      failCount: 0,
      failCountTotal: 0,
      reviewCount: 0,
      lastReviewAt: null,
      learnedAt: null,
      reviewPriority: 0,
      // T2：新词从 0 起算（已记录、确实考过 0 次）
      examCount: 0,
    },
    status: 'unlearned',
    priority: normalizeWordPriority(priority),
    learnOrder: null,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * 统计草稿。
 * @param drafts 草稿列表
 */
export function draftStats(drafts: DraftWord[]): DraftStats {
  let senses = 0;
  let multiSense = 0;
  let dropped = 0;
  for (const d of drafts) {
    const active = d.senses.filter((s) => s.enabled && s.text.trim() !== '');
    senses += active.length;
    if (active.length > 1) multiSense += 1;
    if (d.dropped) dropped += 1;
  }
  return { words: drafts.length, senses, multiSense, dropped };
}

/**
 * 接受一条合并建议：把 absorb 里的义项变成 keep 的近义词，并从义项列表移除。
 * @param draft 草稿
 * @param hint 建议
 * @returns 新的草稿（未匹配到就原样返回）
 */
export function applyMergeHint(draft: DraftWord, hint: MergeSuggestion): DraftWord {
  const keepIndex = draft.senses.findIndex((s) => s.text.trim() === hint.keep.trim());
  if (keepIndex < 0) return draft;
  const absorbSet = new Set(hint.absorb.map((a) => a.trim()));
  const absorbed = draft.senses.filter((s, i) => i !== keepIndex && absorbSet.has(s.text.trim()));
  if (absorbed.length === 0) return draft;

  const keepSense = draft.senses[keepIndex];
  if (!keepSense) return draft;
  const nextKeep: Sense = {
    ...keepSense,
    aliases: Array.from(new Set([...keepSense.aliases, ...absorbed.map((s) => s.text.trim())])),
  };
  const nextSenses = draft.senses
    .filter((s, i) => i === keepIndex || !absorbSet.has(s.text.trim()))
    .map((s) => (s === keepSense ? nextKeep : s));
  return { ...draft, senses: nextSenses, hints: draft.hints.filter((h) => h !== hint) };
}
