import { getSettings } from '../../../core/config';
import { seedFromString } from '../../../core/layout';
import { pickForMemorize } from '../../../core/pick';
import type { Session, Word } from '../../../core/types';
import * as dao from '../../../dao';
import { cancelSpeak } from '../../../services/tts';
import { button, debounce, h } from '../../dom';
import { confirmModal, openModal } from '../../components/Modal';
import { mountSpeechGate } from '../../components/SpeechGate';
import { toastOk, toastWarn } from '../../components/Toast';
import { renderWordCard } from '../../components/WordCard';
import { navigate } from '../../router';
import { createPaperStage } from './PaperStage';
import type { RoundHost } from './rounds';
import { runMemorizeRound, runSpellRound } from './rounds';
import { isAnswerCardOpen, advanceAnswerCard } from './AnswerCard';
import { exitMidway, finishLearn } from './finish';

/** 白纸流程参数（背诵 / 复习的每一组共用这一套引擎，不复制代码） */
export interface FlowOptions {
  session: Session;
  mode: 'learn' | 'review';
  groupIndex: number;
  groupCount: number;
  /** 挂载后直接进入记忆模式（/memorize 路由直入用） */
  startInMemorize?: boolean;
  /** 复习：当前组达标（全部出现 + 每词记忆达标）后回调（页面弹「继续下一组 / 休息」） */
  onGroupDone?: () => void;
  /** 词被斩时通知（复习页要从当前组与后续组移除） */
  onWordChopped?: (id: string) => void;
  /** 销毁时回调 */
  onDestroy?: () => void;
}

/** 白纸流程句柄 */
export interface PaperFlow {
  root: HTMLElement;
  startMemorize: () => void;
  destroy: () => void;
}

/**
 * 创建白纸流程。
 * 所有按钮集中在右下角：进度 →（背完了）→ 保存并退出 → 再次记忆 → 再背一个（每 memorizeEvery 个
 * 新词自动变成「记忆」）。单词点击切换词下中文意思；点中文意思开单词卡。
 * 记忆环节只抽已出现在纸上的词（不满 maxPick 就按已出现数量）。
 * @param opts 会话与模式
 */
export function createPaperFlow(opts: FlowOptions): PaperFlow {
  const session = opts.session;
  const mode = opts.mode;
  const settings = (): ReturnType<typeof getSettings> => getSettings();

  let words: Word[] = [];
  let wordMap = new Map<string, Word>();
  let browseIndex = 0;
  let flowMode: 'browse' | 'memorize' | 'spell' = 'browse';
  let aborted = false;
  let roundBusy = false;
  let pendingSave = false;
  let sinceBatch = 0; // 本轮「再背一个」加过几个新词（每 memorizeEvery 个提示一次记忆）
  let destroyed = false;

  const stage = createPaperStage({
    onWordClick: (word) => {
      stage.toggleMeaning(word.id);
    },
    onMeaningClick: (word) => openCard(word),
  });

  // —— 右下角按钮组 ——
  const progress = h('div', { class: 'paper-progress', text: '' });
  const btnDone = button('背完了', () => void finishAll(), { variant: 'primary', class: 'paper-done hidden' });
  const btnSave = button('保存并退出', () => void saveAndExit());
  const btnAgain = button('再次记忆', () => startMemorize());
  const btnNext = button('再背一个 (Enter)', () => nextAction(), { variant: 'primary', class: 'paper-next' });
  const controls = h('div', { class: 'paper-controls' }, progress, btnDone, btnSave, btnAgain, btnNext);
  const root = h('div', { class: 'paper-flow' }, stage.root, controls);

  // iOS：语音首次必须在用户手势里启动，所以先盖一层「点击开始」（非 iOS 自动跳过）。
  // 解锁只解决「能不能出声」，不影响流程——真正的第一个词由「再背一个」带出来。
  mountSpeechGate(root, () => undefined);

  /** 当前组要背的词 id（learn = 全部 wordIds；review = 当前组） */
  const groupIds = (): string[] => (mode === 'learn' ? session.wordIds : session.groups[opts.groupIndex] ?? []);

  /** 是否处于「每 N 个新词 → 按钮变记忆」状态 */
  const batchReady = (): boolean => sinceBatch > 0 && sinceBatch >= settings().memorizeEvery;

  /** 全部词都记忆达标（「背完了」出现条件） */
  const allQualified = (): boolean => {
    const target = settings().memorizeTargetCount;
    const alive = words.filter((w) => session.shownIds.includes(w.id));
    return alive.length > 0 && alive.every((w) => (session.memorizeCount[w.id] ?? 0) >= target);
  };

  /** 刷新右下角按钮与进度 */
  const refreshUi = (): void => {
    const target = settings().memorizeTargetCount;
    const alive = words;
    const minMem = alive.length > 0 ? Math.min(...alive.map((w) => session.memorizeCount[w.id] ?? 0)) : 0;
    // 能上纸的数量 = min(词单长度, 间距约束下的纸面容量)；放不下时禁用「再背一个」
    const cap = Math.min(words.length, stage.capacity());
    const paperFull = browseIndex >= cap;
    const qualified = allQualified();

    progress.textContent =
      `${mode === 'review' ? `第 ${opts.groupIndex + 1}/${opts.groupCount} 组 · ` : ''}` +
      `已出现 ${browseIndex}/${cap}${cap < words.length ? '（纸面已满）' : ''} · 每词已记忆 ${minMem}/${target}` +
      (mode === 'learn' && qualified ? ' · 可以点「背完了」' : '');

    btnDone.classList.toggle('hidden', !(mode === 'learn' && qualified));
    btnSave.disabled = false; // 任何时刻都能保存退出（一轮进行中会先中断本轮）
    btnAgain.disabled = roundBusy || alive.length === 0 || session.shownIds.length === 0;
    btnNext.disabled = roundBusy || (paperFull && !batchReady());
    btnNext.textContent = batchReady()
      ? `记忆（新词 ${sinceBatch} 个）`
      : paperFull
        ? cap < words.length
          ? '纸上放不下了'
          : '已全部出现'
        : '再背一个 (Enter)';
  };

  /**
   * 再背一个 / 每 N 个新词后的记忆。
   *
   * ★ R3：浏览阶段是按 `words` 的**数组顺序**逐个上纸的，而 `words` 的顺序来自
   *   `session.wordIds`——它由 `LearnPage` 用 `core/pick.ts` 的 `sortForLearn()`
   *   排好（优先级降序是第一关键字，绝对优先）。
   *   所以「再背一个」天然就是「先抽高优先级的词」，这里不需要再排一次；
   *   真正需要单独抽词的地方（换词、断点续跑后取下一个）用 `pickNextForLearn()`。
   */
  const nextAction = (): void => {
    if (destroyed || flowMode !== 'browse' || roundBusy) return;
    if (batchReady()) {
      startMemorize();
      return;
    }
    const cap = Math.min(words.length, stage.capacity());
    if (browseIndex >= cap) return;
    const word = words[browseIndex];
    browseIndex += 1;
    const placement = stage.placementOf(word?.id ?? '');
    if (!word || !placement) return;
    // 最新出现的词自动显示中文意思（上一个自动显示的会收起）
    stage.addWord(word, placement, { showMeaning: true });
    if (!session.shownIds.includes(word.id)) session.shownIds.push(word.id);
    if (settings().practice.autoSpeak) stage.speakWord(word);
    sinceBatch += 1;
    refreshUi();
  };

  /** 编辑写入（防抖写库） */
  const persistEdit = debounce((w: Word) => {
    void dao.words.put(w);
  }, 600);

  /** 点中文意思 → 单词卡（编辑 / 拼 / 斩） */
  const openCard = (word: Word): void => {
    if (destroyed) return;
    let draft: Word = word;
    const apply = (next: Word): void => {
      draft = next;
      wordMap.set(next.id, next);
      const idx = words.findIndex((w) => w.id === next.id);
      if (idx >= 0) words[idx] = next;
    };
    const handle = openModal({
      title: `单词卡 —— ${word.en}`,
      width: '640px',
      body: renderWordCard(word, {
        editable: true,
        onChange: (next) => {
          apply(next);
          persistEdit(next);
        },
        onSpell: (need) => {
          const next = { ...draft, attrs: { ...draft.attrs, needSpell: need } };
          apply(next);
          void dao.words.updateAttrs(word.id, { needSpell: need });
        },
        onChop: () => {
          void (async () => {
            const ok = await confirmModal('确定斩掉？', `「${word.en}」斩后不再出现（列表页可复活）。`, '斩掉', true);
            if (!ok) return;
            await chopWord(word);
            handle.close();
          })();
        },
      }),
    });
  };

  /** 斩词：画布移除 + 会话词单移除（复习时通知页面同步各分组） */
  const chopWord = async (word: Word): Promise<void> => {
    await dao.words.chop(word.id);
    stage.removeWord(word.id);
    words = words.filter((w) => w.id !== word.id);
    wordMap.delete(word.id);
    session.wordIds = session.wordIds.filter((id) => id !== word.id);
    session.shownIds = session.shownIds.filter((id) => id !== word.id);
    if (mode === 'review') opts.onWordChopped?.(word.id);
    browseIndex = words.reduce((n, w) => n + (session.shownIds.includes(w.id) ? 1 : 0), 0);
    await dao.session.saveSession(session);
    refreshUi();
  };

  /** 再次记忆 / 每 N 个新词后的记忆：只抽已出现在纸上的词 */
  const startMemorize = (): void => {
    if (destroyed || roundBusy || flowMode !== 'browse') return;
    const picked = pickForMemorize(session, words, {
      maxPick: settings().memorizeMaxPick,
      targetCount: settings().memorizeTargetCount,
    });
    if (picked.length === 0) {
      toastWarn('纸上还没有词，先点「再背一个」');
      return;
    }
    void runRound(picked);
  };

  /** 一轮：记忆 →（可选）拼写 → 回白纸 */
  const runRound = async (picked: string[]): Promise<void> => {
    roundBusy = true;
    aborted = false;
    flowMode = 'memorize';
    stage.hideWords();
    stage.hideOverlay();
    refreshUi();

    const host: RoundHost = {
      session,
      settings: settings(),
      stage,
      getWord: (id) => wordMap.get(id),
      recordFail: (id) => {
        session.failDeltas[id] = (session.failDeltas[id] ?? 0) + 1;
        if (!session.failedIds.includes(id)) session.failedIds.push(id);
      },
      recordShown: (id) => {
        session.memorizeCount[id] = (session.memorizeCount[id] ?? 0) + 1;
        if (!session.shownIds.includes(id)) session.shownIds.push(id);
      },
      isAborted: () => aborted,
    };

    await runMemorizeRound(host, picked);
    if (destroyed) return;

    if (!aborted) {
      // 本轮抽中的词里有需拼写的 → 自动进入拼写环节
      const spellIds = picked.filter((id) => {
        const w = wordMap.get(id);
        return w !== undefined && w.attrs.needSpell && w.status !== 'chopped';
      });
      if (spellIds.length > 0) {
        flowMode = 'spell';
        refreshUi();
        await runSpellRound(host, spellIds);
      }
    }

    stage.hideOverlay();
    stage.showWords();
    flowMode = 'browse';
    roundBusy = false;
    aborted = false;
    sinceBatch = 0; // 本轮（批次）记忆完成，计数器清零
    if (destroyed) return;
    refreshUi();

    if (pendingSave) {
      pendingSave = false;
      await saveAndExit();
      return;
    }
    if (mode === 'review') {
      // 复习：当前组全部出现且每词记忆达标 → 弹「继续下一组 / 休息」
      const target = settings().memorizeTargetCount;
      const qualified =
        words.length > 0 &&
        words.every((w) => session.shownIds.includes(w.id) && (session.memorizeCount[w.id] ?? 0) >= target);
      if (qualified) opts.onGroupDone?.();
    }
  };

  /** 保存并退出：把词单、每个词的位置和记忆次数都存进会话 */
  const saveAndExit = async (): Promise<void> => {
    if (destroyed) return;
    if (roundBusy && flowMode !== 'browse') {
      pendingSave = true;
      aborted = true; // 先让本轮收尾，再保存退出
      return;
    }
    cancelSpeak();
    await exitMidway(session);
    toastOk(
      mode === 'review'
        ? `已保存进度，下次从第 ${opts.groupIndex + 1} 组继续`
        : '已保存进度（词单、位置与每词记忆次数）',
    );
    navigate('/home');
  };

  /** 背完了：归档（写回未通过次数、标记已背），完全结束本次背诵 */
  const finishAll = async (): Promise<void> => {
    if (destroyed || roundBusy || flowMode !== 'browse') return;
    if (!allQualified()) {
      toastWarn('每个词都记忆达标后，「背完了」才会出现');
      return;
    }
    const n = await finishLearn(session, settings().failCountCap);
    toastOk(`已归档 ${n} 个词，本次背诵完成`);
    navigate('/home');
  };

  /** 全局按键：答案卡（Enter/空格）→ 推进；浏览 → 再背一个；作答 → 提交 */
  const onKey = (ev: KeyboardEvent): void => {
    if (destroyed) return;
    if (isAnswerCardOpen()) {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        advanceAnswerCard();
      }
      return;
    }
    if (ev.key !== 'Enter') return;
    if (document.querySelector('.modal-mask')) return;
    const target = ev.target;
    if (target instanceof HTMLElement && ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(target.tagName)) return;
    if (flowMode === 'browse') nextAction();
    else root.querySelector<HTMLButtonElement>('#mem-submit, #spell-submit')?.click();
  };
  window.addEventListener('keydown', onKey);

  const destroy = (): void => {
    destroyed = true;
    aborted = true;
    window.removeEventListener('keydown', onKey);
    stage.destroy();
    root.remove();
    opts.onDestroy?.();
  };

  /** 挂载初始化：载词 → 有保存的进度就恢复（落点 + 已出现的词 + 记忆次数），否则重新布点 */
  void (async () => {
    const all = await dao.words.getAll();
    wordMap = new Map(all.map((w) => [w.id, w]));
    words = groupIds()
      .map((id) => wordMap.get(id))
      .filter((w): w is Word => w !== undefined && w.status !== 'chopped');

    const shownSet = new Set(session.shownIds);
    const haveSaved = words.length > 0 && words.every((w) => session.placements[w.id] !== undefined);
    if (haveSaved) {
      stage.restorePlacements(session.placements);
      for (const w of words) {
        const p = session.placements[w.id];
        if (shownSet.has(w.id) && p) stage.addWord(w, p, { animate: false });
      }
      session.shownIds = session.shownIds.filter((id) => words.some((w) => w.id === id));
      browseIndex = words.filter((w) => shownSet.has(w.id)).length;
    } else {
      session.placements = stage.computePlacements(words, seedFromString(`${session.id}#${opts.groupIndex}`));
      session.shownIds = session.shownIds.filter((id) => words.some((w) => w.id === id));
      browseIndex = 0;
    }
    stage.applySettings();
    refreshUi();
    if (opts.startInMemorize) startMemorize();
  })();

  return { root, startMemorize, destroy };
}
