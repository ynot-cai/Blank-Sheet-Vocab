/**
 * 做题页（`#/kc/exam`）—— 阶段 05 的主界面。
 *
 * ```
 * 过完卡片 → 逐题作答 → AI 评分 → 下一题 → 全部答完 → 更新 lastExamScore / mastery / status
 * ```
 *
 * 这一页只做三件事：**布局**、**把状态机的变化画出来**、**接按钮**。
 * 推进逻辑（第几题、评分、存档、会话）全在 `kcExam/kcExamController`；
 * 出题材料的准备（题型 / 语境词 / 防重复 / 题库参考）在 `kcExam/kcExamFlow`。
 */
import type { KnowledgeCard } from '../../core/kcTypes';
import * as dao from '../../dao';
import { renderKcExamTaker } from '../components/ExamTaker';
import { isConfirmKey, readExamControls, resolveEnterAction, shouldYieldToNative } from '../components/examKeys';
import { toastOk, toastWarn } from '../components/Toast';
import { button, h } from '../dom';
import { navigate, registerCleanup } from '../router';
import { createExamController, type ExamController, type ExamState } from './kcExam/kcExamController';
import { totalQuestionCount } from './kcExam/kcExamPrepare';
import { reviewSummary } from './kcReview/kcReviewFlow';

/**
 * 渲染做题页。
 * @param ctx 路由上下文（`?resume=1` 续跑）
 */
export function renderKcExamPage(ctx?: { query: URLSearchParams }): HTMLElement {
  const page = h('div', { class: 'page kc-exam-page' });
  const headBox = h('div', { class: 'kc-exam-pagehead' });
  const bodyBox = h('div', { class: 'kc-exam-pagebody' });
  page.appendChild(headBox);
  page.appendChild(bodyBox);

  /** 控制器（拿到会话后才建） */
  let controller: ExamController | null = null;
  /** 最近一次渲染用的状态（键盘处理要按它决定 Enter 干什么） */
  let latest: ExamState | null = null;

  /** 画头部（进度 + 保存并退出） */
  function paintHead(s: ExamState): void {
    headBox.replaceChildren();
    headBox.appendChild(h('h1', { class: 'kc-exam-title', text: '做题' }));
    if (s.phase !== 'done') {
      headBox.appendChild(
        h('span', { class: 'kc-exam-progress', text: `第 ${Math.min(s.questionIndex + 1, s.total)}/${s.total} 题` }),
      );
      headBox.appendChild(
        button('保存并退出', () => void saveAndExit(), { variant: 'ghost', class: 'kc-exam-exit', title: 'Esc' }),
      );
    }
  }

  /** 保存并退出（每次提交时已经存过，这里补一次并跳走） */
  async function saveAndExit(): Promise<void> {
    const session = controller?.getSession() ?? null;
    if (session !== null && !session.finished) {
      await dao.kcSession.save(session);
      toastOk(`已保存，下次从第 ${(controller?.getState().questionIndex ?? 0) + 1} 题继续`);
    }
    navigate('/kc');
  }

  /** 整页渲染（按状态） */
  function render(s: ExamState): void {
    latest = s;
    paintHead(s);
    bodyBox.replaceChildren();

    if (s.phase === 'done') {
      renderDone();
      return;
    }
    if (s.phase === 'error') {
      const box = h('div', { class: 'kc-empty' });
      box.appendChild(h('p', { class: 'kc-empty-title', text: '这里出问题了' }));
      box.appendChild(h('p', { class: 'kc-hint-dim', text: s.error }));
      box.appendChild(button('重试', () => void controller?.retry(), { variant: 'primary' }));
      box.appendChild(button('保存并退出', () => void saveAndExit(), { variant: 'ghost' }));
      bodyBox.appendChild(box);
      return;
    }
    if (s.phase === 'preparing' || s.phase === 'loading') {
      renderPreparing(s);
      return;
    }
    if (s.question === null) {
      bodyBox.appendChild(h('p', { class: 'kc-hint-dim', text: '正在出题…' }));
      return;
    }

    const wrap = h('div', { class: 'kc-exam-wrap' });
    if (s.card !== null) {
      wrap.appendChild(h('p', { class: 'kc-exam-cardname', text: `知识点：${s.card.title}` }));
    }
    wrap.appendChild(
      renderKcExamTaker(
        s.question,
        {
          phase: s.phase === 'grading' ? 'grading' : s.phase === 'graded' ? 'graded' : 'answering',
          answer: s.answer,
          grade: s.grade ?? undefined,
          // 「评分失败」的提示放在 error 里，但 phase 已经是 graded（不阻断），所以照样显示
          error: s.error === '' ? undefined : s.error,
        },
        {
          onSubmit: (a) => void controller?.submit(a),
          onRegrade: (score) => void controller?.regrade(score),
          onNext: () => void controller?.next(),
          onRetry: () => void controller?.retry(),
        },
      ),
    );
    bodyBox.appendChild(wrap);
  }

  /**
   * 「正在出题」界面。
   *
   * 用户明确要求：把**所有** AI 出题时间挪到第一题之前（一口气出完），
   * 所以这里必须把「在等什么、还要等多久」写清楚 ——
   * 否则用户看到的是一个转圈的空白页，会以为卡死了。
   * @param s 状态
   */
  function renderPreparing(s: ExamState): void {
    const { done, total } = s.preparing;
    const box = h('div', { class: 'kc-preparing' });
    box.appendChild(h('p', { class: 'kc-empty-title', text: '正在一口气出完这一轮的题' }));
    box.appendChild(
      h('p', {
        class: 'kc-hint-dim',
        text:
          total === 0
            ? '这一轮没有需要新出的题，马上开始。'
            : `已出好 ${done}/${total} 道（共 ${s.total} 道）。全部出完才开始答题 —— 这样答题过程中就不用再等 AI 了。`,
      }),
    );
    const bar = h('div', { class: 'kc-prepbar' });
    const fill = h('i', { class: 'kc-prepbar-fill' });
    fill.style.width = total === 0 ? '100%' : `${Math.round((done / total) * 100)}%`;
    bar.appendChild(fill);
    box.appendChild(bar);
    bodyBox.appendChild(box);
  }

  /** 「做完了」界面（复习流程额外显示小结） */
  function renderDone(): void {
    const session = controller?.getSession() ?? null;
    const scores = Object.values(session?.examScores ?? {});
    const finished = controller?.getState().finishedCards ?? [];
    const box = h('div', { class: 'kc-finished' });
    box.appendChild(h('p', { class: 'kc-empty-title', text: '做完了' }));
    box.appendChild(
      h('p', {
        class: 'kc-hint-dim',
        text:
          scores.length === 0
            ? '这一轮没有记录到分数。'
            : `共 ${scores.length} 题：得 3 分 ${scores.filter((x) => x === 3).length} 题、2 分 ${scores.filter((x) => x === 2).length} 题、1 分 ${scores.filter((x) => x === 1).length} 题。卡片掌握度已按考核结果重算。`,
      }),
    );
    if (finished.length > 0) {
      box.appendChild(h('p', { class: 'kc-hint-dim', text: reviewSummary(finished) }));
    }
    box.appendChild(button('回二期首页', () => navigate('/kc'), { variant: 'primary' }));
    box.appendChild(button('看卡片列表', () => navigate('/kc/list'), { variant: 'ghost' }));
    bodyBox.appendChild(box);
  }

  /** 没有进行中的学习时的提示 */
  function renderNoSession(): void {
    headBox.replaceChildren(h('h1', { class: 'kc-exam-title', text: '做题' }));
    bodyBox.replaceChildren(
      h('div', { class: 'kc-empty' }, [
        h('p', { class: 'kc-empty-title', text: '没有进行中的学习' }),
        h('p', { class: 'kc-hint-dim', text: '做题是从「学习」流程进来的：先看卡片，再做题。' }),
        button('去学习', () => navigate('/kc/study'), { variant: 'primary' }),
      ]),
    );
  }

  // ── 启动：找未完成的会话 → 建控制器 → 载入第一题 ──
  void (async () => {
    // 不限定 type：学习与复习流程都会进做题，各自的会话由 controller 按 type 处理收尾
    const open = await dao.kcSession.loadLatestOpen();
    if (open === null) {
      renderNoSession();
      return;
    }
    const all = await dao.kc.getAll();
    const byId = new Map(all.map((c) => [c.id, c]));
    const cards: KnowledgeCard[] = open.cardIds
      .map((id) => byId.get(id))
      .filter((c): c is KnowledgeCard => c !== undefined && c.deleted !== 1);
    if (cards.length === 0) {
      await dao.kcSession.remove(open.id);
      toastWarn('上次的卡片都不在了');
      navigate('/kc/study');
      return;
    }

    const session = { ...open, stage: 'exam' as const };
    await dao.kcSession.save(session);

    const total = totalQuestionCount(cards);
    const wantResume = ctx?.query.get('resume') === '1';
    // 续跑时按会话里的题号；否则从头。题号越界就退回最后一题（卡片可能变少了）
    const startIndex = wantResume || open.examIndex > 0 ? Math.min(open.examIndex, Math.max(0, total - 1)) : 0;

    controller = createExamController({ cards, session, startIndex });
    controller.subscribe(render);
    // start() = 一口气出完所有题，然后载入第一题（用户明确要求把出题时间都放在最前面）
    await controller.start();
  })();

  // ── 键盘 ──
  // Enter：**整个流程统一走这里**（用户明确要求 Enter 要一直有用），
  // 规则表见 `components/examKeys`。Esc：保存并退出。
  const onKey = (ev: KeyboardEvent): void => {
    if (ev.key === 'Escape') {
      const tag = (ev.target as HTMLElement | null)?.tagName ?? '';
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      ev.preventDefault();
      void saveAndExit();
      return;
    }
    if (!isConfirmKey(ev)) return;
    const s = latest;
    if (s === null) return;
    // 造句题（textarea）里 Shift+Enter 让给浏览器换行（Enter 仍然是提交）
    if (ev.shiftKey && (ev.target as HTMLElement | null)?.tagName === 'TEXTAREA') return;
    // 焦点在按钮上时让浏览器原生处理（Enter = 点这个按钮）。
    // 不这么做的话，选择题会「原生点击 + 我们提交」各一次，落两条记录。
    if (shouldYieldToNative(ev.target)) return;
    const action = resolveEnterAction(s.phase, readExamControls(page.querySelector<HTMLElement>('.kc-exam')));
    if (action.kind === 'none') return;
    ev.preventDefault();
    if (action.kind === 'submit') void controller?.submit(action.value);
    else if (action.kind === 'next') void controller?.next();
    else if (action.kind === 'retry') void controller?.retry();
    else navigate('/kc');
  };
  // 两处监听：`page` 上收「焦点在答题区里」的键；
  // `window` 上收「焦点掉在 body 上」的键（答题卡每次重画都会把焦点弄丢，
  // 这正是「Enter 时灵时不灵」的另一半原因）。
  const onWindowKey = (ev: KeyboardEvent): void => {
    const target = ev.target as Node | null;
    if (target !== null && page.contains(target)) return; // 已经由 page 上的监听处理
    if (ev.key !== 'Escape' && !isConfirmKey(ev)) return;
    onKey(ev);
  };
  page.addEventListener('keydown', onKey);
  window.addEventListener('keydown', onWindowKey);
  registerCleanup(page, () => {
    page.removeEventListener('keydown', onKey);
    window.removeEventListener('keydown', onWindowKey);
  });

  return page;
}
