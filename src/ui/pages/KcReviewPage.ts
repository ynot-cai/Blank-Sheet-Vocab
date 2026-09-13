/**
 * 复习流程（`#/kc/review`）—— 阶段 06。
 *
 * ```
 * ① 选择复习多少个知识点
 *         ↓
 * ② 看知识卡片（逐张，自评三级 + 斩）      ← 与学习流程相同
 *         ↓
 * ③ 【桥接】跳转到一期背单词界面，上限 5 个词
 *         ↓
 * ④ 做题（AI 出题 + 评分）                ← 与学习流程相同
 *         ↓
 * ⑤ 完成 → 更新 lastReviewAt / reviewCount / mastery / reviewPriority
 * ```
 *
 * ══════════════════════════════════════════════════════════════
 * 三个实现要点
 * ══════════════════════════════════════════════════════════════
 * 1. **阶段靠 `KcSession.stage` 串起来**（`cards` → `words` → `exam` → `done`）：
 *    中途退出后重进，按 stage 回到对应环节（验收标准 7 要验三个阶段）。
 * 2. **卡片复习复用学习流程的组件**（`KcStudyCardView` / `KcCountPicker`），
 *    不复制一套自评逻辑 —— 两处行为必须完全一致，否则用户会觉得「复习和学习不一样」。
 * 3. **桥接复用一期白纸流程**（`createKcWordBridge` → `createPaperFlow`），
 *    只在外层调用，不改一期代码。
 */
import { getSettings } from '../../core/config';
import type { KcSession, KnowledgeCard } from '../../core/kcTypes';
import * as dao from '../../dao';
import { renderReviewPicker } from './kcReview/kcReviewPicker';
import { renderKcStudyCard } from '../components/KcStudyCardView';
import { askResume, confirmDialog } from '../components/kcStudyDialogs';
import { toastOk, toastWarn } from '../components/Toast';
import { button, h } from '../dom';
import { navigate, registerCleanup } from '../router';
import { createKcWordBridge, type KcWordBridge } from './KcWordBridge';
import { pickForReview, resumeSessionCards } from './kcReview/kcReviewFlow';

/**
 * 渲染复习流程页。
 * @param ctx 路由上下文（`?resume=1` 续跑）
 */
export function renderKcReviewPage(ctx?: { query: URLSearchParams }): HTMLElement {
  const page = h('div', { class: 'page kc-review-page' });
  const headBox = h('div', { class: 'kc-study-head' });
  const bodyBox = h('div', { class: 'kc-study-body' });
  page.appendChild(headBox);
  page.appendChild(bodyBox);

  let session: KcSession | null = null;
  let cards: KnowledgeCard[] = [];
  /** 桥接组件（在 words 阶段挂载） */
  let bridge: KcWordBridge | null = null;

  /** 画头部 */
  function paintHead(): void {
    headBox.replaceChildren();
    headBox.appendChild(h('h1', { class: 'kc-study-title-main', text: '复习知识点' }));
    if (session === null) return;
    const stageName = { cards: '看卡片', words: '背单词', exam: '做题', done: '完成' }[session.stage];
    headBox.appendChild(h('span', { class: 'kc-study-progress', text: `环节：${stageName}` }));
    if (session.stage === 'cards') {
      headBox.appendChild(
        h('span', {
          class: 'kc-hint-dim',
          text: `进度 ${Math.min(session.currentIndex, cards.length)}/${cards.length}`,
        }),
      );
    }
    headBox.appendChild(
      button('保存并退出', () => void saveAndExit(), { variant: 'ghost', class: 'kc-study-exit', title: 'Esc' }),
    );
  }

  /** 渲染「选数量」（界面在 kcReview/kcReviewPicker） */
  async function renderPicker(): Promise<void> {
    paintHead();
    bodyBox.replaceChildren();
    const all = await dao.kc.getAll();
    bodyBox.appendChild(renderReviewPicker(all, (count) => void startReview(count)));
  }

  /**
   * 开始一轮复习。
   * @param count 复习几个
   */
  async function startReview(count: number): Promise<void> {
    const all = await dao.kc.getAll();
    const picked = pickForReview(all, count);
    if (picked.length === 0) {
      toastWarn('没有可复习的卡片');
      await renderPicker();
      return;
    }
    if (picked.length < count) toastWarn(`可复习的只剩 ${picked.length} 张，这次就复习这些`);
    session = dao.kcSession.createSession('review', picked.map((c) => c.id));
    cards = picked;
    await dao.kcSession.save(session);
    attachKeys();
    renderCard();
  }

  /** 渲染当前这张卡（自评 → 下一张；全部过完 → 进入背单词） */
  function renderCard(): void {
    if (session === null) return;
    paintHead();
    bodyBox.replaceChildren();
    if (session.currentIndex >= cards.length) {
      void enterWordsStage();
      return;
    }
    const card = cards[session.currentIndex];
    if (card === undefined) {
      void enterWordsStage();
      return;
    }
    const wrap = h('div', { class: 'kc-study-cardwrap' });
    const last = session.selfScores[card.id];
    if (last !== undefined) {
      wrap.appendChild(h('p', { class: 'kc-hint-dim', text: `上次自评：${['', '不会', '模糊', '会了'][last] ?? ''}（再点一次可以改）` }));
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
   * 自评 → 立刻写库 → 下一张（与学习流程完全同一套口径）。
   * @param score 1/2/3
   */
  async function rate(score: 1 | 2 | 3): Promise<void> {
    if (session === null) return;
    const card = cards[session.currentIndex];
    if (card === undefined) return;
    await dao.kc.updateAttrs(card.id, {
      lastSelfScore: score,
      learnedAt: card.attrs.learnedAt ?? Date.now(),
    });
    session.selfScores[card.id] = score;
    session.currentIndex += 1;
    await dao.kcSession.save(session);
    renderCard();
  }

  /**
   * 斩掉当前卡片（二次确认）。
   * @param card 卡片
   */
  async function chopCurrent(card: KnowledgeCard): Promise<void> {
    if (session === null) return;
    if (!(await confirmDialog('确定斩掉？', '斩后这张卡不再出现在学习与复习里（可以在「卡片列表 → 已斩」里复活）。', '斩掉'))) return;
    await dao.kc.chop(card.id);
    cards = cards.filter((c) => c.id !== card.id);
    session.cardIds = session.cardIds.filter((id) => id !== card.id);
    delete session.selfScores[card.id];
    session.currentIndex = Math.min(session.currentIndex, cards.length);
    await dao.kcSession.save(session);
    toastOk('已斩');
    renderCard();
  }

  /** ③ 进入「背单词」环节（桥接一期） */
  async function enterWordsStage(): Promise<void> {
    if (session === null) return;
    session.stage = 'words';
    await dao.kcSession.save(session);
    paintHead();
    bodyBox.replaceChildren(h('p', { class: 'kc-hint-dim', text: '正在准备背单词…' }));

    const limit = getSettings().kc?.reviewWordLimit ?? 5;
    bridge?.destroy();
    bridge = await createKcWordBridge(limit, {
      onDone: (info) => {
        void (async () => {
          bridge?.destroy();
          bridge = null;
          if (session === null) return;
          session.wordsDone = true;
          session.stage = 'exam';
          await dao.kcSession.save(session);
          if (info.skipped) toastWarn(info.wordCount === 0 ? '跳过背单词，直接做题' : '');
          navigate('/kc/exam?resume=1');
        })();
      },
    });
    bodyBox.replaceChildren(bridge.root);
  }

  /** 保存并退出 */
  async function saveAndExit(): Promise<void> {
    if (session !== null && !session.finished) {
      await dao.kcSession.save(session);
      toastOk('已保存，下次从这里继续');
    }
    bridge?.destroy();
    navigate('/kc');
  }

  /** 键盘：1/2/3 自评，Esc 退出 */
  function onKey(ev: KeyboardEvent): void {
    if (session === null || session.stage !== 'cards') return;
    const tag = (ev.target as HTMLElement | null)?.tagName ?? '';
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (ev.key === '1' || ev.key === '2' || ev.key === '3') {
      ev.preventDefault();
      void rate(Number(ev.key) as 1 | 2 | 3);
      return;
    }
    if (ev.key === 'Escape') {
      ev.preventDefault();
      void saveAndExit();
    }
  }
  let keysAttached = false;
  function attachKeys(): void {
    if (keysAttached) return;
    keysAttached = true;
    window.addEventListener('keydown', onKey);
  }

  // ── 启动：按会话的 stage 回到对应环节 ──
  void (async () => {
    const wantResume = ctx?.query.get('resume') === '1';
    const open = await dao.kcSession.loadLatestOpen('review');
    if (open !== null) {
      const byStage: Record<KcSession['stage'], string> = {
        cards: '接着看卡片',
        words: '接着背单词',
        exam: '接着做题',
        done: '已经做完',
      };
      const go =
        wantResume ||
        (await askResume(open, '张', `复习（${byStage[open.stage]}）`));
      if (go) {
        await resume(open);
        return;
      }
      await dao.kcSession.remove(open.id);
    }
    await renderPicker();
  })();

  /**
   * 续跑：按 stage 回到对应环节。
   * @param open 会话
   */
  async function resume(open: KcSession): Promise<void> {
    const restored = await resumeSessionCards(open);
    if (restored.cards.length === 0) {
      await dao.kcSession.remove(open.id);
      toastWarn('上次的卡片都不在了，重新开始吧');
      await renderPicker();
      return;
    }
    session = restored.session;
    cards = restored.cards;
    attachKeys();
    if (session.stage === 'words') {
      await enterWordsStage();
      return;
    }
    if (session.stage === 'exam') {
      navigate('/kc/exam?resume=1');
      return;
    }
    renderCard();
  }

  registerCleanup(page, () => {
    window.removeEventListener('keydown', onKey);
    bridge?.destroy();
  });
  return page;
}
