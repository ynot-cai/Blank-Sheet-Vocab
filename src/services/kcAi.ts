/**
 * 二期 AI 服务：**发请求**这一半（解析那一半在 `kcImportParse.ts`）。
 *
 * 复用一期 `services/ai.ts` 的 `chatComplete`，所以「直连 ⇄ 无状态代理自动切换」
 * 和「JSON 模式被拒自动降级」这两个能力**直接继承**，不需要在这里重写。
 *
 * **安全底线（方案 B）**：密钥只存在这台设备的浏览器里，由 `chatComplete` 放进
 * `Authorization` 头直接发给模型服务；服务器（含我们自己的代理）**不保存、不落库**。
 * 这个文件里**不许出现任何「把密钥存起来」的逻辑**。
 */
import type { Settings } from '../core/types';
import { KC } from '../core/config';
import { createEmptyCard } from '../core/kcModel';
import { aiConfigFromSettings, chatComplete, type AiConfig, type ChatMessage } from './ai';
import { KC_IMPORT_SYSTEM_PROMPT, kcImportUserPrompt } from './kcPrompts';
import { parseImportReply, type ParsedImport } from './kcImportParse';
import type { Block, KnowledgeCard, ParsedKcCard } from '../core/kcTypes';

/** 录入解析的默认超时：要生成 2~5 张结构完整的卡片，比一期的单词解析慢得多 */
export const KC_IMPORT_TIMEOUT_MS = 90_000;

/**
 * assistant 那条历史消息的长度上限。
 *
 * 为什么单独再卡一道（config 里已经有总预算了）：总预算管的是"整体别超"，
 * 而这里管的是"**单条**别把整轮的预算吃光"。模型一次最多能回 12 张卡，
 * 原始 JSON 可能有上万字符；原样回传的话，一条就能顶掉所有历史预算，
 * 等于每轮都退化成"没有记忆"。
 */
const KC_HISTORY_ASSISTANT_LIMIT = 2_000;

/** 一条对话历史（与 `ChatMessage` 的区别：这里**不允许 system**） */
export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

/** 录入解析结果（对外的返回形状，与阶段提示词的约定一致） */
export interface ImportResult extends ParsedImport {
  cards: ParsedKcCard[];
  /** AI 原始返回，便于排查（界面的「查看原始返回」用它） */
  raw: string;
  /**
   * 因为超出上限而被丢掉的历史消息条数（0 = 没丢）。
   * 界面据此显示一行灰字「已省略较早的 N 轮对话」——
   * **为什么必须让用户看见**：用户会以为自己说的前文 AI 还记得，
   * 一旦被悄悄丢掉，"第二个再细一点"就会被理解成别的东西，而界面上毫无线索。
   */
  omittedTurns?: number;
}

/**
 * 把上一轮 AI 返回的卡片压成一小段文字（给历史消息用）。
 *
 * 为什么不直接把原始 JSON 全塞回去：
 * 1. 卡片 JSON 里有块 id、examLoad 之类对"理解用户指代"毫无用处的东西，纯浪费 token；
 * 2. 用户说「第二个再细一点」时，模型只需要认得出**第几个是哪张、讲的是什么**——
 *    序号 + 标题 + 一句摘要 + 块的小标题就足够了。
 *
 * @param cards 一轮里 AI 给出的卡片（解析后的形状）
 */
export function cardsBrief(cards: ParsedKcCard[]): string {
  if (cards.length === 0) return '（这一轮没有生成新卡片）';
  const lines = cards.map((c, i) => {
    // 块的小标题最能帮模型对上号（"看有没有 the"这种），其余细节不必回传
    const heads = c.blocks
      .filter((b: Block) => b.type === 'heading')
      .map((b) => (b.content ?? '').trim())
      .filter((t) => t !== '')
      .slice(0, 3)
      .join(' / ');
    return `${i + 1}. ${c.title}｜${c.summary}${heads === '' ? '' : `｜小标题：${heads}`}`;
  });
  const brief = `{"cards":[${lines.join('\n')}]}`;
  return brief.length > KC_HISTORY_ASSISTANT_LIMIT ? `${brief.slice(0, KC_HISTORY_ASSISTANT_LIMIT)}…（已截断）` : brief;
}

/**
 * 组装这次请求要发的消息列表（**system 在最前，历史按时间顺序居中间，本轮 user 在最后**）。
 *
 * ★ 导出是为了让 `npm run test:kc-import` 直接断言"截断真的发生了"：
 * 截断是纯函数，不需要起服务器；真发请求那一层由同一套测试里的假 AI 服务覆盖。
 *
 * 截断规则：
 * 1. 先按**条数**砍（`KC.maxChatHistoryMessages`），只留最近的若干条；
 * 2. 再按**字符总预算**（`KC.maxChatHistoryChars`）从最旧的一端继续丢，
 *    直到不超预算 —— 最近一轮永远保留（否则这轮对话就没有上下文了）。
 *
 * @param userMessage 本轮用户原话
 * @param existingTitles 已有知识点标题（防重复生成）
 * @param history 以往的对话（按时间顺序，最旧在前）
 * @param limits 上限（默认取 `core/config.ts` 里的命名常量，参数化只为便于测试）
 */
export function buildKcMessages(
  userMessage: string,
  existingTitles: string[],
  history: ChatTurn[] = [],
  limits: { maxMessages?: number; maxChars?: number } = {},
): { messages: ChatMessage[]; omittedTurns: number } {
  const maxMessages = limits.maxMessages ?? KC.maxChatHistoryMessages;
  const maxChars = limits.maxChars ?? KC.maxChatHistoryChars;

  const usable = history.filter((h) => (h.role === 'user' || h.role === 'assistant') && h.content.trim() !== '');
  const kept = usable.slice(Math.max(0, usable.length - maxMessages));
  let omittedTurns = usable.length - kept.length;

  // 字符预算：从最旧的开始丢。countChars 用 spread 是为了按**码点**数，
  // 而不是按 UTF-16 码元（emoji 之类在 JS 里占 2，按码元算会低估 2 倍）。
  const countChars = (m: ChatTurn): number => [...m.content].length;
  let total = kept.reduce((sum, m) => sum + countChars(m), 0);
  let start = 0;
  while (start < kept.length - 1 && total > maxChars) {
    total -= countChars(kept[start] as ChatTurn);
    start += 1;
    omittedTurns += 1;
  }

  // 单条就超预算的情况：留空会浪费一次调用，按字符硬截（宁可少一点，也不要请求被拒）
  const tail = kept.slice(start).map((m) => {
    const text = [...m.content];
    if (text.length <= maxChars) return m;
    return { ...m, content: `${text.slice(0, maxChars).join('')}…（已截断）` };
  });

  return {
    messages: [
      { role: 'system', content: KC_IMPORT_SYSTEM_PROMPT },
      ...tail.map((m): ChatMessage => ({ role: m.role, content: m.content })),
      { role: 'user', content: kcImportUserPrompt(userMessage, existingTitles) },
    ],
    omittedTurns,
  };
}

/**
 * 解析结果 → 可直接入库的卡片。
 *
 * 用 `createEmptyCard` 起步再覆盖字段，而**不是**自己 `Date.now()` 拼一个对象：
 * 那个工厂里走的是单调时钟（见 `core/kcClock.ts`），
 * 自己拼会让「设备时钟倒退时新卡片永远推不上云」这个坑重新长出来。
 *
 * @param parsed 解析出来的卡片
 * @param estMinutes 兜底耗时
 */
export function toKnowledgeCards(parsed: ParsedKcCard[], estMinutes: number): KnowledgeCard[] {
  return parsed.map((p) => {
    const card = createEmptyCard(p.title, estMinutes);
    return {
      ...card,
      summary: p.summary,
      // 一个块都没有时保留工厂给的骨架（卡片的硬性不变量：至少一个块）
      blocks: p.blocks.length > 0 ? p.blocks : card.blocks,
      examTags: p.examTags,
      examLoad: {
        types: p.examLoad.types.length > 0 ? p.examLoad.types : p.examTags,
        estMinutes: p.examLoad.estMinutes,
      },
      source: p.source,
      // 刚录入的知识点还没学过：attrs 保持工厂初值（mastery 0、状态 unlearned），
      // 这是阶段 04 学习流程的入口条件
    };
  });
}

/**
 * 把用户的一句「我这块不行」交给 AI，拆成若干张结构化知识点卡片。
 *
 * **失败不抛异常**：返回带 `error` 的结果，由界面显示「重试 / 手动录入」。
 * （`chatComplete` 自己会抛，那是它的约定；这里把它转成结果对象，
 *   因为调用方是界面，不该处理异常流。）
 *
 * @param userMessage 用户原话
 * @param existingTitles 已有知识点标题（避免重复生成同一张卡）
 * @param cfg AI 接口配置（来自 `aiConfigFromSettings`，密钥只在本机）
 * @param history 以往的对话（可选；界面从聊天面板里取，见 `KcChatPanel.history()`）。
 *                放在**本轮 user 消息之前**，system 仍在最前，所以模型能看懂
 *                「第二个再细一点」指的是上一轮哪张卡。传空数组 = 老的无记忆行为。
 */
export async function analyzeWeakPoint(
  userMessage: string,
  existingTitles: string[],
  cfg: AiConfig,
  history: ChatTurn[] = [],
): Promise<ImportResult> {
  const message = userMessage.trim();
  if (message === '') {
    return { cards: [], droppedCards: 0, droppedBlocks: 0, raw: '', error: '请输入你想整理的内容' };
  }

  const { messages, omittedTurns } = buildKcMessages(message, existingTitles, history);
  let raw = '';
  try {
    raw = await chatComplete(cfg, messages, {
      // jsonMode：让服务端约束成 JSON 对象；不支持时 chatComplete 会自动降级重试一次
      jsonMode: true,
      timeoutMs: KC_IMPORT_TIMEOUT_MS,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.warn('[kcAi] 录入解析调用失败', err);
    return { cards: [], droppedCards: 0, droppedBlocks: 0, raw, error: detail, omittedTurns };
  }

  const parsed = parseImportReply(raw, message);
  if (parsed.error !== undefined) {
    return { ...parsed, raw, omittedTurns, error: `${parsed.error}（可点「重试」，或改用「手动新建」）` };
  }
  return { ...parsed, raw, omittedTurns };
}

/**
 * 从设置里取 AI 配置（便捷入口，与一期 `aiConfigFromSettings` 同一份实现）。
 * @param settings 设置
 */
export function kcAiConfig(settings: Settings): AiConfig {
  return aiConfigFromSettings(settings);
}
