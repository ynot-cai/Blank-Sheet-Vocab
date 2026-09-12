/**
 * 解析流水线：分批调用 AI（或规则解析），每批完成立刻落一次存档（断点续传的 checkpoint）。
 * 某一批出错只记录该批的错误，不中断整体流程。
 */
import { parseText } from '../core/parser';
import type { AiConfig, ParsedWord } from './ai';
import { parseWordBatch } from './ai';
import type { ImportJob } from './importJob';
import { jobProgress, saveJob } from './importJob';

/** 进度回调参数 */
export interface PipelineProgress {
  done: number;
  total: number;
  failed: number;
  /** 当前这一批的序号（从 1 开始） */
  current: number;
}

/** 流水线参数 */
export interface PipelineOptions {
  mode: 'ai' | 'rule';
  cfg?: AiConfig;
  fieldSep: string;
  senseSep: string;
  /** 只重跑失败的批次（「重试失败批次」按钮用） */
  onlyFailed?: boolean;
  onProgress?: (p: PipelineProgress) => void;
  signal?: AbortSignal;
}

/**
 * 用规则解析处理一批原文。
 * @param chunk 一批原文行
 * @param fieldSep 字段分隔符
 * @param senseSep 义项分隔符
 */
function ruleParseChunk(chunk: string[], fieldSep: string, senseSep: string): { entries: ParsedWord[]; error?: string } {
  const { entries, errors } = parseText(chunk.join('\n'), { fieldSep, senseSep });
  if (entries.length === 0) {
    return { entries: [], error: errors[0] ? `规则解析没解析出词：${errors[0].reason}` : '这一批没有解析出任何词' };
  }
  return {
    entries: entries.map((e) => ({
      en: e.en,
      phonetic: '',
      example: '',
      senses: e.senses.map((text) => ({ text, aliases: [] })),
    })),
  };
}

/**
 * 跑完（或继续跑）一个录入任务。
 * @param job 任务（会被就地修改并落存档）
 * @param opts 解析方式等参数
 * @returns 更新后的任务
 */
export async function runJob(job: ImportJob, opts: PipelineOptions): Promise<ImportJob> {
  const total = job.chunks.length;
  for (let i = 0; i < total; i += 1) {
    const alreadyDone = job.doneFlags[i] === true;
    const isFailed = job.errors[i] !== null && job.errors[i] !== undefined;
    const shouldRun = opts.onlyFailed ? isFailed : !alreadyDone;
    if (!shouldRun) continue;
    if (opts.signal?.aborted) break;

    const chunk = job.chunks[i] ?? [];
    opts.onProgress?.({ ...jobProgress(job), current: i + 1 });

    if (opts.mode === 'ai' && opts.cfg) {
      const res = await parseWordBatch(opts.cfg, chunk.join('\n'), opts.signal);
      if (res.failed) {
        job.errors[i] = res.error ?? '解析失败';
        job.doneFlags[i] = false;
      } else {
        job.results.push(...res.entries);
        job.doneFlags[i] = true;
        job.errors[i] = null;
      }
    } else {
      const res = ruleParseChunk(chunk, opts.fieldSep, opts.senseSep);
      if (res.error) {
        job.errors[i] = res.error;
        job.doneFlags[i] = false;
      } else {
        job.results.push(...res.entries);
        job.doneFlags[i] = true;
        job.errors[i] = null;
      }
    }
    saveJob(job); // 每批都落一次存档：断点续传的关键
    opts.onProgress?.({ ...jobProgress(job), current: i + 1 });
  }
  saveJob(job);
  return job;
}

/**
 * 把解析结果按英文归并（同一批次里重复出现的词只留一条，义项合并）。
 * @param results 解析结果
 */
export function dedupeResults(results: ParsedWord[]): ParsedWord[] {
  const map = new Map<string, ParsedWord>();
  for (const item of results) {
    const key = item.en.trim().toLowerCase();
    if (key === '') continue;
    const hit = map.get(key);
    if (!hit) {
      map.set(key, { ...item, senses: item.senses.map((s) => ({ ...s, aliases: [...s.aliases] })) });
      continue;
    }
    for (const sense of item.senses) {
      const dup = hit.senses.find((s) => s.text.trim() === sense.text.trim());
      if (dup) dup.aliases = Array.from(new Set([...dup.aliases, ...sense.aliases]));
      else hit.senses.push({ ...sense, aliases: [...sense.aliases] });
    }
    if (!hit.phonetic && item.phonetic) hit.phonetic = item.phonetic;
    if (!hit.example && item.example) hit.example = item.example;
  }
  return Array.from(map.values());
}
