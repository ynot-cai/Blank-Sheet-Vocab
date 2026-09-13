/**
 * 二期卡片云同步（**编排层**；传输细节在 `kcCloudHttp.ts`）。
 *
 * **共用一期的同步通道**：同一个 Turso 库、同一个 spaceKey 隔离逻辑、
 * 同样的 `X-Space-Key` 头、同样的分批 ≤ 500、同样的「失败只轻提示、绝不阻断」。
 * 但**游标是独立的**（`settings.kc.cloud`）——一期推 words/sources、二期推 knowledge_cards，
 * 两边互不影响：二期同步失败不会拖住一期，一期的 `lastPushAt` 也不会让二期漏推。
 *
 * 一次同步（`kcSyncOnce`）的顺序与一期一致，固定「先拉后推」：
 *   1. pull(since = kc.cloud.lastSyncAt)：拿云端增量（含墓碑）
 *      - 云端 updatedAt **大于**本地 → 用云端覆盖本地
 *      - 本地更新或本地独有 → 留着，等第 2 步推上去
 *   2. push(本地所有 updatedAt >= kc.cloud.lastPushAt 的卡片)：服务端按后写覆盖处理
 *   3. 更新两个游标
 *
 * 为什么必须先拉后推：不先拉就直接推，会把本机较旧的版本推上去
 * （虽然服务端会因为 updatedAt 更旧而拒绝，但那一条就白推了，还多一次往返）。
 *
 * **接口约定**：`kcPull` / `kcPush` / `kcSyncOnce` 三个函数
 * **失败一律返回带 `error` 的结果对象，绝不抛异常**（与一期 `cloudSync` 同约定）——
 * 同步失败绝不能把异常甩到界面上。
 */
import { SYNC } from '../core/config';
import { ensureClockFloor } from '../core/kcClock';
import { recomputeCard } from '../core/kcPriority';
import type { KnowledgeCard } from '../core/kcTypes';
import { STORE, txRun } from '../core/db';
import { emitDataChanged } from '../state/store';
import * as kcDao from './kc';
import * as settingsDao from './settings';
import {
  endpointOf,
  kcCloudReady,
  kcListUrl,
  kcPushUrl,
  requestWithRetry,
  spaceKeyOf,
  toLocalCard,
  toServerCard,
  type KcPullData,
  type KcPushData,
} from './kcCloudHttp';

export { kcCloudReady } from './kcCloudHttp';

/**
 * 一次同步的结果（给界面显示）。
 *
 * `conflicts` 恒为 0：二期把冲突判断放在服务端（服务端按后写覆盖挡掉更旧的版本），
 * 客户端只关心 applied；保留这个字段是为了和一期 `SyncResult` 结构一致，
 * 这样二期的调度器能直接复用一期的 `syncSchedulerFactory`。
 */
export interface KcSyncResult {
  pulled: number;
  pushed: number;
  conflicts: number;
  error?: string;
}

/** 拉取结果（与验收标准的签名一致：**失败返回 error，不抛异常**） */
export interface KcPullResult {
  cards: KnowledgeCard[];
  /** 服务器时间，作为下次拉取的 since */
  serverTime: number;
  /** 云端还有没拉完的（单次上限 MAX_PULL_ROWS） */
  hasMore: boolean;
  error?: string;
}

/** 推送结果（同上：失败返回 error，不抛异常） */
export interface KcPushResult {
  applied: number;
  error?: string;
}

/** 一次同步最多循环多少轮推送（防止异常情况下死循环） */
const MAX_PUSH_ROUNDS = 200;

/**
 * 增量拉取云端卡片。
 * @param since 只取 updated_at 大于它的记录（0 = 全量）
 */
export async function kcPull(since: number): Promise<KcPullResult> {
  try {
    const settings = await settingsDao.get();
    const ep = endpointOf(settings);
    const estMinutes = settings.kc.examLoadDefaultMinutes;
    const spaceKey = await spaceKeyOf(ep.syncCode);
    const res = await requestWithRetry<KcPullData>(kcListUrl(ep.apiBase, since), 'GET', undefined, spaceKey);
    if (!res.ok || !res.data) {
      return { cards: [], serverTime: since, hasMore: false, error: res.error ?? '拉取失败' };
    }

    const cards: KnowledgeCard[] = [];
    for (const row of res.data.cards) {
      const card = toLocalCard(row, estMinutes);
      if (card !== null) cards.push(card);
    }
    return { cards, serverTime: res.data.serverTime, hasMore: res.data.hasMore };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn('[kcCloud] 拉取异常', err);
    return { cards: [], serverTime: since, hasMore: false, error: message };
  }
}

/**
 * 批量推送卡片（**内部自动分批：每批 ≤ 500 张**，规避 Vercel 4.5MB 请求体限制）。
 *
 * 失败时**已成功的批次不回滚**（它们已经在云端了，下次同步会跳过，不会重复推）。
 * @param cards 待推卡片
 */
export async function kcPush(cards: KnowledgeCard[]): Promise<KcPushResult> {
  if (cards.length === 0) return { applied: 0 };
  let applied = 0;
  try {
    const settings = await settingsDao.get();
    const ep = endpointOf(settings);
    const spaceKey = await spaceKeyOf(ep.syncCode);
    const url = kcPushUrl(ep.apiBase);

    for (let i = 0; i < cards.length; i += SYNC.pushBatchSize) {
      const batch = cards.slice(i, i + SYNC.pushBatchSize);
      const res = await requestWithRetry<KcPushData>(
        url,
        'POST',
        JSON.stringify({ cards: batch.map(toServerCard) }),
        spaceKey,
      );
      if (!res.ok || !res.data) return { applied, error: res.error ?? '推送失败' };
      applied += res.data.applied ?? 0;
    }
    return { applied };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn('[kcCloud] 推送异常', err);
    return { applied, error: message };
  }
}

/**
 * 把云端拉下来的一批卡片合到本地（后写覆盖 + 墓碑处理）。
 *
 * 规则与一期 `cloudSync.applyRemote` 一致，只有墓碑处理不同：
 * - 云端版本不比本地新 → 跳过（本地改动还没推上去，不能被旧云端覆盖）
 * - 云端墓碑 → 本地**落成墓碑**（一期 words 是真删，二期不真删，
 *   因为二期要能在「已斩」列表里看到并**复活**）
 * - 否则写入（`deleted` 归 0）
 *
 * @param cards 云端卡片
 * @returns 实际应用的条数
 */
export async function applyRemote(cards: KnowledgeCard[]): Promise<number> {
  if (cards.length === 0) return 0;
  const localAll = await kcDao.getAll();
  const localMap = new Map(localAll.map((c) => [c.id, c]));

  const toWrite: KnowledgeCard[] = [];
  for (const remote of cards) {
    const local = localMap.get(remote.id);
    // 云端的版本不比本地新就跳过
    if (local && local.updatedAt >= remote.updatedAt) continue;
    // 写回时重算掌握度与优先度：另一台设备可能改过分数，或改过公式参数
    const recomputed = recomputeCard(remote);
    toWrite.push({ ...recomputed, deleted: remote.deleted === 1 ? 1 : 0 });
  }
  if (toWrite.length === 0) return 0;

  await txRun(STORE.knowledgeCards, 'readwrite', (s) => {
    for (const card of toWrite) s.put(card);
  });
  emitDataChanged();
  return toWrite.length;
}

/**
 * 把本地待推送的卡片全部推上去（内部循环分批，直到没有新的可推）。
 *
 * 坑与一期完全一样：**批量写入会让几百张卡片共享同一个 `updatedAt`**，
 * 所以不能靠「updatedAt > 游标」分页（会漏）。做法是：
 * 1. 扫描：`listDirty(cursor)` 返回**候选集**（允许包含本次已推过的）；
 * 2. 过滤：用 `pushedIds` 排除本次已推过的，空了就收工；
 * 3. 游标只推进到本页真实的最大 `updatedAt`（不加 1）。
 *
 * @param since 推送起点
 * @param startPushedIds 本次同步已推过的 id
 */
async function pushAll(
  since: number,
  startPushedIds: Set<string> = new Set(),
): Promise<{ pushed: number; cursor: number; pushedIds: Set<string>; error?: string }> {
  const pushedIds = startPushedIds;
  let cursor = since;
  let pushed = 0;

  for (let round = 0; round < MAX_PUSH_ROUNDS; round += 1) {
    const candidates = await kcDao.listDirty(cursor, SYNC.scanPageSize);
    const batch = candidates.filter((c) => !pushedIds.has(c.id)).slice(0, SYNC.pushBatchSize);
    if (batch.length === 0) break;

    const maxUpdated = batch.reduce((max, c) => Math.max(max, c.updatedAt), cursor);
    const res = await kcPush(batch);
    pushed += res.applied;
    // 推送失败：**不推进游标、也不标记已推**（这一批下次重试），错误交给调用方
    if (res.error !== undefined) return { pushed, cursor, pushedIds, error: res.error };

    // 只有**确认推成功**之后才推进游标，中途失败时剩下的下次重试，不会漏
    for (const c of batch) pushedIds.add(c.id);
    cursor = maxUpdated;
  }

  return { pushed, cursor, pushedIds };
}

/**
 * 同步一次（后台防抖与「立即同步」都走这里）。
 *
 * 失败不抛异常，返回带 `error` 的结果；本地数据完全不受影响。
 */
export async function kcSyncOnce(): Promise<KcSyncResult> {
  let pulled = 0;
  let pushed = 0;
  const settings = await settingsDao.get();
  if (!settings.cloud.enabled) return { pulled, pushed, conflicts: 0, error: '云同步未开启' };
  if (!kcCloudReady(settings)) return { pulled, pushed, conflicts: 0, error: '后端地址或同步码还没填' };

  // 同步前先把「时间水位」捞一遍：设备时钟倒退时，本地新卡片的 updatedAt
  // 必须不低于上次推送游标，否则它们会被当成「早就推过了」而永远漏推
  // （见 core/kcClock.ts 的完整说明）
  await ensureClockFloor();

  const cursor = settings.kc.cloud;

  // ── 第 1 步：拉增量（失败就整体失败，不往下走）──
  const pull = await kcPull(cursor.lastSyncAt);
  if (pull.error !== undefined) {
    await settingsDao.set({ kc: { cloud: { lastError: pull.error } } });
    return { pulled, pushed, conflicts: 0, error: pull.error };
  }
  pulled = await applyRemote(pull.cards);

  // ── 第 2 步：推本地增量（失败时已推成功的批次保留，剩下的下次重试）──
  const pushResult = await pushAll(cursor.lastPushAt, new Set<string>());
  pushed = pushResult.pushed;
  if (pushResult.error !== undefined) {
    await settingsDao.set({ kc: { cloud: { lastError: pushResult.error } } });
    return { pulled, pushed, conflicts: 0, error: pushResult.error };
  }

  // ── 第 3 步：更新游标 ──
  // `hasMore`（云端还有没拉完的）时**不能**把推送游标推到 serverTime，
  // 否则本地那些没拉到的行会被误判成「已经在服务端」，下次不再推。
  const pushFromPull = pull.hasMore ? 0 : pull.serverTime;
  await settingsDao.set({
    kc: {
      cloud: {
        lastSyncAt: pull.serverTime,
        lastPushAt: Math.max(pushResult.cursor, pushFromPull),
        lastError: '',
      },
    },
  });
  return { pulled, pushed, conflicts: 0 };
}

/**
 * 二期同步状态快照（二期界面顶部/设置页显示用）。
 */
export async function kcStatus(): Promise<{ pending: number; lastSyncAt: number; lastError: string }> {
  const settings = await settingsDao.get();
  const cursor = settings.kc.cloud;
  const dirty = await kcDao.listDirty(cursor.lastPushAt, Number.MAX_SAFE_INTEGER);
  return { pending: dirty.length, lastSyncAt: cursor.lastSyncAt, lastError: cursor.lastError };
}
