import { uid } from '../../core/model';
import { currentSettings } from './settings/ctx';
import * as dao from '../../dao';
import { aiConfigFromSettings, normalizeEndpoint, splitIntoChunks } from '../../services/ai';
import type { ImportJob } from '../../services/importJob';
import { clearJob, jobProgress, loadJob, saveJob } from '../../services/importJob';
import { dedupeResults, runJob } from '../../services/parsePipeline';
import { button, h } from '../dom';
import { confirmModal } from '../components/Modal';
import { toastError, toastOk, toastWarn } from '../components/Toast';
import { navigate } from '../router';
import { renderInputPanel } from './import/InputPanel';
import { renderJobPanel } from './import/JobPanel';

/**
 * 录入页：来源设置 + 输入方式 + 解析设置 + 分批解析（含断点续传）。
 */
export function renderImportPage(): HTMLElement {
  const page = h('div', { class: 'page' });
  page.appendChild(h('h2', { class: 'page-title', text: '录入单词' }));
  page.appendChild(
    h('p', { class: 'note' }, '贴进来的文本会先解析成「英文条目（单词 / 短语 / 缩写）+ 义项」，解析完进下一屏逐词确认，确认后才真正入库。'),
  );

  const panel = renderInputPanel();
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
      ? (await dao.sources.getById(input.sourceId)) ?? (await dao.sources.ensureByName(input.sourceName, input.priority))
      : await dao.sources.ensureByName(input.sourceName, input.priority);

    const chunks = splitIntoChunks(lines, input.batchSize);
    job = {
      id: uid(),
      sourceId: source.id,
      sourceName: source.name,
      priority: source.priority,
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
