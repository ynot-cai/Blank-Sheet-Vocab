/**
 * 「AI 重新整理义项」（版本 0.1.1，用户「单词列表与单词模块新增 AI 重新整理义项按钮」）。
 *
 * 做什么：把一个词现有的义项（代表义 + 近义词）交给 AI，让它
 * 1. 把同一个意思的重复项合并；
 * 2. 每个义项只保留一个「代表义」+ 最多 3 个常用近义词；
 * 3. 词性前缀（n./v./adj.）统一、缺失的补上；
 * 4. 丢掉解析噪声（如整句例句、来源标记、字母乱码）。
 *
 * 输出的形态与主程序一致：`Sense[]`（`{ id, text, aliases, example, enabled }`）。
 * AI 不可用或返回不合法时**不抛异常**，返回 `error` 让界面提示，词条保持原样。
 *
 * RULES-R1: 本文件只整理义项文本，不参与任何作答判定，也没有时间限制。
 */
import { uid } from '../core/model';
import type { AiConfig } from './ai';
import { chatComplete } from './ai';
import type { Sense, Word } from '../core/types';

/** 整理提示词（系统） */
export const SENSE_SYSTEM_PROMPT = `你是「白纸单词」的义项整理助手。用户会给你一个英文单词，以及程序里现有的义项（每行一个，可能含词性前缀与近义词）。
请把义项整理成干净、可直接背的形态：

规则：
1. 合并同义/重复的义项，只保留真正不同的意思；
2. 每个义项写成「词性. 中文代表义」，词性用 n. / v. / adj. / adv. / prep. / conj. / pron. / num. / phr. 之一；
3. 代表义要短（不超过 12 个字），不要写整句解释；
4. 近义词 0~3 个，只放同义/近义的中文词，不要重复代表义；
5. 不要编造该词没有的义项；宁可少，不要错；
6. 义项个数 1~6 个。

只输出 JSON，不要 markdown 代码块、不要解释：
{"senses":[{"text":"v. 放弃","aliases":["抛弃","遗弃"]}]}`;

/**
 * 请求体里的用户消息（把现有义项列给它）。
 * @param word 词
 */
export function buildSensePrompt(word: Word): string {
  const lines = word.senses.map((s, i) => {
    const aliases = s.aliases.filter((a) => a.trim() !== '');
    return `${i + 1}. ${s.text}${aliases.length > 0 ? `（近义词：${aliases.join('、')}）` : ''}`;
  });
  return [
    `英文单词：${word.en}`,
    `现有义项（共 ${word.senses.length} 个）：`,
    lines.length === 0 ? '（原本没有义项）' : lines.join('\n'),
    '',
    '请按上面的规则重新整理，只输出 JSON。',
  ].join('\n');
}

/** 解析结果 */
export interface SenseRepairResult {
  /** 整理后的义项（至少 1 个；失败时为空数组） */
  senses: Sense[];
  /** 失败原因（成功时为空串） */
  error: string;
}

/**
 * 解析 AI 返回的义项 JSON（**纯函数**，可单测）。
 *
 * 容错：允许 ```json 围栏、允许字段名写成 `meanings`，逐项清洗；
 * 一个字都没有的义项会被丢掉；最多保留 8 个义项。
 * @param raw 模型返回的文本
 */
export function parseSensesResponse(raw: string): SenseRepairResult {
  const text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { senses: [], error: 'AI 返回的不是合法 JSON' };
  }
  const box = data as { senses?: unknown; meanings?: unknown };
  const list = Array.isArray(box.senses) ? box.senses : Array.isArray(box.meanings) ? box.meanings : null;
  if (list === null) return { senses: [], error: 'AI 返回的 JSON 里没有义项数组' };

  const out: Sense[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    if (out.length >= 8) break;
    const obj = item as { text?: unknown; aliases?: unknown; meaning?: unknown };
    const text = String(obj.text ?? obj.meaning ?? '').trim();
    if (text === '') continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const aliasesRaw = Array.isArray(obj.aliases) ? obj.aliases : [];
    const aliases: string[] = [];
    for (const a of aliasesRaw) {
      const t = String(a).trim();
      if (t === '' || t.toLowerCase() === key || aliases.includes(t)) continue;
      aliases.push(t);
      if (aliases.length >= 3) break;
    }
    out.push({ id: uid(), text, aliases, example: '暂无', enabled: true });
  }
  if (out.length === 0) return { senses: [], error: 'AI 没有给出可用的义项' };
  return { senses: out, error: '' };
}

/**
 * 让 AI 重新整理一个词的义项。
 *
 * 失败**不抛异常**：返回 `senses: []` 与中文原因，调用方提示即可，词条保持原样。
 * @param cfg AI 接口配置
 * @param word 词
 */
export async function reorganizeSenses(cfg: AiConfig, word: Word): Promise<SenseRepairResult> {
  if (word.senses.length === 0 && word.en.trim() === '') {
    return { senses: [], error: '这个词没有可整理的内容' };
  }
  try {
    const content = await chatComplete(
      cfg,
      [
        { role: 'system', content: SENSE_SYSTEM_PROMPT },
        { role: 'user', content: buildSensePrompt(word) },
      ],
      { jsonMode: true },
    );
    const parsed = parseSensesResponse(content);
    return parsed;
  } catch (err) {
    return { senses: [], error: err instanceof Error ? err.message : String(err) };
  }
}
