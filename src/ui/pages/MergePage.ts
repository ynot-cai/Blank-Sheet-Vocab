import { normalizeEn, normalizeWordPriority, validateWord, wordPriorityOf } from '../../core/model';
import { planImport } from '../../core/merge';
import { currentSettings } from './settings/ctx';
import type { Word } from '../../core/types';
import * as dao from '../../dao';
import { aiConfigFromSettings, parseWordBatch, suggestMerges } from '../../services/ai';
import type { MergeSuggestion } from '../../services/ai';
import { clearJob, loadJob, saveJob } from '../../services/importJob';
import { button, checkbox, debounce, h, textInput } from '../dom';
import { confirmModal } from '../components/Modal';
import {
  askPriorityConflicts,
  recallConflict,
  resetConflictMemory,
  type PriorityConflict,
} from '../components/PriorityConflict';
import { toastError, toastOk, toastWarn } from '../components/Toast';
import { navigate } from '../router';
import type { DraftWord } from './merge/drafts';
import { draftStats, draftsFromEntries, draftToWord } from './merge/drafts';
import { REANALYZE_BATCH_SIZE, applyReanalysis, draftsToSourceLines } from './merge/reanalyze';
import { renderMergeCard } from './merge/MergeCard';

/** 「智能再合并」每次送给 AI 的词数 */
const MERGE_BATCH_SIZE = 100;

/**
 * 找出「库里已有该词、但优先级不同」的冲突（R1 提示词 2.5 节）。
 *
 * 判据只有一条：**词已存在且优先级不同**。
 *   · 词不存在 → 不是冲突（正常插入）；
 *   · 词已存在且优先级相同 → 不是冲突（静默更新其他内容，不打断用户）。
 *
 * @param incoming 本次要入库的词（顺序与草稿一致）
 * @param existing 库里已有的词（含墓碑，按 en 归一化比对）
 * @returns 冲突列表（去掉本次会话已经问过的那些）
 */
function collectPriorityConflicts(incoming: Word[], existing: Word[]): PriorityConflict[] {
  const byEn = new Map<string, Word>();
  for (const w of existing) {
    if (w.deleted === 1) continue;
    byEn.set(normalizeEnKey(w.en), w);
  }
  const out: PriorityConflict[] = [];
  const seen = new Set<string>();
  for (const next of incoming) {
    const hit = byEn.get(normalizeEnKey(next.en));
    if (!hit) continue;
    const currentPriority = wordPriorityOf(hit);
    const incomingPriority = normalizeWordPriority(next.priority);
    if (currentPriority === incomingPriority) continue;
    const conflict: PriorityConflict = {
      wordId: hit.id,
      en: hit.en,
      currentPriority,
      incomingPriority,
    };
    // 本次会话已经问过的：直接沿用上次的选择，不再弹窗（提示词要求「不再重复问」）
    if (recallConflict(conflict) !== null) continue;
    // 同一批里同一个词只问一次
    if (seen.has(hit.id)) continue;
    seen.add(hit.id);
    out.push(conflict);
  }
  return out;
}

/**
 * 反查「这次会话里已经决定过的冲突」，把决定直接应用到 incoming。
 * @param incoming 本次要入库的词
 * @param existing 库里已有的词
 * @returns 本次会话里已经决定过的那些词 id 集合（这些词需要按上次的选择处理）
 */
function recalledDecisions(incoming: Word[], existing: Word[]): Map<string, 'overwrite' | 'keep'> {
  const byEn = new Map<string, Word>();
  for (const w of existing) {
    if (w.deleted === 1) continue;
    byEn.set(normalizeEnKey(w.en), w);
  }
  const out = new Map<string, 'overwrite' | 'keep'>();
  for (const next of incoming) {
    const hit = byEn.get(normalizeEnKey(next.en));
    if (!hit) continue;
    const remembered = recallConflict({
      wordId: hit.id,
      en: hit.en,
      currentPriority: wordPriorityOf(hit),
      incomingPriority: normalizeWordPriority(next.priority),
    });
    if (remembered !== null) out.set(hit.id, remembered);
  }
  return out;
}

/**
 * 英文归一化 key（与 core/merge.ts 的判重口径保持一致：小写 + 去首尾标点 + 压空白）。
 * @param en 英文
 */
function normalizeEnKey(en: string): string {
  return normalizeEn(en).toLowerCase();
}

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

  // class 里带一个 merge-stat：页面里 note 不止一处（下面还有预设提示条），
  // 给统计行一个稳定标识，脚本/测试可以直接定位它。
  const statLine = h('p', { class: 'note merge-stat' });

  // ★ 预设词库导进来的词，义项是**没整理过的**（每条只有 1 个义项、塞着整串原文），
  //   因为预设 JSON 是从原始词表直接生成的。这里主动提示一句，
  //   否则用户会以为「这软件就长这样」而不知道有整理功能。
  //   判据：所有词都只有 1 个义项 —— 手粘文本走 AI 解析的话不会是这个形态。
  if (drafts.length > 3 && drafts.every((d) => d.senses.length === 1)) {
    page.appendChild(
      h('p', {
        class: 'note warn',
        text:
          '这些词的义项还没有整理过（每个词都只有一条、内容是原始词表里的整串中文）。' +
          '点上面的「AI 重新分析义项」，让 AI 按整理规范把它们分类成义项、挑出代表词、把近义词逐个分开。',
      }),
    );
  }

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
  const reanalyzeBtn = button('AI 重新分析义项', () => void runReanalyze(), {
    title: '让 AI 按整理规范把这个词的义项分类、挑代表词、分隔近义词',
  });
  const toolbar = h(
    'div',
    { class: 'toolbar sticky-row' },
    searchInput,
    multiToggle,
    button('全部展开', () => expandAll(true)),
    button('全部折叠', () => expandAll(false)),
    reanalyzeBtn,
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
          // 放弃这一批了，把「本次会话问过的优先级冲突」也清掉——
          // 下次重新走一遍时应该重新问，而不是沿用上一批的选择。
          resetConflictMemory();
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

  // —— AI 重新分析义项 ——
  /**
   * 让 AI 按《资料整理规范》（core/senseRules.ts）重新整理义项。
   *
   * 主要用途是**预设词库导入之后**：预设数据是从原始词表直接生成的，
   * 每条只有 1 个义项、里面塞着一整串原文（"v. 获取 n. 接近，入口"），
   * 既没分类成义项，也没把近义词分开。这个按钮把整理这步交给 AI。
   *
   * 会上网、要花钱、会覆盖手动编辑，所以动手前必须确认；
   * 失败或没配密钥时**保留原有内容**，不清空、不阻断（本地优先是基石）。
   */
  const runReanalyze = async (): Promise<void> => {
    if (busy) return;
    const cfg = aiConfigFromSettings(currentSettings());
    if (cfg.key.trim() === '') {
      toastWarn('AI 重新分析需要密钥，请先去设置页填写接口地址和密钥');
      return;
    }
    const targets = drafts.filter((d) => !d.dropped);
    if (targets.length === 0) {
      toastWarn('没有可分析的词');
      return;
    }
    const batchCount = Math.ceil(targets.length / REANALYZE_BATCH_SIZE);
    const ok = await confirmModal(
      'AI 重新分析义项',
      `会用 AI 把 ${targets.length} 个词重新整理一遍（分 ${batchCount} 批发给你的 AI 接口）：\n` +
        '把中文意思分类成义项、每个义项挑一个代表词、近义词逐个分开、多词性判断是否同源。\n\n' +
        '⚠️ 会**覆盖**你在这些词上已经做过的修改（改代表词、划掉义项、加近义词）。\n' +
        '分析失败的批次会保持原样，不会清空。确定继续吗？',
      '开始分析',
    );
    if (!ok) return;

    busy = true;
    reanalyzeBtn.disabled = true;
    renderList();

    let done = 0;
    let failedBatches = 0;
    let updated = 0;
    let skipped = 0;
    try {
      for (let i = 0; i < targets.length; i += REANALYZE_BATCH_SIZE) {
        const batch = targets.slice(i, i + REANALYZE_BATCH_SIZE);
        reanalyzeBtn.textContent = `分析中… ${done}/${targets.length}`;
        const res = await parseWordBatch(cfg, draftsToSourceLines(batch));
        done += batch.length;
        if (res.failed) {
          failedBatches += 1;
          continue;
        }
        const applied = applyReanalysis(drafts, res.entries);
        drafts = applied.drafts;
        updated += applied.stat.updated;
        skipped += applied.stat.skipped;
      }
    } catch (err) {
      toastError(err instanceof Error ? err.message : String(err));
    } finally {
      busy = false;
      reanalyzeBtn.disabled = false;
      reanalyzeBtn.textContent = 'AI 重新分析义项';
    }

    persist();
    renderList();
    refreshStats();

    if (failedBatches > 0) toastWarn(`${failedBatches} 批分析失败，那些词保持原样，可再点一次只重试失败的部分`);
    if (updated === 0) {
      toastWarn('AI 没有返回可用的结果，内容未改动');
    } else {
      toastOk(`已重新整理 ${updated} 个词的义项${skipped > 0 ? `，${skipped} 个未变（AI 没返回或返回为空）` : ''}`);
    }
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
      const existing = await dao.words.getAll();

      const incoming: Word[] = [];
      const invalid: string[] = [];
      for (const draft of keep) {
        // ★ 唯一的那个优先级来自任务存档（录入页 / 预设填文本后选的那个）
        const word = draftToWord(draft, job.sourceId, job.priority);
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

      // ── 重复录入的处理：**只由那一个确认框决定** ──
      //   判据：库里已有该词、且**优先级不同** → 弹框问「覆盖 / 保留」。
      //   优先级相同就不问，静默更新其他内容（义项等）。
      const conflicts = collectPriorityConflicts(incoming, existing);
      const overwriteIds = new Set<string>();
      if (conflicts.length > 0) {
        const answer = await askPriorityConflicts(conflicts, { sourceName: job.sourceName });
        for (const c of conflicts) {
          if (answer.decisions.get(c.wordId) === 'overwrite') overwriteIds.add(c.wordId);
        }
        toastOk(`优先级冲突处理完成：覆盖 ${answer.overwrittenCount} 个、保留 ${answer.keptCount} 个`);
      }
      // 本次会话里之前已问过的（同一对话再次入库）也一并应用
      for (const [wordId, decision] of recalledDecisions(incoming, existing)) {
        if (decision === 'overwrite') overwriteIds.add(wordId);
      }

      // 交给 core/merge 做计划：overwriteIds 就是用户在确认框里的选择。
      //   · 选了「覆盖」→ 本次的义项与优先级都写进去，旧义项留档到 rawSources；
      //   · 没选（「保留」）→ 库里那条一个字都不动，本次义项留档到 rawSources。
      const plan = planImport(incoming, existing, overwriteIds);
      const result = await dao.words.bulkUpsert([...plan.inserts, ...plan.replaces]);
      await dao.sources.upsert({ id: job.sourceId, name: job.sourceName, createdAt: Date.now() });
      clearJob();
      // ★ 这里**刻意不清**「本次会话问过的冲突」（resetConflictMemory）。
      //   用户要求的是「同一会话不再重复问」——清了的话，同一对话里再导入一次
      //   同一批词就会把一模一样的框再弹一遍（实测就是这个现象）。
      //   会话记忆只在「取消本次导入」时清（见上面的 onAbort）。
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
