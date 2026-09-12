import { activeSenses, senseMatch } from '../../../core/model';
import type { Session, Settings, Word } from '../../../core/types';
import { button, h } from '../../dom';
import type { AnswerComparison } from './AnswerCard';
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
}

/** 等待条件成立或中断 */
async function waitUntil(cond: () => boolean, abort: () => boolean): Promise<boolean> {
  for (let i = 0; i < 400; i += 1) {
    if (cond()) return true;
    if (abort()) return false;
    await new Promise((r) => window.setTimeout(r, 25));
  }
  return cond();
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

    // Enter 提交（任意一个框按 Enter 都提交；stopPropagation 防止全局 Enter 重复触发）
    for (const input of inputs) {
      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') {
          ev.stopPropagation();
          ev.preventDefault();
          submitted = true;
        }
      });
    }
    box.appendChild(inputsRow);
    box.appendChild(h('div', { class: 'row center' }, submitBtn));
    overlay.appendChild(box);

    // 光标自动落到第一个输入框：点完「记忆」直接敲键盘就能输入，不用先点一下输入框
    window.setTimeout(() => inputs[0]?.focus(), 0);

    await waitUntil(() => submitted, host.isAborted);
    host.stage.hideOverlay();
    if (host.isAborted()) return;

    // 判分：每个框命中任意一个义项的 text / aliases 即算对（顺序无关）
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
    await new Promise<void>((resolve) => showAnswerCard(word, comparison, resolve));
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

    // 光标自动落到拼写输入框
    window.setTimeout(() => input.focus(), 0);

    await waitUntil(() => submitted, host.isAborted);
    host.stage.hideOverlay();
    if (host.isAborted()) return;

    const value = input.value.trim();
    const ok = !hintUsed && value.toLowerCase() === word.en.trim().toLowerCase();
    if (!ok) host.recordFail(id);

    await new Promise<void>((resolve) =>
      showAnswerCard(word, [{ input: value, ok }], resolve),
    );
    if (host.isAborted()) return;
  }
}
