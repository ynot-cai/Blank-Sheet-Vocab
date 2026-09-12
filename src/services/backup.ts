/**
 * 全量 json 导出 / 导入（与本地文件夹自动备份共用同一份序列化函数）。
 */
import { DEFAULT_SETTINGS, deepMergeSettings } from '../core/config';
import { normalizeEn } from '../core/model';
import * as dao from '../dao';
import type { Settings, Source, Word } from '../core/types';
import { emitDataChanged } from '../state/store';

/** 备份文件结构（版本 1） */
export interface BackupFile {
  version: 1;
  exportedAt: number;
  words: Word[];
  sources: Source[];
  settings: Settings;
}

/**
 * 组装一份备份数据。
 */
export async function buildBackupFile(): Promise<BackupFile> {
  const [words, sources, settings] = await Promise.all([dao.words.getAll(), dao.sources.list(), dao.settings.get()]);
  return { version: 1, exportedAt: Date.now(), words, sources, settings };
}

/**
 * 序列化成字符串（导出与自动备份共用）。
 */
export async function serializeBackup(): Promise<string> {
  const file = await buildBackupFile();
  return JSON.stringify(file, null, 2);
}

/**
 * 校验并解析备份文本。
 * @param text 备份文件内容
 * @returns 解析后的 BackupFile
 */
export function parseBackupText(text: string): BackupFile {
  let data: unknown;
  try {
    data = JSON.parse(text) as unknown;
  } catch {
    throw new Error('备份文件格式不正确');
  }
  if (typeof data !== 'object' || data === null) throw new Error('备份文件格式不正确');
  const obj = data as Record<string, unknown>;
  if (obj.version !== 1) throw new Error('备份文件格式不正确（版本不匹配）');
  if (!Array.isArray(obj.words) || !Array.isArray(obj.sources)) throw new Error('备份文件格式不正确');
  const words = obj.words as Word[];
  const sources = obj.sources as Source[];
  for (const w of words) {
    if (typeof w?.id !== 'string' || typeof w?.en !== 'string' || !Array.isArray(w?.senses)) {
      throw new Error('备份文件格式不正确');
    }
  }
  return {
    version: 1,
    exportedAt: typeof obj.exportedAt === 'number' ? obj.exportedAt : Date.now(),
    words,
    sources,
    settings: deepMergeSettings(DEFAULT_SETTINGS, obj.settings ?? {}),
  };
}

/**
 * 把备份数据写进库。
 * @param backup 备份数据
 * @param mode merge = 按 en + sourceId 判重后补缺；replace = 先清空再全量写入
 */
export async function applyBackup(
  backup: BackupFile,
  mode: 'merge' | 'replace',
): Promise<{ words: number; sources: number }> {
  if (mode === 'replace') {
    await dao.words.clearAll();
    await dao.sources.clearAll();
    const srcCount = backup.sources.length;
    for (const s of backup.sources) await dao.sources.upsert(s);
    await dao.words.bulkUpsert(backup.words);
    await dao.settings.set(backup.settings);
    emitDataChanged();
    return { words: backup.words.length, sources: srcCount };
  }

  const [existingWords, existingSources] = await Promise.all([dao.words.getAll(), dao.sources.list()]);
  const keys = new Set(existingWords.map((w) => `${normalizeEn(w.en).toLowerCase()}::${w.sourceId}`));
  const incoming = backup.words.filter((w) => !keys.has(`${normalizeEn(w.en).toLowerCase()}::${w.sourceId}`));

  const srcIds = new Set(existingSources.map((s) => s.id));
  const newSources = backup.sources.filter((s) => !srcIds.has(s.id));
  for (const s of newSources) await dao.sources.upsert(s);
  await dao.words.bulkUpsert(incoming);
  await dao.settings.set(backup.settings);
  emitDataChanged();
  return { words: incoming.length, sources: newSources.length };
}

/**
 * 导出备份并触发浏览器下载，文件名 白纸单词备份_YYYYMMDD_HHmm.json。
 */
export async function exportBackup(): Promise<void> {
  const text = await serializeBackup();
  const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = backupFileName(new Date());
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  await dao.settings.set({ backup: { ...(await dao.settings.get()).backup, lastManualExportAt: Date.now() } });
}

/**
 * 生成备份文件名。
 * @param date 时间
 */
export function backupFileName(date: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `白纸单词备份_${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}_${p(date.getHours())}${p(date.getMinutes())}.json`;
}

/**
 * 从用户选的文件导入。
 * @param file 备份文件
 * @param mode merge = 合并（跳过已存在）；replace = 覆盖（调用方必须先弹二次确认）
 */
export async function importBackup(file: File, mode: 'merge' | 'replace'): Promise<{ words: number; sources: number }> {
  const text = await file.text();
  const backup = parseBackupText(text);
  return applyBackup(backup, mode);
}
