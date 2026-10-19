/**
 * 白纸界面（`#/learn/paper?paper=<id>`）—— 版本 0.0.14。
 *
 * 这一版把白纸接到**存档**上（用户「二、白纸存档机制」）：
 *   进入时按 `?paper=` 读回那张 `PaperArchive`（临时优先级表 + 种子 + 已出现名单 + 落点），
 *   「下一个」按临时优先级取词（同优先级首字母升序），「背完了」命名并永久存档。
 *
 * 三个历史问题的落点仍是 `geometry.ts`（避让向外扩）、`PaperStage.refreshWord`（改中文即时刷新）。
 */
import { PAPER_UI } from '../../core/config';
import { nextWord, orderByPriority, type PriorityTable } from '../../core/learnSelect';
import type { PaperArchive, Word } from '../../core/types';
import * as dao from '../../dao';
import { deviceKind } from '../device';
import { h } from '../dom';
import { confirmModal, promptModal } from '../components/Modal';
import { toastOk, toastWarn } from '../components/Toast';
import { navigate, registerCleanup } from '../router';
import { createPaperStage, type PaperStageHandle } from './paper/PaperStage';
import { applyPaperButtonVars, paperButtonBox } from './paper/geometry';
import { renderWordCard } from '../components/WordCard';
import { mountSpeechGate } from '../components/SpeechGate';

/** 从 hash 里取 `?paper=<id>` */
function readPaperId(): string {
  const raw = window.location.hash.replace(/^#/, '');
  const q = raw.split('?')[1] ?? '';
  return new URLSearchParams(q).get('paper') ?? '';
}

/** 今天（YYYY-MM-DD）——「背完了」不命名时用它 */
function today(): string {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
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
    onMeaningClick: (word) => showWordCard(word),
  });
  page.appendChild(stage.root);

  /**
   * ★ 版本 0.0.19：恢复归档的「语音解锁层」（iOS 首次朗读必须在用户手势里触发）。
   *
   * 它自己判断要不要出现：只有 iOS/iPadOS 这类有 WebKit 手势限制、且本设备还没解锁过时
   * 才盖一层「点击开始」；桌面/安卓**完全不出现**，不会成为多出来的视觉元素。
   * 做法照归档 `已归档/12` 第 12 节与 `已归档/02` 白纸流程的调用方式（挂在页面根上）。
   */
  mountSpeechGate(page, () => undefined);

  /**
   * ★ 版本 0.0.17（用户纠正）：单词卡 = **归档版的正中弹窗**。
   * 外壳照抄归档 `showAnswerCard` 的 `.answer-card`（fixed + 50%/50% 居中 + 点外部关），
   * 内容用仓库里还原的归档共享组件 `renderWordCard`（编辑 / SenseEditor / 拼 / 斩）。
   */
  function showWordCard(word: Word): void {
    if (document.querySelector('.answer-card')) return; // 同一时间只开一张
    const card = h('div', { class: 'answer-card' });
    const x = h('button', { class: 'paper-card-close', type: 'button', text: '×', title: '关闭' });
    x.addEventListener('click', () => card.remove());
    card.appendChild(x);
    card.appendChild(
      renderWordCard(word, {
        editable: true,
        onChange: (next) => {
          void (async () => {
            await dao.words.put(next);
            stage.refreshWord(next);
            const i = queue.findIndex((w) => w.id === next.id);
            if (i >= 0) queue[i] = next;
            toastOk('已保存');
          })();
        },
        onChop: () => {
          void (async () => {
            await dao.words.chop(word.id);
            toastTop(`已斩「${word.en}」`);
          })();
        },
      }),
    );
    card.appendChild(h('div', { class: 'answer-hint', text: '点击卡片外部关闭；卡内可以直接修改' }));
    const onDocClick = (ev: MouseEvent): void => {
      const t = ev.target;
      /**
       * 点卡片外部关闭。
       *
       * ★ 0.0.20：义项的右键菜单（`.sense-ctx-menu`）挂在 `body` 上、**不在** `.answer-card` 里，
       *   所以必须一并排除——否则「右键 → 点删除」的第一下就把整张卡关掉了（实测踩过：
       *   删除菜单点了没反应，卡先没了）。菜单自己会在点任意处后关闭。
       */
      if (t instanceof Element && t.closest('.answer-card') === null && t.closest('.sense-ctx-menu') === null) {
        document.removeEventListener('click', onDocClick, true);
        card.remove();
      }
    };
    // 打开卡的那一下 click 已经派发完毕，现在挂监听不会把自己关掉
    document.addEventListener('click', onDocClick, true);
    document.body.appendChild(card);
  }

  /** 这张纸的存档 */
  let paper: PaperArchive | null = null;
  /** 本轮队列（已按临时优先级排好） */
  let queue: Word[] = [];
  /** 临时优先级表（来自存档） */
  let table: PriorityTable = {};
  const shownOrder: string[] = [];
  const shown = new Set<string>();
  let destroyed = false;

  // ── 统计行 ──
  const stats = h('div', { class: `paper-stats ${isPhone ? 'phone' : 'wide'}`, text: '当前：0 词，平均复习：0 遍' });
  page.appendChild(stats);

  const refreshStats = (): void => {
    const list = queue.filter((w) => shown.has(w.id));
    const avg = list.length === 0 ? 0 : list.reduce((s, w) => s + (w.attrs?.reviewCount ?? 0), 0) / list.length;
    stats.textContent = `当前：${list.length} 词，平均复习：${Math.round(avg * 10) / 10} 遍`;
  };

  /** 把当前进度写回存档（每次上纸都写，保证「继续背诵」里的词数是准的） */
  const persist = async (): Promise<void> => {
    if (!paper) return;
    paper.shownIds = [...shownOrder];
    await dao.papers.put(paper);
  };

  // ── 五个按钮 ──
  const controls = h('div', { class: `paper-controls ${isPhone ? 'phone' : 'wide'}` });
  const btnNext = h('button', { class: 'paper-btn paper-btn-primary', type: 'button', text: '下一个' });
  const btnAgain = h('button', { class: 'paper-btn', type: 'button', text: '再次记忆', title: '本轮为空壳' });
  const btnDone = h('button', { class: 'paper-btn', type: 'button', text: '背完了' });
  const btnSave = h('button', { class: 'paper-btn', type: 'button', text: '保存并退出' });
  const btnClear = h('button', { class: 'paper-btn paper-btn-danger', type: 'button', text: '删除这张纸' });

  /** 下一个：按临时优先级取，优先级为 0 就提示「没有单词了」 */
  const revealNext = async (): Promise<void> => {
    if (!paper) return;
    const next = nextWord(queue, table, shown);
    if (!next) {
      toastWarn('没有单词了');
      return;
    }
    const placements = stage.layout(queue, paper.seed);
    const p = placements[next.id];
    if (!p) {
      toastWarn('这张纸放不下更多单词了');
      return;
    }
    shown.add(next.id);
    shownOrder.push(next.id);
    paper.placements[next.id] = { x: p.x, y: p.y };
    stage.addWord(next, p, true);
    refreshStats();
    await persist();
  };

  btnNext.addEventListener('click', () => void revealNext());
  btnAgain.addEventListener('click', () => toastOk('「再次记忆」本轮是空壳，尚未实现'));

  // ── 背完了：命名 → 清空临时优先级表 → 永久存档 ──
  btnDone.addEventListener('click', () => {
    void (async () => {
      if (!paper) return;
      const name = await promptModal('命名白纸', '给这张纸起个名字；不填就用今天的日期。', paper.name);
      if (name === null) return; // 关掉弹窗 = 取消
      const finalName = name.trim() === '' ? today() : name.trim();
      // 用户要求：永久存档时**清空临时优先级表**
      await dao.papers.put({ ...paper, name: finalName, priorityTable: {}, status: 'finished' });
      toastOk(`已存档「${finalName}」`);
      navigate('/home');
    })();
  });

  btnSave.addEventListener('click', () => {
    void (async () => {
      if (!paper) return;
      // 「保存并退出」= 记录这张 draft 存档（含种子与已出现名单），下次从「继续背诵」进来接着背。
      // ⚠️ 「并上传相关考核数据」本轮不做（用户第四节：成绩/考核后续实现）。
      await dao.papers.put(paper);
      toastOk(`已保存并退出（${shownOrder.length} 个词在纸上）`);
      navigate('/home');
    })();
  });

  btnClear.addEventListener('click', () => {
    void (async () => {
      if (!paper) return;
      const ok = await confirmModal(
        '删除这张纸',
        '会删除这张白纸存档（词库本身不受影响）。确定吗？',
        '确定删除',
        true,
      );
      if (!ok) return;
      await dao.papers.remove(paper.id);
      navigate('/home');
    })();
  });

  controls.appendChild(btnNext);
  controls.appendChild(btnAgain);
  controls.appendChild(btnDone);
  controls.appendChild(btnSave);
  controls.appendChild(btnClear);
  page.appendChild(controls);

  if (!isPhone) {
    const box = paperButtonBox();
    stats.style.bottom = `${window.innerHeight - box.group.y + PAPER_UI.statsGap}px`;
  }

  // ── 初始化：读存档 → 取词 → 还原已出现的词 ──
  void (async () => {
    try {
      const id = readPaperId();
      const found = id === '' ? null : await dao.papers.get(id);
      if (!found) {
        toastWarn('找不到这张白纸，请从「背诵」重新开始');
        navigate('/learn');
        return;
      }
      paper = found;
      table = found.priorityTable ?? {};

      const all = await dao.words.listAlive();
      const usable = all.filter((w) => w.status !== 'chopped');
      queue = orderByPriority(usable, table);
      if (queue.length === 0) {
        toastWarn('这张纸没有可选单词了');
        navigate('/learn');
        return;
      }

      // 还原已经出现的词：按存档里记的落点原位摆回，**不需要再点「下一个」**
      for (const wid of found.shownIds ?? []) {
        const w = usable.find((x) => x.id === wid);
        const p = found.placements?.[wid];
        if (w && p) {
          shown.add(wid);
          shownOrder.push(wid);
          stage.addWord(w, p, false);
        }
      }
      if (shownOrder.length > 0) stage.showMeaning(shownOrder[shownOrder.length - 1]);
      refreshStats();

      if (shownOrder.length === 0) await revealNext();
    } catch (err) {
      console.error('[learn/paper] 初始化失败', err);
      toastWarn('读取白纸存档失败');
    }
  })();

  registerCleanup(page, () => {
    destroyed = true;
    stage.destroy();
  });
  void destroyed;

  return page;
}


/** 右上角提示（用户要求把「斩」后的提示放右上角） */
function toastTop(text: string): void {
  const box = h('div', { class: 'paper-toast-top' });
  box.appendChild(h('span', { text }));
  document.body.appendChild(box);
  window.setTimeout(() => box.remove(), 2200);
}
