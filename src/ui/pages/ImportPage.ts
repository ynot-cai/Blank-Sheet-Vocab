import { uid } from '../../core/model';
import type { PresetTier } from '../../core/presets';
import { currentSettings } from './settings/ctx';
import * as dao from '../../dao';
import { aiConfigFromSettings, normalizeEndpoint, splitIntoChunks } from '../../services/ai';
import type { ImportJob } from '../../services/importJob';
import { clearJob, jobProgress, loadJob, saveJob } from '../../services/importJob';
import { dedupeResults, runJob } from '../../services/parsePipeline';
import { PresetLoadError, clearPresetCache, loadPreset, presetToText } from '../../services/presetVocab';
import { button, h } from '../dom';
import { confirmModal } from '../components/Modal';
import { toastError, toastOk, toastWarn } from '../components/Toast';
import { navigate } from '../router';
import { renderInputPanel } from './import/InputPanel';
import { renderJobPanel } from './import/JobPanel';

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
   * 点预设档位：把这一档的词表**粘贴到下面的文本栏**，并切到「粘贴文本」页签。
   *
   * ★ 刻意**不**弹确认框、也**不**直接入库（原来那套已经删掉了）。理由：
   *   预设 JSON 里的义项是原始词表直接生成的（一个词往往只有一条、塞着
   *   「v. 获取 n. 接近，入口」这种整串中文），必须让 AI 按《资料整理规范》
   *   重新分类义项、挑代表词、把近义词逐个分开——而 AI 那一步在「开始解析」里。
   *   绕过它就等于把一坨没整理的中文直接塞进词库。
   *
   * 所以这里只做三件事：填文本、带出来源名、给个合理的默认优先级。
   * 之后用户点「开始解析」→ 走的是和手打文本**完全同一条**链路。
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
      const text = presetToText(loaded.words, currentSettings().parse.senseSep);
      // 词表直接进**本来就有的那个**编辑框（不另建文本栏）
      panel.setText(text);
      panel.setSourceName(tier.sourceName);
      // 优先级给该档位一个合理默认值（初中=1 … 雅思=5），用户仍可自己改
      panel.setPriority(tier.priority);
      panel.showPasteTab();
      clearPresetCache();
      toastOk(
        `已把「${tier.label}」${loaded.words.length} 词（${loaded.senseCount} 个义项）填进文本栏。` +
          '下一步点「开始解析」，让 AI 按整理规范把义项重新理一遍。',
      );
      // 把视线带到「开始解析」上（长词表会让人不知道下一步点哪）
      window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
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
      ? (await dao.sources.getById(input.sourceId)) ?? (await dao.sources.ensureByName(input.sourceName))
      : await dao.sources.ensureByName(input.sourceName);

    const chunks = splitIntoChunks(lines, input.batchSize);
    job = {
      id: uid(),
      sourceId: source.id,
      sourceName: source.name,
      // ★ 唯一的那个优先级：记进任务，入库时写给这一批的每个词
      priority: input.priority,
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
