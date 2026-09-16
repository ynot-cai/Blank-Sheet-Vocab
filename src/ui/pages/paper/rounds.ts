// RULES-R1: 此处禁止任何强制时间限制（无倒计时 / 无超时提交 / 无超时判错）
import { activeSenses, senseMatch } from '../../../core/model';
import type { Session, Settings, Word } from '../../../core/types';
import { button, h } from '../../dom';
import type { AnswerCardActions, AnswerComparison } from './AnswerCard';
import { showAnswerCard } from './AnswerCard';
import type { PaperStage } from './PaperStage';

/** 一轮作答的宿主（flow 提供） */
export interface RoundHost {
  session: Session;
  getWord: (id: string) => Word | undefined;
  settings: Settings;
  stage: PaperStage;
  /** 记一次未通过：failDeltas +1、加入 failedIds */
  recordFail: (id: string) => void;
  /** 记一次已作答：memorizeCount +1、加入 shownIds */
  recordShown: (id: string) => void;
  /** 用户点了「返回白纸」等中断信号 */
  isAborted: () => boolean;
  /**
   * 答案卡上的「改义项 / 拼 / 斩」回调（**按词构造**）。
   *
   * ★ 用户明确要求：记忆时查看答案用的是**和普通界面完全同一张单词卡**——
   *   即使在考察中，也要能随时查看、随时改义项、随时标记拼写、随时斩。
   *   所以这里不是另做一套只读卡，而是把普通卡片的那套回调原样接过来。
   */
  cardActionsFor?: (word: Word) => AnswerCardActions;
}

/**
 * 等待「用户提交」或「主动中断」。
 *
 * ★ RULES-R1: 这里**不许有次数上限**（原来写的是 400 次 × 25ms = 10 秒）。
 *
 * 原来的写法是一个隐蔽的**超时自动提交**：等满 10 秒就 `return cond()`（= false），
 * 而两个调用点都不看返回值、直接往下走去判分 —— 于是用户盯着题思考超过 10 秒，
 * 界面会自己把没作答的框当提交判掉（空答案 → 记一次未通过 → 弹答案卡）。
 * 这正是铁律第 1 节明令禁止的「超时自动提交 / 超时判错」，
 * 而且 `scripts/checkRules.mjs` 按变量名（timeLimit / countdown）扫，**扫不到它**。
 *
 * 现在改成一直等到用户真的提交、或者用户主动退出（abort）为止，
 * 不给任何时限：思考多久都不会被判错、不会被自动提交。
 *
 * @param cond 条件（用户已提交）
 * @param abort 中断信号（用户点了返回白纸 / 页面被销毁）
 * @returns true = 用户提交了；false = 被中断
 */
async function waitUntil(cond: () => boolean, abort: () => boolean): Promise<boolean> {
  for (;;) {
    if (cond()) return true;
    if (abort()) return false;
    await new Promise((r) => window.setTimeout(r, 25));
  }
}

/**
 * 记忆环节一轮：串行逐个出现（同一时刻屏幕上只有一个词）。
 * 提交 → 立刻弹出正确答案单词卡 → 点击卡片 → 进入下一个（统一作答闭环）。
 * @param host 宿主
 * @param ids 本轮抽出的词 id（顺序已打乱）
 */
export async function runMemorizeRound(host: RoundHost, ids: string[]): Promise<void> {
  for (const id of ids) {
    if (host.isAborted()) return;
    const word = host.getWord(id);
    if (!word) continue;

    // 位置：origin = 背诵阶段的原始落点（没出现过就居中偏上）
    const overlay = host.stage.showOverlay(host.stage.placementOf(id));
    overlay.classList.add('memorize-mode');
    if (host.settings.practice.autoSpeak) host.stage.speakWord(word);

    const senses = activeSenses(word);
    const box = h('div', { class: 'memorize-box' });
    box.appendChild(h('div', { class: 'memorize-word', text: word.en }));
    const inputsRow = h('div', { class: 'mem-inputs' });
    const inputs: HTMLInputElement[] = [];
    senses.forEach((_, i) => {
      const input = h('input', { class: 'input mem-input', type: 'text', placeholder: `义项 ${i + 1}` });
      inputs.push(input);
      inputsRow.appendChild(input);
    });
    const submitBtn = button('提交', () => {
      submitted = true;
    }, { variant: 'primary', class: 'mem-submit' });
    submitBtn.id = 'mem-submit';
    let submitted = false;

    /**
     * Enter：**填完一格跳到下一格**，在最后一格（最右）按才提交。
     *
     * ★ 用户明确要求：「填写完一个点击 enter 切换到另一个（切换到最后（最右）的那个再按，就提交）」。
     *   一个词的多个义项是一串并排的输入框，用户是「填一个 → Enter → 填下一个」的节奏；
     *   原来任意一格按 Enter 都会直接提交，多义项的词几乎必然被半途交上去判错。
     *
     * stopPropagation 依然要留着：`flow.ts` 在 window 上还有一个全局 Enter 处理器，
     * 不拦住的话会重复触发（提交两次）。
     */
    inputs.forEach((input, i) => {
      input.addEventListener('keydown', (ev) => {
        if (ev.key !== 'Enter') return;
        ev.stopPropagation();
        ev.preventDefault();
        const next = inputs[i + 1];
        if (next !== undefined) {
          next.focus();
          next.select(); // 直接覆盖已填内容，省得先删
          return;
        }
        submitted = true; // 最后一格：提交
      });
    });
    box.appendChild(inputsRow);
    // 多义项时给一句操作提示（只有一个框时不需要，Enter 就是提交）
    if (inputs.length > 1) {
      box.appendChild(
        h('div', { class: 'field-hint mem-hint', text: '按 Enter 填下一个义项；在最后一格按 Enter 提交' }),
      );
    }
    box.appendChild(h('div', { class: 'row center' }, submitBtn));
    overlay.appendChild(box);
    // ★ 内容填完再定位：遮罩位置要按「整块卡片都在视口内」来夹（M2 之后手机上
    //   词分两列，原落点模式的卡片会跑出屏幕左边 —— 见 PaperStage 的 clampOverlayLeft）
    host.stage.repositionOverlay();

    // 光标自动落到第一个输入框：点完「记忆」直接敲键盘就能输入，不用先点一下输入框
    // RULES-R1: 纯 UI 延迟（等渲染完再聚焦），与动画/过渡同类，不是答题计时
    window.setTimeout(() => inputs[0]?.focus(), 0);

    // RULES-R1: 提交靠用户点「提交」或按 Enter，**没有任何超时**——
    // 停在这里多久都不会被自动提交、也不会被判错（见 AI_RULES.md 第 1 节）。
    await waitUntil(() => submitted, host.isAborted);
    host.stage.hideOverlay();
    if (host.isAborted()) return;

    // 判分：每个框命中任意一个义项的 text / aliases 即算对（顺序无关）
    // RULES-R1: 判分只看对错，不看用时
    const results = inputs.map((input) => {
      const value = input.value.trim();
      if (value === '') return false;
      return senses.some((s) => senseMatch(value, s));
    });
    const passed = results.every(Boolean);
    if (!passed) host.recordFail(id);

    const comparison: AnswerComparison[] = inputs.map((input, i) => ({
      input: input.value.trim(),
      ok: results[i] ?? false,
    }));
    // 答案卡 = 和普通界面同一张可编辑单词卡（改义项 / 拼 / 斩都能随时用）
    await new Promise<void>((resolve) => showAnswerCard(word, comparison, resolve, host.cardActionsFor?.(word)));
    host.recordShown(id);
    if (host.isAborted()) return;
  }
}

/**
 * 把英文掩码成提示形式：先显示首字母，再显示前 3 个字母，其余字母变下划线（空格/标点保留）。
 * @param en 英文
 * @param prefix 显示前几个字母
 */
export function maskEn(en: string, prefix: number): string {
  let seen = 0;
  return en
    .split('')
    .map((ch) => {
      if (/\s/.test(ch)) return ' ';
      if (!/[a-zA-Z]/.test(ch)) return ch;
      seen += 1;
      return seen <= prefix ? ch : '_';
    })
    .join('');
}

/**
 * 拼写环节一轮：在原落点（或居中偏上）显示全部中文意思，要求填英文。
 * 点过「看提示」就算未通过；判分忽略大小写和首尾空格，完全匹配才算对。
 * 同样走「提交 → 答案卡 → 点击继续」闭环。
 * @param host 宿主
 * @param ids 本轮抽出的词 id
 */
export async function runSpellRound(host: RoundHost, ids: string[]): Promise<void> {
  for (const id of ids) {
    if (host.isAborted()) return;
    const word = host.getWord(id);
    if (!word) continue;

    const overlay = host.stage.showOverlay(host.stage.placementOf(id));
    overlay.classList.add('spell-mode');

    const meanings = activeSenses(word).flatMap((s) => [s.text, ...s.aliases]).join('，');
    const box = h('div', { class: 'memorize-box' });
    box.appendChild(h('div', { class: 'spell-meanings', text: meanings }));

    let hintCount = 0;
    let hintUsed = false;
    const hintLabel = h('span', { class: 'spell-hint-text', text: '' });
    const hintBtn = button('看提示', () => {
      hintCount += 1;
      hintUsed = true;
      const prefix = hintCount >= 2 ? 3 : 1;
      hintLabel.textContent = maskEn(word.en, prefix);
      if (hintCount >= 2) hintBtn.textContent = '再提示没有更多了';
    });
    hintBtn.id = 'spell-hint';

    const input = h('input', { class: 'input spell-input', type: 'text', placeholder: '拼写英文' });
    input.id = 'spell-input';
    const submitBtn = button('提交', () => {
      submitted = true;
    }, { variant: 'primary' });
    submitBtn.id = 'spell-submit';
    let submitted = false;

    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.stopPropagation();
        ev.preventDefault();
        submitted = true;
      }
    });

    box.appendChild(h('div', { class: 'row center' }, input, submitBtn));
    box.appendChild(h('div', { class: 'row center' }, hintBtn, hintLabel));
    overlay.appendChild(box);
    // ★ 内容填完再定位（同记忆环节：卡片必须整块在视口内）
    host.stage.repositionOverlay();

    // 光标自动落到拼写输入框
    // RULES-R1: 纯 UI 延迟（等渲染完再聚焦），与动画/过渡同类，不是答题计时
    window.setTimeout(() => input.focus(), 0);

    await waitUntil(() => submitted, host.isAborted);
    host.stage.hideOverlay();
    if (host.isAborted()) return;

    const value = input.value.trim();
    const ok = !hintUsed && value.toLowerCase() === word.en.trim().toLowerCase();
    if (!ok) host.recordFail(id);

    await new Promise<void>((resolve) =>
      showAnswerCard(word, [{ input: value, ok }], resolve, host.cardActionsFor?.(word)),
    );
    if (host.isAborted()) return;
  }
}
