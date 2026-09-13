/**
 * GET /api/context-words?since=<ts>     增量拉取每日语境词（含墓碑）
 * POST /api/context-words               批量 upsert（单批 ≤ 500）
 *
 * 路由名规则：Vercel 按**文件名**映射，所以是 /api/context-words（连字符）。
 *
 * 与 `/api/kc-list`、`/api/kc-push` 同一套口径（spaceKey 隔离、后写覆盖、
 * 坏行只跳过不整批失败、日志只打条数）。之所以单独一个路由而不是并进 kc-push：
 * 三张小表的数据量与卡片差一个数量级（题目历史会一直长），
 * 混在一起推会让每次同步都背着全部历史。
 */
import { requireSpaceKey, spaceKeyHint, SpaceKeyError } from './_lib/spaceAuth.js';
import { applyCors, handleOptions } from './_lib/cors.js';
import { firstQueryValue, readJsonBody, sendError, sendJson } from './_lib/http.js';
import { MAX_PULL_ROWS, MAX_PUSH_BATCH } from './_lib/limits.js';
import { initKcSchema } from './_lib/kcSchema.js';
import { selectExistingSmallTimes, selectSmallTableSince, upsertSmallTable } from './_lib/kcSmallInventory.js';
import { normalizeRows } from './_lib/kcSmallValidate.js';
import type { ApiHandler } from './_lib/types.js';

/** 允许的最早时间戳（2001-09-09） */
const MIN_TIMESTAMP = 1_000_000_000_000;

/**
 * 解析 since：空/非法一律当 0（全量），不报错。
 * @param raw 查询参数
 */
function parseSince(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.trunc(Math.max(n, MIN_TIMESTAMP));
}

const handler: ApiHandler = async (req, res) => {
  if (handleOptions(req, res)) return;
  applyCors(req, res);

  let spaceKey: string;
  try {
    spaceKey = requireSpaceKey(req);
  } catch (err) {
    if (err instanceof SpaceKeyError) {
      console.warn('[context-words] 拒绝请求：', err.status, err.message);
      sendError(res, err.status, err.message);
      return;
    }
    throw err;
  }

  const startedAt = Date.now();

  // ── GET：增量拉取 ──
  if (req.method === 'GET') {
    const since = parseSince(firstQueryValue(req.query?.['since']));
    try {
      await initKcSchema();
      const rows = await selectSmallTableSince('contextWords', spaceKey, since, MAX_PULL_ROWS);
      const serverTime = Date.now();
      console.info(`[context-words] space=${spaceKeyHint(spaceKey)} 返回 ${rows.length} 条，用时 ${serverTime - startedAt}ms`);
      sendJson(res, 200, { rows, serverTime, hasMore: rows.length >= MAX_PULL_ROWS });
    } catch (err) {
      console.error('[context-words] 拉取失败：', err instanceof Error ? err.message : '未知错误');
      sendError(res, 500, '服务器读取数据库失败，请稍后重试');
    }
    return;
  }

  if (req.method !== 'POST') {
    sendError(res, 405, '只支持 GET / POST');
    return;
  }

  // ── POST：批量 upsert ──
  const body = readJsonBody(req.body);
  if (body === null) {
    sendError(res, 400, '请求体必须是 JSON 对象');
    return;
  }
  const raw = Array.isArray(body['rows']) ? (body['rows'] as unknown[]) : [];
  if (raw.length === 0) {
    sendError(res, 400, 'rows 必须是非空数组');
    return;
  }
  if (raw.length > MAX_PUSH_BATCH) {
    sendError(res, 400, `单批不得超过 ${MAX_PUSH_BATCH} 条（本批 ${raw.length} 条），请前端分批推送`);
    return;
  }

  const { rows, skipped } = normalizeRows('contextWords', raw, MAX_PUSH_BATCH);
  try {
    await initKcSchema();
    const existing = await selectExistingSmallTimes(
      'contextWords',
      spaceKey,
      rows.map((r) => r.id),
    );
    // 后写覆盖：客户端版本不旧于云端才写
    const writable = rows.filter((r) => {
      const server = existing.get(r.id);
      const mine = Number(r.values['updated_at'] ?? 0);
      return server === undefined || mine >= server;
    });
    const conflicts = rows.length - writable.length;
    await upsertSmallTable('contextWords', spaceKey, writable);
    const serverTime = Date.now();
    console.info(
      `[context-words] space=${spaceKeyHint(spaceKey)} 收到 ${raw.length} 条，写入 ${writable.length} 条，冲突 ${conflicts} 条，跳过 ${skipped} 条，用时 ${serverTime - startedAt}ms`,
    );
    sendJson(res, 200, { applied: writable.length, conflicts, skipped, serverTime });
  } catch (err) {
    console.error('[context-words] 写入失败：', err instanceof Error ? err.message : '未知错误');
    sendError(res, 500, '服务器写入数据库失败，请稍后重试');
  }
};

export default handler;
