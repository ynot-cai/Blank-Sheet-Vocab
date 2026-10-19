/**
 * 方式4「AI 智能勾选」的选词服务（版本 0.0.19，用户提示词 07 §1.2）。
 *
 * 用户原话：
 *   - 「用户口述条件，发送给 AI，跳转至确认界面。」
 *   - 「确认界面支持多轮对话。」
 *
 * 本文件的职责只有三件（都在**不动数据**的前提下）：
 *   1. 把候选单词表压成 AI 看得懂的紧凑文本；
 *   2. 调 `services/ai.ts` 的 `chatComplete()`（沿用既有的直连 / 代理两条路径与 JSON 模式）；
 *   3. 把 AI 的返回**严格校验**成「候选表里真实存在」的英文集合
 *      —— 模型输出是不可信输入，它编出来的词必须被丢掉，否则临时优先级表里会出现幽灵条目。
 *
 * ⚠️ 它**不写库**：选词结果只交给背诵选择页，由用户确认后才用于建临时优先级表。
 */
import type { Word } from '../core/types';
import { chatComplete, type AiConfig } from './ai';

/** 一轮原始对话（发给模型的东西，assistant 的 content 是原始 JSON） */
export interface PickMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** 界面上要显示的一轮对话（assistant 的内容已抽成人类可读的一句话） */
export interface PickTurnView {
  role: 'user' | 'assistant';
  text: string;
}

/** 一次选词的结果 */
export interface PickResult {
  /** 选中的英文（**原样**取自候选表，已去重、按候选表顺序） */
  selected: string[];
  /** AI 的一句话说明（没有就空串） */
  reply: string;
  /** 这一轮是否失败（失败时 selected 保留上一轮结果，由调用方决定要不要用） */
  failed: boolean;
  /** 失败原因（给人看的中文） */
  error?: string;
}

/**
 * 单批发给 AI 的单词条数。
 *
 * 为什么要分批：词库可能有几千词，一次性塞进去会超出上下文或直接超时。
 * 400 条 × 每行约 20 字 ≈ 8k 字，单次请求很轻；多批只是多几次调用。
 */
const BATCH_SIZE = 400;

/**
 * 选词的 system prompt。
 * 约束写得比较死（只许原样输出候选表里的英文、只输出 JSON），
 * 因为返回要直接进临时优先级表，不能有半点含糊。
 */
export const PICK_SYSTEM_PROMPT = `你是「白纸单词」的选词助手。用户会用中文口述选词条件，你要从给定的候选单词表里挑出符合条件的单词。

输出严格 JSON：
{"selected":["abandon","ability"],"reply":"一句话说明按什么条件选了什么"}

规则：
1. selected 里只能出现候选单词表里**原样存在**的英文（大小写、连字符、空格都必须一致），不许改写、不许翻译、不许造词。
2. 没有符合条件的单词时，selected 给空数组，reply 说明为什么。
3. reply 用中文、一到两句话，不要罗列全部单词。
4. 只输出 JSON，不要 markdown 代码块，不要任何解释文字。`;

/**
 * 一行候选词（给 AI 看的紧凑格式）。
 *
 * 格式：`英文 | 中文义项代表 | 背诵优先级`
 * 优先级用 `P1`~`P5`（用户口述「只要 p1 的词」时 AI 能直接对应上）。
 * 义项只取前两个代表义项，太长会白白烧 token；`|` 分隔便于模型按列理解。
 * @param word 候选词
 */
export function wordLine(word: Word): string {
  const senses = word.senses
    .filter((s) => s.enabled)
    .map((s) => s.text.trim())
    .filter((t) => t !== '')
    .slice(0, 2)
    .join('；');
  const priority = `P${Math.min(5, Math.max(1, Math.round(word.priority ?? 3)))}`;
  return `${word.en} | ${senses === '' ? '（无中文）' : senses} | ${priority}`;
}

/**
 * 把一批候选词拼成「候选单词表」文本。
 * @param words 这一批候选词
 */
export function candidateText(words: Word[]): string {
  return words.map(wordLine).join('\n');
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
 * 解析 AI 返回的选词结果，并把英文映射回候选表里的真实单词。
 *
 * 这是**不可信输入的边界**：
 * - 不是合法 JSON → 返回 null（调用方按失败处理）；
 * - 模型编出来的英文（候选表里没有）→ 直接丢掉，不报错也不补词；
 * - 大小写/空格不一致 → 按 `trim + toLowerCase` 归一后匹配，输出仍用候选表里的原文。
 *
 * @param raw AI 返回的原始文本
 * @param candidates 这一批候选词（用于校验与还原原文）
 */
export function parsePickResponse(
  raw: string,
  candidates: Word[],
): { selected: string[]; reply: string } | null {
  let data: unknown;
  try {
    data = JSON.parse(stripCodeFence(raw)) as unknown;
  } catch {
    return null;
  }
  if (typeof data !== 'object' || data === null) return null;
  const obj = data as Record<string, unknown>;
  const list = obj['selected'];
  if (!Array.isArray(list)) return null;

  // 候选表：归一化英文 → 原文
  const byKey = new Map<string, string>();
  for (const w of candidates) byKey.set(w.en.trim().toLowerCase(), w.en);

  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    if (typeof item !== 'string') continue;
    const hit = byKey.get(item.trim().toLowerCase());
    if (hit === undefined || seen.has(hit)) continue;
    seen.add(hit);
    out.push(hit);
  }
  // 按候选表顺序输出（同一优先级下白纸按首字母取词，这里保持可预测）
  const order = new Map<string, number>();
  candidates.forEach((w, i) => order.set(w.en, i));
  out.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));

  const reply = typeof obj['reply'] === 'string' ? obj['reply'].trim() : '';
  return { selected: out, reply };
}

/** 一次 AI 选词的输入 */
export interface PickOptions {
  /** AI 接口配置（`aiConfigFromSettings()` 的结果） */
  cfg: AiConfig;
  /** 全部候选词（本页可选的词，通常 = 未斩的全部词） */
  candidates: Word[];
  /** 用户在输入框里口述的条件（第一轮必填；后续轮是补充条件） */
  condition: string;
  /** 之前已经发生的对话（多轮用；第一轮传空数组） */
  history?: PickMessage[];
  /** 当前已选中的英文（多轮时告诉模型「现在选的是这些」，便于增量修改） */
  current?: string[];
}

/**
 * 让 AI 按条件选词（自动分批，多轮时把历史带给模型）。
 *
 * 失败**不抛异常**：返回 `failed: true` 和中文原因，界面照常可用。
 * @param opts 输入
 */
export async function pickWords(opts: PickOptions): Promise<PickResult> {
  const condition = opts.condition.trim();
  if (condition === '') return { selected: [], reply: '', failed: true, error: '请先写一句选词条件' };
  if (opts.candidates.length === 0) return { selected: [], reply: '', failed: true, error: '词库是空的' };

  const chosen = new Set(opts.current ?? []);
  const replies: string[] = [];

  for (let i = 0; i < opts.candidates.length; i += BATCH_SIZE) {
    const batch = opts.candidates.slice(i, i + BATCH_SIZE);
    /** 这一批里「当前已选」的词，作为多轮修改的起点 */
    const pickedInBatch = batch.filter((w) => chosen.has(w.en)).map((w) => w.en);
    const messages = buildMessages(batch, condition, opts.history ?? [], pickedInBatch, i === 0);
    try {
      const content = await chatComplete(opts.cfg, messages, { jsonMode: true });
      const parsed = parsePickResponse(content, batch);
      if (parsed === null) {
        return { selected: [], reply: replies.join(' '), failed: true, error: 'AI 返回的不是合法 JSON，可以再说一次' };
      }
      // 用这一批的结果替换这一批的旧选择（多批时各批独立）
      for (const w of batch) chosen.delete(w.en);
      for (const en of parsed.selected) chosen.add(en);
      if (parsed.reply !== '') replies.push(parsed.reply);
    } catch (err) {
      return {
        selected: [],
        reply: replies.join(' '),
        failed: true,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // 按候选表顺序输出，保证界面稳定
  const selected = opts.candidates.filter((w) => chosen.has(w.en)).map((w) => w.en);
  return { selected, reply: replies.join(' '), failed: false };
}

/**
 * 拼出一次请求的消息列表。
 *
 * 消息顺序（候选表只出现一次，多轮不会重复烧 token）：
 *   system → user(候选单词表) → [第一轮：user(条件)]
 *                              → [后续轮：…历史… → user(补充条件 + 这一批当前已选)]
 *
 * @param batch 这一批候选词
 * @param condition 本轮条件
 * @param history 之前的多轮对话（user = 条件原文，assistant = 上一轮的 JSON 结果）
 * @param pickedInBatch 这一批里当前已选的词
 * @param first 是不是第一轮
 */
function buildMessages(
  batch: Word[],
  condition: string,
  history: PickMessage[],
  pickedInBatch: string[],
  first: boolean,
): { role: 'system' | 'user' | 'assistant'; content: string }[] {
  const out: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
    { role: 'system', content: PICK_SYSTEM_PROMPT },
    { role: 'user', content: `候选单词表（每行：英文 | 中文义项 | 背诵优先级）：\n${candidateText(batch)}` },
  ];
  if (first) {
    out.push({ role: 'user', content: `用户条件：${condition}` });
    return out;
  }
  // 多轮：把之前的条件与 AI 的结果带上，再把「这批当前已选」交给模型修改
  for (const turn of history) out.push(turn);
  out.push({
    role: 'user',
    content:
      `补充条件：${condition}\n` +
      `这一批当前已选：${pickedInBatch.length === 0 ? '（无）' : pickedInBatch.join('、')}\n` +
      '请按上面的补充条件重新给出这一批的完整选择（之前选中但不符合新条件的要去掉）。',
  });
  return out;
}
