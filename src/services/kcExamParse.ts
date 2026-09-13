/**
 * 阶段 05 的**解析层**：把「语境词 / 出题 / 评分」三种 AI 返回变成可用数据。
 *
 * 与 `kcImportParse.ts` 同样的理由分开：这是不可信输入的边界，
 * 最需要测，而且**不需要网络**就能测。
 *
 * 三条原则与录入解析一致：坏数据丢掉、文本过清洗、数值钳制。
 */
import { KC, getSettings } from '../core/config';
import { sanitizeText } from '../core/kcModel';
import { filterExamTags } from '../core/kcExamTypes';
import { extractFirstJsonObject, stripCodeFence } from './kcImportParse';

/**
 * 从 AI 返回里解析出 JSON 对象（三级降级，与录入解析同一套做法）。
 * @param reply AI 返回的原始文本
 * @returns 解析不出来返回 null
 */
export function parseReplyJson(reply: string): unknown | null {
  const text = typeof reply === 'string' ? reply : '';
  const candidates = [stripCodeFence(text), extractFirstJsonObject(stripCodeFence(text)) ?? ''];
  for (const candidate of candidates) {
    if (candidate.trim() === '') continue;
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      /* 试下一种 */
    }
  }
  return null;
}

// ══════════════════════════════════════════════════════════════
// 一、语境词
// ══════════════════════════════════════════════════════════════

/**
 * 解析 AI 返回的语境词。
 *
 * 除了 `{words:[...]}`，还兼容直接给数组、或键名叫 `contextWords` 的写法。
 * 数量按设置里的 `contextWordCount` 截断（默认 5），并去重、去空、限长。
 *
 * @param reply AI 返回的文本
 * @returns 失败时返回空数组（调用方据此提示重试）
 */
export function parseContextWords(reply: string): string[] {
  const parsed = parseReplyJson(reply);
  if (parsed === null) return [];
  let raw: unknown[] = [];
  if (Array.isArray(parsed)) raw = parsed;
  else if (typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    for (const key of ['words', 'contextWords', 'items', 'data']) {
      const v = obj[key];
      if (Array.isArray(v)) {
        raw = v;
        break;
      }
    }
  }
  const limit = getSettings().kc?.contextWordCount ?? 5;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const w = sanitizeText(item, 40).trim();
    const key = w.toLowerCase();
    if (w === '' || seen.has(key)) continue;
    seen.add(key);
    out.push(w);
    if (out.length >= limit) break;
  }
  return out;
}

// ══════════════════════════════════════════════════════════════
// 二、出题
// ══════════════════════════════════════════════════════════════

/** 一道题 */
export interface ParsedQuestion {
  question: string;
  /** AI 选中的语境词（可能为空 = 没关联语境） */
  contextWord: string;
  /** 参考答案与要点 */
  expected: string;
}

/**
 * 解析 AI 返回的题目。
 *
 * `contextWord` 会被**约束到今日语境词列表内**：模型有时会自己发明一个词，
 * 那种情况直接丢掉（否则统计「哪个语境词用过」会乱）。
 *
 * @param reply AI 返回的文本
 * @param todayWords 今日允许的语境词（用于校验 AI 选的那个）
 * @returns 解析失败（没有题干）时返回 null
 */
export function parseQuestion(reply: string, todayWords: string[]): ParsedQuestion | null {
  const parsed = parseReplyJson(reply);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  const question = sanitizeText(typeof obj['question'] === 'string' ? obj['question'] : '', 4000).trim();
  if (question === '') return null;

  const rawWord = sanitizeText(typeof obj['contextWord'] === 'string' ? obj['contextWord'] : '', 40).trim();
  // 只接受「今日列表里的词」（大小写不敏感）；不在列表里就留空
  const matched = todayWords.find((w) => w.toLowerCase() === rawWord.toLowerCase()) ?? '';

  return {
    question,
    contextWord: matched,
    expected: sanitizeText(typeof obj['expected'] === 'string' ? obj['expected'] : '', 2000).trim(),
  };
}

// ══════════════════════════════════════════════════════════════
// 三、评分
// ══════════════════════════════════════════════════════════════

/** 评分结果 */
export interface ParsedGrade {
  score: 1 | 2 | 3;
  reason: string;
}

/**
 * 解析 AI 返回的评分。
 *
 * 分数**必须钳到 1~3 整数**：模型偶尔给 0、5、或 "2分" 这种字符串。
 * 完全解析不出来时返回 `null`，由调用方决定怎么办
 * （界面上的做法是提示「AI 评分失败，可以手动打分」——用户明确要求保留手动改分的入口）。
 *
 * @param reply AI 返回的文本
 */
export function parseGrade(reply: string): ParsedGrade | null {
  const parsed = parseReplyJson(reply);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  const rawScore = obj['score'];
  const n = typeof rawScore === 'number' ? rawScore : Number(String(rawScore).replace(/[^\d.-]/g, ''));
  if (!Number.isFinite(n)) return null;
  const clamped = Math.min(KC.maxScore, Math.max(1, Math.round(n))) as 1 | 2 | 3;
  const reason = sanitizeText(typeof obj['reason'] === 'string' ? obj['reason'] : '', 2000).trim();
  return { score: clamped, reason: reason === '' ? '（AI 没有给出理由）' : reason };
}

/**
 * 把题型 id 过滤成「本卡可考」的合法题型（出题前用）。
 * @param tags 卡片上的考法标签
 */
export function usableExamTypes(tags: string[]): string[] {
  const valid = filterExamTags(tags);
  // 标签全不合法时给一个兜底题型，否则这张卡永远出不了题
  return valid.length > 0 ? valid : ['fill'];
}
