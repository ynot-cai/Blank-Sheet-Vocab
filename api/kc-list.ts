/**
 * GET /api/kc/list?since=<timestamp>
 *
 * 二期的增量拉取（知识卡片）。路由名规则同一期：**Vercel 按文件名映射**，
 * 所以这个文件对应的是 /api/kc-list（连字符），不是带斜杠的那种写法——写成后者会 404。
 *
 * 必须守住的点（与一期 sync-pull 完全一致的口径）：
 * - **包含软删除记录**（deleted=1 也返回），否则「A 设备斩了这张卡」永远同步不到 B 设备；
 * - 所有查询都带 `WHERE space_key = ?`（见 _lib/kcInventory.ts）；
 * - 单次返回有上限（MAX_PULL_ROWS），超出请前端拿 `serverTime` 当下次的 `since` 继续拉；
 * - 日志**只打条数和耗时**，不打卡片内容、不打完整 spaceKey。
 *
 * 安全底线：这里不接触任何 AI 密钥（方案 B），也没有可存密钥的字段。
 */
import { requireSpaceKey, spaceKeyHint, SpaceKeyError } from './_lib/spaceAuth.js';
import { applyCors, handleOptions } from './_lib/cors.js';
import { firstQueryValue, sendError, sendJson } from './_lib/http.js';
import { MAX_PULL_ROWS } from './_lib/limits.js';
import { initKcSchema } from './_lib/kcSchema.js';
import { selectKcCardsSince } from './_lib/kcInventory.js';
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
      console.warn('[kc-list] 拒绝请求：', err.status, err.message);
      sendError(res, err.status, err.message);
      return;
    }
    throw err;
  }

  const since = parseSince(firstQueryValue(req.query?.['since']));
  const startedAt = Date.now();

  try {
    await initKcSchema();
    const cards = await selectKcCardsSince(spaceKey, since, MAX_PULL_ROWS);
    const serverTime = Date.now();

    console.info(
      `[kc-list] space=${spaceKeyHint(spaceKey)} 返回卡片=${cards.length} 用时 ${serverTime - startedAt}ms`,
    );

    sendJson(res, 200, {
      cards,
      serverTime,
      hasMore: cards.length >= MAX_PULL_ROWS,
    });
  } catch (err) {
    console.error('[kc-list] 失败：', err instanceof Error ? err.message : '未知错误');
    sendError(res, 500, '服务器读取数据库失败，请稍后重试');
  }
};

export default handler;
