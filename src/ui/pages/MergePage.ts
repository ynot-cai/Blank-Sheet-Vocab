import { validateWord } from '../../core/model';
import { planImport, setSourcePriorities } from '../../core/merge';
import { currentSettings } from './settings/ctx';
import type { Word } from '../../core/types';
import * as dao from '../../dao';
import { aiConfigFromSettings, suggestMerges } from '../../services/ai';
import type { MergeSuggestion } from '../../services/ai';
import { clearJob, loadJob, saveJob } from '../../services/importJob';
import { button, checkbox, debounce, h, textInput } from '../dom';
import { confirmModal } from '../components/Modal';
import { toastError, toastOk, toastWarn } from '../components/Toast';
import { navigate } from '../router';
import type { DraftWord } from './merge/drafts';
import { draftStats, draftsFromEntries, draftToWord } from './merge/drafts';
import { renderMergeCard } from './merge/MergeCard';

/** 「智能再合并」每次送给 AI 的词数 */
const MERGE_BATCH_SIZE = 100;

/**
 * 义项合并确认页：逐词确认义项、划掉、合并、加近义词，最后一步确认入库。
 */
export function renderMergePage(): HTMLElement {
  const page = h('div', { class: 'page merge-page' });
  page.appendChild(h('h2', { class: 'page-title', text: '确认义项并入库' }));

  const job = loadJob();
  if (!job || job.results.length === 0) {
    page.appendChild(h('p', { class: 'note warn' }, '没有待确认的解析结果。请先去「录入」页粘贴或上传单词。'));
    page.appendChild(button('去录入页', () => navigate('/import'), { variant: 'primary' }));
    return page;
  }

  let drafts: DraftWord[] = draftsFromEntries(job.results);
  let keyword = '';
  let onlyMulti = false;
  let busy = false;

  const statLine = h('p', { class: 'note' });

  // —— 工具条 ——
  const searchInput = textInput(
    '',
    debounce((v: string) => {
      keyword = v.trim().toLowerCase();
      renderList();
    }, 200),
    { placeholder: '按英文过滤卡片' },
  );

  const multiToggle = checkbox(false, '仅看多义词', (v) => {
    onlyMulti = v;
    renderList();
  });

  const expandAll = (open: boolean): void => {
    list.querySelectorAll('details.merge-card').forEach((el) => {
      (el as HTMLDetailsElement).open = open;
    });
  };

  const suggestBtn = button('智能再合并', () => void runSuggest(), { variant: 'primary' });
  const toolbar = h(
    'div',
    { class: 'toolbar sticky-row' },
    searchInput,
    multiToggle,
    button('全部展开', () => expandAll(true)),
    button('全部折叠', () => expandAll(false)),
    suggestBtn,
  );

  // —— 列表 ——
  const list = h('div', { class: 'merge-list' });

  /** 过滤后的草稿 */
  const visibleDrafts = (): DraftWord[] =>
    drafts.filter((d) => {
      if (keyword && !d.en.toLowerCase().includes(keyword)) return false;
      if (onlyMulti && d.senses.filter((s) => s.enabled && s.text.trim() !== '').length <= 1) return false;
      return true;
    });

  /** 把当前草稿写回 sessionStorage 存档（防抖，编辑过程中不会频繁写） */
  const persist = debounce(() => {
    job.results = drafts
      .filter((d) => !d.dropped)
      .map((d) => ({
        en: d.en,
        phonetic: d.phonetic,
        example: d.example,
        senses: d.senses.map((s) => ({ text: s.text, aliases: s.aliases })),
      }));
    saveJob(job);
  }, 500);

  /** 重画列表 */
  const renderList = (): void => {
    const visible = visibleDrafts();
    list.replaceChildren();
    if (visible.length === 0) {
      list.appendChild(h('p', { class: 'note' }, '没有符合条件的卡片。'));
      return;
    }
    for (const draft of visible) {
      list.appendChild(
        renderMergeCard(draft, {
          openDefault: drafts.length <= 8,
          onChange: (next) => {
            const index = drafts.findIndex((d) => d.key === next.key);
            if (index >= 0) drafts[index] = next;
            refreshStats();
            persist();
          },
          onRemove: () => {
            drafts = drafts.filter((d) => d.key !== draft.key);
            renderList();
            refreshStats();
            persist();
          },
        }),
      );
    }
  };

  /** 刷新统计与按钮文案 */
  const refreshStats = (): void => {
    const s = draftStats(drafts);
    statLine.textContent = `共 ${s.words} 个词、${s.senses} 个义项，其中 ${s.multiSense} 个词有多个义项${
      s.dropped > 0 ? ` · ${s.dropped} 个已标记斩掉（不入库）` : ''
    }`;
    commitBtn.textContent = `确认入库（${s.words - s.dropped} 词）`;
  };

  // —— 底部固定操作栏 ——
  const commitBtn = button('确认入库', () => void commit(), { variant: 'primary' });
  const bottom = h(
    'div',
    { class: 'bottom-bar' },
    commitBtn,
    button('返回修改', () => navigate('/import')),
    button(
      '取消本次导入',
      () => {
        void (async () => {
          const ok = await confirmModal('取消本次导入', '会丢弃这次解析出来的所有内容（词库不受影响）。确定吗？', '取消导入', true);
          if (!ok) return;
          clearJob();
          navigate('/home');
        })();
      },
      { variant: 'danger' },
    ),
  );

  // —— 智能再合并 ——
  const runSuggest = async (): Promise<void> => {
    if (busy) return;
    const cfg = aiConfigFromSettings(currentSettings());
    if (cfg.key.trim() === '') {
      toastWarn('智能再合并需要 AI 密钥，请先去设置页填写');
      return;
    }
    const targets = drafts.filter((d) => d.senses.filter((s) => s.enabled && s.text.trim() !== '').length > 1);
    if (targets.length === 0) {
      toastWarn('没有多义词，不需要再合并');
      return;
    }
    busy = true;
    suggestBtn.disabled = true;
    suggestBtn.textContent = '正在请求建议…';
    let suggestions: MergeSuggestion[] = [];
    let failedBatches = 0;
    try {
      for (let i = 0; i < targets.length; i += MERGE_BATCH_SIZE) {
        const batch = targets.slice(i, i + MERGE_BATCH_SIZE);
        const res = await suggestMerges(
          cfg,
          batch.map((d) => ({ en: d.en, senses: d.senses.filter((s) => s.enabled && s.text.trim() !== '').map((s) => s.text) })),
        );
        if (res.failed) {
          failedBatches += 1;
          continue;
        }
        suggestions = suggestions.concat(res.suggestions);
      }
    } finally {
      busy = false;
      suggestBtn.disabled = false;
      suggestBtn.textContent = '智能再合并';
    }

    if (failedBatches > 0) toastWarn(`${failedBatches} 批建议请求失败，可重试`);
    if (suggestions.length === 0) {
      toastOk('AI 没有找出需要合并的义项');
      return;
    }
    let applied = 0;
    for (const suggestion of suggestions) {
      const hit = drafts.find((d) => d.en.trim().toLowerCase() === suggestion.en.trim().toLowerCase());
      if (!hit) continue;
      hit.hints = [...hit.hints, suggestion];
      applied += 1;
    }
    toastOk(`拿到 ${applied} 条合并建议，卡片里点「接受」才会生效`);
    renderList();
  };

  // —— 确认入库 ——
  const commit = async (): Promise<void> => {
    if (busy) return;
    const keep = drafts.filter((d) => !d.dropped);
    if (keep.length === 0) {
      toastError('没有可入库的词');
      return;
    }
    busy = true;
    commitBtn.disabled = true;
    try {
      const [existing, sources] = await Promise.all([dao.words.getAll(), dao.sources.list()]);
      setSourcePriorities(sources);
      const dir = currentSettings().parse.priorityDir;

      const incoming: Word[] = [];
      const invalid: string[] = [];
      for (const draft of keep) {
        const word = draftToWord(draft, job.sourceId);
        const errors = validateWord(word);
        if (errors.length > 0) {
          invalid.push(`${word.en || '（空）'}：${errors.join('，')}`);
          continue;
        }
        incoming.push(word);
      }
      if (invalid.length > 0) {
        toastError(`${invalid.length} 个词不合法，已跳过。例如：${invalid[0] ?? ''}`);
      }
      if (incoming.length === 0) return;

      const plan = planImport(incoming, existing, dir);
      const result = await dao.words.bulkUpsert([...plan.inserts, ...plan.replaces]);
      await dao.sources.upsert({ id: job.sourceId, name: job.sourceName, priority: job.priority, createdAt: Date.now() });
      clearJob();
      toastOk(`入库完成：新增 ${result.inserted} 个、更新 ${result.updated} 个。${plan.report}`);
      navigate('/list');
    } catch (err) {
      toastError(err instanceof Error ? err.message : String(err));
    } finally {
      busy = false;
      commitBtn.disabled = false;
      refreshStats();
    }
  };

  page.appendChild(statLine);
  page.appendChild(toolbar);
  page.appendChild(list);
  page.appendChild(bottom);
  renderList();
  refreshStats();

  return page;
}
