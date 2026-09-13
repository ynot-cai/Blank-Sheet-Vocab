/**
 * 录入任务（importJob）的断点续传存档。
 * 存在 sessionStorage 里：刷新页面不丢，关掉标签页就清掉（半成品解析结果没必要长期留着）。
 */
import type { ParsedWord } from './ai';
import { WORD_PRIORITY_DEFAULT } from '../core/types';
import { normalizeWordPriority } from '../core/model';

/** sessionStorage 的键 */
const JOB_KEY = 'blank-sheet-vocab.importJob';

/** 一次录入任务 */
export interface ImportJob {
  id: string;
  sourceId: string;
  sourceName: string;
  /** 来源优先级（决定「同一个词的义项归谁」，与下面的 wordPriority 是两回事） */
  priority: number;
  /**
   * ★ 词级优先级（R1）：这一批词入库时写进每个 `word.priority`（1~5，5 最高）。
   *
   * 为什么放在任务上而不是「入库时现读界面」：录入任务是**可续传**的
   * （存 sessionStorage，刷新后还能继续），续传时界面上的单选框早就没了。
   * 放在任务里，续传和重试批次都能拿到当初选的那个值。
   *
   * 老存档没有这个字段 —— 读取时按 `WORD_PRIORITY_DEFAULT` 兜底（见 loadJob）。
   */
  wordPriority: number;
  /** 切好的批次（每批是若干行原文） */
  chunks: string[][];
  /** 每批是否已完成 */
  doneFlags: boolean[];
  /** 每批的错误信息（成功为 null） */
  errors: (string | null)[];
  /** 已解析出来的词（按批次顺序追加） */
  results: ParsedWord[];
  /** 是否为 AI 解析（false = 规则解析） */
  useAi: boolean;
  /** 规范化后的完整请求地址（AI 模式，展示给用户自查） */
  endpoint?: string;
  createdAt: number;
}

/**
 * 存一份任务存档。
 * @param job 任务对象
 */
export function saveJob(job: ImportJob): void {
  try {
    sessionStorage.setItem(JOB_KEY, JSON.stringify(job));
  } catch (err) {
    console.warn('[importJob] 存档失败（可能是文本太大）', err);
  }
}

/**
 * 读取任务存档。
 *
 * 兼容性：R1 之前存下的任务没有 `wordPriority` 字段，
 * 这里补成默认值 3，不然续传时会写出 `priority: undefined`。
 */
export function loadJob(): ImportJob | null {
  try {
    const raw = sessionStorage.getItem(JOB_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ImportJob;
    if (!parsed || !Array.isArray(parsed.chunks)) return null;
    if (typeof parsed.wordPriority !== 'number') {
      parsed.wordPriority = normalizeWordPriority(parsed.wordPriority ?? WORD_PRIORITY_DEFAULT);
    }
    return parsed;
  } catch (err) {
    console.warn('[importJob] 读取存档失败', err);
    return null;
  }
}

/**
 * 清掉任务存档。
 */
export function clearJob(): void {
  try {
    sessionStorage.removeItem(JOB_KEY);
  } catch (err) {
    console.warn('[importJob] 清理存档失败', err);
  }
}

/**
 * 统计完成情况。
 * @param job 任务对象
 */
export function jobProgress(job: ImportJob): { done: number; total: number; failed: number } {
  let done = 0;
  let failed = 0;
  job.doneFlags.forEach((ok, i) => {
    if (ok) done += 1;
    else if (job.errors[i]) failed += 1;
  });
  return { done, total: job.chunks.length, failed };
}
