/**
 * GET /api/exam-history?since=<ts>&recent=<days>   拉取题目历史（含墓碑）
 * POST /api/exam-history                           批量 upsert（单批 ≤ 500）
 *
 * 两个用途：
 * 1. **同步**：把本机的题目历史推上去 / 从别的设备拉下来（`since` 增量）；
 * 2. **出题防重复**：带 `recent=<days>` 时额外返回「服务端近 N 天的题干」——
 *    光靠本地拿不到**别的设备**出过的题，而防重复必须覆盖全部设备。
 *
 * 路由名 = 文件名：/api/exam-history（连字符）。
 */
import { requireSpaceKey, spaceKeyHint, SpaceKeyError } from './_lib/spaceAuth.js';
import { applyCors, handleOptions } from './_lib/cors.js';
import { firstQueryValue, readJsonBody, sendError, sendJson } from './_lib/http.js';
import { MAX_PULL_ROWS, MAX_PUSH_BATCH } from './_lib/limits.js';
import { initKcSchema } from './_lib/kcSchema.js';
import {
  selectExistingSmallTimes,
  selectRecentExamQuestions,
  selectSmallTableSince,
  upsertSmallTable,
} from './_lib/kcSmallInventory.js';
import { normalizeRows } from './_lib/kcSmallValidate.js';
import type { ApiHandler } from './_lib/types.js';

/** 允许的最早时间戳（2001-09-09） */
const MIN_TIMESTAMP = 1_000_000_000_000;
/** 一天的毫秒数 */
const DAY_MS = 86_400_000;
/** recent 参数的默认与上限（天） */
const RECENT_DEFAULT_DAYS = 3;
const RECENT_MAX_DAYS = 30;
/** 防重复最多带回多少条题干 */
const RECENT_MAX_ROWS = 200;

/**
 * 解析 since：空/非法一律当 0（全量）。
 * @param raw 查询参数
 */
function parseSince(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.trunc(Math.max(n, MIN_TIMESTAMP));
}

/**
 * 解析 recent（天）：空/非法一律当默认 3 天，并钳到 1~30。
 * @param raw 查询参数
 */
function parseRecentDays(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return RECENT_DEFAULT_DAYS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return RECENT_DEFAULT_DAYS;
  return Math.min(RECENT_MAX_DAYS, Math.max(1, Math.trunc(n)));
}

const handler: ApiHandler = async (req, res) => {
  if (handleOptions(req, res)) return;
  applyCors(req, res);

  let spaceKey: string;
  try {
    spaceKey = requireSpaceKey(req);
  } catch (err) {
    if (err instanceof SpaceKeyError) {
      console.warn('[exam-history] 拒绝请求：', err.status, err.message);
      sendError(res, err.status, err.message);
      return;
    }
    throw err;
  }

  const startedAt = Date.now();

  // ── GET：增量拉取 +（可选）近期题干 ──
  if (req.method === 'GET') {
    const since = parseSince(firstQueryValue(req.query?.['since']));
    const recentDays = parseRecentDays(firstQueryValue(req.query?.['recent']));
    try {
      await initKcSchema();
      const rows = await selectSmallTableSince('examRecords', spaceKey, since, MAX_PULL_ROWS);
      const recentRows = await selectRecentExamQuestions(
        spaceKey,
        Date.now() - recentDays * DAY_MS,
        RECENT_MAX_ROWS,
      );
      const serverTime = Date.now();
      console.info(
        `[exam-history] space=${spaceKeyHint(spaceKey)} 返回 ${rows.length} 条 + 近 ${recentDays} 天题干 ${recentRows.length} 条，用时 ${serverTime - startedAt}ms`,
      );
      sendJson(res, 200, {
        rows,
        recentQuestions: recentRows.map((r) => r.question),
        recentDays,
        serverTime,
        hasMore: rows.length >= MAX_PULL_ROWS,
      });
    } catch (err) {
      console.error('[exam-history] 拉取失败：', err instanceof Error ? err.message : '未知错误');
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

  const { rows, skipped } = normalizeRows('examRecords', raw, MAX_PUSH_BATCH);
  try {
    await initKcSchema();
    const existing = await selectExistingSmallTimes(
      'examRecords',
      spaceKey,
      rows.map((r) => r.id),
    );
    const writable = rows.filter((r) => {
      const server = existing.get(r.id);
      const mine = Number(r.values['updated_at'] ?? 0);
      return server === undefined || mine >= server;
    });
    const conflicts = rows.length - writable.length;
    await upsertSmallTable('examRecords', spaceKey, writable);
    const serverTime = Date.now();
    console.info(
      `[exam-history] space=${spaceKeyHint(spaceKey)} 收到 ${raw.length} 条，写入 ${writable.length} 条，冲突 ${conflicts} 条，跳过 ${skipped} 条，用时 ${serverTime - startedAt}ms`,
    );
    sendJson(res, 200, { applied: writable.length, conflicts, skipped, serverTime });
  } catch (err) {
    console.error('[exam-history] 写入失败：', err instanceof Error ? err.message : '未知错误');
    sendError(res, 500, '服务器写入数据库失败，请稍后重试');
  }
};

export default handler;
