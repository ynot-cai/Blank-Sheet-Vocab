// RULES-R1: 此处禁止任何强制时间限制（无倒计时 / 无超时提交 / 无超时判错）
import { getSettings } from '../../../core/config';
import { seedFromString } from '../../../core/layout';
import { pickForMemorize } from '../../../core/pick';
import type { Session, Word } from '../../../core/types';
import * as dao from '../../../dao';
import { cancelSpeak } from '../../../services/tts';
import { button, h } from '../../dom';
import { openModal, confirmModal, type ModalHandle } from '../../components/Modal';
import { mountSpeechGate } from '../../components/SpeechGate';
import { showUndoToast, toastError, toastOk, toastWarn } from '../../components/Toast';
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
    // ★ 「每词已记忆 N/M」说的是**已经在纸上的词**（这一轮实际在背的这批）。
    //   原来拿整个队列算最小值：队列里还没上纸的词都是 0 遍，于是刚背完一轮
    //   也显示「每词已记忆 0/1」，用户会以为记忆根本没生效（实测反馈）。
    const onPaper = alive.filter((w) => session.shownIds.includes(w.id));
    const minMem = onPaper.length > 0 ? Math.min(...onPaper.map((w) => session.memorizeCount[w.id] ?? 0)) : 0;
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

  /**
   * 卡片编辑的写库队列（**每次改动都一定会落盘**）。
   *
   * ★★ 用户报的 bug（2026-09）：「在背诵过程中修改单词卡的行为名存实亡，
   *    所有的修改根本不会保存」。原因有两层，都在这里修掉：
   *
   * 1. **原来是一个共享的 `debounce`**（只记住最后一次调用的参数）。
   *    连续改**两个不同的词**（相隔不到 600ms）时，前一个词的改动会被直接丢掉：
   *    界面上看着改了、内存里也改了，但**库里永远是旧的** —— 一刷新就「改了个寂寞」。
   *    现在按词 id 存进 `Map`，同一词只留最新值、不同词各写各的，一个都不丢。
   * 2. **原来是 `void dao.words.put(w)`**：写库失败（例如 §0.11 那类陈旧连接）
   *    会被静默吞掉，用户完全看不到。现在失败会弹提示，不再「悄悄不保存」。
   *
   * 另外在「背完了 / 保存并退出 / 重新开始 / 页面销毁」之前都会 `flushEdits()`：
   * 防抖窗口内直接归档的话，那次迟到的写入会带着**旧的 status** 把刚写的 learned 覆盖回去。
   */
  const pendingEdits = new Map<string, Word>();
  let editTimer: number | null = null;

  /** 把待写库的编辑立刻全部落盘（取消防抖计时器，写完再返回） */
  const flushEdits = async (): Promise<void> => {
    if (editTimer !== null) {
      window.clearTimeout(editTimer);
      editTimer = null;
    }
    const batch = [...pendingEdits.values()];
    pendingEdits.clear();
    if (batch.length === 0) return;
    try {
      // ★ 合并而不是整行覆盖：卡片编辑只动「内容」三个字段，
      //   状态 / 属性 / 优先级 / 学习顺序 / 墓碑一律以**库里的最新值**为准。
      //   不这么做的话，一次迟到的写入会把刚做的「斩」「归档」「改状态」悄悄覆盖回去
      //   （实测：改完卡片 600ms 内点斩，词会自己复活成未背）。
      const fresh = new Map((await dao.words.getAll()).map((w) => [w.id, w]));
      const merged: Word[] = [];
      for (const edit of batch) {
        const stored = fresh.get(edit.id);
        merged.push(
          stored
            ? { ...stored, phonetic: edit.phonetic, example: edit.example, senses: edit.senses }
            : edit,
        );
      }
      await dao.words.bulkUpsert(merged);
    } catch (err) {
      console.error('[paper] 单词改动写库失败', err);
      toastError('单词改动没能存进本地库，请再改一次或到设置页看看数据库状态');
    }
  };

  /** 排队一次编辑（防抖 600ms 后写库；不同词互不影响） */
  const queueEdit = (w: Word): void => {
    pendingEdits.set(w.id, w);
    if (editTimer !== null) window.clearTimeout(editTimer);
    editTimer = window.setTimeout(() => {
      editTimer = null;
      void flushEdits();
    }, 600);
  };

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
      // ★ 一定写库（按词排队，连改多个词也不会丢任何一个）
      queueEdit(next);
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
    await flushEdits(); // 卡片编辑先落盘，别被重开带走
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
    await flushEdits(); // ★ 卡片编辑先落盘再退（防抖窗口内退出也不会丢）
    await exitMidway(session);
    toastOk(
      mode === 'review'
        ? `已保存进度，下次从第 ${opts.groupIndex + 1} 组继续`
        : '已保存进度（词单、位置与每词记忆次数）',
    );
    navigate('/home');
  };

  /**
   * 背完了：归档（写回未通过次数、标记已背），完全结束本次背诵。
   *
   * ★ 归档的**只有本轮上过纸的词**（`shownIds`）——用户报过严重 bug：
   *   只点了 4 个词上纸，点「背完了」却把整个词库都标成了已背。
   *   队列里没轮到的词必须原样留着（仍是「未背」），下次继续背。
   */
  const finishAll = async (): Promise<void> => {
    if (destroyed || roundBusy || flowMode !== 'browse') return;
    if (!allQualified()) {
      toastWarn('每个词都记忆达标后，「背完了」才会出现');
      return;
    }
    // 先把待写库的卡片编辑落盘，再归档：否则 600ms 后的那次防抖写入
    // 会带着「旧的 status」把刚写上的 learned 覆盖回去（实测过）。
    await flushEdits();
    const rest = words.filter((w) => !session.shownIds.includes(w.id)).length;
    const n = await finishLearn(session, settings().failCountCap);
    toastOk(
      rest > 0
        ? `已归档 ${n} 个词（就是本轮上过纸的这些）；队列里还有 ${rest} 个没上纸，仍是「未背」`
        : `已归档 ${n} 个词，本次背诵完成`,
    );
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
    // 路由切走前把待写库的卡片编辑落盘（不等它返回：IndexedDB 写入不随路由销毁）
    void flushEdits();
    window.removeEventListener('keydown', onKey);
    stage.destroy();
    root.remove();
    opts.onDestroy?.();
  };

  /**
   * 挂载初始化：载词 → 恢复进度（落点 + 已出现的词 + 记忆次数）。
   *
   * ★★ 用户报的 bug（2026-09）：「保存并退出」后重进**又是一面白纸**。
   *    根因是这里的判断条件写得太死：`haveSaved` 要求**队列里每一个词**都有落点，
   *    而落点是「点一个算一个」的 —— 队列里有 100 个词、只点了 4 个上纸时，
   *    条件永远不成立，于是走了重算分支：位置被重算、**一个词都不画回白纸**，
   *    用户看到的就是一张白纸（记忆次数其实还在，只是看不见）。
   *
   * 现在的口径：**只要「上过纸的词」有落点，就恢复**；恢复不了的那几个
   * （老存档 / 中途换过词）当场补一个落点，也照样画出来。
   * 一句话：`shownIds` 里有几个词，重进就必须看到几个词 —— 绝不允许白纸。
   */
  void (async () => {
    const all = await dao.words.getAll();
    wordMap = new Map(all.map((w) => [w.id, w]));
    words = groupIds()
      .map((id) => wordMap.get(id))
      .filter((w): w is Word => w !== undefined && w.status !== 'chopped');

    session.shownIds = session.shownIds.filter((id) => words.some((w) => w.id === id));
    const shownSet = new Set(session.shownIds);
    const shownWords = words.filter((w) => shownSet.has(w.id));

    // 需要重新布点的情况：队列里有**任何一个**词还没有落点
    //（新会话、老存档、或者中途往队列里加过词）——没有落点就上不了纸。
    // 只要落点齐（正常「保存并退出」之后就是齐的），就原样恢复，**位置一个都不变**。
    const needNewPlacements = words.some((w) => session.placements[w.id] === undefined);
    if (needNewPlacements) {
      session.placements = stage.computePlacements(words, seedFromString(`${session.id}#${opts.groupIndex}`));
    } else {
      stage.restorePlacements(session.placements);
    }
    // ★ 关键：无论走哪条分支，**已出现过的词都要按落点画回白纸**。
    //   老代码在「重算」分支里一个词都不画 —— 那就是用户看到的白纸。
    for (const w of shownWords) {
      const p = session.placements[w.id];
      if (p) stage.addWord(w, p, { animate: false });
    }
    // 已出现的词在队列里是连续的一段前缀，所以「已出现 N 个」= 下一个该上的下标
    browseIndex = shownWords.length;
    if (needNewPlacements) await dao.session.saveSession(session); // 新落点立刻落盘

    stage.applySettings();
    refreshUi();
    if (opts.startInMemorize) startMemorize();
  })();

  return { root, startMemorize, destroy };
}
