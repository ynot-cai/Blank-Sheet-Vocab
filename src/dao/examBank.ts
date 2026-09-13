/**
 * 二期「题目历史 + 题库」本地 DAO（阶段 01 建数据层，界面在阶段 05/07 做）。
 *
 * 两张表的用途不同：
 * - `examRecords`：**已经出过的题**（含用户的答案与 AI 评分）。它的第一作用是
 *   **防重复**——出题前把近 3 天的题目喂给 AI，告诉它「别出这些」；
 *   第二作用是复盘（阶段 06 的复习流程要回放）。
 * - `bankQuestions`：用户看到好题（比如「2023全国甲卷」的语法填空）时点
 *   「添加题库」存下来的**参考样题**，出题时作为风格示例喂给 AI。
 *
 * 空间隔离：两张表都带 `spaceKey`（与云端行同构，推上去零转换）。
 */
import { STORE, clearStore, tx, txRun } from '../core/db';
import { newId, sanitizeText } from '../core/kcModel';
import { getSettings } from '../core/config';
import type { BankQuestion, ExamRecord } from '../core/kcTypes';
import { currentSpaceKey, localDate } from './contextWords';

/** 一天的毫秒数 */
const DAY_MS = 86_400_000;

/**
 * 归一化一条题目历史。
 * @param raw 原始值
 */
function coerceRecord(raw: unknown): ExamRecord | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const question = typeof r['question'] === 'string' ? r['question'] : '';
  if (question.trim() === '') return null; // 没有题干的记录没有意义
  return {
    id: typeof r['id'] === 'string' && r['id'] !== '' ? r['id'] : newId(),
    spaceKey: typeof r['spaceKey'] === 'string' ? r['spaceKey'] : '',
    cardId: typeof r['cardId'] === 'string' ? r['cardId'] : '',
    date: typeof r['date'] === 'string' ? r['date'] : localDate(),
    type: typeof r['type'] === 'string' ? r['type'] : '',
    question: sanitizeText(question),
    userAnswer: sanitizeText(typeof r['userAnswer'] === 'string' ? r['userAnswer'] : ''),
    aiScore: Number.isFinite(Number(r['aiScore'])) ? Math.trunc(Number(r['aiScore'])) : 0,
    aiReason: sanitizeText(typeof r['aiReason'] === 'string' ? r['aiReason'] : ''),
    contextWord: sanitizeText(typeof r['contextWord'] === 'string' ? r['contextWord'] : '', 64),
    createdAt: typeof r['createdAt'] === 'number' ? r['createdAt'] : Date.now(),
  };
}

/**
 * 归一化一条题库样题。
 * @param raw 原始值
 */
function coerceBank(raw: unknown): BankQuestion | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const content = typeof r['content'] === 'string' ? r['content'] : '';
  if (content.trim() === '') return null;
  return {
    id: typeof r['id'] === 'string' && r['id'] !== '' ? r['id'] : newId(),
    spaceKey: typeof r['spaceKey'] === 'string' ? r['spaceKey'] : '',
    type: typeof r['type'] === 'string' ? r['type'] : '',
    content: sanitizeText(content),
    source: sanitizeText(typeof r['source'] === 'string' ? r['source'] : '', 120),
    createdAt: typeof r['createdAt'] === 'number' ? r['createdAt'] : Date.now(),
  };
}

// ───────────────────────────── 题目历史 ─────────────────────────────

/**
 * 新增一条题目历史（出题/评分完成后调它）。
 * @param record 除 id / spaceKey / createdAt 外的字段
 */
export async function addRecord(
  record: Omit<ExamRecord, 'id' | 'spaceKey' | 'createdAt'> & { id?: string; createdAt?: number },
): Promise<ExamRecord> {
  const row: ExamRecord = {
    ...record,
    id: record.id ?? newId(),
    spaceKey: await currentSpaceKey(),
    createdAt: record.createdAt ?? Date.now(),
  };
  await tx(STORE.examRecords, 'readwrite', (s) => s.put(row));
  return row;
}

/**
 * 读全部题目历史（按时间倒序）。
 */
export async function listRecords(): Promise<ExamRecord[]> {
  const rows = await tx<unknown[]>(STORE.examRecords, 'readonly', (s) => s.getAll() as IDBRequest<unknown[]>);
  const out: ExamRecord[] = [];
  for (const row of rows) {
    const rec = coerceRecord(row);
    if (rec !== null) out.push(rec);
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * 取某张卡的历史题目（复习时回放用）。
 * @param cardId 卡片 id
 */
export async function listByCard(cardId: string): Promise<ExamRecord[]> {
  const all = await listRecords();
  return all.filter((r) => r.cardId === cardId);
}

/**
 * 改一条历史题目的分数（用户手动改分用）。
 *
 * 为什么需要：AI 评分不一定准（用户明确说了「主观题 AI 评分不一定准」），
 * 所以界面上留了改分入口。改分只动这条记录的 `aiScore`；
 * 卡片的 `attrs.lastExamScore` 由调用方一并更新（它才是算 mastery 的输入）。
 *
 * @param id 记录 id
 * @param score 新分数（钳到 1~3）
 * @returns 记录不存在返回 false
 */
export async function updateRecordScore(id: string, score: number): Promise<boolean> {
  const row = await tx<unknown>(STORE.examRecords, 'readonly', (s) => s.get(id) as IDBRequest<unknown>);
  const current = coerceRecord(row);
  if (current === null) return false;
  const clamped = Math.min(3, Math.max(1, Math.round(score)));
  await tx(STORE.examRecords, 'readwrite', (s) => s.put({ ...current, aiScore: clamped }));
  return true;
}

/**
 * 取「出题时要避开的近期题目」：近 N 天（默认 3 天，来自设置）。
 *
 * 用途：阶段 05 出题时把这份清单交给 AI，让它别出重复的题。
 * 只返回题干（不返回答案/评分），提示词够用且省 token。
 * @param lookbackDays 回看天数（不传则读设置）
 * @param now 当前时间戳
 */
export async function recentQuestions(lookbackDays?: number, now: number = Date.now()): Promise<string[]> {
  const days = lookbackDays ?? getSettings().kc.examDedupeLookbackDays;
  const since = now - days * DAY_MS;
  const all = await listRecords();
  const out: string[] = [];
  const seen = new Set<string>();
  for (const r of all) {
    if (r.createdAt < since) continue;
    const key = r.question.trim();
    if (key === '' || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

// ───────────────────────────── 题库 ─────────────────────────────

/**
 * 存一条参考样题（「添加题库」按钮）。
 * @param type 题型 id
 * @param content 题目原文（含答案）
 * @param source 来源标注
 */
export async function addBankQuestion(type: string, content: string, source = ''): Promise<BankQuestion> {
  const row: BankQuestion = {
    id: newId(),
    spaceKey: await currentSpaceKey(),
    type,
    content: sanitizeText(content),
    source: sanitizeText(source, 120),
    createdAt: Date.now(),
  };
  await tx(STORE.bankQuestions, 'readwrite', (s) => s.put(row));
  return row;
}

/**
 * 读题库（可按题型过滤）。
 * @param type 题型 id（不传 = 全部）
 */
export async function listBankQuestions(type?: string): Promise<BankQuestion[]> {
  const rows = await tx<unknown[]>(STORE.bankQuestions, 'readonly', (s) => s.getAll() as IDBRequest<unknown[]>);
  const out: BankQuestion[] = [];
  for (const row of rows) {
    const q = coerceBank(row);
    if (q !== null) out.push(q);
  }
  const filtered = type === undefined || type === '' ? out : out.filter((q) => q.type === type);
  return filtered.sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * 删一条题库样题。
 * @param id 记录 id
 */
export async function removeBankQuestion(id: string): Promise<void> {
  await tx(STORE.bankQuestions, 'readwrite', (s) => s.delete(id));
}

/**
 * 清空题目历史与题库（设置页清库用）。
 */
export async function clearAll(): Promise<void> {
  await clearStore(STORE.examRecords);
  await clearStore(STORE.bankQuestions);
}

/** 批量写入题库样题（导入备份 / 从别的设备拉回来时用） */
export async function bulkPutBank(rows: BankQuestion[]): Promise<void> {
  if (rows.length === 0) return;
  await txRun(STORE.bankQuestions, 'readwrite', (s) => {
    for (const row of rows) s.put(row);
  });
}
