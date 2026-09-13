/**
 * 聊天式录入（`#/kc/import`）—— 阶段 02 的主界面。
 *
 * 这一页只做四件事（会话状态与渲染都在 `components/KcChatPanel` 里）：
 * 1. **布局**：标题 + 对话区 + 待入库栏 + 输入框；
 * 2. **发起请求**：调 `analyzeWeakPoint`（AI 密钥只在本机，见 `services/kcAi`）；
 * 3. **入库**：把已采纳的卡片一次性 `bulkUpsert`；
 * 4. **兜底**：手动新建空白卡片（跳过 AI）。
 *
 * ══════════════════════════════════════════════════════════════
 * 两个需要知道的设计决定
 * ══════════════════════════════════════════════════════════════
 * 1. **「采纳」不立刻落库**，而是进「待入库区」，点「确认入库（N 张）」才写库。
 *    理由：采纳即落库会让「丢弃」形同虚设，且中途离开会留下一堆半成品。
 *    （这一点与阶段提示词原文略有出入，验收单里已标注。）
 * 2. **已有标题要滤掉墓碑**：`dao.kc.getAll()` 含已斩的卡片，
 *    把墓碑标题喂给 AI 会让它误判「这个知识点已经有了」，所以先滤 `deleted !== 1`。
 */
import { createEmptyCard, validateCard } from '../../core/kcModel';
import type { KnowledgeCard } from '../../core/kcTypes';
import { EXAM_TYPES as KC_EXAM_TYPES } from '../../core/kcTypes';
import * as dao from '../../dao';
import { aiConfigFromSettings } from '../../services/ai';
import {
  analyzeWeakPoint,
  buildKcMessages,
  KC_IMPORT_TIMEOUT_MS,
  toKnowledgeCards,
  type ImportResult,
} from '../../services/kcAi';
import { createKcChatPanel, type KcChatPanel } from '../components/KcChatPanel';
import { openModal } from '../components/Modal';
import { toastError, toastOk, toastWarn } from '../components/Toast';
import { button, h, textInput } from '../dom';
import { navigate, registerCleanup } from '../router';

/**
 * 渲染聊天式录入页。
 */
export function renderKcImportPage(): HTMLElement {
  const page = h('div', { class: 'page kc-import' });
  /** 「取消」标记：请求回来时丢掉结果 */
  let cancelled = false;
  /** 底部待入库栏（采纳数变化时重画） */
  const barBox = h('div', { class: 'kc-import-bar' });

  const input = textInput('', () => undefined, {
    placeholder: '说说你哪里不行，例如：我在定语从句这块不行',
    class: 'kc-chat-input',
  }) as HTMLInputElement;

  const sendBtn = button('发送', () => void send(), { variant: 'primary' });
  const cancelBtn = button('取消', () => {
    cancelled = true;
    toastWarn('已取消本次请求');
  });
  cancelBtn.hidden = true;

  /** 聊天面板（状态 + 渲染） */
  const panel: KcChatPanel = createKcChatPanel({
    onSubmit: (text) => void send(text),
    onAdoptedChange: (count) => paintBar(count),
    onCreateBlank: () => void createBlank(),
  });

  /**
   * 重画底部操作栏。
   * @param count 已采纳数量（面板传来的，避免重复计算）
   */
  function paintBar(count: number): void {
    barBox.replaceChildren();
    barBox.appendChild(
      h('span', { class: 'kc-import-count', text: count > 0 ? `已采纳 ${count} 张` : '还没有采纳任何卡片' }),
    );
    const clearBtn = button('清空', () => {
      panel.resetAdopted();
    });
    clearBtn.disabled = count === 0;
    barBox.appendChild(clearBtn);

    const commitBtn = button(`确认入库（${count} 张）`, () => void commit(), { variant: 'primary' });
    commitBtn.disabled = count === 0;
    barBox.appendChild(commitBtn);
  }

  /**
   * 发一条消息并请求 AI。
   * @param preset 「重试」传上次的原话；不传则读输入框
   */
  async function send(preset?: string): Promise<void> {
    if (panel.isBusy()) {
      toastWarn('正在整理中，请稍等');
      return;
    }
    const text = (preset ?? input.value).trim();
    if (text === '') {
      toastWarn('先说点什么吧');
      return;
    }
    if (preset === undefined) input.value = '';
    cancelled = false;
    panel.setBusy(true);
    sendBtn.disabled = true;
    cancelBtn.hidden = false;
    // ★ 上下文记忆：**必须在 beginExchange 之前取**
    //   （它压进去的占位消息是 loading 态，不算历史；取早了也拿不到"这一轮"的东西）
    const history = panel.history();
    const pending = buildKcMessages(text, [], history);
    panel.beginExchange(text, pending.omittedTurns);

    // 已有标题：**滤掉墓碑**（否则已斩卡片会让 AI 以为「这个已经有了」）
    const existing = (await dao.kc.getAll()).filter((c) => c.deleted !== 1).map((c) => c.title);
    const settings = await dao.settings.get();

    let result: ImportResult;
    try {
      result = await analyzeWeakPoint(text, existing, aiConfigFromSettings(settings), history);
    } catch (err) {
      // analyzeWeakPoint 自己已经吞了异常，这里只是最后兜底
      result = {
        cards: [],
        droppedCards: 0,
        droppedBlocks: 0,
        raw: '',
        error: err instanceof Error ? err.message : String(err),
      };
    }

    panel.setBusy(false);
    sendBtn.disabled = false;
    cancelBtn.hidden = true;
    if (cancelled) {
      panel.dropPending();
      return;
    }
    panel.applyResult(result);
  }

  /** 手动新建一张空白卡片（跳过 AI）：直接入库，然后回首页 */
  async function createBlank(): Promise<void> {
    const card = createEmptyCard('未命名知识点');
    const errors = validateCard(card);
    if (errors.length > 0) {
      toastError(`内部错误：空白卡片不合法（${errors.join('；')}）`);
      return;
    }
    await dao.kc.bulkUpsert([card]);
    toastOk('已新建一张空白卡片');
    navigate('/kc');
  }

  /** 确认入库：把已采纳的卡片一次性写库 */
  async function commit(): Promise<void> {
    const adopted = panel.adoptedCards();
    if (adopted.length === 0) {
      toastWarn('还没有采纳任何卡片');
      return;
    }
    const settings = await dao.settings.get();
    const cards: KnowledgeCard[] = toKnowledgeCards(adopted, settings.kc.examLoadDefaultMinutes);
    try {
      const res = await dao.kc.bulkUpsert(cards);
      toastOk(`已入库 ${res.inserted + res.updated} 张卡片`);
    } catch (err) {
      console.error('[KcImportPage] 入库失败', err);
      toastError('入库失败，可以重试');
      return;
    }
    // 入库后把状态清回「待处理」（保留对话，方便继续录入）
    panel.resetAdopted();

    openModal({
      title: '入库完成',
      width: '420px',
      body: h('p', { class: 'modal-text', text: `已入库 ${cards.length} 张知识点卡片。接下来做什么？` }),
      actions: [
        { text: '继续录入', variant: 'primary', onClick: (close) => close() },
        { text: '回二期首页', variant: 'ghost', onClick: (close) => { close(); navigate('/kc'); } },
      ],
    });
  }

  // Enter 发送（单行输入框，不需要 Shift+Enter 换行）
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      void send();
    }
  });

  page.appendChild(
    h(
      'header',
      { class: 'kc-import-head' },
      h('h1', { class: 'kc-import-title', text: '录入知识点' }),
      h('p', {
        class: 'kc-import-sub',
        text: `用大白话说你哪里不行，AI 拆成结构化卡片；先采纳，再一次性入库。可用考法：${KC_EXAM_TYPES.map((t) => t.name).join(' / ')}`,
      }),
    ),
  );
  page.appendChild(panel.root);
  page.appendChild(barBox);
  cancelBtn.hidden = true;
  page.appendChild(h('div', { class: 'kc-composer' }, input, h('div', { class: 'kc-composer-btns' }, cancelBtn, sendBtn)));
  page.appendChild(
    h('p', {
      class: 'kc-import-hint',
      text: `AI 超时上限 ${Math.round(KC_IMPORT_TIMEOUT_MS / 1000)} 秒；密钥只存在这台设备的浏览器里，不上传服务器。`,
    }),
  );

  registerCleanup(page, () => {
    // 离开页面时把在途请求标记成已取消（结果回来会被丢掉，不写进已经卸载的 DOM）
    cancelled = true;
  });
  paintBar(0);
  panel.paint();
  return page;
}
