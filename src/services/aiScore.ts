/**
 * 考核的**评分服务**（版本 0.0.21，用户「四、考核过程」「五、数据记录」）。
 *
 * 用户原文：
 * - 「英译中考核：在文本框内输入中文意思（文本框个数取决于义项个数），将答案交给 AI，
 *    AI 参考单词列表记录的意思，依照准确全面程度打分。」
 * - 「每个单词考核分数共 5 分。」
 * - 「拼写考核：完全与旧版相同。」（所以拼写**不走这里**，仍用旧版的完全匹配判分）
 *
 * ── 设计要点 ──
 * - 交给 AI 的东西：英文单词 + 它记录的每个义项（代表义 + 近义词）+ 用户按义项顺序填的答案；
 * - 要回来的东西：0~5 的整数分、**每个输入框**是否算对（答案卡上要标绿/标红）、一句点评；
 * - AI 不可用（没填密钥 / 网络失败 / 返回不合法）时**不让考核卡死**：
 *   退回到旧版那套「逐义项完全匹配」的本地判分，并按命中比例折算成 0~5 分。
 *   这条兜底会写进点评（`comment` 以「本地判分」开头），用户在答案卡上看得见。
 */
import { activeSenses, senseMatch } from '../core/model';
import { DEFAULT_SCORE_RUBRIC } from '../core/config';
import type { Word } from '../core/types';
import { chatComplete, type AiConfig } from './ai';

/** 一次英译中的评分结果 */
export interface ChineseScore {
  /** 0~5 的整数分 */
  score: number;
  /** 每个输入框是否算对（长度与 answer 一致） */
  inputs: boolean[];
  /** 一句话点评（AI 的原话，或本地兜底说明） */
  comment: string;
  /** 走了兜底（AI 不可用）时为失败原因，正常为空 */
  error?: string;
}

/** 满分（用户：每个单词考核分数共 5 分） */
export const EXAM_MAX_SCORE = 5;

/**
 * 评分 prompt 的**固定骨架**（输出格式等，不许被用户的标准覆盖）。
 *
 * ★ 版本 0.0.23（用户要求）：评分标准改成设置项「考核评分标准」，可编辑、原样交给 AI。
 *   所以这里只保留「必须遵守」的骨架（角色、输出 JSON 格式、逐格判定的个数要求），
 *   具体怎么给分/怎么扣分全部来自用户的 `scoreRubric`（见 `buildScoreSystemPrompt`）。
 */
const SCORE_PROMPT_HEAD = `你是「白纸单词」的英译中阅卷助手。用户在看英文单词、按义项顺序填写中文意思，你要按下面的评分标准打分。

输出严格 JSON（只输出 JSON，不要 markdown 代码块、不要解释）：
{"score":4,"inputs":[true,false],"comment":"一句话点评"}

硬性要求（优先于评分标准）：
1. score 必须是 0~5 的整数。
2. inputs 与用户提交的答案**一一对应**（个数必须相同），每一项 true / false 表示该格是否算对。
3. comment 用中文一句话，指出漏了或错了哪些义项。`;

/**
 * 拼出评分用的 system prompt。
 *
 * 用户的「考核评分标准」会被原样放进来（`scoreRubric`）；空串时回落到默认标准，
 * 免得 AI 收到一份没有评分依据的提示词。
 * @param rubric 用户在设置页里写的评分标准（可空）
 */
export function buildScoreSystemPrompt(rubric: string): string {
  const text = rubric.trim() === '' ? DEFAULT_SCORE_RUBRIC : rubric.trim();
  return `${SCORE_PROMPT_HEAD}

──────── 用户设置的评分标准（以此为准）────────
${text}`;
}

/**
 * 默认评分标准下拼出的 system prompt（兼容旧调用点与测试）。
 *
 * @deprecated 0.0.23 起评分标准是可编辑的设置项，请用 `buildScoreSystemPrompt(settings.exam.scoreRubric)`。
 */
export const SCORE_SYSTEM_PROMPT = buildScoreSystemPrompt('');

/**
 * 把一次提交拼成给模型的用户消息。
 * @param word 词
 * @param answers 用户按义项顺序填的答案
 */
export function buildScorePrompt(word: Word, answers: string[]): string {
  const senses = activeSenses(word);
  const senseLines = senses
    .map((s, i) => {
      const aliases = s.aliases.filter((a) => a.trim() !== '');
      return `${i + 1}. 义项代表：${s.text}${aliases.length > 0 ? `（近义词：${aliases.join('、')}）` : ''}`;
    })
    .join('\n');
  const answerLines = senses
    .map((_, i) => `${i + 1}. ${(answers[i] ?? '').trim() === '' ? '（空着没填）' : (answers[i] ?? '').trim()}`)
    .join('\n');
  return [
    `英文单词：${word.en}`,
    `该词记录的义项（共 ${senses.length} 个）：`,
    senseLines,
    '',
    '用户按义项顺序填的答案：',
    answerLines,
    '',
    `请按上面的规则评分，并给出 ${senses.length} 个 true/false。`,
  ].join('\n');
}

/**
 * 去掉模型可能加的 markdown 代码块围栏。
 * @param text 模型返回的文本
 */
function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return fence && fence[1] ? fence[1].trim() : trimmed;
}

/**
 * 解析并校验模型返回的评分。
 *
 * 这是**不可信输入的边界**：分数夹到 0~5 的整数；`inputs` 必须与义项个数一致，
 * 不一致时按「分数 / 满分」比例补齐（宁可少标几个绿勾，也不让答案卡错位）。
 * @param raw 模型返回的文本
 * @param total 义项个数（输入框个数）
 */
export function parseScoreResponse(raw: string, total: number): { score: number; inputs: boolean[]; comment: string } | null {
  let data: unknown;
  try {
    data = JSON.parse(stripCodeFence(raw)) as unknown;
  } catch {
    return null;
  }
  if (typeof data !== 'object' || data === null) return null;
  const obj = data as Record<string, unknown>;

  const rawScore = typeof obj['score'] === 'number' ? obj['score'] : Number(obj['score']);
  if (!Number.isFinite(rawScore)) return null;
  const score = Math.min(EXAM_MAX_SCORE, Math.max(0, Math.round(rawScore)));

  const rawInputs = Array.isArray(obj['inputs']) ? obj['inputs'] : [];
  const inputs: boolean[] = [];
  for (let i = 0; i < total; i += 1) inputs.push(rawInputs[i] === true);

  const comment = typeof obj['comment'] === 'string' ? obj['comment'].trim() : '';
  return { score, inputs, comment };
}

/**
 * 本地兜底判分（AI 不可用时）：逐义项用旧版的 `senseMatch` 判断，
 * 分数 = 5 × 命中比例（四舍五入）。**与旧版判分口径一致**，不会凭空判错。
 * @param word 词
 * @param answers 用户按义项顺序填的答案
 */
export function localScore(word: Word, answers: string[]): ChineseScore {
  const senses = activeSenses(word);
  const inputs = senses.map((sense, i) => {
    const value = (answers[i] ?? '').trim();
    if (value === '') return false;
    return senseMatch(value, sense);
  });
  const hit = inputs.filter(Boolean).length;
  const score = senses.length === 0 ? 0 : Math.round((hit / senses.length) * EXAM_MAX_SCORE);
  return {
    score,
    inputs,
    comment: `本地判分（AI 不可用）：答对 ${hit}/${senses.length} 个义项`,
  };
}

/**
 * 给一次英译中打分：优先交给 AI，失败就退回本地判分。
 *
 * 失败**不抛异常**：返回本地判分 + `error` 说明，考核流程照常往下走。
 * @param cfg AI 接口配置
 * @param word 词
 * @param answers 用户按义项顺序填的答案
 * @param rubric 用户在设置页写的「考核评分标准」（空串用默认标准）
 */
export async function scoreChineseAnswers(
  cfg: AiConfig,
  word: Word,
  answers: string[],
  rubric: string,
): Promise<ChineseScore> {
  const total = activeSenses(word).length;
  try {
    const content = await chatComplete(
      cfg,
      [
        { role: 'system', content: buildScoreSystemPrompt(rubric) },
        { role: 'user', content: buildScorePrompt(word, answers) },
      ],
      { jsonMode: true },
    );
    const parsed = parseScoreResponse(content, total);
    if (parsed === null) {
      const fallback = localScore(word, answers);
      return { ...fallback, error: 'AI 返回的评分格式不对，已用本地判分' };
    }
    return { score: parsed.score, inputs: parsed.inputs, comment: parsed.comment };
  } catch (err) {
    const fallback = localScore(word, answers);
    return { ...fallback, error: err instanceof Error ? err.message : String(err) };
  }
}
