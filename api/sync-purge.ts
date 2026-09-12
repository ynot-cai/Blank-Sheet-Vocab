/**
 * POST /api/sync-purge
 *
 * 注意路由名：Vercel 按文件名映射路由，实际路径是 `/api/sync-purge`（连字符），
 * 不是 `/api/sync/purge`。
 *
 * body: `{ confirm: "DELETE" }`
 *
 * 清空**当前数据空间**（就是请求头里那个 spaceKey 对应的空间）的全部数据。
 * 用于设置页的「清空云端数据」——自用工具，用户明确要求删掉，就不留软删除残影。
 *
 * 安全：
 * - 必须带合法 `X-Space-Key`（401 之外的请求根本进不来）；
 * - `WHERE space_key = ?` 由 _lib/inventory.ts 强制，**不可能删到别人的空间**；
 * - 必须显式带 `confirm: "DELETE"`，避免误触把云端数据清掉；
 * - 日志只打条数，不打印 spaceKey 完整值、不打印词条内容。
 */
import { requireSpaceKey, spaceKeyHint, SpaceKeyError } from './_lib/spaceAuth.js';
import { applyCors, handleOptions } from './_lib/cors.js';
import { readJsonBody, sendError, sendJson } from './_lib/http.js';
import { initSchema } from './_lib/db.js';
import { purgeSpace } from './_lib/inventory.js';
import type { ApiHandler } from './_lib/types.js';

/** 确认口令：前端要显式传它，防止误触 */
const CONFIRM_WORD = 'DELETE';

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
      console.warn('[sync-purge] 拒绝请求：', err.status, err.message);
      sendError(res, err.status, err.message);
      return;
    }
    throw err;
  }

  const body = readJsonBody(req.body);
  if (body === null || body['confirm'] !== CONFIRM_WORD) {
    sendError(res, 400, `危险操作：请求体必须带 { "confirm": "${CONFIRM_WORD}" }`);
    return;
  }

  try {
    await initSchema();
    const removed = await purgeSpace(spaceKey);
    console.info(
      `[sync-purge] space=${spaceKeyHint(spaceKey)} 删除 words=${removed.words} sources=${removed.sources}`,
    );
    sendJson(res, 200, { ok: true, removed: removed.words + removed.sources, serverTime: Date.now() });
  } catch (err) {
    console.error('[sync-purge] 失败：', err instanceof Error ? err.message : '未知错误');
    sendError(res, 500, '服务器删除数据失败，请稍后重试');
  }
};

export default handler;
