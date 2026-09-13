/**
 * 阶段 05 的 **AI 调用层**：语境词生成 / 出题 / 评分。
 *
 * 与解析层（`kcExamParse.ts`）分开：这边只管发请求 + 组装提示词，
 * 那边管不可信输入的清洗（可离线测）。
 *
 * **安全底线（方案 B）**：密钥由 `chatComplete` 直接发给模型服务，
 * 服务器（含我们自己的代理）不保存、不落库。本文件不出现任何存密钥的逻辑。
 */
import { getSettings } from '../core/config';
import type { BankQuestion, KnowledgeCard } from '../core/kcTypes';
import type { AiConfig } from './ai';
import { chatComplete } from './ai';
import {
  KC_CONTEXT_SYSTEM_PROMPT,
  KC_EXAM_SYSTEM_PROMPT,
  KC_GRADE_SYSTEM_PROMPT,
  kcContextUserPrompt,
  kcExamUserPrompt,
  kcGradeUserPrompt,
} from './kcExamPrompts';
import { parseContextWords, parseGrade, parseQuestion, type ParsedGrade, type ParsedQuestion } from './kcExamParse';

/** 出题/评分的超时：题干与理由都不长，比录入快 */
export const KC_EXAM_TIMEOUT_MS = 60_000;
/** 语境词生成的超时：就 5 个词，更快 */
export const KC_CONTEXT_TIMEOUT_MS = 30_000;

/**
 * 取卡片的**正文纯文本**（喂给 AI 让它知道这张卡讲了什么）。
 *
 * 用 `renderBlocks` 渲染再取 `textContent` 会依赖 DOM；这里直接按块类型拼文本，
 * 好处是**在 Node 里也能算**（测试方便），而且顺序、换行都可控。
 * @param card 卡片
 */
export function cardBlocksText(card: KnowledgeCard): string {
  const lines: string[] = [];
  for (const b of card.blocks) {
    switch (b.type) {
      case 'heading':
        lines.push(`# ${b.content ?? ''}`);
        break;
      case 'example':
        lines.push(`例句：${b.content ?? ''}${b.translation ? `（${b.translation}）` : ''}${b.note ? ` 注：${b.note}` : ''}`);
        break;
      case 'list':
        lines.push((b.items ?? []).map((it) => `- ${it}`).join('\n'));
        break;
      case 'table':
        lines.push((b.rows ?? []).map((r) => r.join(' | ')).join('\n'));
        break;
      case 'code':
        lines.push(`代码：${b.content ?? ''}`);
        break;
      default:
        lines.push(b.content ?? '');
    }
  }
  return lines.filter((l) => l.trim() !== '').join('\n');
}

/**
 * 生成今天的语境词。
 *
 * @param recentWords 近 N 天已用过的词（避免重复）
 * @param date 今天的自然日 'YYYY-MM-DD'
 * @param cfg AI 配置
 * @returns 失败时返回 `{ words: [], error }`
 */
export async function generateContextWords(
  recentWords: string[],
  date: string,
  cfg: AiConfig,
): Promise<{ words: string[]; raw: string; error?: string }> {
  const expected = getSettings().kc?.contextWordCount ?? 5;
  try {
    const raw = await chatComplete(
      cfg,
      [
        { role: 'system', content: KC_CONTEXT_SYSTEM_PROMPT },
        { role: 'user', content: kcContextUserPrompt(recentWords, date) },
      ],
      { jsonMode: true, timeoutMs: KC_CONTEXT_TIMEOUT_MS },
    );
    const words = parseContextWords(raw);
    if (words.length === 0) {
      return { words: [], raw, error: 'AI 返回的内容里没有可用的语境词' };
    }
    // 少于期望数量时不报错，只是提示一下（少几个词也能出题）
    const warn = words.length < expected ? `只生成了 ${words.length} 个（期望 ${expected} 个）` : undefined;
    return { words, raw, error: warn };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.warn('[kcExam] 语境词生成失败', err);
    return { words: [], raw: '', error: detail };
  }
}

/**
 * 为一张卡片出一道题。
 *
 * @param card 卡片
 * @param type 题型 id（调用方从 `card.examTags` 里挑）
 * @param contextWords 今日语境词（AI 从中挑一个关联）
 * @param recentQuestions 近 N 天历史题目（防重复）
 * @param bankSamples 同题型参考样题
 * @param cfg AI 配置
 */
export async function generateQuestion(args: {
  card: KnowledgeCard;
  type: string;
  contextWords: string[];
  recentQuestions: string[];
  bankSamples: BankQuestion[];
  cfg: AiConfig;
}): Promise<{ question: ParsedQuestion | null; raw: string; error?: string }> {
  try {
    const raw = await chatComplete(
      args.cfg,
      [
        { role: 'system', content: KC_EXAM_SYSTEM_PROMPT },
        {
          role: 'user',
          content: kcExamUserPrompt({
            cardTitle: args.card.title,
            cardSummary: args.card.summary,
            cardBlocksText: cardBlocksText(args.card),
            type: args.type,
            contextWords: args.contextWords,
            recentQuestions: args.recentQuestions,
            bankSamples: args.bankSamples.map((b) => b.content),
          }),
        },
      ],
      { jsonMode: true, timeoutMs: KC_EXAM_TIMEOUT_MS },
    );
    const question = parseQuestion(raw, args.contextWords);
    if (question === null) return { question: null, raw, error: 'AI 返回的内容里没有可用的题干' };
    return { question, raw };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.warn('[kcExam] 出题失败', err);
    return { question: null, raw: '', error: detail };
  }
}

/**
 * 按 rubric 给答案打分。
 *
 * @param type 题型 id
 * @param question 题干
 * @param expected 参考答案
 * @param userAnswer 学生答案
 * @param cfg AI 配置
 */
export async function gradeAnswer(args: {
  type: string;
  question: string;
  expected: string;
  userAnswer: string;
  cfg: AiConfig;
}): Promise<{ grade: ParsedGrade | null; raw: string; error?: string }> {
  try {
    const raw = await chatComplete(
      args.cfg,
      [
        { role: 'system', content: KC_GRADE_SYSTEM_PROMPT },
        {
          role: 'user',
          content: kcGradeUserPrompt({
            type: args.type,
            question: args.question,
            expected: args.expected,
            userAnswer: args.userAnswer,
          }),
        },
      ],
      { jsonMode: true, timeoutMs: KC_EXAM_TIMEOUT_MS },
    );
    const grade = parseGrade(raw);
    if (grade === null) return { grade: null, raw, error: 'AI 返回的内容不是可用的评分' };
    return { grade, raw };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.warn('[kcExam] 评分失败', err);
    return { grade: null, raw: '', error: detail };
  }
}


