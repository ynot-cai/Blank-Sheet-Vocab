/**
 * 全量 json 导出 / 导入（与本地文件夹自动备份共用同一份序列化函数）。
 */
import { DEFAULT_SETTINGS, deepMergeSettings } from '../core/config';
import { normalizeEn, normalizeWordPriority } from '../core/model';
import * as dao from '../dao';
import type { Attrs, Sense, Settings, Source, Word } from '../core/types';
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
 * ★ 1.0.0（用户）：「调整已保存的单词数据格式，使其成为可直接导入的存档文件；
 * 缺失字段按合理默认值补充。」
 *
 * 导出的每一项都补齐到**完整形态**（字段一个不缺、类型对），所以导出的文件
 * 既可以直接再导入本程序，也能被别的工具当成规范数据读。
 * 同时 `parseBackupText()` 也走这套补齐逻辑，老备份/手写文件缺字段都能导入。
 *
 * @param raw 任意来源的词（可能是老版本、可能缺字段）
 */
export function normalizeWordForBackup(raw: unknown): Word {
  const obj = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const now = Date.now();
  const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
  const num = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
  const stamp = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

  const rawAttrs = (typeof obj['attrs'] === 'object' && obj['attrs'] !== null ? obj['attrs'] : {}) as Record<string, unknown>;
  const rawSenses = Array.isArray(obj['senses']) ? obj['senses'] : [];
  const senses: Sense[] = rawSenses.map((item, i) => {
    const s = (typeof item === 'object' && item !== null ? item : {}) as Record<string, unknown>;
    return {
      id: str(s['id'], `sense-${i + 1}-${now.toString(36)}`),
      text: str(s['text']),
      aliases: Array.isArray(s['aliases']) ? (s['aliases'] as unknown[]).map((a) => String(a)) : [],
      example: str(s['example'], '暂无'),
      enabled: s['enabled'] === false ? false : true,
    };
  });

  const statusRaw = str(obj['status'], 'unlearned');
  const status: Word['status'] =
    statusRaw === 'learning' || statusRaw === 'learned' || statusRaw === 'chopped' ? statusRaw : 'unlearned';

  const attrs: Attrs = {
    needSpell: rawAttrs['needSpell'] === true,
    failCount: num(rawAttrs['failCount']),
    failCountTotal: num(rawAttrs['failCountTotal']),
    reviewCount: num(rawAttrs['reviewCount']),
    lastReviewAt: stamp(rawAttrs['lastReviewAt']),
    learnedAt: stamp(rawAttrs['learnedAt']),
    reviewPriority: num(rawAttrs['reviewPriority']),
    examCount: num(rawAttrs['examCount']),
    examScore: typeof rawAttrs['examScore'] === 'number' && Number.isFinite(rawAttrs['examScore']) ? (rawAttrs['examScore'] as number) : null,
  };

  const word: Word = {
    id: str(obj['id'], `word-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`),
    en: str(obj['en']),
    phonetic: str(obj['phonetic']),
    example: str(obj['example']),
    senses,
    sourceId: str(obj['sourceId'], 'default-source'),
    rawSources: Array.isArray(obj['rawSources']) ? (obj['rawSources'] as Word['rawSources']) : [],
    attrs,
    status,
    priority: normalizeWordPriority(obj['priority']),
    learnOrder: typeof obj['learnOrder'] === 'number' && Number.isFinite(obj['learnOrder']) ? (obj['learnOrder'] as number) : null,
    createdAt: num(obj['createdAt'], now),
    updatedAt: num(obj['updatedAt'], now),
  };
  // 可选字段：只有真的存在才写，缺省就不出现（读的时候按默认值处理，见各字段注释）
  if (obj['spellOnly'] === true) word.spellOnly = true;
  if (obj['deleted'] === 1) word.deleted = 1;
  return word;
}

/**
 * ★ 1.0.0：来源也补齐成完整形态（缺 id 用占位、缺名称用「未命名来源」）。
 * @param raw 任意来源
 * @param index 序号（用来生成占位 id）
 */
export function normalizeSourceForBackup(raw: unknown, index = 0): Source {
  const obj = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const now = Date.now();
  const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
  const num = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
  return {
    id: str(obj['id'], `source-${index + 1}`),
    name: str(obj['name'], '未命名来源'),
    createdAt: num(obj['createdAt'], now),
    updatedAt: num(obj['updatedAt'], now),
  };
}
/**
 * 组装一份备份数据。
 */
export async function buildBackupFile(): Promise<BackupFile> {
  const [words, sources, settings] = await Promise.all([dao.words.getAll(), dao.sources.list(), dao.settings.get()]);
  // ★ 1.0.0：导出即补全（缺字段按默认值补齐，文件可直接再导入）
  return {
    version: 1,
    exportedAt: Date.now(),
    words: words.map((w) => normalizeWordForBackup(w)),
    sources: sources.map((s, i) => normalizeSourceForBackup(s, i)),
    settings,
  };
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
  /**
   * ★ 1.0.0：不再要求每个字段都在——缺字段按合理默认值补齐，只要 en 是字符串就能导入。
   * 完全没有词条名的数据才算格式不正确（导入进来也没法用）。
   */
  const rawWords = obj.words as unknown[];
  const words = rawWords.map((w) => normalizeWordForBackup(w));
  if (words.some((w) => w.en.trim() === '')) throw new Error('备份文件格式不正确（有词条缺少英文）');
  const sources = (obj.sources as unknown[]).map((s, i) => normalizeSourceForBackup(s, i));
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
