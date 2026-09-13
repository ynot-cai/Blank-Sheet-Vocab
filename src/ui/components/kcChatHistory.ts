/**
 * 把聊天面板里的消息整理成**给 AI 的对话历史**。
 *
 * 为什么单独一个文件：`KcChatPanel` 已经到 300 行的硬上限边缘，
 * 而「消息 → 请求上下文」这段是**纯数据整理**（不碰 DOM、不发请求），
 * 拆出来之后既能让面板专注渲染，这一段也能直接被单测盯住。
 *
 * ⚠️ 两条容易改错的规则：
 * 1. **还没回来的那一轮不算历史**（`loading === true` 直接跳过）——
 *    把它带上去，模型会看到一条空的 assistant 消息，还可能把用户的同一句话
 *    当成说过两次。
 * 2. assistant 那侧优先用**上一轮的原始 JSON 返回**（`raw`）：只有它带着
 *    「第几张卡、分别讲了什么」的完整信息，模型才能听懂「第二个再细一点」。
 *    拿不到 raw（手动新建、老会话）才退化成 `cardsBrief()` 的精简文本。
 */
import { cardsBrief, type ChatTurn } from '../../services/kcAi';
import type { ParsedKcCard } from '../../core/kcTypes';

/**
 * 组装历史时**真正用得到**的字段。
 *
 * 故意用结构化类型而不是 import `ChatEntry`：这样这个模块不依赖面板，
 * 面板也不必为了它导出内部结构（少一处循环引用）。
 */
export interface HistorySourceEntry {
  role: 'user' | 'ai';
  text: string;
  /** 还在请求中的占位消息（不算历史） */
  loading?: boolean;
  /** AI 原始返回 */
  raw?: string;
  /** 解析出的卡片 */
  cards?: ParsedKcCard[];
}

/**
 * 消息列表 → 对话历史（按时间顺序，**最旧在前**）。
 *
 * @param entries 面板里的消息（顺序即时间顺序）
 * @param brief 卡片压缩函数（默认 `cardsBrief`；参数化只为便于单测）
 */
export function entriesToHistory(
  entries: HistorySourceEntry[],
  brief: (cards: ParsedKcCard[]) => string = cardsBrief,
): ChatTurn[] {
  const out: ChatTurn[] = [];
  for (const entry of entries) {
    if (entry.loading === true) continue;
    if (entry.role === 'user') {
      if (entry.text.trim() !== '') out.push({ role: 'user', content: entry.text });
      continue;
    }
    const raw = (entry.raw ?? '').trim();
    if (raw !== '') out.push({ role: 'assistant', content: raw });
    else if (entry.cards !== undefined && entry.cards.length > 0) {
      out.push({ role: 'assistant', content: brief(entry.cards) });
    }
  }
  return out;
}
