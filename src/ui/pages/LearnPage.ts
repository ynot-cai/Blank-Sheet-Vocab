/**
 * 背诵选择页面（`#/learn`）—— 版本 0.0.13。
 *
 * 用户要求（三、排版方案 A/B）：
 *   左栏两个页签：`选取单词` / `继续背诵`；右栏是对应内容；
 *   底部一条：`记录成绩` 勾选框 + `开始背诵` 按钮。
 *
 * 这一页的产出是**临时优先级表**（`core/learnSelect.ts`），
 * 加上一个固定种子，组成一张 `PaperArchive`（draft），然后进白纸界面。
 *
 * 四种方式里本轮实现 1/2/3；**方式4（AI 智能勾选）未实现**，
 * 界面上明确写出来，不假装能点（用户第 5 条要求过不许加未提到的元素、也不许糊弄）。
 */
import { DEFAULT_MERGE_POLICY } from '../../core/merge';
import { orderByPriority, tableByDefault, tableByPicked, tableBySources, type PriorityTable } from '../../core/learnSelect';
import type { PaperArchive, Source, Word } from '../../core/types';
import * as dao from '../../dao';
import { button, checkbox, h, textInput } from '../dom';
import { toastWarn } from '../components/Toast';
import { navigate } from '../router';

void DEFAULT_MERGE_POLICY; // 仅为保持 import 稳定（本轮未用合并策略）

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
  let pickedSourceIds = new Set<string>();
  let pickedWordIds = new Set<string>();
  let recordScores = true;
  /** 方式3 的筛选/排序/分页 */
  let keyword = '';
  let sortBy: 'en' | 'priority' = 'en';
  let page = 1;

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
    // 方式4：未实现，退回默认（界面上已提示）
    return tableByDefault(words);
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

  // ── 方式1/2/3 的选择区 ──
  const drawMethodBox = (): HTMLElement => {
    const box = h('div', { class: 'stack' });

    const methods: { v: 1 | 2 | 3 | 4; label: string }[] = [
      { v: 1, label: '默认优先级（临时优先级 = 背诵优先级）' },
      { v: 2, label: '按来源分类（选中来源的词优先级 +1，其余为 0）' },
      { v: 3, label: '从单词列表选取（勾中的词优先级 +1，其余为 0）' },
      { v: 4, label: 'AI 智能勾选（本轮未实现）' },
    ];
    for (const m of methods) {
      const line = h('label', { class: 'radio-line' });
      const radio = h('input', { type: 'radio', name: 'learn-method', checked: method === m.v });
      radio.addEventListener('change', () => {
        method = m.v;
        void drawRight();
      });
      line.appendChild(radio);
      line.appendChild(h('span', { class: 'field-label', text: m.label }));
      box.appendChild(line);
    }

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

    return box;
  };

  /** 方式3 的折叠单词列表（翻页 / 筛选 / 排序 / 勾选 / 批量勾选） */
  const drawPicker = (): HTMLElement => {
    const details = h('details', { class: 'card learn-picker' });
    details.appendChild(h('summary', { class: 'card-title', text: '展开单词列表' }));
    const inner = h('div', { class: 'stack' });
    details.appendChild(inner);

    const toolbar = h('div', { class: 'row' });
    toolbar.appendChild(textInput(keyword, (v) => {
      keyword = v;
      page = 1;
      drawList();
    }, { placeholder: '筛选英文或中文' }));
    const sortBtn = button('排序：首字母', () => {
      sortBy = sortBy === 'en' ? 'priority' : 'en';
      sortBtn.textContent = sortBy === 'en' ? '排序：首字母' : '排序：优先级';
      drawList();
    });
    toolbar.appendChild(sortBtn);
    const allBtn = button('全选本页', () => {
      for (const w of pageRows()) pickedWordIds.add(w.id);
      drawList();
    });
    toolbar.appendChild(allBtn);
    const noneBtn = button('清空勾选', () => {
      pickedWordIds.clear();
      drawList();
    });
    toolbar.appendChild(noneBtn);
    inner.appendChild(toolbar);

    const listBox = h('div', { class: 'stack' });
    const pager = h('div', { class: 'row' });
    inner.appendChild(listBox);
    inner.appendChild(pager);

    const filtered = (): Word[] => {
      const k = keyword.trim().toLowerCase();
      const rows = k === '' ? words : words.filter((w) => w.en.toLowerCase().includes(k) || w.senses.some((s) => s.text.includes(keyword.trim())));
      return rows.slice().sort((a, b) => (sortBy === 'en' ? a.en.localeCompare(b.en, 'en') : (b.priority ?? 3) - (a.priority ?? 3)));
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
        const line = h('label', { class: 'radio-line' });
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
      pager.appendChild(h('span', { class: 'field-hint', text: `共 ${total} 词 · 第 ${page}/${pages} 页 · 已勾 ${pickedWordIds.size}` }));
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
    for (const p of drafts) {
      const row = h('div', { class: 'card learn-archive-row' });
      const title = h('span', { class: 'field-label', text: p.name || '（未命名）' });
      const count = h('span', { class: 'field-hint', text: `${p.shownIds.length} 词` });
      const rec = h('span', { class: 'field-hint', text: p.recordScores ? '记录成绩' : '不记录成绩' });
      const open = button('继续', () => navigate(`/learn/paper?paper=${p.id}`));
      const del = button('删除', () => {
        void (async () => {
          await dao.papers.remove(p.id);
          await drawRight();
        })();
      }, { variant: 'danger' });
      row.appendChild(title);
      row.appendChild(count);
      row.appendChild(rec);
      row.appendChild(open);
      row.appendChild(del);
      box.appendChild(row);
    }
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
