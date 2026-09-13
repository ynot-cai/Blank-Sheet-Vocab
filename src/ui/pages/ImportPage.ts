import { uid } from '../../core/model';
import type { PresetTier } from '../../core/presets';
import { currentSettings } from './settings/ctx';
import * as dao from '../../dao';
import { aiConfigFromSettings, normalizeEndpoint, splitIntoChunks } from '../../services/ai';
import type { ImportJob } from '../../services/importJob';
import { clearJob, jobProgress, loadJob, saveJob } from '../../services/importJob';
import { dedupeResults, runJob } from '../../services/parsePipeline';
import { PresetLoadError, clearPresetCache, loadPreset } from '../../services/presetVocab';
import { button, h } from '../dom';
import { confirmModal } from '../components/Modal';
import { toastError, toastOk, toastWarn } from '../components/Toast';
import { navigate } from '../router';
import { renderInputPanel } from './import/InputPanel';
import { renderJobPanel } from './import/JobPanel';
import { confirmPresetImport } from './import/PresetConfirm';

/**
 * 录入页：预设词库 + 来源设置 + 输入方式 + 解析设置 + 分批解析（含断点续传）。
 */
export function renderImportPage(): HTMLElement {
  const page = h('div', { class: 'page' });
  page.appendChild(h('h2', { class: 'page-title', text: '录入单词' }));
  page.appendChild(
    h('p', { class: 'note' }, '贴进来的文本会先解析成「英文条目（单词 / 短语 / 缩写）+ 义项」，解析完进下一屏逐词确认，确认后才真正入库。'),
  );

  let presetBusy = false;
  const panel = renderInputPanel({
    onPreset: (tier) => void importPreset(tier),
    isPresetBusy: () => presetBusy,
  });
  page.appendChild(panel.el);

  const startBtn = button('开始解析', () => void start(), { variant: 'primary' });
  const startRow = h('div', { class: 'row sticky-row' }, startBtn);
  page.appendChild(startRow);

  const jobPanel = renderJobPanel({
    onContinue: () => void run(job, false),
    onRetryFailed: () => void run(job, true),
    onAbort: () => {
      void (async () => {
        const ok = await confirmModal('放弃本次导入', '会清掉这次解析的中间结果（词库里的数据不受影响）。确定吗？', '放弃', true);
        if (!ok) return;
        clearJob();
        job = null;
        jobPanel.update(null, false);
        toastOk('已清空本次导入任务');
      })();
    },
  });

  const resumeBanner = h('div', { class: 'banner hidden' });
  page.appendChild(resumeBanner);
  page.appendChild(jobPanel.el);

  let job: ImportJob | null = loadJob();
  let running = false;

  /**
   * 导入一整档预设词库。
   *
   * 这些词表的义项是现成的，所以**不经过 AI 解析**：
   * 直接把词条填进 ImportJob.results，复用 jobPanel（看进度）和合并确认页（逐词确认）。
   * 走的是和「粘贴文本→解析」完全相同的下游路径，只是跳过了「解析」这一步。
   *
   * 导入前先弹确认框（可改优先度）：优先级决定已有词的义项会不会被覆盖，
   * 而事后改来源优先级**不会**补做合并，所以必须给用户一个导入前改的机会。
   *
   * @param tier 选中的档位
   */
  const importPreset = async (tier: PresetTier): Promise<void> => {
    if (presetBusy || running) return;
    presetBusy = true;
    try {
      const loaded = await loadPreset(tier);
      if (loaded.words.length === 0) {
        toastError(`预设词库「${tier.label}」是空的，请重新生成产物（npm run presets）`);
        return;
      }

      // 已存在的来源要先查出来：确认框里要显示「当前优先级」并作为输入框默认值
      const existingList = await dao.sources.list();
      const existing =
        existingList.find((s) => s.name.trim().toLowerCase() === tier.sourceName.trim().toLowerCase()) ?? null;

      const answer = await confirmPresetImport(tier, {
        words: loaded.words.length,
        senseCount: loaded.senseCount,
        existing: existing ? { priority: existing.priority } : null,
      });
      if (!answer.confirmed) return;

      const source = await dao.sources.ensureByName(tier.sourceName, answer.priority);

      // chunks 在预设预览流程里**不会被读取**——合并页只用 results。
      // 但 ImportJob 的类型要求它是数组，而且任务面板/续传横幅会显示「已完成 x/y 批」，
      // 所以留一个已经完成的占位批次（写清楚来源），既满足类型也让人看得懂。
      // 这里刻意**不**按词数切几百个批次：那是纯粹的内存浪费。
      const chunks: string[][] = [[`预设词库：${tier.label}`]];

      const next: ImportJob = {
        id: uid(),
        sourceId: source.id,
        sourceName: source.name,
        priority: source.priority,
        // 预设词库也要能选优先级（提示词 2.4 节）：确认框里选的值写进这一批词
        wordPriority: answer.wordPriority,
        chunks,
        doneFlags: chunks.map(() => true),
        errors: chunks.map(() => null),
        results: loaded.words,
        useAi: false,
        createdAt: Date.now(),
      };
      job = next;
      saveJob(next);
      clearPresetCache();
      refreshBanner();
      jobPanel.update(next, false);
      toastOk(`已载入「${tier.sourceName}」${loaded.words.length} 词、${loaded.senseCount} 个义项，正在进入确认页`);
      navigate('/merge');
    } catch (err) {
      if (err instanceof PresetLoadError) toastError(err.message);
      else toastError(err instanceof Error ? err.message : String(err));
    } finally {
      presetBusy = false;
    }
  };

  /** 刷新「有未完成任务」提示 */
  const refreshBanner = (): void => {
    resumeBanner.replaceChildren();
    if (!job || jobProgress(job).total === jobProgress(job).done) {
      resumeBanner.classList.add('hidden');
      return;
    }
    resumeBanner.classList.remove('hidden');
    const p = jobProgress(job);
    resumeBanner.appendChild(
      h('span', { text: `有未完成的导入任务：${job.sourceName}，已完成 ${p.done}/${p.total} 批（共解析出 ${job.results.length} 个词）` }),
    );
    resumeBanner.appendChild(button('继续解析', () => void run(job, false), { variant: 'primary' }));
    resumeBanner.appendChild(button('重试失败批次', () => void run(job, true)));
    resumeBanner.appendChild(
      button(
        '去合并页',
        () => {
          navigate('/merge');
        },
        { variant: 'ghost' },
      ),
    );
    resumeBanner.appendChild(
      button(
        '放弃并清空',
        () => {
          clearJob();
          job = null;
          refreshBanner();
          jobPanel.update(null, false);
        },
        { variant: 'danger' },
      ),
    );
  };

  /** 开始一次新的解析 */
  const start = async (): Promise<void> => {
    const input = panel.read();
    const lines = input.text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l !== '' && !l.startsWith('#'));
    if (lines.length === 0) {
      toastError('还没有内容：请粘贴文本或上传文件');
      return;
    }
    if (input.sourceName.trim() === '') {
      toastError('请填写来源名称');
      return;
    }

    let mode = input.mode;
    const settings = currentSettings();
    const cfg = aiConfigFromSettings(settings);
    if (mode === 'ai' && cfg.key.trim() === '') {
      const goRule = await confirmModal(
        '没有填密钥',
        'AI 解析需要在设置页填接口地址和密钥。要改用「规则解析（离线）」继续吗？',
        '改用规则解析',
      );
      if (goRule) mode = 'rule';
      else {
        navigate('/settings');
        return;
      }
    }

    const source = input.sourceId
      ? (await dao.sources.getById(input.sourceId)) ?? (await dao.sources.ensureByName(input.sourceName, input.sourcePriority))
      : await dao.sources.ensureByName(input.sourceName, input.sourcePriority);

    const chunks = splitIntoChunks(lines, input.batchSize);
    job = {
      id: uid(),
      sourceId: source.id,
      sourceName: source.name,
      priority: source.priority,
      // ★ R1：把录入页选的词级优先级记进任务，入库时写给这一批的每个词
      wordPriority: input.priority,
      chunks,
      doneFlags: chunks.map(() => false),
      errors: chunks.map(() => null),
      results: [],
      useAi: mode === 'ai',
      endpoint: mode === 'ai' ? normalizeEndpoint(cfg.endpoint) : undefined,
      createdAt: Date.now(),
    };
    saveJob(job);
    console.info('[导入] 最终请求地址：', job.endpoint ?? '（规则解析，不发请求）');
    if (job.endpoint) toastOk(`接口地址规范化后：${job.endpoint}`);
    refreshBanner();
    await run(job, false);
  };

  /** 跑（或继续跑）任务 */
  const run = async (target: ImportJob | null, onlyFailed: boolean): Promise<void> => {
    if (!target || running) return;
    running = true;
    jobPanel.update(target, true);
    resumeBanner.classList.add('hidden');
    const input = panel.read();
    try {
      await runJob(target, {
        mode: target.useAi ? 'ai' : 'rule',
        cfg: aiConfigFromSettings(currentSettings()),
        fieldSep: input.fieldSep,
        senseSep: input.senseSep,
        onlyFailed,
        onProgress: () => jobPanel.update(target, true),
      });
    } catch (err) {
      toastError(err instanceof Error ? err.message : String(err));
    } finally {
      running = false;
      jobPanel.update(target, false);
    }

    const p = jobProgress(target);
    if (p.done >= p.total) {
      target.results = dedupeResults(target.results);
      saveJob(target);
      toastOk(`解析完成，共 ${target.results.length} 个词，正在进入合并确认页`);
      navigate('/merge');
      return;
    }

    // 全失败 → 提示是否改走规则解析
    if (p.done === 0 && p.failed > 0 && target.useAi) {
      const fallback = await confirmModal(
        'AI 解析失败了',
        '所有批次都没成功。要不要改用「规则解析（离线）」重跑一遍？',
        '改用规则解析',
      );
      if (fallback) {
        target.useAi = false;
        target.errors = target.errors.map(() => null);
        target.results = [];
        await run(target, false);
        return;
      }
    }
    refreshBanner();
    jobPanel.update(target, false);
  };

  const existing = loadJob();
  if (existing) {
    job = existing;
    refreshBanner();
    jobPanel.update(existing, false);
    toastWarn('检测到未完成的导入任务，可继续解析或放弃');
  }

  return page;
}
