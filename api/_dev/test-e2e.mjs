/**
 * 模拟真实用户在设置页的操作：测试连接 → 立即同步 → 多设备 → 断网容错。
 *
 * 这个脚本走的是**前端真正用的那条代码路径**（import src/dao/cloudSync.ts），
 * 只把浏览器环境（IndexedDB / localStorage）用替身补上，然后真的打线上后端。
 *
 * 用法：
 *   npm run test:e2e                                  # 对线上后端跑
 *   npm run test:e2e -- http://localhost:3000         # 对本地后端跑
 *
 * 说明：用的是一个专门的测试同步码，跑完会把云端测试数据清掉，不影响你的真实数据。
 */
import './envFile.mjs'; // 静态导入：注册 TS 加载钩子（.js→.ts 映射、无后缀补全）
import 'fake-indexeddb/auto';

/** 后端地址 */
const base = (process.argv[2] ?? process.env.E2E_API_BASE ?? 'https://blank-sheet-vocab.vercel.app').replace(/\/+$/, '');

/** 测试用的同步码（独立空间，用完清理） */
const TEST_CODE = 'e2e-check-2026';
const OTHER_CODE = 'e2e-check-other-2026';

// ── 补浏览器环境（必须在 import src 之前）──
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
// crypto 用 Node 自带的（19+ 已有 globalThis.crypto.subtle，无需注入）

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
 * 造一个词。
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
    sourceId: '',
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

console.log(`\n=== 模拟真实用户操作：${base} ===\n`);

// ─────────────────────────── 0. 先清一个干净的开始
// （fake-indexeddb 是进程内的，同一次运行内没问题，但要防止脚本被重复调用时残留数据）
await syncData.clearAllLocal();
await dao.settings.set({
  cloud: { enabled: false, apiBase: '', syncCode: '', lastSyncAt: 0, lastPushAt: 0, lastError: '' },
});
check('起始状态：本地库为空', (await dao.words.getAll()).length === 0);
console.log('');

// ─────────────────────────── 1. 设置页「测试连接」
console.log('[1] 设置页 → 「测试连接」');
{
  const res = await cloudSync.testConnection(base);
  check('测试连接成功（绿字）', res.ok === true, res.message);
  check('提示里说明数据库正常', res.message.includes('数据库正常'), res.message);

  const bad = await cloudSync.testConnection('http://127.0.0.1:9');
  check('错误地址返回失败而不是抛异常', bad.ok === false, bad.message);
}

// ─────────────────────────── 2. 填同步码 → 首次同步（本地推到云端）
console.log('\n[2] 填后端地址 + 同步码 → 「立即同步」（本机词库推到云端）');
{
  await dao.settings.set({
    cloud: { enabled: true, apiBase: base, syncCode: TEST_CODE, autoSync: true, lastSyncAt: 0, lastPushAt: 0 },
  });

  const words = [makeWord('apple'), makeWord('banana'), makeWord('cherry')];
  await dao.words.bulkUpsert(words);

  const res = await cloudSync.syncOnce();
  check('同步没有报错', !res.error, JSON.stringify(res));
  check('推送了 3 条', res.pushed === 3, JSON.stringify(res));

  const settings = await dao.settings.get();
  check('lastSyncAt 已更新（设置页会显示「x 分钟前」）', settings.cloud.lastSyncAt > 0);
  check('没有残留错误信息', settings.cloud.lastError === '', settings.cloud.lastError);
}

// ─────────────────────────── 3. 「换设备」：清空本地再拉回
console.log('\n[3] 换设备：另一个浏览器填同一个同步码 → 拉到同一份数据');
{
  await syncData.clearAllLocal();
  await dao.settings.set({ cloud: { lastSyncAt: 0, lastPushAt: 0, lastError: '' } });
  check('新设备本地是空的', (await dao.words.listAlive()).length === 0);

  const res = await cloudSync.syncOnce();
  check('同步没有报错', !res.error, JSON.stringify(res));
  check('拉到了 3 条', res.pulled === 3, JSON.stringify(res));

  const words = await dao.words.listAlive();
  check('本地已有那 3 个词', words.length === 3, `实际 ${words.length}`);
  check('义项与属性完整', words[0].senses.length === 1 && words[0].attrs.failCount === 0);
}

// ─────────────────────────── 4. 增量：改一个词，另一台设备能看到
console.log('\n[4] 增量同步：改一个词 → 云端更新 → 别的设备拉得到');
{
  const target = (await dao.words.listAlive())[0];
  await new Promise((r) => setTimeout(r, 5));
  await dao.words.updateAttrs(target.id, { failCount: 2, needSpell: true });

  const push = await cloudSync.syncOnce();
  check('推送了 1 条改动', push.pushed === 1, JSON.stringify(push));

  // 模拟另一台设备：版本退回去
  const stale = (await dao.words.getAll()).map((w) =>
    w.id === target.id ? { ...w, updatedAt: 1, attrs: { ...w.attrs, failCount: 0 } } : w,
  );
  await syncData.applyRemoteWords(stale);
  await dao.settings.set({ cloud: { lastSyncAt: 0 } });

  const pull = await cloudSync.syncOnce();
  const updated = await dao.words.getById(target.id);
  check('另一台设备拉到了更新', pull.pulled >= 1, JSON.stringify(pull));
  check('新版本生效（failCount=2）', updated?.attrs.failCount === 2, JSON.stringify(updated?.attrs));
}

// ─────────────────────────── 5. 隔离：换同步码看不到旧数据
console.log('\n[5] 换同步码 = 换空间（隔离）');
{
  // 用一个「全新同步码 + 空本地库」模拟新用户，确认拉不到别人的数据
  await syncData.clearAllLocal();
  await dao.settings.set({ cloud: { syncCode: OTHER_CODE, lastSyncAt: 0, lastPushAt: 0, lastError: '' } });

  const fresh = await cloudSync.syncOnce();
  check('新空间同步没有报错', !fresh.error, JSON.stringify(fresh));
  check('新空间拉不到任何数据', fresh.pulled === 0, JSON.stringify(fresh));
  check('新空间本地仍为空', (await dao.words.listAlive()).length === 0);

  // 回到原同步码：数据应该还在（说明两个空间互不影响）
  await dao.settings.set({ cloud: { syncCode: TEST_CODE, lastSyncAt: 0, lastPushAt: 0, lastError: '' } });
  const back = await cloudSync.syncOnce();
  check('切回原同步码能拉到数据', back.pulled >= 3, JSON.stringify(back));
  check('原空间的 3 个词都还在', (await dao.words.listAlive()).length >= 3);
}

// ─────────────────────────── 6. 断网：不阻断使用
console.log('\n[6] 后端挂掉 → 同步失败但本地功能照常');
{
  await dao.settings.set({ cloud: { apiBase: 'http://127.0.0.1:9', lastError: '' } });
  const res = await cloudSync.syncOnce();
  check('返回失败而不是抛异常', typeof res.error === 'string' && res.error !== '', JSON.stringify(res));

  const settings = await dao.settings.get();
  check('失败原因被记下（设置页可见）', settings.cloud.lastError !== '');

  const w = makeWord('offline-word');
  await dao.words.bulkUpsert([w]);
  await dao.words.updateAttrs(w.id, { needSpell: true });
  await dao.words.chop(w.id);
  const after = await dao.words.getById(w.id);
  check('断网时录入/改属性/斩词都正常', after?.status === 'chopped' && after.attrs.needSpell === true);

  await dao.settings.set({ cloud: { apiBase: base } });
  const ok = await cloudSync.syncOnce();
  check('恢复后同步成功', !ok.error, JSON.stringify(ok));
}

// ─────────────────────────── 7. 清理云端测试数据
console.log('\n[7] 清理测试数据（两个测试空间）');
{
  for (const code of [TEST_CODE, OTHER_CODE]) {
    await dao.settings.set({ cloud: { syncCode: code, lastSyncAt: 0, lastPushAt: 0 } });
    const cleared = await cloudSync.clearCloud();
    check(`清空 ${code} 的云端数据`, cleared.ok === true, cleared.error ?? '');

    // 清空后再拉一次：应该什么都拉不到（通过 API 验证，不直连数据库）
    await dao.settings.set({ cloud: { lastSyncAt: 0, lastPushAt: 0 } });
    await syncData.clearAllLocal();
    const after = await cloudSync.syncOnce();
    check(`${code} 清空后云端确实为空`, after.pulled === 0, JSON.stringify(after));
  }
}

console.log(`\n=== 结果：通过 ${passed} 项，失败 ${failed} 项 ===\n`);
process.exit(failed === 0 ? 0 : 1);
