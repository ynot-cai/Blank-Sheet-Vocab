/**
 * 二期会话 DAO（学习 / 复习的「保存并退出」）。
 *
 * 与一期 `dao/session.ts` 的关系：**各存各的**。
 * 一期的 `sessions` 表存白纸撒点的词单与位置，二期的 `kcSessions` 表存卡片进度；
 * 两套数据本来就独立（主提示词第 7 节），所以会话也分开——否则
 * 「二期复习到一半」和「一期背诵到一半」会互相覆盖。
 *
 * 云端同步：**不同步**。会话是「这台设备进行到哪儿了」的临时状态，
 * 推到别的设备只会造成困惑（手机上接着看一半的复习？）。阶段 01 的四张表
 * 同步的是**内容**，会话不属于内容。
 */
import { STORE, tx, txRun } from '../core/db';
import { newId } from '../core/kcModel';
import type { KcSession } from '../core/kcTypes';

/** 会话表里的一行 */
interface KcSessionRow {
  id: string;
  type: 'study' | 'review';
  cardIds: string[];
  currentIndex: number;
  selfScores: Record<string, number>;
  examScores: Record<string, number>;
  stage: KcSession['stage'];
  wordIds: string[];
  wordsDone: boolean;
  examIndex: number;
  finished: boolean;
  createdAt: number;
  updatedAt: number;
}

/** 合法的流程阶段（用来兜住老数据/脏数据） */
const STAGES: readonly KcSession['stage'][] = ['cards', 'words', 'exam', 'done'];

/**
 * 归一化一行会话（缺字段补默认值，坏值丢弃）。
 * @param raw 原始值
 */
function coerceSession(raw: unknown): KcSession | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r['id'] === 'string' && r['id'] !== '' ? r['id'] : newId();
  const type = r['type'] === 'review' ? 'review' : 'study';
  const cardIds = Array.isArray(r['cardIds']) ? r['cardIds'].filter((x): x is string => typeof x === 'string') : [];
  const num = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
  const scores = (v: unknown): Record<string, number> => {
    if (typeof v !== 'object' || v === null) return {};
    const out: Record<string, number> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      const n = num(val, 0);
      if (n >= 1 && n <= 3) out[k] = n;
    }
    return out;
  };
  const stage = STAGES.includes(r['stage'] as KcSession['stage']) ? (r['stage'] as KcSession['stage']) : 'cards';
  return {
    id,
    type,
    cardIds,
    // 下标钳到合法范围（老会话里的卡片可能已经被删了）
    currentIndex: Math.max(0, Math.min(cardIds.length, Math.trunc(num(r['currentIndex'])))),
    selfScores: scores(r['selfScores']),
    examScores: scores(r['examScores']),
    stage,
    wordIds: Array.isArray(r['wordIds']) ? r['wordIds'].filter((x): x is string => typeof x === 'string') : [],
    wordsDone: r['wordsDone'] === true,
    examIndex: Math.max(0, Math.trunc(num(r['examIndex']))),
    finished: r['finished'] === true,
    createdAt: num(r['createdAt'], Date.now()),
    updatedAt: num(r['updatedAt'], Date.now()),
  };
}

/**
 * 新建一个会话对象（**不落库**，由调用方决定何时 save）。
 * @param type 学习还是复习
 * @param cardIds 本轮卡片
 */
export function createSession(type: KcSession['type'], cardIds: string[]): KcSession {
  const now = Date.now();
  return {
    id: newId(),
    type,
    cardIds: [...cardIds],
    currentIndex: 0,
    selfScores: {},
    examScores: {},
    stage: 'cards',
    wordIds: [],
    wordsDone: false,
    examIndex: 0,
    finished: false,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * 保存会话（新建或覆盖；自动刷新 `updatedAt`）。
 * @param session 会话
 */
export async function save(session: KcSession): Promise<void> {
  const row: KcSessionRow = { ...session, updatedAt: Date.now() };
  await tx(STORE.kcSessions, 'readwrite', (s) => s.put(row));
}

/**
 * 读某一个会话。
 * @param id 会话 id
 */
export async function load(id: string): Promise<KcSession | null> {
  const row = await tx<unknown>(STORE.kcSessions, 'readonly', (s) => s.get(id) as IDBRequest<unknown>);
  return coerceSession(row ?? null);
}

/**
 * 读**最新的一条未完成会话**（「继续上次」用）。
 * @param type 只找学习或只找复习；不传则不限
 */
export async function loadLatestOpen(type?: KcSession['type']): Promise<KcSession | null> {
  const all = await tx<unknown[]>(STORE.kcSessions, 'readonly', (s) => s.getAll() as IDBRequest<unknown[]>);
  const sessions: KcSession[] = [];
  for (const row of all) {
    const s = coerceSession(row);
    if (s === null) continue;
    if (s.finished) continue;
    if (type !== undefined && s.type !== type) continue;
    if (s.cardIds.length === 0) continue;
    sessions.push(s);
  }
  sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  return sessions[0] ?? null;
}

/**
 * 删掉一个会话（完成或用户选「重新开始」时调）。
 * @param id 会话 id
 */
export async function remove(id: string): Promise<void> {
  await tx(STORE.kcSessions, 'readwrite', (s) => s.delete(id));
}

/**
 * 清掉所有未完成的会话（设置页清库、或用户明确要求重来时用）。
 * @param type 只清某一类；不传则全清
 */
export async function clearOpen(type?: KcSession['type']): Promise<number> {
  const all = await tx<unknown[]>(STORE.kcSessions, 'readonly', (s) => s.getAll() as IDBRequest<unknown[]>);
  const ids: string[] = [];
  for (const row of all) {
    const s = coerceSession(row);
    if (s === null) continue;
    if (type !== undefined && s.type !== type) continue;
    ids.push(s.id);
  }
  if (ids.length === 0) return 0;
  await txRun(STORE.kcSessions, 'readwrite', (s) => {
    for (const id of ids) s.delete(id);
  });
  return ids.length;
}
