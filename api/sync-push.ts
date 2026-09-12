/**
 * POST /api/sync/push
 *
 * body: `{ words?: WordInput[], sources?: SourceInput[] }`
 *
 * 冲突策略：**后写覆盖（last-write-wins）**——客户端 `updatedAt` 不旧于云端就覆盖，
 * 更旧的一条算 `conflicts` 并跳过。个人自用、设备就两三个，冲突极少；
 * 将来要升级成「冲突提示」时，把 conflicts 的明细返回即可，表结构不用动。
 *
 * 字段含义（前端也按这个口径显示）：
 * - `applied`：真正执行了 upsert 的行数（**重复推同样的内容也算 applied**，因为确实写了一次）；
 * - `conflicts`：被服务器挡下的行数（客户端版本比云端旧，**不覆盖**，避免旧设备把新数据打回去）；
 * - `skipped`：结构不合法、被跳过的行数（见 _lib/validate.ts）。
 *
 * 安全与日志要求：
 * - 只打条数和耗时；**绝不打印完整 spaceKey**（最多前 8 位），也绝不打印任何单词内容。
 */
import { requireSpaceKey, spaceKeyHint, SpaceKeyError } from './_lib/spaceAuth.ts';
import { applyCors, handleOptions } from './_lib/cors.ts';
import { readJsonBody, sendError, sendJson } from './_lib/http.ts';
import { MAX_PUSH_BATCH } from './_lib/limits.ts';
import { initSchema } from './_lib/db.ts';
import {
  selectExistingSourceTimes,
  selectExistingWordTimes,
  upsertSources,
  upsertWords,
  type SourceInput,
  type WordInput,
} from './_lib/inventory.ts';
import { coerceBatch } from './_lib/validate.ts';
import type { ApiHandler } from './_lib/types.ts';

/**
 * 过滤出「该写」的行：云端没有，或客户端版本不比云端旧。
 * @param rows 归一化后的输入行
 * @param existing id → 云端已有版本号
 * @returns 该写的行 + 被后写覆盖策略挡掉的条数
 */
function selectWritable<T extends { id: string; updatedAt: number }>(
  rows: T[],
  existing: Map<string, number>,
): { writable: T[]; conflicts: number } {
  const writable: T[] = [];
  let conflicts = 0;
  for (const row of rows) {
    const serverTime = existing.get(row.id);
    if (serverTime === undefined || row.updatedAt >= serverTime) writable.push(row);
    else conflicts += 1;
  }
  return { writable, conflicts };
}

const handler: ApiHandler = async (req, res) => {
  if (handleOptions(req, res)) return;
  applyCors(req, res);

  if (req.method !== 'POST') {
    sendError(res, 405, '只支持 POST');
    return;
  }

  let spaceKey: string;
  try {
    spaceKey = requireSpaceKey(req);
  } catch (err) {
    if (err instanceof SpaceKeyError) {
      console.warn('[sync-push] 拒绝请求：', err.status, err.message);
      sendError(res, err.status, err.message);
      return;
    }
    throw err;
  }

  const body = readJsonBody(req.body);
  if (body === null) {
    sendError(res, 400, '请求体必须是 JSON 对象');
    return;
  }

  const rawWords = Array.isArray(body['words']) ? (body['words'] as unknown[]) : [];
  const rawSources = Array.isArray(body['sources']) ? (body['sources'] as unknown[]) : [];
  const total = rawWords.length + rawSources.length;

  // 批量上限：规避 Vercel 4.5MB 请求体限制，前端必须自己分批
  if (total === 0) {
    sendError(res, 400, 'words 和 sources 至少要有一个非空数组');
    return;
  }
  if (total > MAX_PUSH_BATCH) {
    sendError(res, 400, `单批不得超过 ${MAX_PUSH_BATCH} 条（本批 ${total} 条），请前端分批推送`);
    return;
  }

  const { words, sources, skipped } = coerceBatch(rawWords, rawSources);
  const startedAt = Date.now();

  try {
    await initSchema();

    const wordExisting = await selectExistingWordTimes(
      spaceKey,
      words.map((w: WordInput) => w.id),
    );
    const sourceExisting = await selectExistingSourceTimes(
      spaceKey,
      sources.map((s: SourceInput) => s.id),
    );

    const wordResult = selectWritable(words, wordExisting);
    const sourceResult = selectWritable(sources, sourceExisting);

    await upsertWords(spaceKey, wordResult.writable);
    await upsertSources(spaceKey, sourceResult.writable);

    const applied = wordResult.writable.length + sourceResult.writable.length;
    const conflicts = wordResult.conflicts + sourceResult.conflicts;
    const serverTime = Date.now();

    console.info(
      `[sync-push] space=${spaceKeyHint(spaceKey)} 收到 ${total} 条，写入 ${applied} 条，冲突 ${conflicts} 条，跳过 ${skipped} 条，用时 ${serverTime - startedAt}ms`,
    );

    sendJson(res, 200, { applied, conflicts, skipped, serverTime });
  } catch (err) {
    console.error('[sync-push] 失败：', err instanceof Error ? err.message : '未知错误');
    sendError(res, 500, '服务器写入数据库失败，请稍后重试');
  }
};

export default handler;
