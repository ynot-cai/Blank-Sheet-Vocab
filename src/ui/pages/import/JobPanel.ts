import { button, h } from '../../dom';
import type { ImportJob } from '../../../services/importJob';
import { jobProgress } from '../../../services/importJob';

/** 进度面板句柄 */
export interface JobPanel {
  el: HTMLElement;
  update: (job: ImportJob | null, running: boolean) => void;
}

/**
 * 渲染解析进度面板（进度条 + 已完成 x/y 批 + 继续/重试失败/放弃）。
 * @param handlers 三个操作的回调
 */
export function renderJobPanel(handlers: {
  onContinue: () => void;
  onRetryFailed: () => void;
  onAbort: () => void;
}): JobPanel {
  const el = h('div', { class: 'card job-panel hidden' });
  const title = h('h3', { class: 'card-title', text: '解析进度' });
  const bar = h('div', { class: 'progress-bar' });
  const fill = h('div', { class: 'progress-fill' });
  bar.appendChild(fill);
  const line = h('p', { class: 'field-hint', text: '' });
  const failedBox = h('div', { class: 'stack' });

  const row = h('div', { class: 'row' });
  const btnContinue = button('继续解析', () => handlers.onContinue(), { variant: 'primary' });
  const btnRetry = button('重试失败批次', () => handlers.onRetryFailed());
  const btnAbort = button('放弃并清空', () => handlers.onAbort(), { variant: 'danger' });
  row.appendChild(btnContinue);
  row.appendChild(btnRetry);
  row.appendChild(btnAbort);

  el.appendChild(title);
  el.appendChild(bar);
  el.appendChild(line);
  el.appendChild(failedBox);
  el.appendChild(row);

  return {
    el,
    update(job, running) {
      if (!job) {
        el.classList.add('hidden');
        return;
      }
      el.classList.remove('hidden');
      const p = jobProgress(job);
      const percent = p.total === 0 ? 0 : Math.round((p.done / p.total) * 100);
      fill.style.width = `${percent}%`;
      line.textContent = `已完成 ${p.done}/${p.total} 批${p.failed > 0 ? ` · 失败 ${p.failed} 批` : ''}${
        running ? ' · 正在解析…' : ''
      } · 已解析出 ${job.results.length} 个词`;
      btnContinue.disabled = running || p.done >= p.total;
      btnRetry.disabled = running || p.failed === 0;
      btnAbort.disabled = running;
      failedBox.replaceChildren();
      job.errors.forEach((err, i) => {
        if (!err) return;
        failedBox.appendChild(h('p', { class: 'test-result bad', text: `第 ${i + 1} 批失败：${err}` }));
      });
    },
  };
}
