/**
 * 云同步的编排层（阶段 02 的核心）。
 *
 * 核心原则：**本地优先（Local-first）**。所有操作先写本地 IndexedDB，
 * 云端同步只是后台悄悄跟上；同步失败**绝不阻断**任何功能，只在界面顶部给一条轻提示。
 *
 * 一次同步（syncOnce）的顺序固定为「先拉后推」：
 *   1. pull(since = lastSyncAt)：拿云端增量（**含 deleted=1 的墓碑**）
 *      - 云端 updatedAt **大于**本地 → 用云端覆盖本地（后写覆盖 last-write-wins）
 *      - 本地更新或本地独有 → 留着，等第 2 步推上去
 *   2. push(本地所有 updatedAt > lastPushAt 的行)：服务端按后写覆盖处理
 *   3. 更新 lastSyncAt（界面显示用）与 lastPushAt（下次推送的起点）
 *
 * 为什么要有「先拉后推」这一步序：不先拉就直接推，会把本机较旧的版本
 * 推上去覆盖别的设备刚改好的内容（后写覆盖是按 updatedAt 比大小的，
 * 本地 old 版本推上去时服务端会因为 updatedAt 更旧而拒绝——但那一条就白推了）。
 */
import { SYNC } from '../core/config';
import { normalizeApiBase } from '../core/syncHelper';
import { emitDataChanged } from '../state/store';
import type { Settings, Source, Word } from '../core/types';
import * as dao from './index';
import {
  applyRemoteSources,
  applyRemoteWords,
  clearAllLocal,
  countDirty,
  listDirtySources,
  listDirtyWords,
  removeWordsPermanently,
} from './syncData';
import { toLocalSource, toLocalWord, toSourcePayload, toWordPayload } from './syncMap';
import { pingHealth, pullRemote, purgeRemote, pushRemote, type SyncEndpoint } from './syncServer';

/** 一次同步的结果（给界面显示） */
export interface SyncResult {
  pulled: number;
  pushed: number;
  conflicts: number;
  error?: string;
}

/** 云端整体状态（设置页显示用） */
export interface CloudStatus {
  /** 是否配置齐全（后端地址 + 有效同步码） */
  configured: boolean;
  /** 待推送条数 */
  pending: number;
  /** 上次同步时间戳 */
  lastSyncAt: number;
  /** 上次错误 */
  lastError: string;
}

/** 「强制覆盖」的方向 */
export type OverwriteMode = 'local-to-cloud' | 'cloud-to-local';

/** 一次同步最多循环多少轮推送（防止异常情况下死循环） */
const MAX_PUSH_ROUNDS = 200;

/**
 * 从设置里取同步端点。
 * @param settings 设置
 */
function endpointOf(settings: Settings): SyncEndpoint {
  return {
    apiBase: normalizeApiBase(settings.cloud.apiBase),
    syncCode: settings.cloud.syncCode.trim(),
  };
}

/**
 * 把 cloud 设置写回（并同步内存缓存，界面立刻能看到）。
 * @param patch cloud 设置补丁
 */
async function patchCloud(patch: Partial<Settings['cloud']>): Promise<void> {
  await dao.settings.set({ cloud: patch });
}

/**
 * 保存错误信息（设置页会显示，方便排查）。
 * @param message 错误说明（**不含任何密钥**）
 */
async function saveError(message: string): Promise<void> {
  await patchCloud({ lastError: message });
}

/**
 * 配置是否齐全（后端地址 + 同步码都填了）。
 * @param settings 设置
 */
function cloudReady(settings: Settings): boolean {
  return normalizeApiBase(settings.cloud.apiBase) !== '' && settings.cloud.syncCode.trim() !== '';
}

/**
 * 「测试连接」：只打健康检查，不需要同步码。
 * @param apiBase 后端地址
 */
export async function testConnection(apiBase: string): Promise<{ ok: boolean; message: string }> {
  const base = normalizeApiBase(apiBase);
  if (base === '') return { ok: false, message: '请先填后端地址' };
  const res = await pingHealth(base);
  return { ok: res.ok && res.dbOk, message: res.message };
}

/**
 * 应用云端增量到本地（含墓碑处理）。**不触发同步**。
 * @param words 云端词条
 * @param sources 云端来源
 * @returns 实际应用的条数
 */
async function applyRemote(words: Word[], sources: Source[]): Promise<number> {
  const localWords = await dao.words.getAll();
  const localMap = new Map(localWords.map((w) => [w.id, w]));

  const toWrite: Word[] = [];
  const toDrop: string[] = [];
  for (const remote of words) {
    const local = localMap.get(remote.id);
    // 云端的版本不比本地新就跳过（本地改动还没推上去，不能被旧云端覆盖）
    if (local && local.updatedAt >= remote.updatedAt) continue;
    if (remote.deleted === 1) {
      // 云端墓碑落地：本地**真的删掉**这条词。
      // 说明：本地自己的删除走「斩」（chopped），墓碑只由别的设备写入，
      // 所以这里删掉不会丢用户在本机的操作痕迹，也不会复活别的设备上的删除。
      toDrop.push(remote.id);
    } else {
      // 编辑中的词可能已经没有墓碑，直接覆盖即可
      toWrite.push({ ...remote, deleted: 0 });
    }
    if (toWrite.length + toDrop.length >= SYNC.pullPageLimit) break;
  }

  const localSources = await dao.sources.listAll();
  const localSourceMap = new Map(localSources.map((s) => [s.id, s]));
  const sourcesToWrite: Source[] = [];
  const sourcesToDrop: string[] = [];
  for (const remote of sources) {
    const local = localSourceMap.get(remote.id);
    const localVersion = local ? (local.updatedAt ?? local.createdAt) : -1;
    const remoteVersion = remote.updatedAt ?? remote.createdAt;
    if (local && localVersion >= remoteVersion) continue;
    if (remote.deleted === 1) sourcesToDrop.push(remote.id);
    else sourcesToWrite.push({ ...remote, deleted: 0 });
  }

  // 一次性写回（内部各用一个事务），写完统一通知数据变动
  await applyRemoteWords(toWrite);
  await applyRemoteSources(sourcesToWrite);
  await removeWordsPermanently(toDrop);
  for (const id of sourcesToDrop) await dao.sources.removePermanently(id);

  const applied = toWrite.length + toDrop.length + sourcesToWrite.length + sourcesToDrop.length;
  if (applied > 0) emitDataChanged();
  return applied;
}

/**
 * 把本地待推送的数据全部推上去（内部循环分批，直到没有新的可推）。
 *
 * ⚠️ 这里有个必读的坑：**批量写入会让几百条记录的 `updatedAt` 完全相同**
 * （导入 / 粘贴 / 批量改属性都用同一个 `now`）。所以不能靠「`updatedAt > 游标`」分页：
 * - 游标停在 `max(updatedAt)`：下一轮把同批剩下的全部漏掉（实测 1100 条只推上去 500 条）；
 * - 游标 +1：又会把同批剩下的全部跳过。
 *
 * 正确做法分两步：
 * 1. **扫描**：`listDirtyWords(cursor)` 返回的是「服务端可能还没有」的候选集，
 *    里面**允许包含本次同步已经推过的记录**（它们的时间戳就是等于游标的那一批）；
 * 2. **过滤**：用 `pushedIds` 把本次同步已推过的 id 排除掉，剩下的才是真正待推的；
 *    过滤后为空就说明**没有更新的数据了**，可以收工。
 *
 * 游标只推进到「本页待推数据的真实最大 updatedAt」（不加 1），
 * 这样既不会漏、也不会在同一批时间戳上反复打转。
 *
 * @param ep 同步端点
 * @param since 推送起点（上次同步成功推到的 updatedAt）
 * @param startPushedIds 本次同步已推过的 id（每次同步开始时是空集合）
 * @returns 推送统计、新游标（下次同步的起点）、累计已推 id
 */
async function pushAll(
  ep: SyncEndpoint,
  since: number,
  startPushedIds: Set<string> = new Set(),
): Promise<{ pushed: number; conflicts: number; cursor: number; pushedIds: Set<string> }> {
  const pushedIds = startPushedIds;
  let cursor = since;
  let pushed = 0;
  let conflicts = 0;

  for (let round = 0; round < MAX_PUSH_ROUNDS; round += 1) {
    // 扫描用宽页：个人自用词库几千条，一次多读一点没关系，
    // 关键是**不能因为分页而看不到下一页**（否则又会出现漏推）。
    const wordCandidates = await listDirtyWords(cursor, SYNC.scanPageSize);
    const sourceCandidates = await listDirtySources(cursor, SYNC.scanPageSize);
    const words = wordCandidates.filter((w) => !pushedIds.has(w.id)).slice(0, SYNC.pushBatchSize);
    const sources = sourceCandidates.filter((s) => !pushedIds.has(s.id)).slice(0, SYNC.pushBatchSize);
    if (words.length === 0 && sources.length === 0) break;

    const maxWord = words.reduce((max, w) => Math.max(max, w.updatedAt), cursor);
    const maxSource = sources.reduce((max, s) => Math.max(max, s.updatedAt ?? s.createdAt), cursor);

    const res = await pushRemote(ep, words.map(toWordPayload), sources.map(toSourcePayload));
    if (!res.ok || !res.data) return { pushed, conflicts, cursor, pushedIds };
    pushed += res.data.applied;
    conflicts += res.data.conflicts;

    // 只有**确认推成功**之后才推进游标与已推集合；中途失败时剩下的下次重试，不会漏
    for (const w of words) pushedIds.add(w.id);
    for (const s of sources) pushedIds.add(s.id);
    cursor = Math.max(maxWord, maxSource);
  }

  return { pushed, conflicts, cursor, pushedIds };
}

/**
 * 同步一次（设置页「立即同步」与后台防抖都走这里）。
 *
 * 失败时**不抛异常**，返回带 `error` 的结果。
 */
export async function syncOnce(): Promise<SyncResult> {
  const settings = await dao.settings.get();
  const cloud = settings.cloud;
  if (!cloud.enabled) return { pulled: 0, pushed: 0, conflicts: 0, error: '云同步未开启' };
  if (!cloudReady(settings)) return { pulled: 0, pushed: 0, conflicts: 0, error: '后端地址或同步码还没填' };

  const ep = endpointOf(settings);
  let pulled = 0;
  let pushed = 0;
  let conflicts = 0;

  try {
    // ── 第 1 步：拉增量（since = lastSyncAt）──
    const pull = await pullRemote(ep, cloud.lastSyncAt);
    if (!pull.ok || !pull.data) {
      const message = pull.status === 401 ? '同步码无效或服务器拒绝（检查同步码是否一致）' : (pull.error ?? '拉取失败');
      await saveError(message);
      return { pulled, pushed, conflicts, error: message };
    }
    pulled = await applyRemote(
      pull.data.words.map(toLocalWord),
      pull.data.sources.map(toLocalSource),
    );

    // ── 第 2 步：推本地增量（since = lastPushAt）──
    // 传一个「本次同步已推过的 id」集合：同一毫秒里可能有几百条记录，
    // 靠 updatedAt 游标分不开它们（见 pushAll 的注释）。
    const pushResult = await pushAll(ep, cloud.lastPushAt, new Set<string>());
    pushed = pushResult.pushed;
    conflicts = pushResult.conflicts;

    // ── 第 3 步：更新游标 ──
    // 说明：`hasMore`（服务器还有没拉完的数据）时**不能**把游标直接推到 serverTime，
    // 否则本地那些没拉到的行会被误判成「已经在服务端」，下次不再推。
    // 这时只认 pushAll 自己算出来的真实推送进度。
    const pushAtFromPull = pull.data.hasMore ? 0 : pull.data.serverTime;
    const nextPushAt = Math.max(pushResult.cursor, pushAtFromPull);
    await patchCloud({
      lastSyncAt: pull.data.serverTime,
      lastPushAt: nextPushAt,
      lastError: '',
    });
    return { pulled, pushed, conflicts };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn('[cloudSync] 同步异常', err);
    await saveError(message);
    return { pulled, pushed, conflicts, error: message };
  }
}

/**
 * 「强制覆盖」：用一边的数据全量盖掉另一边。
 *
 * - `local-to-cloud`：把本地全部数据推上去（**不发删除**，只覆盖同 id 的行）；
 * - `cloud-to-local`：清空本地后全量拉回云端数据。
 * @param mode 方向
 */
export async function overwrite(mode: OverwriteMode): Promise<SyncResult> {
  const settings = await dao.settings.get();
  const cloud = settings.cloud;
  if (!cloud.enabled) return { pulled: 0, pushed: 0, conflicts: 0, error: '云同步未开启' };
  if (!cloudReady(settings)) return { pulled: 0, pushed: 0, conflicts: 0, error: '后端地址或同步码还没填' };
  const ep = endpointOf(settings);

  try {
    if (mode === 'cloud-to-local') {
      const pull = await pullRemote(ep, 0);
      if (!pull.ok || !pull.data) return { pulled: 0, pushed: 0, conflicts: 0, error: pull.error ?? '拉取失败' };
      await clearAllLocal();
      const pulled = await applyRemote(
        pull.data.words.map(toLocalWord),
        pull.data.sources.map(toLocalSource),
      );
      await patchCloud({
        lastSyncAt: pull.data.serverTime,
        lastPushAt: pull.data.serverTime,
        lastError: '',
      });
      return { pulled, pushed: 0, conflicts: 0 };
    }

    // local-to-cloud：从 0 开始把所有本地数据推上去
    const result = await pushAll(ep, 0, new Set<string>());
    const now = Date.now();
    await patchCloud({ lastSyncAt: now, lastPushAt: Math.max(result.cursor, now), lastError: '' });
    return { pulled: 0, pushed: result.pushed, conflicts: result.conflicts, error: undefined };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await saveError(message);
    return { pulled: 0, pushed: 0, conflicts: 0, error: message };
  }
}

/**
 * 清空**云端**当前数据空间的数据（本地不动）。
 * @returns 删除条数或错误
 */
export async function clearCloud(): Promise<{ ok: boolean; removed: number; error?: string }> {
  const settings = await dao.settings.get();
  if (!cloudReady(settings)) return { ok: false, removed: 0, error: '云同步未开启或配置不全' };
  const res = await purgeRemote(endpointOf(settings));
  if (!res.ok || !res.data) {
    const message = res.status === 401 ? '同步码无效或服务器拒绝' : (res.error ?? '清空失败');
    await saveError(message);
    return { ok: false, removed: 0, error: message };
  }
  await patchCloud({ lastPushAt: 0, lastSyncAt: 0, lastError: '' });
  return { ok: true, removed: res.data.removed };
}

/**
 * 读云端整体状态（设置页显示用）。
 */
export async function getStatus(): Promise<CloudStatus> {
  const settings = await dao.settings.get();
  const cloud = settings.cloud;
  const dirty = await countDirty(cloud.lastPushAt);
  return {
    configured: normalizeApiBase(cloud.apiBase) !== '' && cloud.syncCode.trim() !== '',
    pending: dirty.words + dirty.sources,
    lastSyncAt: cloud.lastSyncAt,
    lastError: cloud.lastError,
  };
}

/**
 * 是否配置齐全（后台防抖同步前的快速判断，避免白跑）。
 */
export function isConfigured(settings: Settings): boolean {
  const cloud = settings.cloud;
  return cloud.enabled && normalizeApiBase(cloud.apiBase) !== '' && cloud.syncCode.trim() !== '';
}
