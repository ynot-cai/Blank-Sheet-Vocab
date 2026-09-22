// RULES-R1: 此处禁止任何强制时间限制（无倒计时 / 无超时提交 / 无超时判错）
import { coerceColsOverride, getSettings, LAYOUT_COLS_OPTIONS, mergeSettingsPatch, setSettingsCache } from '../../../core/config';
import { controlBandHeight, seedFromString } from '../../../core/layout';
import { pickForMemorize } from '../../../core/pick';
import type { LayoutColsOverride, Session, Word } from '../../../core/types';
import * as dao from '../../../dao';
import { cancelSpeak } from '../../../services/tts';
import { appStore, emitDataChanged } from '../../../state/store';
import { button, h } from '../../dom';
import { openModal, confirmModal, type ModalHandle } from '../../components/Modal';
import { mountSpeechGate } from '../../components/SpeechGate';
import { showUndoToast, toastError, toastOk, toastWarn } from '../../components/Toast';
import { renderWordCard } from '../../components/WordCard';
import { navigate } from '../../router';
import { controlTier, deviceKind } from '../../device';
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
   * ★ T2：复习模式的「结束复习」出口。
   *
   * 为什么需要它：复习页现在只有「保存并退出」（= 中断，不写复习记录）与
   * 「背完了」（= 写回 `reviewCount / lastReviewAt / 优先度`）两种收尾方式，
   * 而 `背完了` 在 `mode === 'learn'` 时才显示 —— 复习模式于是**根本没有
   * 「正常结束并写回数据」的按钮**，用户复习完一圈只能「保存并退出」，
   * 复习次数永远不涨。
   *
   * 由页面决定何时可用（复习页按「这次取出来的词是不是都复习过了」判断），
   * 流程只负责在合适的时候调用它。
   */
  onRequestFinish?: () => void;
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
  /**
   * ★ T2：初始化（载词 + 恢复落点/进度）完成的 Promise。
   *
   * 为什么要暴露：初始化是异步的，完成之前 `words` 是空的 ——
   * 那时按钮状态是错的（「再背一个」会显示成「已全部出现」）。
   * 重新挂载流程的调用方要 `await flow.ready` 之后再判断界面状态。
   */
  ready: Promise<void>;
}

/**
 * 手机上的短文案（圆里只放得下 2~3 个字）。
 * 与按钮文案的对应关系写死在这里，避免「圆里一个词、下面是另一个词」。
 */
const ROUND_LABELS: Record<string, string> = {
  '背完了': '完',
  '保存并退出': '存',
  '再次记忆': '忆',
  '再背一个 (Enter)': '背',
  '再复习一个 (Enter)': '复',
  '重新开始': '重',
};

/** 圆下方的小字（比圆里的字更完整，但仍要短） */
const ROUND_SUB_LABELS: Record<string, string> = {
  '背完了': '背完了',
  '保存并退出': '保存',
  '再次记忆': '记忆',
  '再背一个 (Enter)': '再背',
  '再复习一个 (Enter)': '再复习',
  '重新开始': '重开',
};

/**
 * 圆下方小字的动态文案：原按钮的文案会变（「再背一个」↔「记忆（新词 N 个）」↔
 * 「纸上放不下了」），圆下方的小字也要跟着变，否则会出现「圆里写背、按钮其实在提示放不下」。
 * @param btn 原按钮
 * @returns 小字文案（空串表示不改）
 */
function shortNextLabel(btn: HTMLButtonElement): string {
  const text = btn.textContent ?? '';
  if (text.startsWith('记忆')) return '记忆';
  if (text.startsWith('纸上放不下')) return '纸满';
  if (text.startsWith('已全部出现')) return '已满';
  if (text.startsWith('再背一个')) return '再背';
  // ★ T2：复习模式的同一个按钮（文案不同，行为一致）
  if (text.startsWith('再复习一个')) return '再复习';
  return ROUND_SUB_LABELS[btn.dataset.fullLabel ?? ''] ?? '';
}

/** 建一个带 data-full-label 的按钮（圆按钮靠它找回自己的原按钮） */
function labeledButton(
  text: string,
  onClick: (ev: MouseEvent) => void,
  opts: { variant?: 'primary' | 'danger' | 'ghost'; class?: string } = {},
): HTMLButtonElement {
  const btn = button(text, onClick, opts);
  btn.dataset.fullLabel = text;
  return btn;
}

/**
 * 组装手机版底部圆形按钮带（导出供 `#/dev/layout` 复用）。
 *
 * 尺寸来自 `settings.layout.mobile.button`（直径 / 间距 / 小字字号），
 * 通过 CSS 变量注入 —— 这样「避让带高度」（core/layout.ts 的 controlBandHeight，
 * 用同一份参数算）与按钮的实际位置永远对得上。
 *
 * 为什么按钮文字要换短文案：直径只有 50px，`再背一个 (Enter)` 塞不进去。
 * 完整文案保留在 `title` 上（长按可见），`data-full-label` 供测试与后续调整。
 * @param progress 进度条元素（放在横带上方居中）
 * @param buttons 按钮（顺序即显示顺序）
 */
export function buildRoundControls(progress: HTMLElement, buttons: HTMLButtonElement[]): HTMLElement {
  const tier = controlTier();
  const box = h('div', { class: 'paper-controls-round' });
  box.style.setProperty('--btn-d', `${tier.button.diameterPx}px`);
  box.style.setProperty('--btn-gap', `${tier.button.gapPx}px`);
  box.style.setProperty('--btn-lf', `${Math.max(tier.button.labelFontPx, 10)}px`);
  // 供 probe / 测试核对「避让带高度」与按钮带一致
  box.dataset.bandHeight = String(controlBandHeight(tier));
  box.appendChild(progress);
  for (const btn of buttons) {
    const full = btn.dataset.fullLabel ?? btn.textContent ?? '';
    const circle = h('span', { class: 'paper-round-circle', text: ROUND_LABELS[full] ?? full.slice(0, 1) });
    const label = h('span', { class: 'paper-round-label', text: ROUND_SUB_LABELS[full] ?? full });
    const wrap = h('button', { class: 'paper-round-btn', type: 'button', title: full });
    wrap.dataset.fullLabel = full;
    // 视觉权重跟着原按钮走（主按钮深底白字）
    if (btn.classList.contains('btn-primary')) wrap.classList.add('is-primary');
    if (btn.classList.contains('paper-restart')) wrap.classList.add('is-restart');
    wrap.appendChild(circle);
    wrap.appendChild(label);
    // 点击转交给原按钮：所有流程逻辑只有一份（原来那些 btn 的 onClick 不动）
    wrap.addEventListener('click', () => btn.click());
    box.appendChild(wrap);
  }
  return box;
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

  // ── 按钮组 ──
  // ★ M2：手机上是**底部横排圆形按钮**（等大圆 + 圆下方小字），
  //   平板/桌面保持原来的右下角竖排（用户明确要求桌面不变）。
  const onPhone = deviceKind() === 'phone';
  const progress = h('div', { class: onPhone ? 'paper-round-progress' : 'paper-progress', text: '' });
  const btnDone = labeledButton('背完了', () => void finishAll(), { variant: 'primary', class: 'paper-done hidden' });
  const btnSave = labeledButton('保存并退出', () => void saveAndExit());
  const btnAgain = labeledButton('再次记忆', () => startMemorize());
  /**
   * ★ T2：「再背一个」在复习模式下叫「再复习一个」。
   *
   * 两者是**同一个按钮、同一套逻辑**（把词单里的下一个词放上纸），
   * 只有文案不同 —— 用户明确要求复习与背诵的按钮保持一致，
   * 而「再背一个」出现在复习页会让人以为走错了流程。
   * 短的圆按钮文案与 `ROUND_LABELS` / `shortNextLabel()` 的映射在下面同步加了两条。
   */
  const nextLabelBase = mode === 'review' ? '再复习一个' : '再背一个';
  const btnNext = labeledButton(`${nextLabelBase} (Enter)`, () => nextAction(), { variant: 'primary', class: 'paper-next' });
  // ★ 用户要求「下次点击直接开始」之后，续跑是自动的，于是必须有一个显式的
  //   「把这一轮丢掉、从零开始」入口，否则保存过的进度就再也甩不掉了。
  //   这是**破坏性**操作（丢掉位置与每词记忆遍数），所以保留二次确认——
  //   RULES-R3 的「不弹确认」只管「斩」，不管这里。
  const btnRestart = labeledButton('重新开始', () => void restartRound(), { class: 'paper-restart' });
  const roundControls = onPhone ? buildRoundControls(progress, [btnDone, btnSave, btnAgain, btnNext, btnRestart]) : null;
  const controls = roundControls ?? h('div', { class: 'paper-controls' }, progress, btnDone, btnSave, btnAgain, btnRestart, btnNext);

  /**
   * 布点种子：同一会话 + 同一组 → 固定不变。
   * 续跑时位置不跳、切列数重排时也是「同一套随机风格」，便于对照。
   */
  const layoutSeed = seedFromString(`${session.id}#${opts.groupIndex}`);

  /**
   * ★ S3：手动列数快捷入口（永久兜底）——一个 32×32 的 ⊞ 按钮 + 轻量选择条。
   *
   * 为什么要有（用户原话）：「如果做不到自动适配，请加一个手动切换的按钮」。
   * 自动修复是主，手动是**永久兜底**：以后算法再出问题（列太少 / 排得像手机 /
   * 某个尺寸下挤在一起），用户自己选个列数立刻就能用，不必等版本更新。
   *
   * 位置：手机在**底部按钮带左侧**（那条带子本来就是布点避让区，压不到单词）；
   * 平板/桌面在右下角按钮列的最上面（同理，属于避让区）。两处都是 32×32。
   */
  const colsBar = h('div', { class: 'paper-cols-bar hidden' });
  const colsTrigger = h('button', {
    class: 'paper-cols-btn',
    type: 'button',
    title: '手动指定列数（自动布局不合适时的兜底）',
    text: '⊞',
  });
  const colsControl = h('div', { class: 'paper-cols' }, colsBar, colsTrigger);
  if (roundControls) roundControls.appendChild(colsControl);
  else controls.insertBefore(colsControl, controls.firstChild);

  /** 重画选择条（每次打开都按最新设置标出当前档） */
  const drawColsBar = (): void => {
    colsBar.replaceChildren();
    const current = coerceColsOverride(getSettings().layoutColsOverride);
    for (const value of LAYOUT_COLS_OPTIONS) {
      const item = h('button', {
        class: `paper-cols-item${value === current ? ' is-active' : ''}`,
        type: 'button',
        text: value === 'auto' ? '自动' : String(value),
        title: value === 'auto' ? '自动（按屏幕宽度推导列数）' : `固定 ${value} 列`,
      });
      item.addEventListener('click', (ev) => {
        ev.stopPropagation();
        applyColsOverride(value);
        colsBar.classList.add('hidden');
      });
      colsBar.appendChild(item);
    }
  };

  /**
   * 应用列数覆盖：**立刻重排** + 记住选择（写设置，下次打开还是它）。
   * @param value 'auto' 或具体列数
   */
  const applyColsOverride = (value: LayoutColsOverride): void => {
    const merged = mergeSettingsPatch({ layoutColsOverride: value });
    setSettingsCache(merged); // 布点现读缓存 → 下一次布点立刻用新列数
    appStore.set({ settings: merged });
    emitDataChanged();
    void dao.settings.set({ layoutColsOverride: value }); // 落库：记住选择
    if (words.length > 0) {
      // 重排：同一批词、同一个种子重新布点；**已经上纸的词就地移动**（不重建 DOM）
      session.placements = stage.relayout(words, layoutSeed);
      void dao.session.saveSession(session);
    }
    refreshUi();
    toastOk(value === 'auto' ? '已切回自动布局' : `已固定 ${value} 列`);
  };

  colsTrigger.addEventListener('click', (ev) => {
    ev.stopPropagation();
    drawColsBar();
    colsBar.classList.toggle('hidden');
  });
  /** 点别处收起选择条（不拦事件：只是顺手关掉，不影响背词流程） */
  const onDocumentClick = (): void => colsBar.classList.add('hidden');
  document.addEventListener('click', onDocumentClick);

  const root = h('div', { class: 'paper-flow' }, stage.root, controls);

  // iOS：语音首次必须在用户手势里启动，所以先盖一层「点击开始」（非 iOS 自动跳过）。
  // 解锁只解决「能不能出声」，不影响流程——真正的第一个词由「再背一个」带出来。
  mountSpeechGate(root, () => undefined);

  /**
   * 当前该背/该复习的词 id。
   *
   * - `learn`：整份 `wordIds`（背诵没有分组概念）；
   * - `review`：**优先用 `wordIds`**。
   *
   * ★ T2 修的一个真 bug：以前 review 一律读 `session.groups[opts.groupIndex]`，
   *   而 T2 的复习页已经不给用户看分组了（`groups` 传空数组、`groupCount` 报 1），
   *   于是 `groupIds()` 永远返回空数组 → `words` 为空 → 纸面容量 0 →
   *   界面上「已出现 0/0」、连「再复习一个」按钮都不出现（显示成「已全部出现」）。
   *   实测复现：库里有 2 个已背词、会话 `wordIds` 也对，但复习页一个字都没有。
   *
   *   现在改成：`wordIds` 就是本轮词单（T2 的复习页正是这么维护它的，
   *   分批追加也是往它里面 push）。只有当调用方**显式**给了分组
   *   （老存档续跑，`groups` 非空）时才按分组取，保持向后兼容。
   */
  const groupIds = (): string[] => {
    if (mode === 'learn') return session.wordIds;
    const group = session.groups?.[opts.groupIndex];
    return group !== undefined && group.length > 0 ? group : session.wordIds;
  };

  /** 是否处于「每 N 个新词 → 按钮变记忆」状态 */
  const batchReady = (): boolean => sinceBatch > 0 && sinceBatch >= settings().memorizeEvery;

  /**
   * 复习模式的「这次取出来的词都复习过了吗」。
   *
   * 判定口径与 `allQualified()` 一样（每个词都上过纸 + 记忆遍数达标），
   * 但**只看纸上的词**：复习是「点一下多复习一个」推进的，
   * 词单里排在后面、还没轮到的词不算 —— 用户随时可以点「背完了」结束，
   * 把已经复习的这一批写回数据（剩下的留在词库里，下次还会被抽到）。
   */
  const reviewQualified = (): boolean => {
    const target = settings().memorizeTargetCount;
    const alive = words.filter((w) => session.shownIds.includes(w.id));
    return mode === 'review' && alive.length > 0 && alive.every((w) => (session.memorizeCount[w.id] ?? 0) >= target);
  };

  /** 全部词都记忆达标（「背完了」出现条件） */
  const allQualified = (): boolean => {
    const target = settings().memorizeTargetCount;
    const alive = words.filter((w) => session.shownIds.includes(w.id));
    return alive.length > 0 && alive.every((w) => (session.memorizeCount[w.id] ?? 0) >= target);
  };

  /**
   * 手机版：把圆按钮的状态/文案同步成原按钮的当前值。
   *
   * 为什么需要同步而不是各写一套：`refreshUi()` 会改 `btnNext.textContent`
   * （「再背一个」↔「记忆（新词 N 个）」↔「纸上放不下了」）、改 `disabled`、
   * 切换「背完了」的 hidden。圆按钮只是显示层，**状态的唯一来源仍是原按钮**
   * ——两处各判一次迟早会出现「按钮能点但显示灰的」这类不一致。
   */
  const syncRoundControls = (): void => {
    if (!onPhone) return;
    for (const btn of [btnDone, btnSave, btnAgain, btnNext, btnRestart]) {
      const wrap = roundControls?.querySelector<HTMLButtonElement>(`[data-full-label="${btn.dataset.fullLabel ?? ''}"]`);
      if (!wrap) continue;
      wrap.disabled = btn.disabled;
      wrap.classList.toggle('hidden', btn.classList.contains('hidden'));
      const label = wrap.querySelector<HTMLElement>('.paper-round-label');
      const short = shortNextLabel(btn);
      if (label && short !== '') label.textContent = short;
    }
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
    const reviewDone = reviewQualified();

    progress.textContent =
      `${mode === 'review' ? '复习 · ' : ''}` +
      `已出现 ${browseIndex}/${cap}${cap < words.length ? '（纸面已满）' : ''} · 每词已记忆 ${minMem}/${target}` +
      (mode === 'learn' && qualified ? ' · 可以点「背完了」' : '') +
      (mode === 'review' && reviewDone ? ' · 可以点「背完了」结束复习' : '');

    // ★ T2：复习模式也要有「背完了」出口 —— 否则复习完一圈只能「保存并退出」，
    //   而那个是不写复习记录的（reviewCount / lastReviewAt 永远不涨）。
    if (mode === 'learn') {
      btnDone.classList.toggle('hidden', !qualified);
    } else {
      btnDone.textContent = '背完了';
      btnDone.classList.toggle('hidden', !reviewDone);
    }
    btnSave.disabled = false; // 任何时刻都能保存退出（一轮进行中会先中断本轮）
    btnAgain.disabled = roundBusy || alive.length === 0 || session.shownIds.length === 0;
    btnNext.disabled = roundBusy || (paperFull && !batchReady());
    btnNext.textContent = batchReady()
      ? `记忆（新词 ${sinceBatch} 个）`
      : paperFull
        ? cap < words.length
          ? '纸上放不下了'
          : '已全部出现'
        : `${nextLabelBase} (Enter)`;
    syncRoundControls();
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

    /**
     * 记一次未通过（failDeltas +1、加入 failedIds）。
     *
     * ★ T2：抽成独立函数而不是内联在 host 里，是为了让 `recordExam` 能**直接调用它**
     *   而不是绕回 `host.recordFail` —— 后者在 host 对象字面量的初始化过程中
     *   属于「还没赋值的引用」，读起来像 bug，也不必要地依赖初始化顺序。
     */
    const recordFail = (id: string): void => {
      session.failDeltas[id] = (session.failDeltas[id] ?? 0) + 1;
      if (!session.failedIds.includes(id)) session.failedIds.push(id);
    };

    const host: RoundHost = {
      session,
      settings: settings(),
      stage,
      getWord: (id) => wordMap.get(id),
      recordFail,
      // ★ T2：每次判分都记一次总考核次数（分母），未通过时再记一次失败（分子）。
      //   两者在同一处累加，杜绝「只加 failCount 不加 examCount」这类漏项。
      recordExam: (id, passed) => {
        session.examDeltas = session.examDeltas ?? {};
        session.examDeltas[id] = (session.examDeltas[id] ?? 0) + 1;
        if (!passed) recordFail(id);
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
        ? '已保存复习进度，下次从「复习」继续'
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
   *
   * ★ T2：复习模式走另一个出口（`opts.onRequestFinish`，由复习页写回复习数据），
   *   因为两者的收尾语义完全不同 —— 背诵是「标记已背 + 归档未通过次数」，
   *   复习是「更新 lastReviewAt / reviewCount / 优先度」，混在一起会互相写错字段。
   */
  const finishAll = async (): Promise<void> => {
    if (destroyed || roundBusy || flowMode !== 'browse') return;
    if (mode === 'review') {
      if (!reviewQualified()) {
        toastWarn('先复习到词，「背完了」才会出现');
        return;
      }
      await flushEdits();
      opts.onRequestFinish?.();
      return;
    }
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
    // ★ S3：选择条的「点别处收起」监听也要撤掉，否则换页后它还挂在 document 上
    document.removeEventListener('click', onDocumentClick);
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
   *
   * ★ T2：抽成 `initFlow()` 并把它的 Promise 作为 `flow.ready` 返回。
   *   为什么必须能 await：初始化是**异步**的（要先 `dao.words.getAll()`），
   *   在它完成之前 `words` 还是空数组 —— 此时 `refreshUi()` 算出来的容量是 0，
   *   「再背一个 / 再复习一个」按钮会显示成 **「已全部出现」且带着纸面已满的状态**，
   *   页面上一个字都没有。调用方（复习页在「点一下多复习一个」之后会重新挂载流程）
   *   必须等 `ready` 再继续，否则会拿到一个「空纸 + 没有可用按钮」的界面。
   */
  const initFlow = async (): Promise<void> => {
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
      session.placements = stage.computePlacements(words, layoutSeed);
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
  };

  /**
   * 初始化 Promise：`initFlow()` 一抛错就吞掉并打日志。
   *
   * 为什么不 `void initFlow()` 了事：那样一个未处理的 rejection 会冒到
   * `window.onunhandledrejection` → 全局兜底错误页（整个应用被遮罩盖住）。
   * 白纸流程加载失败应当只影响这一页，不该把用户锁死。
   */
  const initPromise: Promise<void> = initFlow().catch((err: unknown) => {
    console.error('[paper/flow] 初始化失败', err);
    toastError('白纸加载失败，可以点「保存并退出」回到首页再试');
  });

  return { root, startMemorize, destroy, ready: initPromise };
}
