/**
 * GET /api/health —— 健康检查（**不需要 spaceKey**）。
 *
 * 用途：前端设置页的「测试连接」按钮、Vercel 部署后自查。
 * 只回「连不连得上数据库」，绝不包含连接串、库名、表名等任何环境细节。
 */
import { pingDB } from './_lib/db.js';
import { applyCors, handleOptions } from './_lib/cors.js';
import { sendJson } from './_lib/http.js';
import type { ApiHandler } from './_lib/types.js';

const handler: ApiHandler = async (req, res) => {
  if (handleOptions(req, res)) return;
  applyCors(req, res);
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, { ok: false, error: '只支持 GET' });
    return;
  }
  const connected = await pingDB();
  sendJson(res, connected ? 200 : 500, {
    ok: connected,
    time: Date.now(),
    db: connected ? 'connected' : 'error',
  });
};

export default handler;
