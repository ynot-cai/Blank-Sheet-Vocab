import { uid } from '../../core/model';
import { setSettingsCache } from '../../core/config';
import { groupWords, pickForReview, recommendReviewCount } from '../../core/pick';
import type { Session } from '../../core/types';
import * as dao from '../../dao';
import { button, h, numberInput } from '../dom';
import { openModal } from '../components/Modal';
import { toastOk, toastWarn } from '../components/Toast';
import { navigate, registerCleanup, type RouteContext } from '../router';
import { exitMidway, finishReview } from './paper/finish';
import { createPaperFlow } from './paper/flow';
import { currentSettings } from './settings/ctx';

/**
 * 复习页（阶段 07）：推荐值 → 按优先度抽词 → 分组（每组上限 reviewGroupSize），
 * 每一组完整复用「背诵 + 记忆 + 拼写」流程（通过 session.type='review' 与 groupId 区分，不复制一套）。
 * @param ctx 路由上下文（resume=1 时从上次的组继续）
 */
export function renderReviewPage(ctx?: RouteContext): HTMLElement {
  const page = h('div', { class: 'page review-page' });

  let session: Session | null = null;
  let groups: string[][] = [];
  let groupIndex = 0;
  let currentFlow: { destroy(): void } | null = null;

  /** 挂载当前组（旧组的白纸流程必须先销毁，否则全局 Enter 监听会叠加） */
  const mountGroup = (): void => {
    if (!session) return;
    if (currentFlow) currentFlow.destroy();
    currentFlow = null;
    session.groupId = groupIndex;
    void dao.session.saveSession(session);
    const flow = createPaperFlow({
      session,
      mode: 'review',
      groupIndex,
      groupCount: groups.length,
      onWordChopped: (id) => {
        // 斩掉的词从当前组与后续组移除（组内数量相应减少）
        if (!session) return;
        session.wordIds = session.wordIds.filter((x) => x !== id);
        for (const group of groups) {
          const at = group.indexOf(id);
          if (at >= 0) group.splice(at, 1);
        }
      },
      onGroupDone: () => groupDone(),
    });
    currentFlow = flow;
    page.replaceChildren(flow.root);
    registerCleanup(page, () => flow.destroy());
  };

  /** 一组记忆+拼写走完后的弹窗 */
  const groupDone = (): void => {
    if (!session) return;
    const isLast = groupIndex >= groups.length - 1;
    openModal({
      title: isLast ? '全部组完成！' : `第 ${groupIndex + 1} 组完成`,
      body: isLast ? '所有组都走完了。标记完成并写回复习数据？' : `当前进度 ${groupIndex + 1}/${groups.length} 组。继续下一组，还是休息一下？`,
      actions: isLast
        ? [
            {
              text: '标记完成',
              variant: 'primary',
              onClick: (close) => {
                close();
                void completeAll();
              },
            },
            { text: '再休息一下', variant: 'ghost', onClick: (close) => closeAndRest(close) },
          ]
        : [
            {
              text: '继续下一组',
              variant: 'primary',
              onClick: (close) => {
                close();
                groupIndex += 1;
                if (session) session.placements = {}; // 新组重新布点（续跑才用保存的位置）
                mountGroup();
              },
            },
            { text: '休息一下', variant: 'ghost', onClick: (close) => closeAndRest(close) },
          ],
    });
  };

  const closeAndRest = (close: () => void): void => {
    close();
    void rest();
  };

  /** 休息：保存进度（词单 + 组号 + 位置 + 记忆次数）回首页 */
  const rest = async (): Promise<void> => {
    if (!session) return;
    await exitMidway(session);
    toastOk(`已保存进度，下次从第 ${groupIndex + 1} 组继续`);
    navigate('/home');
  };

  /** 全部组完成：写回复习属性并清会话 */
  const completeAll = async (): Promise<void> => {
    if (!session) return;
    const n = await finishReview(session, currentSettings());
    toastOk(`复习完成，已更新 ${n} 个词的复习记录`);
    navigate('/home');
  };

  /** 用已有会话续跑（从保存的组号开始） */
  const resume = async (existing: Session): Promise<void> => {
    setSettingsCache(await dao.settings.get()); // 同步设置缓存
    const settings = currentSettings();
    groups = groupWords(existing.wordIds, settings.reviewGroupSize);
    groupIndex = Math.min(existing.groupId, Math.max(0, groups.length - 1));
    session = { ...existing, groups };
    mountGroup();
  };

  /** 新复习：对话框 → 抽词 → 分组 → 第一组 */
  const startNew = async (): Promise<void> => {
    setSettingsCache(await dao.settings.get()); // 同步设置缓存
    const all = await dao.words.getAll();
    const settings = currentSettings();
    const rec = recommendReviewCount(all, settings);

    if (rec.count === 0) {
      page.replaceChildren(
        h('p', { class: 'note warn' }, '还没有已背的单词，先去背一轮吧'),
        button('去背诵', () => navigate('/learn'), { variant: 'primary' }),
      );
      return;
    }

    let input: HTMLInputElement;
    const recLine = h('p', {
      class: 'note',
      text: `按当前优先度，建议复习 ${rec.count} 个（优先度 ≥ ${rec.threshold.toFixed(2)} 的词共 ${rec.count} 个）`,
    });
    const useRec = button('用推荐值', () => {
      input.value = String(rec.count);
    });
    input = numberInput(rec.count, () => undefined, { min: 1, max: 999 });

    openModal({
      title: '开始复习',
      body: h(
        'div',
        { class: 'stack' },
        h('label', { class: 'field' }, h('span', { class: 'field-label', text: '本次复习多少个词？' }), input),
        h('div', { class: 'row' }, recLine, useRec),
      ),
      actions: [
        { text: '取消', variant: 'ghost', onClick: (close) => close() },
        {
          text: '开始',
          variant: 'primary',
          onClick: (close) => {
            void (async () => {
              const n = Math.max(1, Math.floor(Number(input.value) || rec.count));
              const ids = pickForReview(all, n, settings);
              if (ids.length === 0) {
                toastWarn('没有可复习的词');
                return;
              }
              if (ids.length < n) toastWarn(`可复习的词只有 ${ids.length} 个`);
              groups = groupWords(ids, settings.reviewGroupSize);
              const now = Date.now();
              session = {
                id: uid(),
                type: 'review',
                wordIds: [...ids],
                placements: {},
                shownIds: [],
                memorizeCount: {},
                spellEnabled: false,
                failedIds: [],
                failDeltas: {},
                groupId: 0,
                groups,
                finished: false,
                createdAt: now,
              };
              await dao.session.saveSession(session);
              groupIndex = 0;
              close();
              mountGroup();
            })();
          },
        },
      ],
    });
  };

  void (async () => {
    if (ctx?.query.get('resume') === '1') {
      const existing = await dao.session.loadSession();
      if (existing && !existing.finished && existing.type === 'review' && existing.wordIds.length > 0) {
        await resume(existing);
        return;
      }
    }
    await startNew();
  })();

  return page;
}
