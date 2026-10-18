/**
 * 白纸界面（`#/learn/paper`）—— 本轮的主体。
 *
 * 职责：抽词 → 布点 → 逐个「下一个」放上纸 → 四个按钮（保存退出 / 删除这张纸 / 下一个 / 再次记忆）。
 *
 * 三个历史问题的落点：
 *  ① 单词与按钮重叠 → `geometry.ts` 的避让矩形改为**向外扩**，且手机端可用区下边界收到它顶边；
 *  ② 按钮大小不断变化 → 按钮宽高由 `PAPER_UI` 常量 + CSS 变量固定，文字只省略号截断；
 *  ③ 改中文不立即显示 → 卡片保存后调 `stage.refreshWord(word)` 重算纸上文本。
 */
import { getSettings, PAPER_UI } from '../../core/config';
import { normalizeWordPriority } from '../../core/model';
import type { Session, Word } from '../../core/types';
import * as dao from '../../dao';
import { deviceKind } from '../device';
import { button, h } from '../dom';
import { confirmModal } from '../components/Modal';
import { toastOk } from '../components/Toast';
import { navigate, registerCleanup } from '../router';
import { createPaperStage, type PaperStageHandle } from './paper/PaperStage';
import { applyPaperButtonVars, paperButtonBox } from './paper/geometry';
import { openWordCard } from './paper/WordCard';

/** 「下一个」一次最多往纸上放几个词（纸面容量由布点自己兜） */
const MAX_ON_PAPER = 60;

/**
 * 按「背诵优先级从高到低，同优先级随机」抽词（用户指定的默认逻辑）。
 * @param all 全部存活词（调用方已过滤掉已斩）
 * @param limit 最多取几个
 */
function pickForLearn(all: Word[], limit: number): Word[] {
  const byPriority = new Map<number, Word[]>();
  for (const w of all) {
    const p = normalizeWordPriority(w.priority);
    const list = byPriority.get(p) ?? [];
    list.push(w);
    byPriority.set(p, list);
  }
  const out: Word[] = [];
  // 5 → 1 逐档取；同一档内先洗牌再取，保证「同优先级随机」
  for (let p = 5; p >= 1 && out.length < limit; p -= 1) {
    const list = (byPriority.get(p) ?? []).slice();
    for (let i = list.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [list[i], list[j]] = [list[j], list[i]];
    }
    for (const w of list) {
      if (out.length >= limit) break;
      out.push(w);
    }
  }
  return out;
}

/**
 * 渲染白纸界面。
 */
export function renderLearnPaperPage(): HTMLElement {
  const isPhone = deviceKind() === 'phone';
  const page = h('div', { class: 'paper-page' });
  applyPaperButtonVars(page);

  const stage: PaperStageHandle = createPaperStage({
    onWordClick: (word) => stage.toggleMeaning(word.id),
    onMeaningClick: (word) => {
      const close = openWordCard({
        word,
        isPhone,
        onClose: () => undefined,
        onSpeak: () => speak(word.en),
        onSave: (next) => {
          void (async () => {
            await dao.words.put(next);
            // ★ ③ 立刻刷新纸上的中文与义项数——这是「改了中文不立即显示」的修复点
            stage.refreshWord(next);
            const idx = queue.findIndex((w) => w.id === next.id);
            if (idx >= 0) queue[idx] = next;
            toastOk('已保存');
          })();
        },
        onChop: () => {
          void (async () => {
            await dao.words.chop(word.id);
            stage.refreshWord({ ...word, status: 'chopped' });
            toastOkAtTop(`已斩「${word.en}」`);
          })();
        },
      });
      void close;
    },
  });
  page.appendChild(stage.root);

  /** 待放上纸的词（按优先级抽好，顺序就是出场顺序） */
  let queue: Word[] = [];
  /** 已经放上纸的词 id（按出场顺序） */
  const shownOrder: string[] = [];
  const shown = new Set<string>();
  /**
   * ★ 每个词**当时算出来的落点**。
   * 用户第 4 条：保存退出后再次进入，位置与「已经出现」都要原样保留，
   * 所以落点必须一起存进会话；不存的话恢复时只能重排，位置就变了。
   */
  const placements: Record<string, { x: number; y: number }> = {};
  let session: Session | null = null;
  let destroyed = false;

  // ── 统计行 ──
  const stats = h('div', { class: `paper-stats ${isPhone ? 'phone' : 'wide'}`, text: '当前：0 词，平均复习：0 遍' });
  page.appendChild(stats);

  /** 重算统计：当前词数 + 平均复习遍数 */
  const refreshStats = (): void => {
    const words = queue.filter((w) => shown.has(w.id));
    const avg =
      words.length === 0 ? 0 : words.reduce((s, w) => s + (w.attrs?.reviewCount ?? 0), 0) / words.length;
    stats.textContent = `当前：${words.length} 词，平均复习：${Math.round(avg * 10) / 10} 遍`;
  };

  // ── 四个按钮 ──
  const controls = h('div', { class: `paper-controls ${isPhone ? 'phone' : 'wide'}` });

  const btnNext = h('button', { class: 'paper-btn paper-btn-primary', type: 'button', text: '下一个' });
  const btnAgain = h('button', { class: 'paper-btn', type: 'button', text: '再次记忆', title: '本轮为空壳' });
  const btnSave = h('button', { class: 'paper-btn', type: 'button', text: '保存退出' });
  const btnClear = h('button', { class: 'paper-btn paper-btn-danger', type: 'button', text: '删除这张纸' });

  /** 把下一个词放上纸 */
  const revealNext = (): void => {
    const next = queue.find((w) => !shown.has(w.id));
    if (!next) {
      btnNext.disabled = true;
      return;
    }
    const points = stage.layout(queue.filter((w) => shown.has(w.id) || w.id === next.id));
    const p = points[next.id];
    if (!p) {
      btnNext.disabled = true;
      return;
    }
    shown.add(next.id);
    shownOrder.push(next.id);
    // 记下落点：保存时一起存，恢复时原样还原
    placements[next.id] = { x: p.x, y: p.y };
    // 最后一个出现的词自动显示中文
    stage.addWord(next, p, true);
    refreshStats();
    if (!queue.some((w) => !shown.has(w.id))) btnNext.disabled = true;
  };

  btnNext.addEventListener('click', revealNext);
  btnAgain.addEventListener('click', () => toastOk('「再次记忆」本轮是空壳，尚未实现'));
  btnSave.addEventListener('click', () => {
    void (async () => {
      const s: Session = {
        id: session?.id ?? `learn-${Date.now()}`,
        type: 'learn',
        // ★ 存**整个队列的顺序**（不只是已出现的），这样恢复后「下一个」接着原先的抽词顺序往下走
        wordIds: queue.map((w) => w.id),
        // ★ 存每个词的真实落点，恢复时才能一模一样地摆回去
        placements: { ...placements },
        shownIds: [...shownOrder],
        memorizeCount: {},
        spellEnabled: false,
        failedIds: [],
        failDeltas: {},
        examDeltas: {},
        groupId: 0,
        groups: [],
        finished: false,
        createdAt: session?.createdAt ?? Date.now(),
      };
      await dao.session.saveSession(s);
      session = s;
      toastOk(`已保存并退出（${s.shownIds.length} 个词在纸上）`);
      navigate('/home');
    })();
  });

  btnClear.addEventListener('click', () => {
    void (async () => {
      const ok = await confirmModal(
        '删除这张纸',
        '会删掉这张纸上保存的进度（词库本身不受影响）。确定吗？',
        '确定删除',
        true,
      );
      if (!ok) return;
      await dao.session.clearSession();
      navigate('/home');
    })();
  });

  controls.appendChild(btnNext);
  controls.appendChild(btnAgain);
  controls.appendChild(btnSave);
  controls.appendChild(btnClear);
  page.appendChild(controls);

  // 统计行贴着按钮组：宽屏放在按钮组正上方
  if (!isPhone) {
    const box = paperButtonBox();
    stats.style.bottom = `${window.innerHeight - box.group.y + PAPER_UI.statsGap}px`;
  }

  // ── 初始化：优先**恢复上次保存的这张纸**，没有才重新抽词 ──
  void (async () => {
    try {
      const all = await dao.words.listAlive();
      const usable = all.filter((w) => w.status !== 'chopped');
      const byId = new Map(usable.map((w) => [w.id, w]));

      const saved = await dao.session.loadSession();
      if (saved && !saved.finished && saved.type === 'learn' && saved.wordIds.length > 0) {
        const restored = saved.wordIds.map((id) => byId.get(id)).filter((w): w is Word => w !== undefined);
        if (restored.length > 0) {
          session = saved;
          queue = restored;
          for (const [id, p] of Object.entries(saved.placements ?? {})) placements[id] = p;
          // ★ 关键：把「已经出现」的词**按当时的落点**一次性摆回去，不需要再点「下一个」
          for (const id of saved.shownIds ?? []) {
            const w = byId.get(id);
            const p = placements[id];
            if (w && p) {
              shown.add(id);
              shownOrder.push(id);
              stage.addWord(w, p, false);
            }
          }
          if (shown.size > 0) stage.showMeaning(shownOrder[shownOrder.length - 1]);
          refreshStats();
          if (!queue.some((w) => !shown.has(w.id))) btnNext.disabled = true;
          toastOk(`已恢复上次的这张纸（${shown.size} 个词在位）`);
          return;
        }
      }

      queue = pickForLearn(usable, MAX_ON_PAPER);
      if (queue.length === 0) {
        toastOk('词库是空的，先去「录入」加词');
        navigate('/home');
        return;
      }
      if (!destroyed) revealNext();
    } catch (err) {
      console.error('[learn/paper] 初始化失败', err);
      toastOk('读取词库失败');
    }
  })();

  registerCleanup(page, () => {
    destroyed = true;
    stage.destroy();
  });

  return page;
}

/** 用浏览器内置语音念一个词（完整 TTS 抽象层仍归档在 已归档/12） */
function speak(text: string): void {
  try {
    const s = getSettings();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = s.speech.rate;
    u.lang = s.speech.accent;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
  } catch {
    /* 没有语音能力就静默 */
  }
}

/** 右上角提示（用户要求把「斩」后的绿条从右下角改到右上角） */
function toastOkAtTop(text: string): void {
  const box = h('div', { class: 'paper-toast-top' });
  box.appendChild(h('span', { text }));
  document.body.appendChild(box);
  window.setTimeout(() => box.remove(), 2200);
}

/** 供 `button()` 之外的地方复用（无） */
void button;
