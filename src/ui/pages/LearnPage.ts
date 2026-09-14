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
 * 右下角「再背一个」逐个上纸，每 memorizeEvery 个新词按钮自动变成「记忆」。
 *
 * ★ 用户要求（2026-09）：「保存并退出」要**连同单词位置、背诵进度、
 *   每个单词进行了多少遍记忆**一起保留，**下次点「背诵」直接开始**。
 *   所以本页启动时**总是**先看有没有未完成的会话，有就直接续跑——
 *   不看 `?resume=1`、也不弹「继续上次 / 重新开始」的询问框（那个框已从首页删掉）。
 *   代价是「重开一轮」需要一个显式入口：背诵页右下角的「重新开始」（带二次确认）。
 *
 * @param ctx 路由上下文（保留形参：`?resume=1` 仍然兼容，但现在不带也会续跑）
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
    await syncSettings();

    // ★ 用户要求「下次点击直接开始」：**不需要 ?resume=1，也不弹任何询问框**。
    //   只要库里有未完成的背诵会话，就把它的词单 / 每个词在白纸上的位置 /
    //   每词已记忆的遍数原样恢复，直接接着背。
    //
    //   原来只有带 `?resume=1`（由首页弹「继续上次 / 重新开始」时补上）才续跑，
    //   从顶栏「背诵」直接进来会走 startNew()，把保存的进度**悄悄丢掉**——
    //   表现就是「明明点了保存并退出，下次进来还是从头开始」。
    //   想主动重开一轮用背诵页上的「重新开始」（会先确认）。
    const existing = await dao.session.loadSession();
    if (existing && !existing.finished && existing.type === 'learn' && existing.wordIds.length > 0) {
      const words = await dao.words.getAll();
      const alive = existing.wordIds.filter((id) => words.some((w) => w.id === id && w.status !== 'chopped'));
      if (alive.length > 0) {
        existing.wordIds = alive;
        await dao.session.saveSession(existing);
        mountFlow(existing);
        return;
      }
      // 词单里的词全没了（被斩 / 被删）→ 旧会话没有意义了，清掉重开
      await dao.session.clearSession();
    }
    await startNew();
  })();

  return page;
}
