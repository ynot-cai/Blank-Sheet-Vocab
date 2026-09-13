/**
 * POST /api/kc-push
 *
 * 路由名规则：Vercel 按**文件名**映射路由，所以这个文件对应的是
 * /api/kc-push（连字符），不是带斜杠的那种写法——写成后者线上会 404。
 *
 * body: `{ cards: KcCardInput[] }`，**单批 ≤ 500 条**（前端必须自己分批，
 * 否则大卡片集首次同步会被 Vercel 的 4.5MB 请求体限制打成 413）。
 *
 * 冲突策略：与一期完全一致 —— **后写覆盖（last-write-wins）**：
 * 客户端 `updatedAt` 不旧于云端就覆盖，更旧的一条算 `conflicts` 并跳过
 * （避免旧设备把新数据打回去）。
 *
 * 字段含义（前端也按这个口径显示）：
 * - `applied`：真正执行了 upsert 的行数（重复推同样内容也算，因为确实写了一次）；
 * - `conflicts`：被服务器挡下的行数（客户端版本比云端旧）；
 * - `skipped`：结构不合法被跳过的行数（见 _lib/kcValidate.ts）。
 *
 * 日志纪律：只打条数和耗时；**绝不打印卡片内容**，也绝不打印完整 spaceKey。
 */
import { requireSpaceKey, spaceKeyHint, SpaceKeyError } from './_lib/spaceAuth.js';
import { applyCors, handleOptions } from './_lib/cors.js';
import { readJsonBody, sendError, sendJson } from './_lib/http.js';
import { MAX_PUSH_BATCH } from './_lib/limits.js';
import { initKcSchema } from './_lib/kcSchema.js';
import { selectExistingKcTimes, upsertKcCards, type KcCardInput } from './_lib/kcInventory.js';
import { normalizeCards } from './_lib/kcValidate.js';
import type { ApiHandler } from './_lib/types.js';

/**
 * 过滤出「该写」的卡片：云端没有，或客户端版本不比云端旧。
 * @param cards 归一化后的卡片
 * @param existing id → 云端已有版本号
 */
function selectWritable(
  cards: KcCardInput[],
  existing: Map<string, number>,
): { writable: KcCardInput[]; conflicts: number } {
  const writable: KcCardInput[] = [];
  let conflicts = 0;
  for (const card of cards) {
    const serverTime = existing.get(card.id);
    if (serverTime === undefined || card.updatedAt >= serverTime) writable.push(card);
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
      console.warn('[kc-push] 拒绝请求：', err.status, err.message);
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

  const rawCards = Array.isArray(body['cards']) ? (body['cards'] as unknown[]) : [];
  if (rawCards.length === 0) {
    sendError(res, 400, 'cards 必须是非空数组');
    return;
  }
  if (rawCards.length > MAX_PUSH_BATCH) {
    sendError(res, 400, `单批不得超过 ${MAX_PUSH_BATCH} 张（本批 ${rawCards.length} 张），请前端分批推送`);
    return;
  }

  const { cards, skipped } = normalizeCards(rawCards);
  const startedAt = Date.now();

  try {
    await initKcSchema();

    // 先查冲突基线（**只查本空间**，见 kcInventory 的 SQL）
    const existing = await selectExistingKcTimes(
      spaceKey,
      cards.map((c) => c.id),
    );
    const { writable, conflicts } = selectWritable(cards, existing);
    await upsertKcCards(spaceKey, writable);

    const applied = writable.length;
    const serverTime = Date.now();

    console.info(
      `[kc-push] space=${spaceKeyHint(spaceKey)} 收到 ${rawCards.length} 张，写入 ${applied} 张，冲突 ${conflicts} 张，跳过 ${skipped} 张，用时 ${serverTime - startedAt}ms`,
    );

    sendJson(res, 200, { applied, conflicts, skipped, serverTime });
  } catch (err) {
    console.error('[kc-push] 失败：', err instanceof Error ? err.message : '未知错误');
    sendError(res, 500, '服务器写入数据库失败，请稍后重试');
  }
};

export default handler;
