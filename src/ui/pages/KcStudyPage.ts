/**
 * 学习流程（`#/kc/study`）—— 阶段 04 的核心体验。
 *
 * ```
 * 选数量 → 逐张看卡片 → 每张自评（不会/模糊/会了）→ 全部过完 → 进入做题（阶段 05）
 * ```
 *
 * ══════════════════════════════════════════════════════════════
 * 四个实现要点
 * ══════════════════════════════════════════════════════════════
 * 1. **自评后立刻写库**（`dao.kc.updateAttrs`）——不能等「保存并退出」才写，
 *    否则中途关掉页面这次学习就白做了。同时写 `learnedAt` 与 `status='learning'`。
 * 2. **每一步都能「保存并退出」**（用户明确要求）：右上角按钮 + Esc，存进 `kcSession`。
 *    会话**每次自评后也顺手存一次**，所以断电/关页面也不会丢进度。
 * 3. **重进时问「继续上次 / 重新开始」**：`dao.kcSession.loadLatestOpen('study')`。
 * 4. **键盘 1/2/3 自评、Esc 退出**，与一期手感一致。
 */

// RULES-R1: 此处禁止任何强制时间限制（无倒计时 / 无超时提交 / 无超时判错）
import type { KcSession, KnowledgeCard } from '../../core/kcTypes';
import * as dao from '../../dao';
import { toastOk, toastWarn } from '../components/Toast';
import { renderKcStudyCard, type SelfRating } from '../components/KcStudyCardView';
import { button, h } from '../dom';
import { navigate, registerCleanup } from '../router';
import { renderKcCountPicker } from '../components/KcCountPicker';
import { pickUnlearned, resumeSession } from './kcExam/kcExamFlow';
import { renderKcFinishPanel, summarizeScores } from '../components/KcFinishPanel';
import { askResume, scoreLabel } from '../components/kcStudyDialogs';
import { chopKcCardUndoable } from './kcChopUndo';

/** 学习流程的阶段：选卡片 → 逐张自评 → 看完了（做题在阶段 05） */
type Phase = 'picking' | 'cards' | 'finished';

/**
 * 渲染学习流程页。
 * @param ctx 路由上下文（`?resume=1` 时跳过「选数量」直接续跑）
 */
export function renderKcStudyPage(ctx?: { query: URLSearchParams }): HTMLElement {
  const page = h('div', { class: 'page kc-study-page' });
  const headBox = h('div', { class: 'kc-study-head' });
  const bodyBox = h('div', { class: 'kc-study-body' });
  page.appendChild(headBox);
  page.appendChild(bodyBox);

  /** 当前会话（null = 还没开始） */
  let session: KcSession | null = null;
  /** 当前阶段 */
  let phase: Phase = 'picking';
  /** 本轮卡片（按会话里的 id 取出来的实体） */
  let cards: KnowledgeCard[] = [];
  /** 键盘监听是否已挂上（避免重复挂） */
  let keyHandlerAttached = false;

  /** 显示进度（第几张 / 共几张） */
  function paintHead(): void {
    headBox.replaceChildren();
    if (session === null || phase === 'picking') {
      headBox.appendChild(h('h1', { class: 'kc-study-title-main', text: '学习知识点' }));
      return;
    }
    const done = Math.min(session.currentIndex, cards.length);
    headBox.appendChild(h('h1', { class: 'kc-study-title-main', text: '学习知识点' }));
    headBox.appendChild(
      h('span', { class: 'kc-study-progress', text: `进度 ${done}/${cards.length}` }),
    );
    headBox.appendChild(
      button('保存并退出', () => void saveAndExit(), { variant: 'ghost', class: 'kc-study-exit', title: 'Esc' }),
    );
  }

  /** 渲染「选数量」界面 */
  async function renderPicker(): Promise<void> {
    phase = 'picking';
    paintHead();
    bodyBox.replaceChildren();

    const all = await dao.kc.getAll();
    const unlearned = all.filter((c) => c.deleted !== 1 && c.status === 'unlearned').length;
    const learning = all.filter((c) => c.deleted !== 1 && c.status === 'learning').length;

    bodyBox.appendChild(
      renderKcCountPicker({
        candidateCount: unlearned,
        candidateLabel: '未学',
        extraHint: learning > 0 ? `（另有 ${learning} 张学习中）` : '',
        onStart: (count) => void startStudy(count),
        emptyTitle: '还没有未学的知识点',
        emptyHint: learning > 0 ? `有 ${learning} 张正在学习中，可以去「复习」里过一遍。` : '先去「录入」加几张卡片吧。',
        emptyActions: [
          { label: '去录入', onClick: () => navigate('/kc/import') },
          { label: '去复习', onClick: () => navigate('/kc/review') },
        ],
      }),
    );
  }

  /**
   * 开始新一轮学习。
   * @param count 学几张
   */
  async function startStudy(count: number): Promise<void> {
    const picked = await pickUnlearned(count);
    if (picked.length === 0) {
      toastWarn('没有可学的卡片了');
      await renderPicker();
      return;
    }
    if (picked.length < count) {
      toastWarn(`未学卡片只剩 ${picked.length} 张，这次就学这些`);
    }
    session = dao.kcSession.createSession('study', picked.map((c) => c.id));
    cards = picked;
    phase = 'cards';
    await dao.kcSession.save(session);
    attachKeys();
    renderCard();
  }

  /**
   * 从保存的会话续跑（取卡片与修正下标的逻辑在 kcExamFlow.resumeSession）。
   * @param open 会话
   */
  async function resume(open: KcSession): Promise<void> {
    const restored = await resumeSession(open);
    if (restored.empty) {
      await dao.kcSession.remove(open.id);
      toastWarn('上次的卡片都不在了，重新开始吧');
      await renderPicker();
      return;
    }
    session = restored.session;
    cards = restored.cards;
    phase = 'cards';
    await dao.kcSession.save(restored.session);
    attachKeys();
    renderCard();
  }

  /** 渲染当前这张卡 */
  function renderCard(): void {
    if (session === null) return;
    bodyBox.replaceChildren();
    paintHead();

    // 全部过完
    if (session.currentIndex >= cards.length) {
      phase = 'finished';
      renderFinished();
      return;
    }
    const card = cards[session.currentIndex];
    if (card === undefined) {
      void finishStudy();
      return;
    }
    const lastScore = session.selfScores[card.id];
    const wrap = h('div', { class: 'kc-study-cardwrap' });
    if (lastScore !== undefined) {
      wrap.appendChild(h('p', { class: 'kc-hint-dim', text: `上次自评：${scoreLabel(lastScore)}（再点一次可以改）` }));
    }
    wrap.appendChild(
      renderKcStudyCard(card, {
        onRate: (score) => void rate(score),
        onChop: () => void chopCurrent(card),
      }),
    );
    bodyBox.appendChild(wrap);
  }

  /**
   * 自评 → 立刻写库 → 下一张。
   * @param score 1/2/3
   */
  async function rate(score: SelfRating): Promise<void> {
    if (session === null) return;
    const card = cards[session.currentIndex];
    if (card === undefined) return;

    // 1) 立刻写库：自评分 + 首次学习时间
    //    说明：`updateAttrs` 内部会用最新分数重算 mastery 与 reviewPriority
    await dao.kc.updateAttrs(card.id, {
      lastSelfScore: score,
      learnedAt: card.attrs.learnedAt ?? Date.now(),
    });
    // 状态从 unlearned → learning（第一次学）
    if (card.status === 'unlearned') {
      await dao.kc.updateMeta(card.id, { status: 'learning' });
    }

    // 2) 会话进度（顺手存，断电也不丢）
    session.selfScores[card.id] = score;
    session.currentIndex += 1;
    await dao.kcSession.save(session);

    // 3) 下一张
    renderCard();
  }

  /**
   * 斩掉当前卡片，然后跳过它。
   *
   * ★ RULES-R3: 斩不弹确认，但必须提供 ≥8 秒的撤销 Toast。
   *   撤销的实现（含「完全恢复本轮位置」）在 `kcChopUndo.ts`，
   *   与复习流程共用同一份——两处行为不一致的话用户立刻能感觉到。
   *
   * @param card 卡片
   */
  async function chopCurrent(card: KnowledgeCard): Promise<void> {
    const s = session;
    if (s === null) return;
    await chopKcCardUndoable({
      card,
      cards,
      session: s,
      onChanged: async () => {
        await dao.kcSession.save(s);
        renderCard();
      },
    });
  }

  /** 全部卡片过完 */
  async function finishStudy(): Promise<void> {
    if (session === null) return;
    phase = 'finished';
    session.finished = true;
    session.stage = 'done';
    await dao.kcSession.save(session);
    paintHead();
    renderFinished();
  }

  /** 渲染「看完了」界面（→ 进入做题） */
  function renderFinished(): void {
    bodyBox.replaceChildren();
    const scores: number[] = Object.values(session?.selfScores ?? {});
    bodyBox.appendChild(
      renderKcFinishPanel(
        '卡片看完啦',
        [summarizeScores(scores), '接下来做几道题：AI 会按每张卡的考法出题，并结合今日语境词。'],
        [
          { label: '开始做题', variant: 'primary', onClick: () => navigate('/kc/exam') },
          { label: '先不做，回二期首页', variant: 'ghost', onClick: () => navigate('/kc') },
          { label: '再学一轮', variant: 'ghost', onClick: () => void renderPicker() },
        ],
      ),
    );
  }

  /** 保存并退出 */
  async function saveAndExit(): Promise<void> {
    if (session !== null) {
      await dao.kcSession.save(session);
      const left = Math.max(0, cards.length - session.currentIndex);
      toastOk(left > 0 ? `已保存，还剩 ${left} 张` : '已保存');
    }
    navigate('/kc');
  }

  /** 挂键盘监听（只挂一次，页面卸载时摘掉） */
  function attachKeys(): void {
    if (keyHandlerAttached) return;
    keyHandlerAttached = true;
    window.addEventListener('keydown', onKey);
  }

  /**
   * 键盘：1/2/3 自评，Esc 保存并退出。
   * @param ev 事件
   */
  function onKey(ev: KeyboardEvent): void {
    if (phase !== 'cards') return;
    // 正在输入框里打字时不抢键（本页目前没有输入框，但保持这个习惯）
    const tag = (ev.target as HTMLElement | null)?.tagName ?? '';
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (ev.key === '1' || ev.key === '2' || ev.key === '3') {
      ev.preventDefault();
      void rate(Number(ev.key) as SelfRating);
      return;
    }
    if (ev.key === 'Escape') {
      ev.preventDefault();
      void saveAndExit();
    }
  }

  // ── 启动：先看有没有未完成的会话 ──
  void (async () => {
    const resumeWanted = ctx?.query.get('resume') === '1';
    const open = await dao.kcSession.loadLatestOpen('study');
    if (open !== null) {
      // 用户明确要求：「如果做题时退出，再点学习就自然而然跳转到做到的那道题，
      // 不要在主界面再搞一个按钮」。会话 stage 已经是 exam 就说明上次退在做题环节，
      // 这里不再问「继续 / 重新开始」（那正是他嫌多余的一步），直接进那道题。
      if (open.stage === 'exam') {
        navigate('/kc/exam?resume=1');
        return;
      }
      if (resumeWanted || open.currentIndex > 0) {
        if (await askResume(open, '张', '学习')) {
          await resume(open);
          return;
        }
        await dao.kcSession.remove(open.id);
      }
    }
    await renderPicker();
  })();

  registerCleanup(page, () => {
    window.removeEventListener('keydown', onKey);
  });
  return page;
}
