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
   * @deprecated 0.0.21 起「拼写」改成**真的标记**（见 onSpell）。这里保留字段只为兼容老调用方。
   */
  onSpell?: (needSpell: boolean) => void;
  /**
   * ★ 版本 0.0.21（用户「三、选取逻辑」第 3 条）：「仅拼写」按钮 = 把词标记成**只做拼写考察**，
   * 标记后它立即从白纸上消失（消失动作由调用方做）。
   */
  onSpellOnly?: (spellOnly: boolean) => void;
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
 * 生成一个新义项的 id（新增中文意思用）。
 * 优先用 `crypto.randomUUID()`；旧环境退回时间戳 + 随机串。
 */
function newSenseId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return `sense-${crypto.randomUUID()}`;
  } catch {
    /* 继续走兜底 */
  }
  return `sense-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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

    // —— 第 1 行：英文（大黑粗，最左端）＋中文（仅义项代表）＋（右上角）X ——
    const head = h('div', { class: 'word-head' });
    const headMain = h('div', { class: 'word-head-main' });
    headMain.appendChild(h('span', { class: 'word-en', text: current.en }));
    headMain.appendChild(h('span', { class: 'word-brief', text: formatSensesBrief(current.senses) }));
    if (opts.showAttrs) headMain.appendChild(buildAttrs());
    head.appendChild(headMain);
    // ★ 0.0.21：X 与单词**同一行**、贴卡片右上角（用户在 0.0.20 反馈：原来那颗 X 浮在单词上面一行）
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

    // —— 第 1 行：英文变文本框（最左端）＋（右上角）X ——
    const head = h('div', { class: 'word-head word-head-edit' });
    const headMain = h('div', { class: 'word-head-main' });
    const enInput = textInput(draft.en, (v) => {
      draft = { ...draft, en: v };
    }, { class: 'word-en-input', placeholder: '英文' });
    headMain.appendChild(enInput);
    if (opts.showAttrs) headMain.appendChild(buildAttrs());
    head.appendChild(headMain);
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
   * `⠿ 词性，义项代表，近义词1，近义词2`（近义词更灰）。
   *
   * 交互（用户口径）：左键改文字；**右键只有「删除」**；**左键拖拽调整位置**（拖到哪就插到哪，
   * 原位置被挤开）；**支持新增中文意思**。
   *
   * ★ 版本 0.0.21 的修正：0.0.20 用的是 HTML5 `draggable` + dragstart/dragover/drop，
   *   实测（用户反馈「拖动未生效 / 触发条件过于苛刻」）原因有两条：
   *   1. 义项文字是 `contenteditable`，浏览器优先把它当**选文字**，`dragstart` 常常不派发；
   *   2. 我在文字的 dragstart 上加了 `stopPropagation()`，等于把唯一的触发路径也堵了。
   *   现在改成**指针拖动**（pointerdown/move/up）：行的左侧有一个明确的拖动手柄 ⠿，
   *   按住手柄（或行的空白处）就能拖；按在文字上仍然是选字/编辑，两者互不打架。
   */
  function buildSenseEditor(): HTMLElement {
    const box = h('div', { class: 'word-senses-edit' });
    if (draft.senses.length === 0) {
      box.appendChild(h('div', { class: 'field-hint', text: '（没有义项）' }));
    }

    draft.senses.forEach((sense, index) => {
      const row = h('div', {
        class: 'sense-edit-row',
        title: '按住左侧 ⠿ 可拖动排序；在文字上右键删除这个义项',
      });

      // ★ 拖动手柄：让「拖动」有一个不用猜的触发点（用户反馈原来的触发条件太苛刻）
      const handle = h('span', { class: 'sense-drag-handle', text: '⠿', title: '按住拖动，调整义项顺序' });
      row.appendChild(handle);

      row.appendChild(buildEditableSenseText(sense));
      sense.aliases.forEach((alias, aliasIndex) => {
        row.appendChild(h('span', { class: 'sense-edit-sep', text: '，' }));
        row.appendChild(buildEditableAlias(sense, alias, aliasIndex));
      });

      row.addEventListener('contextmenu', (ev) => openSenseMenu(ev, index));

      /**
       * 指针拖动：按在手柄或行的空白处开始；按在可编辑文字上不接管（那是编辑/选字）。
       */
      row.addEventListener('pointerdown', (ev) => {
        if (ev.button !== 0) return;
        const target = ev.target;
        if (target instanceof Element && target.closest('[contenteditable]') !== null) return;
        beginPointerDrag(ev, index);
      });

      box.appendChild(row);
    });

    // ★ 新增中文意思（用户 0.0.21 要求）
    const addBtn = button(
      '＋ 新增中文意思',
      () => {
        draft = {
          ...draft,
          senses: [...draft.senses, { id: newSenseId(), text: '', aliases: [], example: '暂无', enabled: true }],
        };
        draw();
        // 直接聚焦到新加那一行的文字上，省得再点一下
        window.requestAnimationFrame(() => {
          const rows = inner.querySelectorAll('.sense-edit-row');
          const last = rows[rows.length - 1]?.querySelector<HTMLElement>('.sense-edit-text');
          last?.focus();
        });
      },
      { variant: 'ghost', class: 'sense-add-btn' },
    );
    box.appendChild(addBtn);
    return box;
  }

  /**
   * 指针拖动调序（0.0.21）。
   *
   * 为什么不用 HTML5 DnD：见 {@link buildSenseEditor} 的说明——`contenteditable` 会让
   * `dragstart` 基本不派发，用户体感就是「拖不动」。指针事件没有这个问题，
   * 而且「按住手柄 → 拖到目标行 → 松手」的路径在任何鼠标/触屏上一致。
   *
   * @param ev 触发拖动的 pointerdown
   * @param from 被拖的是第几个义项
   */
  function beginPointerDrag(ev: PointerEvent, from: number): void {
    ev.preventDefault();
    const rowsOf = (): HTMLElement[] => Array.from(inner.querySelectorAll<HTMLElement>('.sense-edit-row'));
    const source = rowsOf()[from];
    source?.classList.add('dragging');
    let target = from;

    const paintTarget = (): void => {
      for (const r of rowsOf()) r.classList.remove('drop-target');
      const el = rowsOf()[target];
      if (el && target !== from) el.classList.add('drop-target');
    };

    const onMove = (e: PointerEvent): void => {
      const hit = document.elementFromPoint(e.clientX, e.clientY);
      const rowEl = hit instanceof Element ? hit.closest<HTMLElement>('.sense-edit-row') : null;
      if (rowEl === null) return;
      const idx = rowsOf().indexOf(rowEl);
      if (idx < 0 || idx === target) return;
      target = idx;
      paintTarget();
    };

    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      for (const r of rowsOf()) r.classList.remove('dragging', 'drop-target');
      if (target === from) return;
      moveSense(from, target);
      draw();
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    paintTarget();
  }

  /** 一个「义项文本」的可编辑片段 */
  function buildEditableSenseText(sense: Sense): HTMLElement {
    const el = h('span', { class: 'sense-edit-text', contenteditable: 'true', text: sense.text });
    el.addEventListener('input', () => {
      sense.text = el.textContent ?? '';
    });
    return el;
  }

  /** 一个「近义词」的可编辑片段（更灰） */
  function buildEditableAlias(sense: Sense, alias: string, aliasIndex: number): HTMLElement {
    const el = h('span', { class: 'sense-edit-alias', contenteditable: 'true', text: alias });
    el.addEventListener('input', () => {
      // 就地改别名（空串在保存时统一丢掉）
      sense.aliases[aliasIndex] = el.textContent ?? '';
    });
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
    /**
     * 拼写 / 仅拼写（0.0.21：用户「三、选取逻辑」第 3 条把它们当成**标记**用）。
     * - 「拼写」：标记后，这个词若被选中考核会**额外加一次拼写考察**；
     * - 「仅拼写」：标记后这个词只做拼写考察，并**立即从白纸上消失**（消失由调用方做）。
     * 调用方没接回调时保持原来的空壳行为（点一下只给提示）。
     */
    const spelled = current.attrs.needSpell === true;
    foot.appendChild(
      button(
        spelled ? '拼写 ✓' : '拼写',
        () => {
          if (!opts.onSpell) {
            toastWarn('「拼写」需要从白纸/单词列表打开才可用');
            return;
          }
          const next = { ...current, attrs: { ...current.attrs, needSpell: !spelled } };
          current = next;
          draw();
          opts.onSpell(next.attrs.needSpell);
        },
        { variant: spelled ? 'primary' : 'ghost', class: 'word-btn-spell', title: '标记后：这个词若被抽到考核，会额外考一次拼写' },
      ),
    );
    const spellOnly = current.spellOnly === true;
    foot.appendChild(
      button(
        spellOnly ? '仅拼写 ✓' : '仅拼写',
        () => {
          if (!opts.onSpellOnly) {
            toastWarn('「仅拼写」需要从白纸/单词列表打开才可用');
            return;
          }
          const next = { ...current, spellOnly: !spellOnly };
          current = next;
          draw();
          opts.onSpellOnly(next.spellOnly === true);
        },
        {
          variant: spellOnly ? 'primary' : 'ghost',
          class: 'word-btn-spellonly',
          title: '标记后：这个词只拼写、不考中文，并立即从纸上消失',
        },
      ),
    );
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
    const senses = draft.senses
      .map((s) => ({
        ...s,
        // 清掉空别名，避免保存出「一个空近义词」这种没法判分的数据
        aliases: s.aliases.map((a) => a.trim()).filter((a) => a !== ''),
      }))
      // 新增了但一个字都没填的义项不落库（否则纸上会出现空中文）
      .filter((s) => s.text.trim() !== '');
    current = { ...draft, senses };
    draft = current;
    editing = false;
    draw();
    opts.onChange?.(current);
  }

  draw();
  return card;
}
