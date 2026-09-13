/**
 * 题库页（`#/kc/bank`）—— 阶段 05 做**存储与读取**，阶段 07 再做完整管理页。
 *
 * 题库的唯一用途：出题时作为**风格参考**（抽 3~5 条同题型样题喂给 AI）。
 * 所以这一页的核心动作是「加进来 / 看清楚 / 删掉」，不需要花哨功能。
 *
 * 说明文案是用户明确要求照抄的（见页面底部）。
 */
import { EXAM_TYPES, type BankQuestion } from '../../core/kcTypes';
import * as dao from '../../dao';
import { openModal } from '../components/Modal';
import { toastOk, toastWarn } from '../components/Toast';
import { bankAddButton } from '../components/KcContextManager';
import { exportBankText, splitBankText } from './kcBank/kcBankImport';
import { button, h } from '../dom';
import { navigate } from '../router';

/** 当前的题型筛选（空串 = 全部） */
let filterType = '';

/**
 * 渲染题库页。
 */
export function renderKcBankPage(): HTMLElement {
  const page = h('div', { class: 'page kc-bank-page' });
  const headBox = h('div', { class: 'kc-bank-head' });
  const filterBox = h('div', { class: 'kc-bank-filter' });
  const listBox = h('div', { class: 'kc-bank-list' });
  page.appendChild(headBox);
  page.appendChild(filterBox);
  page.appendChild(listBox);

  /** 重新读库并重画 */
  const refresh = async (): Promise<void> => {
    const all = await dao.examBank.listBankQuestions();
    const shown = filterType === '' ? all : all.filter((q) => q.type === filterType);

    // ── 头部 ──
    headBox.replaceChildren();
    headBox.appendChild(h('h1', { class: 'kc-bank-title', text: '题库' }));
    headBox.appendChild(h('span', { class: 'kc-bank-count', text: `共 ${all.length} 条${filterType === '' ? '' : `（本页显示 ${shown.length} 条）`}` }));
    headBox.appendChild(bankAddButton(() => void refresh()));
    headBox.appendChild(
      button('批量粘贴', () => {
        void batchPaste();
      }, { variant: 'ghost' }),
    );
    headBox.appendChild(
      button('导入文件', () => {
        void importFile();
      }, { variant: 'ghost' }),
    );
    headBox.appendChild(
      button('全部导出', () => {
        exportAll(all);
      }, { variant: 'ghost' }),
    );
    headBox.appendChild(button('回二期首页', () => navigate('/kc'), { variant: 'ghost' }));
    headBox.appendChild(button('清空题库', () => void removeAll(all.length), { variant: 'ghost', class: 'kc-bank-danger' }));

    // ── 筛选 ──
    filterBox.replaceChildren();
    const mkFilter = (value: string, label: string): HTMLElement =>
      button(label, () => {
        filterType = value;
        void refresh();
      }, { variant: filterType === value ? 'primary' : 'ghost', class: 'kc-filter-btn' });
    filterBox.appendChild(mkFilter('', '全部'));
    for (const t of EXAM_TYPES) filterBox.appendChild(mkFilter(t.id, t.name));

    // ── 列表 ──
    listBox.replaceChildren();
    if (shown.length === 0) {
      const empty = h('div', { class: 'kc-empty' });
      empty.appendChild(h('p', { class: 'kc-empty-title', text: all.length === 0 ? '题库还是空的' : '这个题型下没有样题' }));
      empty.appendChild(
        h('p', {
          class: 'kc-hint-dim',
          text: '每个题型放 30~50 道高质量样题就够 —— AI 会模仿它们的风格与难度来出题。',
        }),
      );
      listBox.appendChild(empty);
      return;
    }
    for (const q of shown) listBox.appendChild(renderBankItem(q, () => void refresh()));
  };

  /**
   * 清空整个题库（二次确认 + 要求输入「删除」）。
   * @param count 当前条数
   */
  async function removeAll(count: number): Promise<void> {
    if (count === 0) return;
    const input = h('input', { class: 'input', type: 'text', placeholder: '输入「删除」确认' });
    openModal({
      title: `清空题库（${count} 条）？`,
      width: '440px',
      body: h('div', {}, [
        h('p', { class: 'modal-text', text: '清空后无法恢复。题库只是出题的风格参考，清掉不会影响知识卡片。' }),
        input,
      ]),
      actions: [
        { text: '取消', variant: 'ghost', onClick: (close) => close() },
        {
          text: '清空',
          variant: 'danger',
          onClick: (close) => {
            void (async () => {
              if (input.value.trim() !== '删除') {
                return;
              }
              const all = await dao.examBank.listBankQuestions();
              for (const q of all) await dao.examBank.removeBankQuestion(q.id);
              toastOk(`已清空 ${all.length} 条`);
              close();
              await refresh();
            })();
          },
        },
      ],
    });
  }

  /**
   * 批量粘贴导入（阶段 07 §2）：按规则切分 + 猜题型。
   */
  async function batchPaste(): Promise<void> {
    const typeSelect = h('select', { class: 'input' });
    for (const t of EXAM_TYPES) typeSelect.appendChild(h('option', { value: t.id, text: t.name }));
    const textarea = h('textarea', {
      class: 'input kc-bank-content-area',
      rows: '10',
      placeholder: '把题目粘进来（支持空行分隔 / 1. 2. 3. 编号 / --- 分隔线）',
    });
    const sourceInput = h('input', { class: 'input', type: 'text', placeholder: '来源标注（整批共用），如「2023全国甲卷」' });
    const preview = h('p', { class: 'kc-hint-dim', text: '粘贴后点「预览」看看切成了几道、各自判成什么题型。' });

    openModal({
      title: '批量粘贴题目',
      width: '640px',
      body: [
        h('label', { class: 'kc-set-field' }, [
          h('span', { class: 'kc-field-label', text: '认不出特征时用哪个题型' }),
          typeSelect,
        ]),
        h('label', { class: 'kc-set-field' }, [h('span', { class: 'kc-field-label', text: '题目文本' }), textarea]),
        h('label', { class: 'kc-set-field' }, [h('span', { class: 'kc-field-label', text: '来源（可选）' }), sourceInput]),
        preview,
      ],
      actions: [
        { text: '取消', variant: 'ghost', onClick: (close) => close() },
        {
          text: '预览',
          variant: 'ghost',
          onClick: () => {
            const items = splitBankText(textarea.value, typeSelect.value, sourceInput.value.trim());
            const counts = new Map<string, number>();
            for (const it of items) counts.set(it.type, (counts.get(it.type) ?? 0) + 1);
            const detail = [...counts.entries()]
              .map(([t, n]) => `${EXAM_TYPES.find((x) => x.id === t)?.name ?? t} ${n} 道`)
              .join('、');
            preview.textContent = items.length === 0 ? '没有解析出任何题目。' : `会导入 ${items.length} 道：${detail}`;
          },
        },
        {
          text: '导入',
          variant: 'primary',
          onClick: (close) => {
            void (async () => {
              const items = splitBankText(textarea.value, typeSelect.value, sourceInput.value.trim());
              if (items.length === 0) {
                toastWarn('没有解析出题目');
                return;
              }
              for (const it of items) {
                await dao.examBank.addBankQuestion(it.type, it.content, sourceInput.value.trim());
              }
              toastOk(`已导入 ${items.length} 道题`);
              close();
              await refresh();
            })();
          },
        },
      ],
    });
  }

  /**
   * 从文件导入（txt / md）。
   */
  async function importFile(): Promise<void> {
    const input = h('input', { type: 'file', accept: '.txt,.md,text/plain' });
    input.addEventListener('change', () => {
      void (async () => {
        const file = input.files?.[0];
        if (file === undefined) return;
        const text = await file.text();
        const items = splitBankText(text, 'fill', file.name);
        if (items.length === 0) {
          toastWarn('文件里没有解析出题目');
          return;
        }
        for (const it of items) await dao.examBank.addBankQuestion(it.type, it.content, file.name);
        toastOk(`从 ${file.name} 导入 ${items.length} 道题`);
        await refresh();
      })();
    });
    input.click();
  }

  /**
   * 全部导出（下载一个 .txt，格式与批量导入兼容）。
   * @param rows 全部题库
   */
  function exportAll(rows: BankQuestion[]): void {
    if (rows.length === 0) {
      toastWarn('题库是空的');
      return;
    }
    const text = exportBankText(rows.map((r) => ({ type: r.type, content: r.content, source: r.source })));
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: `知识点题库_${new Date().toISOString().slice(0, 10)}.txt` });
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toastOk(`已导出 ${rows.length} 道题（导出文件可以直接再用「批量粘贴」导回来）`);
  }

  void refresh();
  return page;
}

/**
 * 渲染一条样题。
 * @param q 样题
 * @param onChanged 删除后回调
 */
function renderBankItem(q: BankQuestion, onChanged: () => void): HTMLElement {
  const item = h('article', { class: 'kc-bank-item' });
  const head = h('div', { class: 'kc-bank-itemhead' });
  head.appendChild(h('span', { class: 'kc-chip', text: EXAM_TYPES.find((t) => t.id === q.type)?.name ?? q.type }));
  if (q.source !== '') head.appendChild(h('span', { class: 'kc-bank-source', text: q.source }));
  head.appendChild(h('span', { class: 'kc-bank-date', text: new Date(q.createdAt).toLocaleDateString() }));
  head.appendChild(
    button('删除', () => {
      void (async () => {
        await dao.examBank.removeBankQuestion(q.id);
        toastOk('已删除');
        onChanged();
      })();
    }, { variant: 'ghost', class: 'kc-mini-btn kc-mini-btn--danger' }),
  );
  item.appendChild(head);

  // 题目内容可能很长：默认折叠，点开看全文（内容一律当纯文本）
  const details = h('details', { class: 'kc-bank-details' });
  details.appendChild(h('summary', { text: firstLine(q.content) }));
  details.appendChild(h('pre', { class: 'kc-pre kc-bank-content', text: q.content }));
  item.appendChild(details);
  return item;
}

/**
 * 取内容的第一行（列表里当作标题行）。
 * @param text 内容
 */
function firstLine(text: string): string {
  const line = text.split('\n').map((l) => l.trim()).find((l) => l !== '') ?? '（空）';
  return line.length > 60 ? `${line.slice(0, 60)}…` : line;
}
