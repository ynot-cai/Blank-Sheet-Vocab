/**
 * 「库的版本号比代码新」自检（版本 0.0.26）：`npm run test:dbversion`
 *
 * 背景：用户报「数据库打不开：The requested version (11) is less than the existing version (12)」。
 * 根因是缺表自愈（repairUpgrade）当年把库抬到了 N+1，而下一次正常打开还在请求 N。
 *
 * 这里用 fake-indexeddb 复现三种局面，确认 openDB 都能自己恢复：
 *   [1] 全新库 → 正常建成 v11（回归）
 *   [2] 库已经是 v12（表齐）→ 不许抛错，直接可用
 *   [3] 库是 v12 但缺一张表 → 自动抬到 v13 并补上
 *   [4] repairUpgrade() 不指定版本时，也不会请求比库里更低的版本
 *
 * 用法：node --import ./api/_dev/loader-register.mjs api/_dev/test-dbversion.mjs
 */
import 'fake-indexeddb/auto';

/** dbOpen / dbSchema 用到的全局 */
globalThis.window = globalThis;

const { DB_NAME, STORE, DB_VERSION } = await import('../../src/core/dbSchema.ts');
const { openDB, repairUpgrade, releaseConnections } = await import('../../src/core/dbOpen.ts');

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`);
  }
}

/** 删库（先把连接放开） */
function dropDb() {
  releaseConnections();
  return new Promise((res) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => res(true);
    req.onerror = () => res(false);
    req.onblocked = () => res(false);
  });
}

/** 直接建一个指定版本、指定表集合的库（模拟「浏览器里已经是这个版本」） */
function makeDbAt(version, stores) {
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, version);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of stores) {
        const keyPath = name === 'settings' || name === 'ttsCache' ? 'key' : 'id';
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath });
      }
    };
    req.onsuccess = () => {
      req.result.close();
      res(true);
    };
    req.onerror = () => rej(req.error ?? new Error('建库失败'));
  });
}

const ALL = Object.values(STORE);

// ─────────────────────────── [1] 全新库
console.log('\n[1] 全新库：正常建成代码声明的版本');
await dropDb();
{
  const db = await openDB();
  check('★ 打开成功', Boolean(db) && db.version === DB_VERSION, `v${db?.version}`);
  const missing = ALL.filter((s) => !db.objectStoreNames.contains(s));
  check('★ 表齐全（含 spellRecords / cardFavorites）', missing.length === 0, missing.join('、'));
  db.close();
}

// ─────────────────────────── [2] 库比代码新（表齐）
console.log('\n[2] 库已经是 v12 且表齐：不许抛「版本比库低」');
releaseConnections();
await dropDb();
await makeDbAt(DB_VERSION + 1, ALL);
{
  let err = null;
  let db = null;
  try {
    db = await openDB();
  } catch (e) {
    err = e;
  }
  check('★ 不再抛 VersionError', err === null, err === null ? '' : String(err?.message ?? err));
  check('★ 连接可用且版本是 v12', Boolean(db) && db.version === DB_VERSION + 1, `v${db?.version}`);
  check('★ 表仍然齐全', db ? ALL.every((s) => db.objectStoreNames.contains(s)) : false);
  db?.close();
}

// ─────────────────────────── [3] 库比代码新且缺表
console.log('\n[3] 库是 v12 但缺一张表：自动抬版本补齐');
releaseConnections();
await dropDb();
await makeDbAt(DB_VERSION + 1, ALL.filter((s) => s !== STORE.spellRecords));
{
  const db = await openDB();
  check('★ 打开成功', Boolean(db), '');
  check('★ 缺的表被补上', db.objectStoreNames.contains(STORE.spellRecords) === true);
  check('★ 版本被抬到 v13（现有 + 1）', db.version === DB_VERSION + 2, `v${db.version}`);
  check('其它表一个没少', ALL.every((s) => db.objectStoreNames.contains(s)));
  db.close();
}

// ─────────────────────────── [4] repairUpgrade 的目标版本
console.log('\n[4] repairUpgrade()：目标版本永远高于库里现有版本');
releaseConnections();
await dropDb();
await makeDbAt(DB_VERSION + 2, ALL);
{
  let err = null;
  let db = null;
  try {
    db = await repairUpgrade();
  } catch (e) {
    err = e;
  }
  check('不指定目标版本也能修（先读现有版本再 +1）', err === null, err === null ? '' : String(err?.message ?? err));
  check('★ 版本变成「现有 + 1」= v14', Boolean(db) && db.version === DB_VERSION + 3, `v${db?.version}`);
  check('所有表都在', db ? ALL.every((s) => db.objectStoreNames.contains(s)) : false);
  db?.close();
}

// ─────────────────────────── [5] 修完之后下次打开还正常
console.log('\n[5] 修完再打开一次：不应再报错');
{
  releaseConnections();
  const db = await openDB();
  check('★ 再次打开成功', Boolean(db));
  check('版本保持在修复后的值', db.version === DB_VERSION + 3, `v${db.version}`);
  db.close();
}

console.log(`\n库版本自检：${passed} 项通过，${failed} 项失败`);
if (failed > 0) process.exit(1);
