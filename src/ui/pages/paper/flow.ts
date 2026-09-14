// RULES-R1: 此处禁止任何强制时间限制（无倒计时 / 无超时提交 / 无超时判错）
import { getSettings } from '../../../core/config';
import { seedFromString } from '../../../core/layout';
import { pickForMemorize } from '../../../core/pick';
import type { Session, Word } from '../../../core/types';
import * as dao from '../../../dao';
import { cancelSpeak } from '../../../services/tts';
import { button, debounce, h } from '../../dom';
import { openModal, confirmModal, type ModalHandle } from '../../components/Modal';
import { mountSpeechGate } from '../../components/SpeechGate';
import { showUndoToast, toastOk, toastWarn } from '../../components/Toast';
import { renderWordCard } from '../../components/WordCard';
import { navigate } from '../../router';
import { createPaperStage } from './PaperStage';
import type { AnswerCardActions } from './AnswerCard';
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
  /**
   * 词被斩时通知（复习页要从当前组与后续组移除）。
   * ★ 返回值是「撤销这次移除」的函数：RULES-R3 的撤销要把它调回来，
   *   否则词虽然复活了，却不在复习分组里（下一组就少了它）。
   */
  onWordChopped?: (id: string) => void | (() => void);
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
 * ⭐ 用户口径（2026-09）：抽词规则、拼写环节的词源、「保存并退出」保留什么，
 *    都以下面各处的 `⚠️/★ 用户口径` 注释为准（那些提示词 md 已按用户要求从仓库删除）。
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
  // ★ 用户要求「下次点击直接开始」之后，续跑是自动的，于是必须有一个显式的
  //   「把这一轮丢掉、从零开始」入口，否则保存过的进度就再也甩不掉了。
  //   这是**破坏性**操作（丢掉位置与每词记忆遍数），所以保留二次确认——
  //   RULES-R3 的「不弹确认」只管「斩」，不管这里。
  const btnRestart = button('重新开始', () => void restartRound(), { class: 'paper-restart' });
  const controls = h('div', { class: 'paper-controls' }, progress, btnDone, btnSave, btnAgain, btnRestart, btnNext);
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

  /** 取某词的最新内存副本（用户可能刚在卡里改过义项） */
  const latestWord = (word: Word): Word => wordMap.get(word.id) ?? word;

  /**
   * 卡片上的操作（改义项 / 拼 / 斩）。
   *
   * ★ 抽成一份是必须的：普通界面点中文意思打开的卡、以及**记忆环节的答案卡**，
   *   用的是同一个 `renderWordCard`；两处各写一套回调的话，
   *   会出现「普通卡里改了义项生效，答案卡里改了不生效」这种很难查的不一致。
   *
   * @param word 这张卡对应的词（回调内部每次取最新副本）
   */
  const cardActionsFor = (word: Word): AnswerCardActions => ({
    onChange: (next: Word) => {
      wordMap.set(next.id, next);
      const idx = words.findIndex((w) => w.id === next.id);
      if (idx >= 0) words[idx] = next;
      persistEdit(next);
    },
    onSpell: (need: boolean) => {
      const w = latestWord(word);
      const next: Word = { ...w, attrs: { ...w.attrs, needSpell: need } };
      wordMap.set(next.id, next);
      const idx = words.findIndex((x) => x.id === next.id);
      if (idx >= 0) words[idx] = next;
      void dao.words.updateAttrs(word.id, { needSpell: need });
    },
    onChop: () => {
      // RULES-R3: 斩不弹确认，但必须提供 ≥8 秒的撤销 Toast。
      // 传最新副本而不是 `word`：用户可能刚在卡片里改过义项，
      // 撤销后要重画回白纸的是**改过的**那一份，否则白纸上会显示旧意思。
      void chopWord(latestWord(word));
    },
  });

  /** 点中文意思 → 单词卡（编辑 / 拼 / 斩） */
  const openCard = (word: Word): void => {
    if (destroyed) return;
    let handle: ModalHandle | null = null;
    const actions = cardActionsFor(word);
    handle = openModal({
      title: `单词卡 —— ${word.en}`,
      width: '640px',
      body: renderWordCard(word, {
        editable: true,
        onChange: actions.onChange,
        onSpell: actions.onSpell,
        // 弹窗里斩完顺手关掉弹窗（答案卡不是弹窗，没这一步）
        onChop: () => {
          actions.onChop?.();
          handle?.close();
        },
      }),
    });
  };

  /**
   * 斩词：画布移除 + 会话词单移除（复习时通知页面同步各分组）。
   *
   * ★ RULES-R3: 斩不弹确认，但必须提供 ≥8 秒的撤销 Toast。
   *   撤销必须**完全恢复**，所以斩之前要把「怎么恢复」需要的东西全记下来：
   *   原状态、在词单里的位置、是否已出现在纸上、落点。
   *   只把 `status` 改回来的话，词会回到库里但**不在白纸上**，
   *   用户看到的是「撤销了但什么都没变」——这是最容易漏的一处。
   *
   * @param word 要斩的词
   */
  const chopWord = async (word: Word): Promise<void> => {
    const prevStatus = word.status;
    const prevIndex = words.findIndex((w) => w.id === word.id);
    const prevWordIdIndex = session.wordIds.indexOf(word.id);
    const wasShown = session.shownIds.includes(word.id);
    const placement = session.placements[word.id];

    await dao.words.chop(word.id);
    stage.removeWord(word.id);
    words = words.filter((w) => w.id !== word.id);
    wordMap.delete(word.id);
    session.wordIds = session.wordIds.filter((id) => id !== word.id);
    session.shownIds = session.shownIds.filter((id) => id !== word.id);
    // 复习页要同步各组；它返回的撤销函数在下面撤销时调回
    const undoGroups = mode === 'review' ? opts.onWordChopped?.(word.id) : undefined;
    browseIndex = words.reduce((n, w) => n + (session.shownIds.includes(w.id) ? 1 : 0), 0);
    await dao.session.saveSession(session);
    refreshUi();

    // RULES-R3: 斩不弹确认，但必须提供 ≥8 秒的撤销 Toast
    showUndoToast(`已斩 ${word.en}`, async () => {
      const restored: Word = { ...word, status: prevStatus };
      await dao.words.setStatus(word.id, prevStatus);
      // 插回原来的位置：追加到末尾的话，「再背一个」的顺序会和斩之前不一样
      words.splice(prevIndex < 0 ? words.length : Math.min(prevIndex, words.length), 0, restored);
      wordMap.set(word.id, restored);
      if (prevWordIdIndex >= 0) session.wordIds.splice(Math.min(prevWordIdIndex, session.wordIds.length), 0, word.id);
      else if (!session.wordIds.includes(word.id)) session.wordIds.push(word.id);
      if (wasShown && !session.shownIds.includes(word.id)) session.shownIds.push(word.id);
      if (placement !== undefined) {
        session.placements[word.id] = placement;
        // 原本已经上纸的词，撤销后要重新画回白纸（否则它「回来了」但看不见）
        if (wasShown) stage.addWord(restored, placement, { animate: false });
      }
      undoGroups?.();
      browseIndex = words.reduce((n, w) => n + (session.shownIds.includes(w.id) ? 1 : 0), 0);
      await dao.session.saveSession(session);
      refreshUi();
    });
  };

  /**
   * 再次记忆 / 每 N 个新词后的记忆：只抽已出现在纸上的词。
   *
   * ⭐ 用户口径（2026-09）：「假设设置里填『最大 10 个』。若目前只出现了 3 个，
   *    那就只进行 3 次。如果有超过 10 个，优先按『已经抽到的次数最低』排序，
   *    遍数相同时随机抽；如果上一轮有单词未通过、又没被前面的机制抽到，
   *    则作为**额外项**加入（也就是最终超过 10 个）。」
   *    规则的实现在 `core/pick.ts` 的 `pickForMemorize`（含与旧写法的差异说明）。
   */
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
        // 词在答题途中被斩掉了就不算「已作答」：它已经不在本轮词单里，
        // 再往 shownIds 里塞回去，等于让一张斩掉的卡重新参与统计与抽词。
        if (!session.wordIds.includes(id)) return;
        session.memorizeCount[id] = (session.memorizeCount[id] ?? 0) + 1;
        if (!session.shownIds.includes(id)) session.shownIds.push(id);
      },
      isAborted: () => aborted,
      // ★ 答案卡 = 普通单词卡：考察中也能随时改义项 / 拼 / 斩
      cardActionsFor,
    };

    // 记下本轮开始前每词的未通过次数，跑完一比就知道「本轮谁没通过」
    const failBefore = new Map(picked.map((id) => [id, session.failDeltas[id] ?? 0]));

    await runMemorizeRound(host, picked);
    if (destroyed) return;

    // ★ 记忆抽词的「额外项」依据：**上一轮**没通过的词。
    //   只记本轮，不累积 —— 累积的话，一个很早以前错过的词会被永远强制抽到。
    session.lastRoundFailedIds = picked.filter((id) => (session.failDeltas[id] ?? 0) > (failBefore.get(id) ?? 0));

    if (!aborted) {
      // 本轮抽中的词里有需拼写的 → 自动进入拼写环节
      // （★ 用户重申：拼写不是另外抽的，就是**当次记忆选到的词**里标了「拼」的那些）
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
    // 本轮的记忆遍数、未通过情况立刻落库：用户直接关掉页面也不会丢
    // （「保存并退出」会再存一次，两条路都写，谁先发生都不会漏）
    await dao.session.saveSession(session);

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

  /**
   * 重新开始：丢掉保存的进度，按当前词库重开一轮。
   *
   * 为什么需要它：续跑改成自动之后（「下次点击直接开始」），
   * 没有这个入口的话，一份保存过的会话就再也甩不掉了。
   * 这是破坏性操作（丢位置与每词记忆遍数），所以有二次确认。
   */
  const restartRound = async (): Promise<void> => {
    if (destroyed || roundBusy) return;
    const ok = await confirmModal('重新开始这一轮？', '会丢掉保存的位置与每个词的记忆遍数，重新按当前词库开始一轮背诵。', '重新开始', true);
    if (!ok) return;
    await dao.session.clearSession();
    navigate('/learn');
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
    const target = ev.target;
    // 焦点在输入控件/按钮上时**让给浏览器原生**。
    // 为什么答案卡也要判：答案卡现在是可编辑的（用户可以在里面改义项、标记拼写），
    // 在里面打字按 Enter 必须留给输入框，不能被当成「答案看完了」。
    if (target instanceof HTMLElement && ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(target.tagName)) return;
    if (isAnswerCardOpen()) {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        advanceAnswerCard();
      }
      return;
    }
    if (ev.key !== 'Enter') return;
    if (document.querySelector('.modal-mask')) return;
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
