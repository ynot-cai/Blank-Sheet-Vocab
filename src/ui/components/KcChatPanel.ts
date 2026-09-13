/**
 * 录入聊天面板：**会话状态 + 渲染**（录入页把输入框与底部栏接上来）。
 *
 * 为什么从 `KcImportPage` 里拆出来：
 * 1. 单文件 ≤ 300 行的硬约束（原来一页 490 行）；
 * 2. 「对话状态机」（消息、卡片采纳状态、用户编辑覆盖、忙碌/取消）是一个独立的东西，
 *    和「页面布局 + 路由 + 导航」没有关系，分开以后各自都好读。
 *
 * 它对外只暴露三件事：`root`（DOM）、`paint()`（重画）、以及一组回调
 * （`onSubmit` 让页面去发请求、`onAdoptedChange` 让页面更新底部栏）。
 * **这个组件自己不发 AI 请求**，请求由页面发起后调 `applyResult()` 回填 ——
 * 这样「什么时候调 AI」这个决定留在页面层，组件只负责状态与显示。
 */
import type { ParsedKcCard } from '../../core/kcTypes';
import type { ChatTurn, ImportResult } from '../../services/kcAi';
import { h } from '../dom';
import { entriesToHistory } from './kcChatHistory';
import { openKcMetaEditor } from './KcMetaEditor';
import { renderKcPreviewCard, type KcPreviewState } from './KcCardPreview';

/** 一条消息（用户 / AI） */
export interface ChatEntry {
  id: string;
  role: 'user' | 'ai';
  text: string;
  /** AI 消息才有：解析出的卡片 */
  cards?: ParsedKcCard[];
  /** AI 消息才有：错误说明（有它就显示「重试」） */
  error?: string;
  /** AI 消息才有：AI 原始返回（排查用） */
  raw?: string;
  /** 发起这条 AI 消息时的用户原话（重试用） */
  request?: string;
  /** 发起这条 AI 消息时被丢掉的历史轮数（>0 时显示一行灰字提示） */
  omitted?: number;
  loading?: boolean;
}

/** 面板回调 */
export interface KcChatHandlers {
  /** 用户发了一条消息（页面据此调 AI；成功后用 `applyResult` 回填） */
  onSubmit: (text: string) => void;
  /** 已采纳数量变化（页面刷新底部操作栏） */
  onAdoptedChange: (count: number) => void;
  /** 点「取消」 */
  onCancel?: () => void;
  /** 点空状态里的「手动新建空白卡片」 */
  onCreateBlank: () => void;
}

/** 面板对外接口 */
export interface KcChatPanel {
  /** 面板根元素 */
  root: HTMLElement;
  /** 重画 */
  paint: () => void;
  /** 标记「正在请求」（页面据此禁用发送按钮、显示取消） */
  setBusy: (busy: boolean) => void;
  /** 正在请求 */
  isBusy: () => boolean;
  /**
   * 记一条「用户发了话 + AI 正在整理」的开场。
   * @param text 用户原话
   * @param omitted 这次请求因为超上限被丢掉的历史轮数（0 = 没丢）
   */
  beginExchange: (text: string, omitted?: number) => void;
  /** 把 AI 结果回填到最后一条占位消息上（没有再补一条） */
  applyResult: (result: ImportResult) => void;
  /** 请求被取消：把那条占位消息摘掉 */
  dropPending: () => void;
  /** 当前已采纳的卡片（顺序即消息顺序） */
  adoptedCards: () => ParsedKcCard[];
  /** 把全部卡片标回「待处理」（入库成功后调） */
  resetAdopted: () => void;
  /** 最近一条用户消息（重试用） */
  lastUserText: () => string;
  /**
   * 到目前为止的对话历史（按时间顺序，**最旧在前**），交给页面作为下一轮请求的上下文。
   *
   * 为什么放在这里而不是页面自己记一份：会话状态（`entries` / `cardEdits`）本来
   * 就只在这个组件里，页面再记一份就会出现「两边的对话不一致」这种极难查的错。
   */
  history: () => ChatTurn[];
}

/** 生成一个会话内 id */
function makeId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 建一个聊天面板。
 * @param handlers 回调
 */
export function createKcChatPanel(handlers: KcChatHandlers): KcChatPanel {
  /** 会话内的消息（**不落库**，刷新即清 —— 阶段 02 的明确要求） */
  const entries: ChatEntry[] = [];
  /** 卡片状态：'消息id:下标' → 待处理/已采纳/已丢弃 */
  const cardStates = new Map<string, KcPreviewState>();
  /** 用户改过的卡片（覆盖 AI 原稿） */
  const cardEdits = new Map<string, ParsedKcCard>();
  let busy = false;

  const root = h('div', { class: 'kc-chat' });
  const keyOf = (entryId: string, index: number): string => `${entryId}:${index}`;

  /** 取某张卡的当前内容（用户编辑过的优先） */
  const cardAt = (entry: ChatEntry, index: number): ParsedKcCard | null => {
    const edited = cardEdits.get(keyOf(entry.id, index));
    if (edited !== undefined) return edited;
    return entry.cards?.[index] ?? null;
  };

  /** 已采纳的卡片（按消息顺序） */
  const adoptedCards = (): ParsedKcCard[] => {
    const out: ParsedKcCard[] = [];
    for (const entry of entries) {
      if (entry.role !== 'ai' || entry.cards === undefined) continue;
      entry.cards.forEach((_c, index) => {
        if (cardStates.get(keyOf(entry.id, index)) !== 'adopted') return;
        const card = cardAt(entry, index);
        if (card !== null) out.push(card);
      });
    }
    return out;
  };

  /** 通知外部「采纳数变了」 */
  const notifyAdopted = (): void => handlers.onAdoptedChange(adoptedCards().length);

  /** 渲染一条 AI 消息里的卡片列表 */
  function renderCards(entry: ChatEntry): HTMLElement {
    const box = h('div', { class: 'kc-chat-cards' });
    const cards = entry.cards ?? [];
    if (cards.length === 0) {
      if (entry.error === undefined) {
        box.appendChild(h('p', { class: 'kc-chat-note', text: 'AI 认为这些内容都已有卡片了（没有生成新的知识点）。' }));
      }
      return box;
    }
    cards.forEach((_c, index) => {
      const data = cardAt(entry, index);
      if (data === null) return;
      const state = cardStates.get(keyOf(entry.id, index)) ?? 'pending';
      box.appendChild(
        renderKcPreviewCard(
          data,
          state,
          {
            onAdopt: () => {
              cardStates.set(keyOf(entry.id, index), state === 'adopted' ? 'pending' : 'adopted');
              paint();
            },
            onDiscard: () => {
              cardStates.set(keyOf(entry.id, index), 'discarded');
              paint();
            },
            onEdit: () => {
              openKcMetaEditor(data, (next) => {
                cardEdits.set(keyOf(entry.id, index), next);
                paint();
              });
            },
          },
          // 只有一张卡时默认展开（省一次点击）；多张时默认收起，避免刷屏
          { startOpen: cards.length === 1 },
        ),
      );
    });
    return box;
  }

  /** 空状态提示（同时当使用说明） */
  function renderEmptyHint(): HTMLElement {
    const box = h('div', { class: 'kc-empty' });
    box.appendChild(h('p', { class: 'kc-empty-title', text: '说说你哪里不行，AI 帮你拆成知识点卡片' }));
    box.appendChild(
      h('ul', { class: 'kc-empty-list' }, [
        h('li', { text: '「我在定语从句这块不行」' }),
        h('li', { text: '「虚拟语气 always 搞混，尤其是 should 省略」' }),
        h('li', { text: '「非谓语动词 doing 和 done 分不清」' }),
      ]),
    );
    box.appendChild(
      h('p', {
        class: 'kc-empty-note',
        // 说清「会长什么样」：用户如果以为 AI 会吐一篇讲义，看到极简卡片会以为漏了内容
        text: 'AI 会把它拆成 2~5 个独立知识点，每张卡 2~4 个块、只留记忆痛点（如「有 the 时…，无 the 时…」），例句最多 1~2 个。可以连着聊，AI 记得前面说过什么。',
      }),
    );
    box.appendChild(h('button', {
      class: 'btn btn-ghost',
      type: 'button',
      text: '或：手动新建一张空白卡片',
      onclick: () => handlers.onCreateBlank(),
    }));
    return box;
  }

  /** 重画整个对话区（并滚到底部） */
  function paint(): void {
    root.replaceChildren();
    if (entries.length === 0) root.appendChild(renderEmptyHint());
    for (const entry of entries) {
      const bubble = h('div', { class: `kc-bubble kc-bubble--${entry.role}` });
      bubble.appendChild(h('div', { class: 'kc-bubble-text', text: entry.text }));
      if (entry.omitted !== undefined && entry.omitted > 0) {
        bubble.appendChild(
          h('p', {
            class: 'kc-history-note',
            text: `已省略较早的 ${entry.omitted} 条对话（只把最近的对话带给 AI）`,
          }),
        );
      }
      if (entry.loading === true) bubble.appendChild(h('span', { class: 'kc-typing', text: '· · ·' }));
      if (entry.error !== undefined) {
        bubble.appendChild(h('p', { class: 'kc-bubble-error', text: `出错了：${entry.error}` }));
        bubble.appendChild(
          h('div', { class: 'kc-bubble-actions' }, h('button', {
            class: 'btn btn-primary',
            type: 'button',
            text: '重试',
            onclick: () => {
              if (entry.request !== undefined) handlers.onSubmit(entry.request);
            },
          })),
        );
      }
      if (entry.cards !== undefined) bubble.appendChild(renderCards(entry));
      if (entry.raw !== undefined && entry.raw !== '') {
        const raw = h('details', { class: 'kc-raw' });
        raw.appendChild(h('summary', { text: '查看 AI 原始返回' }));
        raw.appendChild(h('pre', { class: 'kc-pre', text: entry.raw }));
        bubble.appendChild(raw);
      }
      root.appendChild(bubble);
    }
    root.scrollTop = root.scrollHeight;
    notifyAdopted();
  }

  /**
   * 对话历史（给下一轮请求当上下文）。
   *
   * 组装规则与两条易错点写在 `kcChatHistory.ts`（纯函数，好单测）。
   */
  const history = (): ChatTurn[] => entriesToHistory(entries);

  return {
    root,
    paint,
    adoptedCards,
    history,
    isBusy: () => busy,

    setBusy(next: boolean): void {
      busy = next;
    },

    lastUserText(): string {
      for (let i = entries.length - 1; i >= 0; i -= 1) {
        const e = entries[i];
        if (e !== undefined && e.role === 'user') return e.text;
      }
      return '';
    },

    beginExchange(text: string, omitted = 0): void {
      entries.push({ id: makeId(), role: 'user', text });
      entries.push({ id: makeId(), role: 'ai', text: '正在整理…', loading: true, request: text, omitted });
      paint();
    },

    applyResult(result: ImportResult): void {
      const pendingIndex = entries.findIndex((e) => e.loading === true);
      // 占位消息一定存在（beginExchange 刚压进去）；找不到就补一条，避免结果丢掉
      const aiEntry: ChatEntry = pendingIndex >= 0 ? (entries[pendingIndex] as ChatEntry) : { id: makeId(), role: 'ai', text: '' };
      aiEntry.loading = false;
      aiEntry.raw = result.raw;
      // 截断情况以**服务端实际算出来的**为准（重试时历史可能又长了一截）
      if (result.omittedTurns !== undefined) aiEntry.omitted = result.omittedTurns;
      if (result.error !== undefined) {
        aiEntry.text = '没能整理出来。';
        aiEntry.error = result.error;
      } else {
        aiEntry.cards = result.cards;
        const extra = result.droppedBlocks > 0 ? `（丢弃了 ${result.droppedBlocks} 个不合规的块）` : '';
        aiEntry.text =
          result.cards.length === 0
            ? '没有生成新卡片。'
            : `我帮你拆成了 ${result.cards.length} 个知识点${extra}。逐张看看，合适的点「采纳」。`;
      }
      if (pendingIndex < 0) entries.push(aiEntry);
      paint();
    },

    dropPending(): void {
      const i = entries.findIndex((e) => e.loading === true);
      if (i >= 0) entries.splice(i, 1);
      paint();
    },

    resetAdopted(): void {
      for (const k of [...cardStates.keys()]) cardStates.set(k, 'pending');
      paint();
    },
  };
}
