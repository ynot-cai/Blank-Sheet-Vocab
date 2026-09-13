/**
 * 【桥接】复习间隙背 5 个单词 —— **一二期唯一的连接点**（阶段 06 §3）。
 *
 * 实现纪律（主提示词第 7 节）：
 * - **复用一期页面**（`createPaperFlow`），不复制一套背单词逻辑；
 * - **不修改一期的核心逻辑**，只是在外层调用；
 * - 词源：一期主词库，优先新词，没有新词就复习旧词（见 `kcReviewFlow.pickBridgeWords`）；
 * - 上限 5 个（`settings.kc.reviewWordLimit`）；
 * - 一期词库为空 → 跳过这一环节并提示。
 *
 * 会话隔离：桥接用的是**一期自己的 `sessions` 表**（`dao.session`），
 * 与二期的 `kcSessions` 完全分开，所以「二期复习到一半」不会被一期的会话覆盖。
 */
import { uid } from '../../core/model';
import type { Session, Word } from '../../core/types';
import * as dao from '../../dao';
import { h, button } from '../dom';
import { toastOk } from '../components/Toast';
import { createPaperFlow } from './paper/flow';
import { pickBridgeWords } from './kcReview/kcReviewFlow';

/** 桥接组件的回调 */
export interface KcWordBridgeHandlers {
  /** 背完（或用户点「结束」）→ 回到二期流程 */
  onDone: (info: { wordCount: number; skipped: boolean }) => void;
  /** 退出时清理（路由切走） */
  onCleanup?: () => void;
}

/** 桥接组件句柄 */
export interface KcWordBridge {
  root: HTMLElement;
  destroy: () => void;
}

/**
 * 建「背 5 个单词」桥接界面。
 *
 * @param limit 词数上限（默认取设置）
 * @param handlers 回调
 */
export async function createKcWordBridge(
  limit: number | undefined,
  handlers: KcWordBridgeHandlers,
): Promise<KcWordBridge> {
  const root = h('div', { class: 'kc-bridge' });
  const picked = await pickBridgeWords(limit);

  // ── 词库为空：跳过这一环节（用户明确要求要有提示） ──
  if (picked.source === 'none') {
    root.appendChild(
      h('div', { class: 'kc-bridge-empty' }, [
        h('p', { class: 'kc-empty-title', text: '一期词库为空，跳过背单词' }),
        h('p', { class: 'kc-hint-dim', text: '去一期的「录入」页加几个单词，下次复习就会带上这一步。' }),
        button('继续做题', () => handlers.onDone({ wordCount: 0, skipped: true }), { variant: 'primary' }),
      ]),
    );
    return { root, destroy: () => undefined };
  }

  // ── 正常：复用一期的白纸流程 ──
  const words: Word[] = picked.words;
  const session: Session = {
    id: uid(),
    type: 'review', // 一期已有的类型；桥接不新增 type（不改一期逻辑）
    wordIds: words.map((w) => w.id),
    placements: {},
    shownIds: [],
    memorizeCount: {},
    spellEnabled: false,
    failedIds: [],
    failDeltas: {},
    groupId: 0,
    groups: [words.map((w) => w.id)],
    finished: false,
    createdAt: Date.now(),
  };
  // 存进一期的会话表：万一用户中途关页面，一期自己的续跑机制也能用
  await dao.session.saveSession(session);

  // 顶部说明：让用户明白「为什么突然在背单词」（用户明确要求要显示来源提示）
  const banner = h('div', { class: 'kc-bridge-banner' });
  banner.appendChild(h('span', { class: 'kc-bridge-tag', text: '复习间隙 · 背 5 个单词' }));
  banner.appendChild(
    h('span', {
      class: 'kc-hint-dim',
      text:
        picked.source === 'new'
          ? `词来自一期词库的**新词**，共 ${words.length} 个（上限 ${limit ?? 5}）。`
          : `一期没有新词了，所以复习**旧词**，共 ${words.length} 个（上限 ${limit ?? 5}）。`,
    }),
  );
  banner.appendChild(
    button('跳过这一步', () => handlers.onDone({ wordCount: 0, skipped: true }), {
      variant: 'ghost',
      class: 'kc-bridge-skip',
    }),
  );
  root.appendChild(banner);

  // 白纸流程（一期原样复用）
  const host = h('div', { class: 'kc-bridge-flow' });
  root.appendChild(host);
  const flow = createPaperFlow({
    session,
    mode: 'review',
    groupIndex: 0,
    groupCount: 1,
    onGroupDone: () => {
      // 一期语义：这一组达标了（全部出现 + 每词记忆达标）
      toastOk('单词完成，继续做题');
      handlers.onDone({ wordCount: words.length, skipped: false });
    },
    onWordChopped: (id) => {
      session.wordIds = session.wordIds.filter((w) => w !== id);
    },
  });
  host.appendChild(flow.root);

  return {
    root,
    destroy: () => {
      try {
        flow.destroy();
      } catch (err) {
        console.warn('[kcWordBridge] 销毁一期白纸流程出错', err);
      }
      handlers.onCleanup?.();
      // 桥接结束：清掉一期会话（避免一期「背诵」页误以为有未完成的复习）
      void dao.session.clearSession().catch(() => undefined);
    },
  };
}

/** 桥接的说明文案（没有词库时的提示用，导出便于测试断言） */
export const BRIDGE_SKIP_HINT = '一期词库为空，跳过背单词';
