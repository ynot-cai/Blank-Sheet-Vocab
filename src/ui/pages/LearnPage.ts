/**
 * 背诵选择页面（`#/learn`）—— 版本 0.0.19。
 *
 * 用户要求（提示词 07 三、排版方案 A/B）：
 *   左栏两个页签：`选取单词` / `继续背诵`；右栏是对应内容；
 *   底部一条：`记录成绩` 勾选框 + `开始背诵` 按钮。
 *
 * 这一页的产出是**临时优先级表**（`core/learnSelect.ts`），
 * 加上一个固定种子，组成一张 `PaperArchive`（draft），然后进白纸界面。
 *
 * ── 版本 0.0.19 的两件事 ──
 * 1. 提示词 07 §1.2 **方式4「AI 智能勾选」**：口述条件 → 发给 AI → 跳到**确认界面**，
 *    确认界面支持**多轮对话**（接着说「再多加一些动词」这类补充条件，AI 重新给选择）。
 *    选出的词与方式3 同口径进临时优先级表（勾中的词 = 1 + 背诵优先级，其余 0）。
 * 2. 提示词 10 第 3 条：视觉优化——只**加线、改框**，不添加任何有实质信息的文本。
 */
import { orderByPriority, tableByDefault, tableByPicked, tableBySources, type PriorityTable } from '../../core/learnSelect';
import type { PaperArchive, Source, Word } from '../../core/types';
import * as dao from '../../dao';
import { aiConfigFromSettings } from '../../services/ai';
import { pickWords, type PickMessage, type PickTurnView } from '../../services/aiPick';
import { button, checkbox, h, textInput } from '../dom';
import { toastError, toastWarn } from '../components/Toast';
import { navigate } from '../router';
import { currentSettings } from './settings/ctx';

/** 方式3 分页大小 */
const PAGE_SIZE = 20;

/**
 * 渲染背诵选择页。
 */
export function renderLearnPage(): HTMLElement {
  // ── 页面状态（全部是本页的临时状态，离开页面即丢） ──
  let tab: 'pick' | 'resume' = 'pick';
  let method: 1 | 2 | 3 | 4 = 1;
  let words: Word[] = [];
  let sources: Source[] = [];
  const pickedSourceIds = new Set<string>();
  const pickedWordIds = new Set<string>();
  let recordScores = true;
  /** 方式3 的筛选/排序/分页 */
  let keyword = '';
  let sortBy: 'en' | 'priority' = 'en';
  let page = 1;

  // ── 方式4 的状态 ──
  /** 用户在条件框里口述的内容（第一轮） */
  let aiCondition = '';
  /** 是否已经进到「确认界面」 */
  let aiStarted = false;
  /** 正在等 AI 回复 */
  let aiBusy = false;
  /** 当前 AI 选中的词 id */
  const aiSelected = new Set<string>();
  /** 确认界面里显示的对话（人话） */
  const aiTurns: PickTurnView[] = [];
  /** 发给模型的历史（user = 条件原文，assistant = 上一轮 JSON 结果） */
  const aiMessages: PickMessage[] = [];
  /** 确认界面里「继续对话」的输入框内容 */
  let aiFollowUp = '';

  const page_ = h('div', { class: 'page learn-select' });
  const left = h('aside', { class: 'learn-select-nav' });
  const right = h('section', { class: 'learn-select-main' });
  const body = h('div', { class: 'learn-select-body' }, left, right);
  page_.appendChild(body);

  // ── 左栏两个页签 ──
  const navItems: { key: 'pick' | 'resume'; label: string }[] = [
    { key: 'pick', label: '选取单词' },
    { key: 'resume', label: '继续背诵' },
  ];
  const drawNav = (): void => {
    left.replaceChildren();
    for (const item of navItems) {
      const b = h('button', {
        class: `learn-nav-item${tab === item.key ? ' is-active' : ''}`,
        type: 'button',
        text: item.label,
      });
      b.addEventListener('click', () => {
        tab = item.key;
        drawNav();
        void drawRight();
      });
      left.appendChild(b);
    }
  };

  // ── 底部：记录成绩 + 开始背诵 ──
  const bottom = h('div', { class: 'learn-select-bottom' });
  const recordBox = checkbox(recordScores, '记录成绩', (on) => {
    recordScores = on;
  });
  const startBtn = button('开始背诵', () => void start(), { variant: 'primary', class: 'learn-start-btn' });
  bottom.appendChild(recordBox);
  bottom.appendChild(startBtn);
  page_.appendChild(bottom);

  /** 按当前方式算出临时优先级表 */
  const buildTable = (): PriorityTable => {
    if (method === 1) return tableByDefault(words);
    if (method === 2) return tableBySources(words, pickedSourceIds);
    if (method === 3) return tableByPicked(words, pickedWordIds);
    // 方式4：AI 选中的词与方式3 同口径（勾中的词 = 1 + 背诵优先级，其余 0）
    return tableByPicked(words, aiSelected);
  };

  /** 「开始背诵」：建一张 draft 存档并进白纸 */
  const start = async (): Promise<void> => {
    const table = buildTable();
    const queue = orderByPriority(words, table);
    if (queue.length === 0) {
      toastWarn('这一轮没有选中任何单词');
      return;
    }
    const now = Date.now();
    const paper: PaperArchive = {
      id: `paper-${now}`,
      name: '',
      priorityTable: table,
      // 种子在这里定死并落库：同一张纸无论何时打开，位置都一样
      seed: `paper-${now}`,
      shownIds: [],
      placements: {},
      recordScores,
      status: 'draft',
      createdAt: now,
      updatedAt: now,
    };
    await dao.papers.put(paper);
    navigate(`/learn/paper?paper=${paper.id}`);
  };

  // ── 方式1/2/3/4 的选择区 ──
  const drawMethodBox = (): HTMLElement => {
    const box = h('div', { class: 'stack' });

    const methods: { v: 1 | 2 | 3 | 4; label: string }[] = [
      { v: 1, label: '默认优先级（临时优先级 = 背诵优先级）' },
      { v: 2, label: '按来源分类（选中来源的词优先级 +1，其余为 0）' },
      { v: 3, label: '从单词列表选取（勾中的词优先级 +1，其余为 0）' },
      { v: 4, label: 'AI 智能勾选（口述条件，AI 选词）' },
    ];
    /** 四个方式的框：外框一条线，行与行之间一条线（视觉优化，不加任何文字） */
    const methodsBox = h('div', { class: 'learn-methods' });
    for (const m of methods) {
      const line = h('label', { class: 'radio-line' });
      const radio = h('input', { type: 'radio', name: 'learn-method', checked: method === m.v });
      radio.addEventListener('change', () => {
        method = m.v;
        void drawRight();
      });
      line.appendChild(radio);
      line.appendChild(h('span', { class: 'field-label', text: m.label }));
      methodsBox.appendChild(line);
    }
    box.appendChild(methodsBox);

    if (method === 2) {
      const srcBox = h('div', { class: 'card' });
      srcBox.appendChild(h('h3', { class: 'card-title', text: '选择来源' }));
      if (sources.length === 0) {
        srcBox.appendChild(h('p', { class: 'note', text: '还没有任何来源。先去「录入」建立来源。' }));
      } else {
        for (const s of sources) {
          const line = h('label', { class: 'radio-line' });
          const cb = h('input', { type: 'checkbox', checked: pickedSourceIds.has(s.id) });
          cb.addEventListener('change', () => {
            if (cb.checked) pickedSourceIds.add(s.id);
            else pickedSourceIds.delete(s.id);
          });
          line.appendChild(cb);
          line.appendChild(h('span', { class: 'field-label', text: s.name }));
          srcBox.appendChild(line);
        }
      }
      box.appendChild(srcBox);
    }

    if (method === 3) {
      box.appendChild(h('p', { class: 'note', text: '本轮从单词列表选取：展开后勾选，勾中的词优先级 +1。' }));
      box.appendChild(drawPicker());
    }

    if (method === 4) {
      box.appendChild(aiStarted ? drawAiConfirm() : drawAiStart());
    }

    return box;
  };

  /**
   * 方式4 的第一步：口述条件。
   * 这里只有一个输入框和一个「发送给 AI」按钮——用户原话是「用户口述条件，发送给 AI」。
   */
  const drawAiStart = (): HTMLElement => {
    const box = h('div', { class: 'card learn-ai-start' });
    box.appendChild(h('h3', { class: 'card-title', text: '口述选词条件' }));
    const area = h('textarea', {
      class: 'textarea learn-ai-input',
      rows: '3',
      placeholder: '例如：只选背诵优先级是 p1、且中文意思里有「放弃」的词',
    });
    area.value = aiCondition;
    area.addEventListener('input', () => {
      aiCondition = area.value;
    });
    box.appendChild(area);

    const send = button(
      aiBusy ? '发送中…' : '发送给 AI',
      () => {
        if (aiBusy) return;
        aiBusy = true;
        send.disabled = true;
        send.textContent = '发送中…';
        void (async () => {
          try {
            await runAiTurn(aiCondition, true);
          } finally {
            // ★ 先落「不忙」再重画：否则新画出来的按钮会带着「发送中…」的字样且仍是禁用态
            //   （实测踩过：确认界面的「继续对话」一直点不动）
            aiBusy = false;
            void drawRight();
          }
        })();
      },
      { variant: 'primary' },
    );
    send.disabled = aiBusy;
    box.appendChild(h('div', { class: 'row' }, send));
    return box;
  };

  /**
   * 方式4 的第二步：**确认界面**（用户原话「跳转至确认界面」「确认界面支持多轮对话」）。
   *
   * 组成：对话记录 → 选中的单词（可勾选调整）→ 继续对话的输入框 → 返回。
   * 「开始背诵」仍在底部那条（选定后直接用它）。
   */
  const drawAiConfirm = (): HTMLElement => {
    const box = h('div', { class: 'stack learn-ai-confirm' });
    box.appendChild(h('h3', { class: 'card-title', text: '确认界面' }));

    // ① 对话记录
    const log = h('div', { class: 'learn-ai-log' });
    for (const turn of aiTurns) {
      log.appendChild(
        h('div', { class: `learn-ai-turn ${turn.role}` }, h('span', { class: 'learn-ai-who', text: turn.role === 'user' ? '我' : 'AI' }), h('span', { class: 'learn-ai-text', text: turn.text })),
      );
    }
    box.appendChild(log);

    // ② 选中的单词（可取消/补勾；勾选状态就是最终会进白纸的词）
    const listCard = h('div', { class: 'card learn-ai-list' });
    listCard.appendChild(h('h4', { class: 'sub-title', text: `已选 ${aiSelected.size} 词` }));
    if (aiSelected.size === 0) {
      listCard.appendChild(h('p', { class: 'note', text: 'AI 这一轮没有选出单词，可以补充条件再说一次。' }));
    } else {
      const rows = h('div', { class: 'stack learn-ai-rows' });
      for (const w of words) {
        if (!aiSelected.has(w.id)) continue;
        const line = h('label', { class: 'radio-line' });
        const cb = h('input', { type: 'checkbox', checked: true });
        cb.addEventListener('change', () => {
          if (cb.checked) aiSelected.add(w.id);
          else aiSelected.delete(w.id);
          void drawRight();
        });
        line.appendChild(cb);
        line.appendChild(h('span', { class: 'field-label', text: w.en }));
        line.appendChild(h('span', { class: 'field-hint', text: w.senses.map((s) => s.text).join(' / ') }));
        rows.appendChild(line);
      }
      listCard.appendChild(rows);
    }
    box.appendChild(listCard);

    // ③ 多轮对话：接着说补充条件
    const followCard = h('div', { class: 'card learn-ai-follow' });
    const follow = h('textarea', {
      class: 'textarea learn-ai-input',
      rows: '2',
      placeholder: '继续对话：例如「去掉太长的词」「再多加一些动词」',
    });
    follow.value = aiFollowUp;
    follow.addEventListener('input', () => {
      aiFollowUp = follow.value;
    });
    const send = button(
      aiBusy ? '发送中…' : '继续对话',
      () => {
        if (aiBusy) return;
        aiBusy = true;
        send.disabled = true;
        send.textContent = '发送中…';
        void (async () => {
          try {
            await runAiTurn(aiFollowUp, false);
          } finally {
            aiBusy = false;
            void drawRight();
          }
        })();
      },
      { variant: 'primary' },
    );
    send.disabled = aiBusy;
    followCard.appendChild(follow);
    followCard.appendChild(
      h(
        'div',
        { class: 'row' },
        send,
        button('返回条件', () => {
          aiStarted = false;
          aiFollowUp = '';
          void drawRight();
        }),
      ),
    );
    box.appendChild(followCard);

    return box;
  };

  /**
   * 跑一轮 AI 选词。
   *
   * @param condition 这一轮的条件（第一轮 = 口述条件，后续 = 补充条件）
   * @param first 是不是第一轮（第一轮清空历史）
   */
  const runAiTurn = async (condition: string, first: boolean): Promise<void> => {
    const text = condition.trim();
    if (text === '') {
      toastWarn('先写一句选词条件');
      return;
    }
    const cfg = aiConfigFromSettings(currentSettings());
    const current = words.filter((w) => aiSelected.has(w.id)).map((w) => w.en);
    /**
     * ★ 0.0.27（用户：「AI 选取功能缺少上下文记忆」）：**每一轮都把全部对话带上**。
     * 之前靠 `first ? [] : aiMessages`，一旦界面回到初始面板（first=true）历史就被清空，
     * 模型立刻"失忆"。现在历史只增不清（清空只发生在用户重开一轮时 aiMessages 本来就是空的）。
     */
    const history = aiMessages.slice();
    const result = await pickWords({
      cfg,
      candidates: words,
      condition: text,
      history,
      current,
    });
    if (result.failed) {
      toastError(result.error ?? 'AI 选词失败');
      return;
    }
    // 用返回值覆盖选中集合（不累加：多轮的目的是「按新条件重选」）
    aiSelected.clear();
    const byEn = new Map(words.map((w) => [w.en, w.id]));
    for (const en of result.selected) {
      const id = byEn.get(en);
      if (id !== undefined) aiSelected.add(id);
    }
    const reply = result.reply === '' ? `已选出 ${result.selected.length} 个词` : result.reply;
    aiTurns.push({ role: 'user', text });
    aiTurns.push({ role: 'assistant', text: reply });
    // ★ 0.0.27：历史只追加、不在这里清空（「全部上下文」要求每一轮都能看到前面说过什么）
    // 给模型留一份「上一轮的完整结果」，多轮时它才能在此基础上增删
    aiMessages.push({ role: 'user', content: first ? `用户条件：${text}` : `补充条件：${text}` });
    aiMessages.push({ role: 'assistant', content: JSON.stringify({ selected: result.selected, reply }) });
    if (first) aiCondition = text;
    aiFollowUp = '';
    aiStarted = true;
    // ★ 重画之前先落「不忙」，否则新画出的按钮会带着「发送中…」并保持禁用
    aiBusy = false;
    void drawRight();
  };

  /** 方式3 的折叠单词列表（翻页 / 筛选 / 排序 / 勾选 / 批量勾选） */
  const drawPicker = (): HTMLElement => {
    const details = h('details', { class: 'card learn-picker' });
    details.appendChild(h('summary', { class: 'card-title', text: '展开单词列表' }));
    const inner = h('div', { class: 'stack' });
    details.appendChild(inner);

    const toolbar = h('div', { class: 'row learn-picker-toolbar' });
    toolbar.appendChild(
      textInput(keyword, (v) => {
        keyword = v;
        page = 1;
        drawList();
      }, { placeholder: '筛选英文或中文' }),
    );
    const sortBtn = button('排序：首字母', () => {
      sortBy = sortBy === 'en' ? 'priority' : 'en';
      sortBtn.textContent = sortBy === 'en' ? '排序：首字母' : '排序：优先级';
      drawList();
    });
    toolbar.appendChild(sortBtn);
    toolbar.appendChild(
      button('全选本页', () => {
        for (const w of pageRows()) pickedWordIds.add(w.id);
        drawList();
      }),
    );
    toolbar.appendChild(
      button('清空勾选', () => {
        pickedWordIds.clear();
        drawList();
      }),
    );
    inner.appendChild(toolbar);

    const listBox = h('div', { class: 'stack learn-picker-list' });
    const pager = h('div', { class: 'row learn-picker-pager' });
    inner.appendChild(listBox);
    inner.appendChild(pager);

    const filtered = (): Word[] => {
      const k = keyword.trim().toLowerCase();
      const rows =
        k === ''
          ? words
          : words.filter((w) => w.en.toLowerCase().includes(k) || w.senses.some((s) => s.text.includes(keyword.trim())));
      return rows
        .slice()
        .sort((a, b) =>
          sortBy === 'en' ? a.en.localeCompare(b.en, 'en') : (b.priority ?? 3) - (a.priority ?? 3),
        );
    };
    const pageRows = (): Word[] => {
      const rows = filtered();
      return rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
    };

    const drawList = (): void => {
      listBox.replaceChildren();
      const rows = pageRows();
      if (rows.length === 0) {
        listBox.appendChild(h('p', { class: 'note', text: '没有匹配的单词' }));
      }
      for (const w of rows) {
        const line = h('label', { class: 'radio-line learn-row' });
        const cb = h('input', { type: 'checkbox', checked: pickedWordIds.has(w.id) });
        cb.addEventListener('change', () => {
          if (cb.checked) pickedWordIds.add(w.id);
          else pickedWordIds.delete(w.id);
        });
        line.appendChild(cb);
        line.appendChild(h('span', { class: 'field-label', text: w.en }));
        line.appendChild(h('span', { class: 'field-hint', text: w.senses.map((s) => s.text).join(' / ') }));
        listBox.appendChild(line);
      }
      pager.replaceChildren();
      const total = filtered().length;
      const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
      pager.appendChild(
        h('span', { class: 'field-hint', text: `共 ${total} 词 · 第 ${page}/${pages} 页 · 已勾 ${pickedWordIds.size}` }),
      );
      const prev = button('上一页', () => {
        page = Math.max(1, page - 1);
        drawList();
      });
      prev.disabled = page <= 1;
      const next = button('下一页', () => {
        page = Math.min(pages, page + 1);
        drawList();
      });
      next.disabled = page >= pages;
      pager.appendChild(prev);
      pager.appendChild(next);
    };

    drawList();
    return details;
  };

  /** 继续背诵：进行中的存档列表（方案 B） */
  const drawResume = async (): Promise<HTMLElement> => {
    const box = h('div', { class: 'stack' });
    const drafts = await dao.papers.listDrafts();
    if (drafts.length === 0) {
      box.appendChild(h('p', { class: 'note', text: '还没有进行中的白纸存档。' }));
      return box;
    }
    /** 存档列表：外框一条线，行与行之间一条线（视觉优化，不加任何文字） */
    const listBox = h('div', { class: 'learn-archive-list' });
    for (const p of drafts) {
      const row = h('div', { class: 'learn-archive-row' });
      row.appendChild(h('span', { class: 'field-label', text: p.name || '（未命名）' }));
      row.appendChild(h('span', { class: 'field-hint', text: `${p.shownIds.length} 词` }));
      row.appendChild(h('span', { class: 'field-hint', text: p.recordScores ? '记录成绩' : '不记录成绩' }));
      row.appendChild(button('继续', () => navigate(`/learn/paper?paper=${p.id}`)));
      row.appendChild(
        button(
          '删除',
          () => {
            void (async () => {
              await dao.papers.remove(p.id);
              await drawRight();
            })();
          },
          { variant: 'danger' },
        ),
      );
      listBox.appendChild(row);
    }
    box.appendChild(listBox);
    return box;
  };

  const drawRight = async (): Promise<void> => {
    right.replaceChildren();
    // 底部栏只在「选取单词」页签可用（方案 B 里它是不可用的）
    startBtn.disabled = tab !== 'pick';
    recordBox.setAttribute('disabled', tab === 'pick' ? 'false' : 'true');
    if (tab === 'pick') {
      right.appendChild(h('h2', { class: 'page-title', text: '选取单词' }));
      right.appendChild(drawMethodBox());
    } else {
      right.appendChild(h('h2', { class: 'page-title', text: '继续背诵' }));
      right.appendChild(await drawResume());
    }
  };

  // ── 初始化：读词与来源 ──
  void (async () => {
    try {
      const [all, srcs] = await Promise.all([dao.words.listAlive(), dao.sources.list()]);
      words = all.filter((w) => w.status !== 'chopped');
      sources = srcs;
    } catch (err) {
      console.error('[learn] 读取词库/来源失败', err);
    }
    drawNav();
    await drawRight();
  })();

  return page_;
}
