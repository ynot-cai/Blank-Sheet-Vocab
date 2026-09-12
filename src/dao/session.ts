import { clearStore, STORE, tx } from '../core/db';
import type { Session } from '../core/types';

/** 会话在库里的固定 key（单用户，同一时间只有一个进行中的会话） */
const SESSION_KEY = 'current';

/** 落库的会话行：除 groups 外的全部进度（用户要求「保存并退出」记录位置与每词记忆次数） */
interface SessionRow {
  id: string;
  type: Session['type'];
  wordIds: string[];
  placements: Session['placements'];
  shownIds: string[];
  memorizeCount: Session['memorizeCount'];
  failedIds: string[];
  failDeltas: Session['failDeltas'];
  spellEnabled: boolean;
  groupId: number;
  finished: boolean;
  createdAt: number;
}

/**
 * 保存会话（「保存并退出」走这里）。
 * 现在会持久化：wordIds / placements（每个单词在白纸上的位置）/
 * shownIds（已出现的词）/ memorizeCount（每词记忆次数）/ failedIds / failDeltas / groupId 等。
 * 只有 groups（复习分组）不落库——复习续跑时会按 wordIds 重新分组。
 * @param s 会话对象
 */
export async function saveSession(s: Session): Promise<void> {
  const row: SessionRow = {
    // 行主键固定为 'current'（sessions 表内联 keyPath 'id'，put 不传第二个 key）
    id: SESSION_KEY,
    type: s.type,
    wordIds: [...s.wordIds],
    placements: clonePlacements(s.placements),
    shownIds: [...s.shownIds],
    memorizeCount: { ...s.memorizeCount },
    failedIds: [...s.failedIds],
    failDeltas: { ...s.failDeltas },
    spellEnabled: s.spellEnabled,
    groupId: s.groupId,
    finished: s.finished,
    createdAt: s.createdAt,
  };
  await tx(STORE.sessions, 'readwrite', (store) => store.put(row));
}

/**
 * 读取会话（含保存的进度：落点 / 已出现 / 记忆次数）。
 */
export async function loadSession(): Promise<Session | null> {
  const row = await tx<SessionRow | undefined>(
    STORE.sessions,
    'readonly',
    (s) => s.get(SESSION_KEY) as IDBRequest<SessionRow | undefined>,
  );
  if (!row) return null;
  return {
    id: row.id,
    type: row.type,
    wordIds: [...row.wordIds],
    placements: clonePlacements(row.placements ?? {}),
    shownIds: [...(row.shownIds ?? [])],
    memorizeCount: { ...(row.memorizeCount ?? {}) },
    spellEnabled: row.spellEnabled ?? false,
    failedIds: [...(row.failedIds ?? [])],
    failDeltas: { ...(row.failDeltas ?? {}) },
    groupId: row.groupId ?? 0,
    groups: [],
    finished: row.finished,
    createdAt: row.createdAt,
  };
}

/**
 * 清空会话。
 */
export async function clearSession(): Promise<void> {
  await clearStore(STORE.sessions);
}

/** 复制落点表（避免共享引用） */
function clonePlacements(placements: Session['placements']): Session['placements'] {
  const out: Session['placements'] = {};
  for (const [id, p] of Object.entries(placements)) {
    if (p) out[id] = { x: p.x, y: p.y };
  }
  return out;
}
