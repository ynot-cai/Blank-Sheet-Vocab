import { uid } from '../../core/model';
import { DEFAULT_SETTINGS, getSettings, setSettingsCache } from '../../core/config';
import { sortForLearn } from '../../core/pick';
import type { Session, Word } from '../../core/types';
import * as dao from '../../dao';
import { h } from '../dom';
import { toastWarn } from '../components/Toast';
import { navigate, registerCleanup, type RouteContext } from '../router';
import { createPaperFlow } from './paper/flow';

/**
 * 背诵白纸页（阶段 05，新版交互）：
 * 不再弹「背多少个词」对话框——直接把全部未背词放进本轮词单（不设数量上限），
 * 右下角「再背一个」逐个上纸，每 memorizeEvery 个新词按钮自动变成「记忆」；
 * 「保存并退出」会把词单、每个词的位置和记忆次数存下来，续跑时原样恢复。
 * @param ctx 路由上下文（resume=1 时用上次保存的进度继续）
 */
export function renderLearnPage(ctx?: RouteContext): HTMLElement {
  const page = h('div', { class: 'page learn-page' });

  /** 挂载前把设置缓存与数据库同步（防止缓存是旧值，白纸流程读到过期参数） */
  const syncSettings = async (): Promise<void> => {
    setSettingsCache(await dao.settings.get());
  };

  /** 挂载白纸流程 */
  const mountFlow = (session: Session): void => {
    const flow = createPaperFlow({ session, mode: 'learn', groupIndex: 0, groupCount: 1 });
    page.replaceChildren(flow.root);
    registerCleanup(page, () => flow.destroy());
  };

  /**
   * 取词：未背且未斩。
   * 不设数量上限：点一次「再背一个」就多上一个词，由用户自己决定何时停下。
   *
   * ★ R3：排序规则改为**优先级绝对优先**（`core/pick.ts` 的 `sortForLearn`）：
   *   先按 `word.priority` 降序（5 → 1），同级内再按设置决定的顺序（默认 createdAt）。
   *   这和「再背一个」用的 `pickNextForLearn` 是**同一个排序函数**，
   *   所以「词单顺序」和「逐个上纸的顺序」永远一致——
   *   两处各写一份的话，用户会看到「我点的顺序和它给的不一样」，很难查。
   *
   * @param sessionId 本次会话 id（random 模式下当随机种子，保证同一会话顺序稳定）
   */
  const pickWords = async (sessionId: string): Promise<Word[]> => {
    const all = await dao.words.getAll();
    const candidates = all.filter((w) => w.status === 'unlearned' && w.deleted !== 1);
    return sortForLearn(candidates, getSettingsSafe().learnPick.samePriorityOrder, sessionId);
  };

  /** 读设置（缓存没准备好时退回默认值，避免整页崩掉） */
  const getSettingsSafe = (): ReturnType<typeof getSettings> => {
    try {
      return getSettings();
    } catch {
      return DEFAULT_SETTINGS;
    }
  };

  /** 开始新一轮（无对话框：直接取全部未背词） */
  const startNew = async (): Promise<void> => {
    await syncSettings();
    const sessionId = uid();
    const picked = await pickWords(sessionId);
    if (picked.length === 0) {
      toastWarn('没有可背的未背词，先去「录入」页加词吧');
      navigate('/import');
      return;
    }
    const now = Date.now();
    const session: Session = {
      id: sessionId,
      type: 'learn',
      wordIds: picked.map((w) => w.id),
      placements: {},
      shownIds: [],
      memorizeCount: {},
      spellEnabled: false,
      failedIds: [],
      failDeltas: {},
      groupId: 0,
      groups: [picked.map((w) => w.id)],
      finished: false,
      createdAt: now,
    };
    await dao.session.saveSession(session);
    mountFlow(session);
  };

  void (async () => {
    // resume=1：用上次保存的词单 + 位置 + 记忆次数继续
    if (ctx?.query.get('resume') === '1') {
      const existing = await dao.session.loadSession();
      if (existing && !existing.finished && existing.type === 'learn' && existing.wordIds.length > 0) {
        await syncSettings();
        const words = await dao.words.getAll();
        const alive = existing.wordIds.filter((id) => words.some((w) => w.id === id && w.status !== 'chopped'));
        existing.wordIds = alive;
        await dao.session.saveSession(existing);
        mountFlow(existing);
        return;
      }
    }
    await startNew();
  })();

  return page;
}
