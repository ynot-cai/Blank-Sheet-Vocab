/**
 * ★ T2 验收专用：手动跑一次「总考核次数」回填。
 *
 * ── 为什么需要它 ──
 * 真实的回填跑在 IndexedDB 的 v7 `onupgradeneeded` 里（见 `core/dbSchema.ts` 的
 * `migrateToV7ExamCount`）。而测试里**没法**让一个已经升到 v7 的库再触发一次
 * `oldVersion < 7` 的分支 —— IndexedDB 不支持降版本号。
 * 所以这里提供一个显式入口，用**同一段逻辑**（`backfillExamCountRow`）
 * 对全表跑一遍，让验收能证明：
 *   · 三个历史场景的结果正确；
 *   · 第二次跑一个词都不动（幂等）；
 *   · 迁移不碰 examCount 以外的任何字段。
 *
 * ⚠️ 这是 dev 模块，**不在任何用户路径上**：
 *   - 只有测试脚本与控制台会 import 它；
 *   - 它不改版本号、不动表结构，只按同一套规则补字段。
 *
 * 与「真实升级会不会被触发」的关系：那一条由 `createSchema` 里的
 * `if (oldVersion > 0 && oldVersion < 7)` 保证，属于框架行为（v2/v6 已经用过同一模式）。
 */
import { backfillExamCountRow, DB_NAME, STORE } from '../core/dbSchema';

/** 回填统计 */
export interface ExamCountBackfillResult {
  /** 扫描到的词数 */
  scanned: number;
  /** 真的补了具体次数的词数（failCountTotal > 0） */
  backfilled: number;
  /** 保持「从没考过」的词数（failCountTotal = 0） */
  keptUnlearned: number;
  /** 本来就有记录、没动的词数 */
  skipped: number;
}

/**
 * 对 `words` 全表跑一次回填。
 *
 * 与迁移一样**幂等**：第二次调用时所有词都有 `examCount` 了，`skipped` 等于全表。
 * @returns 统计结果
 */
export async function runExamCountBackfill(): Promise<ExamCountBackfillResult> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('打不开本地数据库'));
  });
  try {
    const rows = await new Promise<Record<string, unknown>[]>((resolve, reject) => {
      const tx = db.transaction(STORE.words, 'readonly');
      const req = tx.objectStore(STORE.words).getAll();
      req.onsuccess = () => resolve(req.result as Record<string, unknown>[]);
      req.onerror = () => reject(req.error ?? new Error('读取词库失败'));
    });
    const result: ExamCountBackfillResult = { scanned: rows.length, backfilled: 0, keptUnlearned: 0, skipped: 0 };
    const toWrite: Record<string, unknown>[] = [];
    for (const row of rows) {
      const verdict = backfillExamCountRow(row);
      if (verdict === 'skipped') result.skipped += 1;
      else {
        if (verdict === 'backfilled') result.backfilled += 1;
        else result.keptUnlearned += 1;
        toWrite.push(row);
      }
    }
    if (toWrite.length > 0) {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE.words, 'readwrite');
        const store = tx.objectStore(STORE.words);
        for (const row of toWrite) store.put(row);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error('写回词库失败'));
      });
    }
    return result;
  } finally {
    db.close();
  }
}

/** 挂到 window 上，便于控制台手工排查（幂等，可反复调用） */
export function attachExamCountBackfill(): void {
  window.__t2BackfillExamCount = () => runExamCountBackfill();
}

declare global {
  interface Window {
    /** T2 验收/排查用：手动跑一次总考核次数回填 */
    __t2BackfillExamCount?: () => Promise<ExamCountBackfillResult>;
  }
}
