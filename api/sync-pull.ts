/**
 * GET /api/sync-pull?since=<timestamp>
 *
 * 注意路由名：Vercel 把 `api/` 下的**文件名**直接映射成路由，
 * 所以这个文件对应的是 `/api/sync-pull`（连字符），不是 `/api/sync/pull`。
 * 写成后者会 404，前端就表现成「同步不了」——这个坑已经踩过一次。
 *
 * 从请求头 `X-Space-Key` 取数据空间（SHA-256 哈希，服务器不知道明文同步码），
 * 增量拉取 words + sources。
 *
 * 几个必须守住的点：
 * - **包含软删除记录**（deleted=1 也返回），否则别的设备永远删不掉这条；
 * - 所有查询都带 `WHERE space_key = ?`（见 _lib/inventory.ts）；
 * - 单次返回条数有上限（MAX_PULL_ROWS）；**超出部分请前端分次拉**：
 *   用返回的 `serverTime` 作为下一次的 `since` 继续拉，直到
 *   `hasMore` 为 false。这次先按「个人自用、词量几千」的规模实现，
 *   不做服务器端游标。
 */
import { requireSpaceKey, spaceKeyHint, SpaceKeyError } from './_lib/spaceAuth.js';
import { applyCors, handleOptions } from './_lib/cors.js';
import { firstQueryValue, sendError, sendJson } from './_lib/http.js';
import { MAX_PULL_ROWS } from './_lib/limits.js';
import { initSchema } from './_lib/db.js';
import { selectSourcesSince, selectWordsSince } from './_lib/inventory.js';
import type { ApiHandler } from './_lib/types.js';

/** 允许的最早时间戳（2001-09-09，比它小的一律当 0 处理） */
const MIN_TIMESTAMP = 1_000_000_000_000;

/**
 * 解析 since 参数：空/非法一律当 0（= 全量拉取），不报错。
 * @param raw 查询参数原值
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

  if (req.method !== 'GET') {
    sendError(res, 405, '只支持 GET');
    return;
  }

  let spaceKey: string;
  try {
    spaceKey = requireSpaceKey(req);
  } catch (err) {
    if (err instanceof SpaceKeyError) {
      // 日志只留状态和原因，绝不打印 spaceKey（连缩写都不需要）
      console.warn('[sync-pull] 拒绝请求：', err.status, err.message);
      sendError(res, err.status, err.message);
      return;
    }
    throw err;
  }

  const since = parseSince(firstQueryValue(req.query?.['since']));
  const startedAt = Date.now();

  try {
    await initSchema();
    const words = await selectWordsSince(spaceKey, since, MAX_PULL_ROWS);
    const sources = await selectSourcesSince(spaceKey, since, MAX_PULL_ROWS);
    const serverTime = Date.now();

    // 只打条数和耗时，不打 spaceKey、不打任何单词内容
    console.info(
      `[sync-pull] space=${spaceKeyHint(spaceKey)} 返回 words=${words.length} sources=${sources.length} 用时 ${serverTime - startedAt}ms`,
    );

    sendJson(res, 200, {
      words,
      sources,
      serverTime,
      hasMore: words.length >= MAX_PULL_ROWS || sources.length >= MAX_PULL_ROWS,
    });
  } catch (err) {
    console.error('[sync-pull] 失败：', err instanceof Error ? err.message : '未知错误');
    sendError(res, 500, '服务器读取数据库失败，请稍后重试');
  }
};

export default handler;
