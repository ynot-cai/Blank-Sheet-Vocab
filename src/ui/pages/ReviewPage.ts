// RULES-R1: 此处禁止任何强制时间限制（无倒计时 / 无超时提交 / 无超时判错）
import { uid } from '../../core/model';
import { setSettingsCache } from '../../core/config';
import { sortReviewCandidates } from '../../core/pick';
import type { Session, Word } from '../../core/types';
import * as dao from '../../dao';
import { button, h } from '../dom';
import { toastOk, toastWarn } from '../components/Toast';
import { navigate, registerCleanup, type RouteContext } from '../router';
import { finishReview } from './paper/finish';
import { createPaperFlow } from './paper/flow';
import { currentSettings } from './settings/ctx';

/**
 * 复习页（阶段 07 建立，**T2 改造为对齐背诵的交互**）。
 *
 * ── T2 改了什么 ──
 * 以前：进复习 → 弹窗问「本次复习多少个词？」→ 一次性抽 N 个 → 分组（每组 ≤ reviewGroupSize）
 *       → 一组背完弹「继续下一组 / 休息」→ 全部走完才写回复习数据。
 * 现在：进复习 → **直接开始，不弹选择框** → 底部主按钮「再复习一个」
 *       → 点一下多上一个词（按复习优先度降序取）→ 其余按钮与背诵一致
 *       （再次记忆 / 保存并退出 / 背完了）。
 *
 * 用户的理由很直接：背诵页早就是「点一下多背一个」，复习却要先猜一个数字，
 * 而那个数字（`recommendReviewCount` 给的推荐值）用户根本无从判断合不合理。
 *
 * ── 为什么词单还是一次取一批，而不是每次现查一个词 ──
 * 白纸的布点（`PaperStage`）需要**知道本轮有哪些词**才能把它们撒到纸上；
 * 一个一个查的话，每次加词都要重排整张纸，用户看到的词会乱跳。
 * 所以：**首屏取一段（{@link REVIEW_CHUNK} 个）建立词单**，
 * 点「再复习一个」时若这一段的词已用完，就再取下一段**追加**到词单里
 * （`advanceChunk()`），纸面布局保持稳定。
 *
 * ── 分组机制保留但用户看不见 ──
 * `createPaperFlow` 的「当前组完成」回调（`onGroupDone`）在复习模式下才触发，
 * 而它正是「用户又复习完了一个词」的信号 —— 我们就用它来取下一个词。
 * 所以这里把 `groupCount` 报成 1（不给用户看组号），`groupId` 只当内部计数器用。
 *
 * @param ctx 路由上下文（resume=1 时从上次的进度继续）
 */
export function renderReviewPage(ctx?: RouteContext): HTMLElement {
  const page = h('div', { class: 'page review-page' });

  /**
   * 首屏一次取多少个词进词单。
   *
   * 为什么是 30：等于默认的 `reviewGroupSize`，也就是「原来一次复习的量」——
   * 用户习惯的节奏不变，只是从「一次全给」变成「先给一段、需要再要」。
   * 纸面本身放不下的部分由 `PaperStage` 的容量限制兜着（进度条会显示"纸面已满"）。
   */
  const REVIEW_CHUNK = 30;

  let session: Session | null = null;
  let groupIndex = 0;
  let currentFlow: { destroy(): void } | null = null;
  /** 词库全量（取下一个词时用；每次取词前刷新） */
  let allWords: Word[] = [];

  /**
   * 挂载当前词单（旧流程必须先销毁，否则全局 Enter 监听会叠加）。
   *
   * ★ T2：`flow.ready` 必须等 —— 白纸初始化是异步的（先读词库），
   *   完成之前按钮状态是错的（「再复习一个」会显示成「已全部出现」，
   *   纸面容量算成 0）。实测过：不等它就会出现「复习页一个字都没有、
   *   也没有任何可用按钮」的界面。
   * @returns 初始化完成的 Promise
   */
  const mountFlow = async (): Promise<void> => {
    if (!session) return;
    if (currentFlow) currentFlow.destroy();
    currentFlow = null;
    session.groupId = groupIndex;
    await dao.session.saveSession(session);
    const flow = createPaperFlow({
      session,
      mode: 'review',
      groupIndex,
      groupCount: 1,
      onWordChopped: (id) => {
        // 斩掉的词从词单移除（撤销时插回原处，顺序才不会变）
        const s = session;
        if (!s) return undefined;
        const wordIdIndex = s.wordIds.indexOf(id);
        s.wordIds = s.wordIds.filter((x) => x !== id);
        return () => {
          if (wordIdIndex >= 0) s.wordIds.splice(Math.min(wordIdIndex, s.wordIds.length), 0, id);
          else if (!s.wordIds.includes(id)) s.wordIds.push(id);
        };
      },
      // ★ T2：这个回调现在只表示「用户又复习完了一轮」——
      //   用它来把下一批词放进词单（而不是弹「继续下一组」）。
      onGroupDone: () => void advanceChunk(),
      // ★ T2：复习模式的「背完了」出口（写回 lastReviewAt / reviewCount / 优先度）
      onRequestFinish: () => void completeAll(),
    });
    currentFlow = flow;
    page.replaceChildren(flow.root);
    registerCleanup(page, () => flow.destroy());
    await flow.ready;
  };

  /**
   * 当前这一批的词已经全部复习完 → 追加下一批。
   *
   * 为什么「追加」而不是「替换」：`wordIds` 就是白纸的本轮词单，
   * 换掉的话已经上纸、已经复习过的词会从词单里消失，白纸上的位置也没了。
   * 追加则是「纸上再多几个词」，与背诵页「再背一个」的行为一致。
   */
  const advanceChunk = async (): Promise<void> => {
    if (!session) return;
    await refreshWords();
    const next = sortReviewCandidates(allWords, new Set(session.wordIds), currentSettings(), Date.now());
    if (next.length === 0) {
      toastWarn('没有更多可复习的词了，可以点「背完了」结束');
      return;
    }
    const batch = next.slice(0, REVIEW_CHUNK);
    session.wordIds.push(...batch.map((w) => w.id));
    // 新词要重新布点（它们还没有落点），所以清掉已保存的位置并重挂流程
    session.placements = {};
    groupIndex += 1;
    await dao.session.saveSession(session);
    void mountFlow();
    toastOk(`又加入 ${batch.length} 个待复习的词`);
  };

  /** 刷新词库缓存 */
  const refreshWords = async (): Promise<void> => {
    allWords = await dao.words.getAll();
  };

  /** 结束复习：写回复习属性并清会话（只算真的复习过的词） */
  const completeAll = async (): Promise<void> => {
    if (!session) return;
    const n = await finishReview(session, currentSettings());
    if (n === 0) {
      // 一个词都没复习过就点了「背完了」：不该写任何复习记录
      toastWarn('这一轮还没有复习到任何词，未写回复习记录');
      navigate('/home');
      return;
    }
    toastOk(`复习完成，已更新 ${n} 个词的复习记录`);
    navigate('/home');
  };

  /**
   * 用已有会话续跑（T2 之前保存的进度也走这里）。
   *
   * 说明：老存档里 `wordIds` 是「当时抽好的那一批」，我们原样接着用，
   * 不再按 reviewGroupSize 重新切分 —— T2 之后分组对用户不可见，
   * 且分批取词由 `advanceChunk()` 负责。
   */
  const resume = async (existing: Session): Promise<void> => {
    setSettingsCache(await dao.settings.get());
    session = { ...existing, groups: [] };
    groupIndex = existing.groupId ?? 0;
    await refreshWords();
    void mountFlow();
  };

  /**
   * 新复习：**不弹任何对话框**，直接取第一批词开干。
   *
   * 这一段就是 T2 「取消选复习个数」的落点：原来的 `openModal` +
   * 数字输入框 + 「用推荐值」按钮整段删掉了。
   */
  const startNew = async (): Promise<void> => {
    setSettingsCache(await dao.settings.get());
    await refreshWords();

    const candidates = sortReviewCandidates(allWords, new Set(), currentSettings(), Date.now());
    if (candidates.length === 0) {
      page.replaceChildren(
        h('p', { class: 'note warn' }, '还没有已背的单词，先去背一轮吧'),
        button('去背诵', () => navigate('/learn'), { variant: 'primary' }),
      );
      return;
    }

    const first = candidates.slice(0, REVIEW_CHUNK);
    const now = Date.now();
    session = {
      id: uid(),
      type: 'review',
      wordIds: first.map((w) => w.id),
      placements: {},
      shownIds: [],
      memorizeCount: {},
      spellEnabled: false,
      failedIds: [],
      failDeltas: {},
      examDeltas: {},
      groupId: 0,
      groups: [],
      finished: false,
      createdAt: now,
    };
    groupIndex = 0;
    await dao.session.saveSession(session);
    void mountFlow();
  };

  void (async () => {
    if (ctx?.query.get('resume') === '1') {
      const existing = await dao.session.loadSession();
      if (existing && !existing.finished && existing.type === 'review' && existing.wordIds.length > 0) {
        await resume(existing);
        return;
      }
    } else {
      // ★ 与背诵页同一口径：只要库里有未完成的复习会话就自动续跑，
      //   不弹「继续上次 / 重新开始」的询问框（T2 之前这里必须带 ?resume=1）。
      const existing = await dao.session.loadSession();
      if (existing && !existing.finished && existing.type === 'review' && existing.wordIds.length > 0) {
        const words = await dao.words.getAll();
        const alive = existing.wordIds.filter((id) => words.some((w) => w.id === id && w.status !== 'chopped'));
        if (alive.length > 0) {
          existing.wordIds = alive;
          await resume(existing);
          return;
        }
        await dao.session.clearSession();
      }
    }
    await startNew();
  })();

  return page;
}
