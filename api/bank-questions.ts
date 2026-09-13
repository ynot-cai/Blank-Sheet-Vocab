/**
 * GET /api/bank-questions?since=<ts>&type=<id>   拉取题库（含墓碑，可按题型筛）
 * POST /api/bank-questions                        批量 upsert（单批 ≤ 500）
 *
 * 题库的用途是「出题时的风格参考」，所以除了同步之外还要支持**按题型取**：
 * 客户端出题前会挑 3~5 条同题型样题喂给 AI。
 *
 * 路由名 = 文件名：/api/bank-questions（连字符）。
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
/** 题型 id 的合法形状（只允许字母数字下划线连字符，防注入进 LIKE/等值比较） */
const TYPE_RE = /^[a-z0-9_-]{1,32}$/i;

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

const handler: ApiHandler = async (req, res) => {
  if (handleOptions(req, res)) return;
  applyCors(req, res);

  let spaceKey: string;
  try {
    spaceKey = requireSpaceKey(req);
  } catch (err) {
    if (err instanceof SpaceKeyError) {
      console.warn('[bank-questions] 拒绝请求：', err.status, err.message);
      sendError(res, err.status, err.message);
      return;
    }
    throw err;
  }

  const startedAt = Date.now();

  // ── GET：增量拉取（可选按题型过滤）──
  if (req.method === 'GET') {
    const since = parseSince(firstQueryValue(req.query?.['since']));
    const rawType = (firstQueryValue(req.query?.['type']) ?? '').trim();
    if (rawType !== '' && !TYPE_RE.test(rawType)) {
      sendError(res, 400, 'type 参数格式不合法');
      return;
    }
    try {
      await initKcSchema();
      const rows = await selectSmallTableSince('bankQuestions', spaceKey, since, MAX_PULL_ROWS);
      // 题型过滤放在取回之后再筛：单次上限 2000 条，题库规模远小于它
      const filtered = rawType === '' ? rows : rows.filter((r) => r['type'] === rawType);
      const serverTime = Date.now();
      console.info(
        `[bank-questions] space=${spaceKeyHint(spaceKey)} 返回 ${filtered.length} 条${rawType === '' ? '' : `（题型 ${rawType}）`}，用时 ${serverTime - startedAt}ms`,
      );
      sendJson(res, 200, {
        rows: filtered,
        serverTime,
        hasMore: rows.length >= MAX_PULL_ROWS,
      });
    } catch (err) {
      console.error('[bank-questions] 拉取失败：', err instanceof Error ? err.message : '未知错误');
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

  const { rows, skipped } = normalizeRows('bankQuestions', raw, MAX_PUSH_BATCH);
  try {
    await initKcSchema();
    const existing = await selectExistingSmallTimes(
      'bankQuestions',
      spaceKey,
      rows.map((r) => r.id),
    );
    const writable = rows.filter((r) => {
      const server = existing.get(r.id);
      const mine = Number(r.values['updated_at'] ?? 0);
      return server === undefined || mine >= server;
    });
    const conflicts = rows.length - writable.length;
    await upsertSmallTable('bankQuestions', spaceKey, writable);
    const serverTime = Date.now();
    console.info(
      `[bank-questions] space=${spaceKeyHint(spaceKey)} 收到 ${raw.length} 条，写入 ${writable.length} 条，冲突 ${conflicts} 条，跳过 ${skipped} 条，用时 ${serverTime - startedAt}ms`,
    );
    sendJson(res, 200, { applied: writable.length, conflicts, skipped, serverTime });
  } catch (err) {
    console.error('[bank-questions] 写入失败：', err instanceof Error ? err.message : '未知错误');
    sendError(res, 500, '服务器写入数据库失败，请稍后重试');
  }
};

export default handler;
