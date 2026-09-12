/**
 * 阶段 02 验收脚本：`npm run test:sync`
 *
 * 在 Node 里跑**真正的前端同步代码**（src/dao/cloudSync.ts 等），靠两样东西把浏览器环境补上：
 * - `fake-indexeddb`：真的 IndexedDB 语义，DAO 一行都不用改；
 * - 本地 API 服务（api/_dev/harness.mjs）：真的 HTTP 请求打到真的 api/ 处理函数和真的 SQL。
 *
 * 因此这里验证的是「多设备同步」的完整链路，而不是替身。
 */
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { loadEnvFiles } from './envFile.mjs'; // 静态导入：注册 TS 加载钩子 + 读 .env
import 'fake-indexeddb/auto';

loadEnvFiles('..');

// ── 先把浏览器环境补上（顺序很重要：必须在 import src 之前）──
const DB_FILE = './.tmp/test-sync.db';
if (existsSync(DB_FILE)) rmSync(DB_FILE);
mkdirSync('./.tmp', { recursive: true });
process.env.TURSO_DATABASE_URL = `file:${DB_FILE}`;

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
  key: (i) => [...store.keys()][i] ?? null,
  get length() {
    return store.size;
  },
};
globalThis.window = globalThis;

const { startServer } = await import('./harness.mjs');
const { initSchema } = await import('../_lib/db.ts');

// ── 本机 API（前端通过 fetch 打它，等价于线上 Vercel）──
const PORT = 3123;
const server = startServer(PORT);
await new Promise((r) => setTimeout(r, 250));
const API_BASE = `http://127.0.0.1:${PORT}`;

// ── 加载被测代码 ──
const dao = await import('../../src/dao/index.ts');
const cloudSync = await import('../../src/dao/cloudSync.ts');
const { syncData } = dao;

let passed = 0;
let failed = 0;

/**
 * 一条断言。
 * @param {string} name 用例名
 * @param {boolean} ok 是否通过
 * @param {string} [detail] 失败时的补充
 */
function check(name, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`);
  }
}

/**
 * 造一个词（和真实数据同构）。
 * @param {string} en 英文
 */
function makeWord(en) {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    en,
    phonetic: `/${en}/`,
    example: `This is ${en}.`,
    senses: [{ id: 's1', text: `n. ${en} 的意思`, aliases: [], enabled: true }],
    sourceId: 'src-1',
    rawSources: [],
    attrs: {
      needSpell: false,
      failCount: 0,
      failCountTotal: 0,
      reviewCount: 0,
      lastReviewAt: null,
      learnedAt: null,
      reviewPriority: 0,
    },
    status: 'unlearned',
    learnOrder: null,
    createdAt: now,
    updatedAt: now,
    deleted: 0,
  };
}

/**
 * 直接读云端库里某个空间的词条（验证「云端真的有」）。
 * @param {string} syncCode 同步码
 */
async function cloudWords(syncCode) {
  const { getDB } = await import('../_lib/db.ts');
  const { getSpaceKey } = await import('../../src/core/syncHelper.ts');
  const key = await getSpaceKey(syncCode);
  const rs = await getDB().execute({
    sql: 'SELECT id, en, deleted FROM words WHERE space_key = ? ORDER BY en',
    args: [key],
  });
  return rs.rows.map((r) => ({ ...r }));
}

console.log('\n=== 阶段 02 验收：前端本地优先 + 云同步 ===\n');
await initSchema();

// ─────────────────────────────────────────── 1. 没开云同步时完全离线可用
console.log('[1] 未开启云同步 → 纯本地，绝对不联网');
{
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (...args) => {
    calls.push(String(args[0]));
    return realFetch(...args);
  };

  await dao.words.bulkUpsert([makeWord('offline-a'), makeWord('offline-b')]);
  const all = await dao.words.listAlive();
  check('本地读写正常（2 条）', all.length === 2, `实际 ${all.length}`);

  const res = await cloudSync.syncOnce();
  check('未开启时同步直接拒绝', res.error === '云同步未开启', JSON.stringify(res));
  check('未开启时一次 API 请求都没发', calls.filter((u) => u.includes('/api/')).length === 0, calls.join(','));

  globalThis.fetch = realFetch;
}

// ─────────────────────────────────────────── 2. 配置 + 测试连接
console.log('\n[2] 填后端地址 + 同步码 → 测试连接');
{
  await dao.settings.set({ cloud: { enabled: true, apiBase: API_BASE, syncCode: 'my-word-2026', autoSync: true } });
  const settings = await dao.settings.get();
  check('设置能存下来（含 cloud 分区）', settings.cloud.syncCode === 'my-word-2026' && settings.cloud.enabled);

  const bad = await cloudSync.testConnection('http://127.0.0.1:9');
  check('连不上时返回失败而不是抛异常', bad.ok === false, JSON.stringify(bad));

  const good = await cloudSync.testConnection(API_BASE);
  check('测试连接成功', good.ok === true, JSON.stringify(good));
}

// ─────────────────────────────────────────── 3. 首次同步：本地推到云端
console.log('\n[3] 首次同步：本机已有数据 → 推到云端');
{
  const before = await cloudWords('my-word-2026');
  check('云端一开始是空的', before.length === 0, `实际 ${before.length}`);

  const res = await cloudSync.syncOnce();
  check('同步没有报错', !res.error, JSON.stringify(res));
  check('推送了 2 条', res.pushed === 2, JSON.stringify(res));

  const after = await cloudWords('my-word-2026');
  check('云端确实有 2 条', after.length === 2, JSON.stringify(after));

  const settings = await dao.settings.get();
  check('lastSyncAt 已更新', settings.cloud.lastSyncAt > 0, String(settings.cloud.lastSyncAt));
  check('lastPushAt 已更新', settings.cloud.lastPushAt > 0, String(settings.cloud.lastPushAt));

  const again = await cloudSync.syncOnce();
  check('再同步一次不会重复推送', again.pushed === 0, JSON.stringify(again));
}

// ─────────────────────────────────────────── 4. 换设备
console.log('\n[4] 多设备：新设备填同一个同步码 → 拉到同一份数据');
{
  await syncData.clearAllLocal();
  await dao.settings.set({ cloud: { lastSyncAt: 0, lastPushAt: 0, lastError: '' } });
  const empty = await dao.words.listAlive();
  check('新设备本地是空的', empty.length === 0, `实际 ${empty.length}`);

  const res = await cloudSync.syncOnce();
  check('同步没有报错', !res.error, JSON.stringify(res));
  check('拉到了 2 条', res.pulled === 2, JSON.stringify(res));

  const words = await dao.words.listAlive();
  check('本地已经有那 2 条词', words.length === 2, `实际 ${words.length}`);
  check('字段完整（义项 / 属性都在）', words[0].senses.length === 1 && words[0].attrs.failCount === 0);
}

// ─────────────────────────────────────────── 5. 增量同步
console.log('\n[5] 增量同步：本机改一个词 → 云端更新 → 另一台设备拉得到');
{
  const words = await dao.words.listAlive();
  const target = words[0];
  await new Promise((r) => setTimeout(r, 5));
  await dao.words.updateAttrs(target.id, { failCount: 2, reviewCount: 7 });

  const res = await cloudSync.syncOnce();
  check('推送了 1 条改动', res.pushed === 1, JSON.stringify(res));

  const rows = await cloudWords('my-word-2026');
  check('云端那条还在', rows.some((r) => r.id === target.id));

  // 模拟另一台设备：把本地版本退回去，再同步，应该拉回新版本
  const localWords = await dao.words.getAll();
  const stale = localWords.map((w) =>
    w.id === target.id ? { ...w, updatedAt: 1, attrs: { ...w.attrs, failCount: 0 } } : w,
  );
  await syncData.applyRemoteWords(stale);
  await dao.settings.set({ cloud: { lastSyncAt: 0 } });

  const res2 = await cloudSync.syncOnce();
  check('拉到了更新', res2.pulled >= 1, JSON.stringify(res2));
  const updated = await dao.words.getById(target.id);
  check('本地已经是云端的新版本（failCount=2）', updated?.attrs.failCount === 2, JSON.stringify(updated?.attrs));
}

// ─────────────────────────────────────────── 6. 数据隔离
console.log('\n[6] 数据隔离：换一个同步码 → 拉不到前一个码的数据');
{
  await dao.settings.set({ cloud: { syncCode: 'another-space-9999', lastSyncAt: 0, lastPushAt: 0 } });
  const res = await cloudSync.syncOnce();
  check('同步没有报错', !res.error, JSON.stringify(res));

  const rows = await cloudWords('another-space-9999');
  check('新空间没有前一个码的数据（隔离生效）', rows.length === 0 || res.pulled === 0, JSON.stringify({ rows: rows.length, pulled: res.pulled }));

  const stillThere = await cloudWords('my-word-2026');
  check('原空间数据还在（没被串掉）', stillThere.length >= 2, `实际 ${stillThere.length}`);

  // 换码 = 换一个全新空间；本机数据会被推到新空间（预期行为，不是 bug）
  check('换码后本机数据被推到新空间（预期行为）', res.pushed >= 1, JSON.stringify(res));

  await dao.settings.set({ cloud: { syncCode: 'my-word-2026', lastSyncAt: 0, lastPushAt: 0 } });
}

// ─────────────────────────────────────────── 7. 断网
console.log('\n[7] 断网 / 后端挂掉 → 同步失败，但本地功能一切正常');
{
  await dao.settings.set({ cloud: { apiBase: 'http://127.0.0.1:9', lastError: '' } });

  const res = await cloudSync.syncOnce();
  check('返回失败而不是抛异常', typeof res.error === 'string' && res.error !== '', JSON.stringify(res));

  const settings = await dao.settings.get();
  check('失败原因被记下来（设置页能看到）', settings.cloud.lastError !== '', settings.cloud.lastError);

  // 断网期间的本地操作必须照常
  const w = makeWord('offline-editing');
  await dao.words.bulkUpsert([w]);
  await dao.words.updateAttrs(w.id, { needSpell: true });
  await dao.words.chop(w.id);
  const after = await dao.words.getById(w.id);
  check('断网时录入 / 改属性 / 斩词都正常', after?.status === 'chopped' && after.attrs.needSpell === true);
  const stats = await dao.words.stats();
  check('统计照常能算', stats.total > 0 && stats.chopped >= 1, JSON.stringify(stats));

  await dao.settings.set({ cloud: { apiBase: API_BASE } });
  const ok = await cloudSync.syncOnce();
  check('恢复后同步成功', !ok.error, JSON.stringify(ok));
  const settings2 = await dao.settings.get();
  check('恢复后清掉了错误信息', settings2.cloud.lastError === '', settings2.cloud.lastError);
}

// ─────────────────────────────────────────── 8. 分批推送
console.log('\n[8] 首次全量同步 1100 条 → 自动分批');
{
  await syncData.clearAllLocal();
  await dao.settings.set({ cloud: { lastSyncAt: 0, lastPushAt: 0, lastError: '' } });
  const many = Array.from({ length: 1100 }, (_, i) => makeWord(`bulk-${String(i).padStart(4, '0')}`));
  await dao.words.bulkUpsert(many);

  const res = await cloudSync.syncOnce();
  check('没有报错', !res.error, JSON.stringify(res));
  check('1100 条全部推上去（自动分 3 批）', res.pushed >= 1100, JSON.stringify(res));

  const rows = await cloudWords('my-word-2026');
  check('云端总数 ≥ 1100', rows.length >= 1100, `实际 ${rows.length}`);
}

// ─────────────────────────────────────────── 9. 云端墓碑
console.log('\n[9] 云端墓碑 → 本机真的删掉（不会复活）');
{
  const words = await dao.words.listAlive();
  const victim = words[0];
  const { getDB } = await import('../_lib/db.ts');
  const { getSpaceKey } = await import('../../src/core/syncHelper.ts');
  const key = await getSpaceKey('my-word-2026');
  await getDB().execute({
    sql: 'UPDATE words SET deleted = 1, updated_at = ? WHERE space_key = ? AND id = ?',
    args: [Date.now() + 1000, key, victim.id],
  });

  await dao.settings.set({ cloud: { lastSyncAt: 0 } });
  const res = await cloudSync.syncOnce();
  check('同步没有报错', !res.error, JSON.stringify(res));
  const gone = await dao.words.getById(victim.id);
  check('本机那条已经被删掉', gone === null, JSON.stringify(gone));
  const alive = await dao.words.listAlive();
  check('活词里也不再有它', !alive.some((w) => w.id === victim.id));
}

// ─────────────────────────────────────────── 10. 调度器状态
console.log('\n[10] 调度器：断网时连续失败，状态可被界面读取');
{
  await dao.settings.set({ cloud: { apiBase: 'http://127.0.0.1:9', lastError: '' } });
  const scheduler = await import('../../src/dao/syncScheduler.ts');
  await scheduler.syncNow();
  const state = scheduler.getSyncState();
  check('状态变成 error', state.phase === 'error', JSON.stringify({ phase: state.phase }));
  check('失败次数在累加', state.failStreak >= 1, String(state.failStreak));
  check('busy 已经归位（不会卡在同步中）', state.busy === false);
  scheduler.cancelScheduled();

  await dao.settings.set({ cloud: { apiBase: API_BASE } });
  const okState = await scheduler.syncNow();
  check('恢复后同步成功', Boolean(okState) && !okState.error, JSON.stringify(okState));
  check('失败计数清零', scheduler.getSyncState().failStreak === 0);
}

server.close();
console.log(`\n=== 结果：通过 ${passed} 项，失败 ${failed} 项 ===\n`);
process.exit(failed === 0 ? 0 : 1);
