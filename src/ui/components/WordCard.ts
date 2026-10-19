/**
 * 单词卡（版本 0.0.20 按 `开发必读/逻辑与交互要求.md` 第四节「单词卡」重写）。
 *
 * ── 用户对该卡的规格（提示词 04 §三，逐条对应到下面的实现）──
 * 1. **出现位置**：正中弹窗（外壳由调用方给：白纸页是 `.answer-card`，列表页是 `openModal`）。
 *    本组件只负责卡片内容，不再自己决定挂在哪。
 * 2. **排版自上而下**：英文（大黑粗）＋中文（仅义项代表）→ 音标＋发音按钮 →
 *    例句（最多两行，超过加一个「查看全部」）→ 按钮区（编辑/保存、拼写、仅拼写、斩，水平并排）。
 *    右上角有「X」关闭按钮（调用方传 `onClose`）。
 * 3. **编辑**：点击后卡片改变形态——英文变文本框；中文部分由「词性，义项代表1　词性，义项代表2」
 *    变成「词性，义项代表1，其他近义词1，其他近义词2（近义词用较灰的颜色）；义项代表2……」；
 *    左键可改每一个中文意思；**右键菜单只有一项「删除」**；**左键拖拽调整含义位置**；
 *    此时原「编辑」按钮被「保存」取代，点击即保存修改。
 * 4. **拼写 / 仅拼写**：仅做空壳子（点击给一句提示，不实现任何逻辑）。
 * 5. **斩**：行为不变，唯一的改动点（绿色通知改右上角）由调用方负责——白纸页用的是右上角提示。
 *
 * ── 与 0.0.19 的差别（本次改了什么）──
 * - 删掉了「查看义项」按钮与折叠面板：用户要求义项直接在卡片上改（编辑态里就是中文那一行）；
 * - 新增「编辑 ↔ 保存」两态：以前音标/例句一直是输入框、改一下就写库，没有「保存」这一步；
 * - 新增义项拖拽调序、右键删除、近义词灰显；
 * - 例句改为最多两行 + 「查看全部」。
 */
import { getSettings } from '../../core/config';
import { activeSenses, formatSensesBrief, humanizeDays } from '../../core/model';
import { getFailRate } from '../../core/priority';
import type { AnswerComparison, Sense, Word } from '../../core/types';
import { speak } from '../../services/tts';
import { button, h, textInput } from '../dom';
import { toastWarn } from './Toast';

/** 单词卡参数 */
export interface WordCardOptions {
  /** 可编辑（进入编辑态）。白纸页与列表页详情都传 true */
  editable?: boolean;
  /**
   * 内容变化——**只在点「保存」时触发一次**（0.0.20 起）。
   * 调用方决定怎么落库（白纸页立即写库；列表页详情写库后重画列表）。
   */
  onChange?: (next: Word) => void;
  /** 点「斩」 */
  onChop?: () => void;
  /** 点关闭（右上角 X） */
  onClose?: () => void;
  /** 是否显示属性小结（列表页详情用） */
  showAttrs?: boolean;
  /** 答案卡模式：展示输入对照（对的标绿、错的标红并显示正确答案） */
  answerFeedback?: AnswerComparison[];
  /**
   * @deprecated 0.0.20 起没有「查看义项」面板了（义项直接在编辑态里改）。
   * 保留这个字段只为不破坏老调用方，传了也不产生任何行为。
   */
  allowViewSenses?: boolean;
  /**
   * @deprecated 0.0.20 起「拼写」按用户要求只做空壳，这个回调不再被调用。
   * 保留字段只为不破坏老调用方。
   */
  onSpell?: (needSpell: boolean) => void;
}

/**
 * 朗读一个词（单词卡上的 🔊）。
 *
 * 走 `services/tts` 的 `speak()`：缓存 → 有道 TTS → 浏览器语音三级降级，
 * 并读设置页「音频设置」里的语音来源 / 语速 / 口音。
 * @param word 要朗读的单词
 */
function speakWord(word: Word): void {
  const speech = getSettings().speech;
  speak(word.en, { rate: speech.rate, lang: speech.accent });
}

/**
 * 渲染单词卡。
 * @param word 单词
 * @param opts 编辑开关与回调
 */
export function renderWordCard(word: Word, opts: WordCardOptions = {}): HTMLElement {
  const editable = opts.editable ?? false;
  /** 当前展示的词（保存后就是它） */
  let current: Word = word;
  /** 编辑态草稿（只有 `editing === true` 时才有意义） */
  let draft: Word = word;
  let editing = false;
  /** 例句是否已展开 */
  let exampleExpanded = false;

  const card = h('div', { class: 'word-card' });
  const inner = h('div', { class: 'word-card-inner' });
  card.appendChild(inner);

  // ── 右键菜单（整个卡片同一时刻最多一个）──
  let ctxMenu: HTMLElement | null = null;
  const closeCtx = (): void => {
    ctxMenu?.remove();
    ctxMenu = null;
  };

  /**
   * 在鼠标位置弹出「义项右键菜单」。
   *
   * 用户口径：**右键菜单只有单一一个「删除」**，点击即可删除该中文意思。
   * @param ev 右键事件
   * @param index 第几个义项
   */
  function openSenseMenu(ev: MouseEvent, index: number): void {
    ev.preventDefault();
    closeCtx();
    const menu = h('div', { class: 'sense-ctx-menu' });
    menu.appendChild(
      button(
        '删除',
        () => {
          draft.senses.splice(index, 1);
          closeCtx();
          draw();
        },
        { variant: 'ghost', class: 'sense-ctx-del' },
      ),
    );
    menu.style.left = `${ev.clientX}px`;
    menu.style.top = `${ev.clientY}px`;
    document.body.appendChild(menu);
    ctxMenu = menu;
    /**
     * 下一拍再挂「点任意处关闭」，否则这次右键的后续事件会立刻把菜单关掉。
     * RULES-R1: 这是**纯 UI 延迟**（等这一轮事件派发完），与动画 / 过渡同类，
     *   不是答题计时、不影响任何作答。
     */
    window.setTimeout(() => {
      document.addEventListener('click', closeCtx, { once: true });
    }, 0);
  }

  /** 画整张卡（视图态 / 编辑态二选一） */
  function draw(): void {
    inner.replaceChildren(editing ? buildEdit() : buildView());
  }

  // ══════════════════════════ 视图态 ══════════════════════════
  function buildView(): HTMLElement {
    const frag = h('div', { class: 'word-card-body' });

    // —— 第 1 行：英文（大黑粗）＋中文（仅义项代表） ——
    const head = h('div', { class: 'word-head' });
    head.appendChild(h('span', { class: 'word-en', text: current.en }));
    head.appendChild(h('span', { class: 'word-brief', text: formatSensesBrief(current.senses) }));
    if (opts.showAttrs) head.appendChild(buildAttrs());
    if (opts.onClose) head.appendChild(buildClose());
    frag.appendChild(head);

    frag.appendChild(buildPhoneticRow(false));

    // —— 第 3 行：例句（最多两行，超过加「查看全部」） ——
    if (current.example.trim() !== '') {
      const ex = h('div', {
        class: `word-example${exampleExpanded ? ' expanded' : ''}`,
        text: current.example,
        title: current.example,
      });
      frag.appendChild(ex);
      const moreBox = h('div', { class: 'word-example-more hidden' });
      moreBox.appendChild(
        button(exampleExpanded ? '收起' : '查看全部', () => {
          exampleExpanded = !exampleExpanded;
          draw();
        }, { variant: 'ghost', class: 'mini' }),
      );
      frag.appendChild(moreBox);
      // 真的超过两行才给「查看全部」（量一次真实渲染高度）
      window.requestAnimationFrame(() => {
        if (!ex.isConnected) return;
        const overflow = ex.scrollHeight > ex.clientHeight + 1;
        if (exampleExpanded || overflow) moreBox.classList.remove('hidden');
      });
    }

    frag.appendChild(buildAnswerFeedbackIfAny());
    frag.appendChild(buildFoot());
    return frag;
  }

  // ══════════════════════════ 编辑态 ══════════════════════════
  function buildEdit(): HTMLElement {
    const frag = h('div', { class: 'word-card-body editing' });

    // —— 第 1 行：英文变文本框 + 中文部分变成「义项代表，近义词（更灰）…」——
    const head = h('div', { class: 'word-head word-head-edit' });
    const enInput = textInput(draft.en, (v) => {
      draft = { ...draft, en: v };
    }, { class: 'word-en-input', placeholder: '英文' });
    head.appendChild(enInput);
    if (opts.showAttrs) head.appendChild(buildAttrs());
    if (opts.onClose) head.appendChild(buildClose());
    frag.appendChild(head);

    frag.appendChild(buildSenseEditor());
    frag.appendChild(buildPhoneticRow(true));

    // —— 例句：编辑态直接给输入框 ——
    frag.appendChild(
      h(
        'div',
        { class: 'row word-example-edit' },
        h('span', { class: 'field-label', text: '例句' }),
        textInput(draft.example, (v) => {
          draft = { ...draft, example: v };
        }, { placeholder: 'He abandoned his car.' }),
      ),
    );

    frag.appendChild(buildAnswerFeedbackIfAny());
    frag.appendChild(buildFoot());
    return frag;
  }

  /** 右上角 X 关闭 */
  function buildClose(): HTMLElement {
    return button('✕', () => opts.onClose?.(), { variant: 'ghost', class: 'modal-close word-card-close', title: '关闭' });
  }

  /** 属性小结（①②③④⑤⑥，列表页详情用） */
  function buildAttrs(): HTMLElement {
    const exams = current.attrs.examCount;
    return h('span', {
      class: 'word-attrs',
      text:
        `①拼:${current.attrs.needSpell ? '是' : '否'} · ②未通过:${current.attrs.failCount}/${current.attrs.failCountTotal}` +
        ` · 失败率:${getFailRate(current.attrs).toFixed(2)}（考 ${typeof exams === 'number' ? exams : '未记录'} 次）` +
        ` · ③复习:${current.attrs.reviewCount} · ④${humanizeDays(current.attrs.lastReviewAt)} · ⑤${humanizeDays(current.attrs.learnedAt, Date.now(), '未背')}` +
        ` · ⑥${current.attrs.reviewPriority.toFixed(2)}`,
    });
  }

  /** 第 2 行：音标 + 发音按钮 */
  function buildPhoneticRow(edit: boolean): HTMLElement {
    const row = h('div', { class: 'word-phonetic-row' });
    if (edit) {
      row.appendChild(
        textInput(draft.phonetic, (v) => {
          draft = { ...draft, phonetic: v };
        }, { placeholder: '/əˈbændən/' }),
      );
    } else {
      row.appendChild(h('span', { class: 'word-phonetic', text: current.phonetic || '（无音标）' }));
    }
    row.appendChild(
      button('🔊', () => speakWord(current), { variant: 'ghost', class: 'mini', title: '朗读这个单词' }),
    );
    return row;
  }

  /**
   * 编辑态的「中文部分」：每个义项一行，行内是
   * `词性，义项代表，近义词1，近义词2`（近义词更灰）。
   *
   * 交互（用户口径）：左键改文字；**右键只有「删除」**；**左键拖拽调整位置**（拖到哪就插到哪，
   * 原位置被挤开）。
   */
  function buildSenseEditor(): HTMLElement {
    const box = h('div', { class: 'word-senses-edit' });
    if (draft.senses.length === 0) {
      box.appendChild(h('div', { class: 'field-hint', text: '（没有义项）' }));
      return box;
    }

    draft.senses.forEach((sense, index) => {
      const row = h('div', {
        class: 'sense-edit-row',
        draggable: 'true',
        title: '左键拖动可调整顺序；右键删除这个义项',
      });

      row.appendChild(buildEditableSenseText(sense));
      sense.aliases.forEach((alias, aliasIndex) => {
        row.appendChild(h('span', { class: 'sense-edit-sep', text: '，' }));
        row.appendChild(buildEditableAlias(sense, alias, aliasIndex));
      });

      row.addEventListener('contextmenu', (ev) => openSenseMenu(ev, index));

      // —— 拖拽调序 ——
      row.addEventListener('dragstart', (ev) => {
        row.classList.add('dragging');
        ev.dataTransfer?.setData('text/plain', String(index));
        if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'move';
      });
      row.addEventListener('dragend', () => row.classList.remove('dragging'));
      row.addEventListener('dragover', (ev) => {
        ev.preventDefault();
        row.classList.add('drop-target');
        if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move';
      });
      row.addEventListener('dragleave', () => row.classList.remove('drop-target'));
      row.addEventListener('drop', (ev) => {
        ev.preventDefault();
        row.classList.remove('drop-target');
        const raw = ev.dataTransfer?.getData('text/plain') ?? '';
        const from = Number(raw);
        if (!Number.isInteger(from) || from === index) return;
        moveSense(from, index);
        draw();
      });

      box.appendChild(row);
    });
    return box;
  }

  /** 一个「义项文本」的可编辑片段 */
  function buildEditableSenseText(sense: Sense): HTMLElement {
    const el = h('span', { class: 'sense-edit-text', contenteditable: 'true', text: sense.text });
    el.addEventListener('input', () => {
      sense.text = el.textContent ?? '';
    });
    // 拖拽与文字选择不冲突：在文本上按下时不启动拖动由浏览器自己决定，这里只挡「点一下就拖」
    el.addEventListener('dragstart', (ev) => ev.stopPropagation());
    return el;
  }

  /** 一个「近义词」的可编辑片段（更灰） */
  function buildEditableAlias(sense: Sense, alias: string, aliasIndex: number): HTMLElement {
    const el = h('span', { class: 'sense-edit-alias', contenteditable: 'true', text: alias });
    el.addEventListener('input', () => {
      // 就地改别名（空串在保存时统一丢掉）
      sense.aliases[aliasIndex] = el.textContent ?? '';
    });
    el.addEventListener('dragstart', (ev) => ev.stopPropagation());
    return el;
  }

  /** 把第 from 个义项移动到第 to 位（拖拽落点插到目标之前） */
  function moveSense(from: number, to: number): void {
    if (from < 0 || to < 0 || from >= draft.senses.length || to >= draft.senses.length) return;
    const list = draft.senses.slice();
    const [item] = list.splice(from, 1);
    if (!item) return;
    list.splice(to, 0, item);
    draft = { ...draft, senses: list };
  }

  /** 答案卡模式的输入对照（没有就不生成节点） */
  function buildAnswerFeedbackIfAny(): HTMLElement {
    const cmp = h('div', { class: 'answer-cmp' });
    if (!opts.answerFeedback || opts.answerFeedback.length === 0) {
      // 没有输入对照时给一个空容器（display 不影响布局），保持 build 流程简单
      cmp.classList.add('hidden');
      return cmp;
    }
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
      const correct = activeSenses(current);
      cmp.appendChild(
        h('div', { class: 'answer-correct' }, '正确答案：', ...correct.map((s) => h('span', { class: 'chip', text: s.text }))),
      );
    }
    return cmp;
  }

  /**
   * 按钮区：编辑/保存、拼写、仅拼写、斩（用户要求**水平并排**）。
   * 「拼写」「仅拼写」按用户口径只做空壳。
   */
  function buildFoot(): HTMLElement {
    const foot = h('div', { class: 'card-foot word-card-foot' });
    if (editable) {
      foot.appendChild(
        button(
          editing ? '保存' : '编辑',
          () => {
            if (editing) saveEdit();
            else startEdit();
          },
          { variant: editing ? 'primary' : 'ghost', class: 'word-btn-edit' },
        ),
      );
    }
    foot.appendChild(button('拼写', () => toastWarn('「拼写」本轮是空壳，尚未实现'), { variant: 'ghost', class: 'word-btn-spell' }));
    foot.appendChild(button('仅拼写', () => toastWarn('「仅拼写」本轮是空壳，尚未实现'), { variant: 'ghost', class: 'word-btn-spellonly' }));
    if (opts.onChop) foot.appendChild(button('斩', () => opts.onChop?.(), { variant: 'danger', class: 'word-btn-chop' }));
    return foot;
  }

  /** 进入编辑态：先拷一份草稿（改坏了没保存就等于没改） */
  function startEdit(): void {
    draft = {
      ...current,
      senses: current.senses.map((s) => ({ ...s, aliases: [...s.aliases] })),
    };
    editing = true;
    exampleExpanded = false;
    draw();
  }

  /** 保存：把草稿提交给调用方并回到视图态 */
  function saveEdit(): void {
    // 清掉空别名，避免保存出「一个空近义词」这种没法判分的数据
    const senses = draft.senses.map((s) => ({
      ...s,
      aliases: s.aliases.map((a) => a.trim()).filter((a) => a !== ''),
    }));
    current = { ...draft, senses };
    draft = current;
    editing = false;
    draw();
    opts.onChange?.(current);
  }

  draw();
  return card;
}
