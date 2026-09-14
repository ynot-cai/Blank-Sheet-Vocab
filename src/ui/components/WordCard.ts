import { getSettings } from '../../core/config';
import { formatSensesBrief, humanizeDays } from '../../core/model';
import type { Sense, Word } from '../../core/types';
import { speak } from '../../services/tts';
import { button, h, textInput } from '../dom';
import type { AnswerComparison } from '../pages/paper/AnswerCard';
import { renderSenseEditor } from './SenseEditor';

/** 单词卡参数 */
export interface WordCardOptions {
  /** 可编辑（改音标 / 例句 / 义项）。⭐ 用户口径（2026-09）：记忆环节的答案卡也传 true——考察中一样能改 */
  editable?: boolean;
  /** 内容变化（调用方决定何时写库） */
  onChange?: (next: Word) => void;
  /** 点「斩掉此词」 */
  onChop?: () => void;
  /** 点「拼」（卡内会同步切换按钮文案并回传新状态） */
  onSpell?: (needSpell: boolean) => void;
  /** 点关闭 */
  onClose?: () => void;
  /** 是否显示属性小结（列表页详情用） */
  showAttrs?: boolean;
  /** 答案卡模式：展示输入对照（对的标绿、错的标红并显示正确答案） */
  answerFeedback?: AnswerComparison[];
  /**
   * 展示「查看义项」按钮。
   * ⚠️ 旧注释写的是「只给一个『查看义项』按钮（**不显示拼/斩**）」——
   * 那是只读答案卡时代的说法，已按用户口径作废：答案卡现在跟普通卡一样有拼 / 斩。
   */
  allowViewSenses?: boolean;
}

/**
 * 渲染单词卡（排版：中文意思紧跟单词后面、全黑醒目；音标在单词下方、喇叭在音标旁；
 * 例句在音标下方；底部「查看义项 / 拼 / 斩」并列，点「查看义项」才展开具体义项编辑）。
 * @param word 单词
 * @param opts 编辑开关与回调
 */
export function renderWordCard(word: Word, opts: WordCardOptions = {}): HTMLElement {
  const editable = opts.editable ?? false;
  const settings = getSettings();
  let current: Word = word;
  const card = h('div', { class: 'word-card' });

  const emit = (next: Word): void => {
    current = next;
    briefSpan.textContent = formatSensesBrief(next.senses);
    opts.onChange?.(next);
  };

  /** 只重画底部按钮区（「拼」切换用） */
  function drawFoot(): void {
    const old = card.querySelector('.card-foot');
    if (old?.parentNode) old.parentNode.replaceChild(buildFoot(), old);
  }

  /** 第一行里的中文意思（全黑、醒目、紧跟在单词后面，只显示代表义项） */
  const briefSpan = h('span', { class: 'word-brief', text: formatSensesBrief(current.senses) });

  /** 构建卡片主体 */
  function build(): HTMLElement {
    const frag = h('div', { class: 'word-card-inner' });

    // —— 第 1 行：单词 + 中文意思（紧跟其后） ——
    const head = h('div', { class: 'word-head' });
    head.appendChild(h('span', { class: 'word-en', text: current.en }));
    head.appendChild(briefSpan);
    if (opts.showAttrs) {
      head.appendChild(
        h('span', {
          class: 'word-attrs',
          text:
            `①拼:${current.attrs.needSpell ? '是' : '否'} · ②未通过:${current.attrs.failCount}/${current.attrs.failCountTotal}` +
            ` · ③复习:${current.attrs.reviewCount} · ④${humanizeDays(current.attrs.lastReviewAt)} · ⑤${humanizeDays(current.attrs.learnedAt, Date.now(), '未背')}` +
            ` · ⑥${current.attrs.reviewPriority.toFixed(2)}`,
        }),
      );
    }
    if (opts.onClose) {
      head.appendChild(button('✕', () => opts.onClose?.(), { variant: 'ghost', class: 'modal-close', title: '关闭' }));
    }
    frag.appendChild(head);

    // —— 第 2 行：音标 + 喇叭（喇叭在音标旁边） ——
    const phRow = h('div', { class: 'word-phonetic-row' });
    if (editable) {
      phRow.appendChild(
        textInput(current.phonetic, (v) => emit({ ...current, phonetic: v }), { placeholder: '/əˈbændən/' }),
      );
    } else {
      phRow.appendChild(h('span', { class: 'word-phonetic', text: current.phonetic || '（无音标）' }));
    }
    phRow.appendChild(
      button(
        '🔊',
        () => speak(current.en, { rate: settings.practice.speakRate, lang: settings.practice.speakLang }),
        { variant: 'ghost', class: 'mini', title: '朗读这个单词' },
      ),
    );
    frag.appendChild(phRow);

    // —— 第 3 行：例句 ——
    if (editable) {
      frag.appendChild(
        h(
          'div',
          { class: 'row' },
          h('span', { class: 'field-label', text: '例句' }),
          textInput(current.example, (v) => emit({ ...current, example: v }), {
            placeholder: 'He abandoned his car.',
          }),
        ),
      );
    } else if (current.example) {
      frag.appendChild(h('div', { class: 'word-example', text: current.example }));
    }

    // —— 答案卡模式：输入对照（对的标绿、错的标红 + 正确答案） ——
    if (opts.answerFeedback && opts.answerFeedback.length > 0) {
      const cmp = h('div', { class: 'answer-cmp' });
      for (const item of opts.answerFeedback) {
        cmp.appendChild(
          h(
            'div',
            { class: `answer-cmp-line ${item.ok ? 'ok' : 'bad'}` },
            h('span', { class: 'answer-cmp-mark', text: item.ok ? '✓' : '✗' }),
            h('span', { text: item.input === '' ? '（未填）' : item.input }),
          ),
        );
      }
      if (opts.answerFeedback.some((i) => !i.ok)) {
        const correct = current.senses.filter((s) => s.enabled && s.text.trim() !== '');
        cmp.appendChild(
          h('div', { class: 'answer-correct' }, '正确答案：', ...correct.map((s) => h('span', { class: 'chip', text: s.text }))),
        );
      }
      frag.appendChild(cmp);
    }

    // —— 底部操作行：查看义项 / 拼 / 斩 ——
    if (opts.onChop || opts.onSpell || opts.allowViewSenses) frag.appendChild(buildFoot());

    // —— 义项详情：点「查看义项」才展开 ——
    const sensePanel = h('div', { class: 'sense-panel hidden' });
    sensePanel.appendChild(
      renderSenseEditor(current.senses, (next: Sense[]) => emit({ ...current, senses: next }), {
        readonly: !editable,
      }),
    );
    frag.appendChild(sensePanel);
    return frag;
  }

  /** 底部操作区：查看义项 + 拼 + 斩 */
  function buildFoot(): HTMLElement {
    const foot = h('div', { class: 'card-foot' });
    foot.appendChild(
      button(
        '查看义项',
        () => {
          // 点击时才查面板（初次构建时面板还没挂到卡上）
          card.querySelector('.sense-panel')?.classList.toggle('hidden');
        },
        { variant: 'ghost', class: 'btn-view-senses' },
      ),
    );
    if (opts.onSpell) {
      foot.appendChild(
        button(
          current.attrs.needSpell ? '已标记拼写 ✓（再点取消）' : '拼（加入拼写环节）',
          () => {
            const next = !current.attrs.needSpell;
            emit({ ...current, attrs: { ...current.attrs, needSpell: next } });
            opts.onSpell?.(next);
            drawFoot();
          },
          { variant: current.attrs.needSpell ? 'primary' : 'ghost' },
        ),
      );
    }
    if (opts.onChop) foot.appendChild(button('斩掉此词', () => opts.onChop?.(), { variant: 'danger' }));
    return foot;
  }

  card.appendChild(build());
  return card;
}
