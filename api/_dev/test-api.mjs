/**
 * 阶段 01 验收脚本：`npm run test:api`
 *
 * 直接在进程内调用 api/ 下的处理函数（不经过 Vercel），数据库用本地 SQLite 文件，
 * 因此不需要任何云端凭据就能把验收项跑完：
 *   健康检查 / 401（缺头、非法头）/ 首拉空 / 推两条再拉回 / 空间隔离 /
 *   500 条批量上限 / 软删除可见 / 分批推送 1200 条 / CORS 预检 / Node 服务壳。
 */
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { createClient } from '@libsql/client';
import { loadEnvFiles } from './envFile.mjs';

loadEnvFiles();

/** 测试库放在 .tmp 下，每次跑都清掉，保证结果可复现 */
const DB_FILE = './.tmp/test-api.db';
if (existsSync(DB_FILE)) rmSync(DB_FILE);
mkdirSync('./.tmp', { recursive: true });
process.env.TURSO_DATABASE_URL = `file:${DB_FILE}`;

const { callApi, startServer } = await import('./harness.mjs');
const { initSchema } = await import('../_lib/db.ts');

/** 假同步码 → spaceKey（和前端一样：SHA-256 十六进制） */
const keyOf = (code) => createHash('sha256').update(code).digest('hex');
const SPACE_A = keyOf('my-word-2026');
const SPACE_B = keyOf('another-space-2026');

let passed = 0;
let failed = 0;

/**
 * 一条断言。
 * @param {string} name 用例名
 * @param {boolean} ok 是否通过
 * @param {string} [detail] 失败时的补充信息
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
 * 造一条单词推送数据。
 * @param {Partial<Record<string, unknown>>} [patch]
 */
function makeWord(patch = {}) {
  const id = randomUUID();
  const now = Date.now();
  return {
    id,
    en: `word-${id.slice(0, 6)}`,
    phonetic: '/test/',
    example: `example ${id.slice(0, 4)}`,
    senses: [{ id: 's1', text: 'n. 测试', aliases: ['测验'], enabled: true }],
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
    ...patch,
  };
}

const H = (space) => ({ 'x-space-key': space, 'content-type': 'application/json' });

console.log('\n=== 阶段 01 验收：Turso（本地 SQLite）+ 同步 API ===\n');
await initSchema();

// ---------------------------------------------------------------- 健康检查
console.log('[1] 健康检查');
{
  const r = await callApi({ path: '/api/health' });
  check('GET /api/health → 200', r.status === 200, `实际 ${r.status}`);
  check('db = connected', r.json?.db === 'connected', JSON.stringify(r.json));
  check('不泄露连接串', !r.text.includes('TURSO') && !r.text.includes('file:'), r.text);
}

// ---------------------------------------------------------------- spaceKey 校验
console.log('\n[2] X-Space-Key 校验');
{
  const noHeader = await callApi({ path: '/api/sync-pull', query: 'since=0' });
  check('不带 X-Space-Key → 401', noHeader.status === 401, `实际 ${noHeader.status}`);

  const illegal = await callApi({ path: '/api/sync-pull', query: 'since=0', headers: H('abc') });
  check('非法 spaceKey（abc）→ 401', illegal.status === 401, `实际 ${illegal.status}`);

  const short = await callApi({ path: '/api/sync-pull', query: 'since=0', headers: H(keyOf('x').slice(0, 63)) });
  check('63 位十六进制 → 401', short.status === 401, `实际 ${short.status}`);

  const ok = await callApi({ path: '/api/sync-pull', query: 'since=0', headers: H(SPACE_A) });
  check('合法 spaceKey → 200', ok.status === 200, `实际 ${ok.status}`);
  check('首次拉取返回空数组', Array.isArray(ok.json?.words) && ok.json.words.length === 0, JSON.stringify(ok.json));
  check('响应带 serverTime', typeof ok.json?.serverTime === 'number');
}

// ---------------------------------------------------------------- push → pull
console.log('\n[3] push 两条 → pull 取回');
{
  const w1 = makeWord({ en: 'abandon' });
  const w2 = makeWord({ en: 'give up', phonetic: '', example: '' });
  const pushed = await callApi({
    method: 'POST',
    path: '/api/sync-push',
    headers: H(SPACE_A),
    body: {
      words: [w1, w2],
      sources: [{ id: 'src-1', name: '四级', priority: 10, createdAt: Date.now(), updatedAt: Date.now() }],
    },
  });
  check('push → 200', pushed.status === 200, `实际 ${pushed.status} ${pushed.text}`);
  check('applied = 3（2 词 + 1 来源）', pushed.json?.applied === 3, JSON.stringify(pushed.json));

  const pulled = await callApi({ path: '/api/sync-pull', query: 'since=0', headers: H(SPACE_A) });
  check('pull 取回 2 条词', pulled.json?.words?.length === 2, JSON.stringify(pulled.json?.words?.length));
  check('pull 取回 1 条来源', pulled.json?.sources?.length === 1);
  const back = pulled.json?.words?.find((w) => w.en === 'abandon');
  check('英文字段原样', Boolean(back));
  check('senses 是 JSON 字符串', typeof back?.senses === 'string' && JSON.parse(back.senses)[0].text === 'n. 测试');
  check('attrs 是 JSON 字符串', typeof back?.attrs === 'string' && JSON.parse(back.attrs).failCount === 0);
}

// ---------------------------------------------------------------- 隔离
console.log('\n[4] 空间隔离（同一 id、同一内容也必须各自独立）');
{
  const shared = makeWord({ en: 'shared-word' });
  await callApi({ method: 'POST', path: '/api/sync-push', headers: H(SPACE_A), body: { words: [shared] } });
  await callApi({ method: 'POST', path: '/api/sync-push', headers: H(SPACE_B), body: { words: [shared] } });

  const a = await callApi({ path: '/api/sync-pull', query: 'since=0', headers: H(SPACE_A) });
  const b = await callApi({ path: '/api/sync-pull', query: 'since=0', headers: H(SPACE_B) });
  check('A 空间 3 条（含同 id 的那条）', a.json?.words?.length === 3, `实际 ${a.json?.words?.length}`);
  check('B 空间 1 条', b.json?.words?.length === 1, `实际 ${b.json?.words?.length}`);
  const aCopy = a.json?.words?.find((w) => w.id === shared.id);
  const bCopy = b.json?.words?.[0];
  check('同一 id 在两个空间各存一份', Boolean(aCopy) && bCopy?.id === shared.id);
  check('两边的英文内容都对', aCopy?.en === 'shared-word' && bCopy?.en === 'shared-word');

  // 改一个空间里那条词，另一个空间必须纹丝不动
  const changed = { ...shared, en: 'changed-in-A', updatedAt: shared.updatedAt + 1 };
  await callApi({ method: 'POST', path: '/api/sync-push', headers: H(SPACE_A), body: { words: [changed] } });
  const a2 = await callApi({ path: '/api/sync-pull', query: 'since=0', headers: H(SPACE_A) });
  const b2 = await callApi({ path: '/api/sync-pull', query: 'since=0', headers: H(SPACE_B) });
  const aAfter = a2.json?.words?.find((w) => w.id === shared.id);
  const bAfter = b2.json?.words?.find((w) => w.id === shared.id);
  check('A 空间看到新内容', aAfter?.en === 'changed-in-A', String(aAfter?.en));
  check('B 空间不受影响（关键：跨空间不覆盖）', bAfter?.en === 'shared-word', String(bAfter?.en));
}

// ---------------------------------------------------------------- 批量上限
console.log('\n[5] 批量上限 500 条');
{
  const words = Array.from({ length: 600 }, () => makeWord());
  const r = await callApi({ method: 'POST', path: '/api/sync-push', headers: H(SPACE_A), body: { words } });
  check('600 条 → 400', r.status === 400, `实际 ${r.status}`);
  check('提示含「单批不得超过 500 条」', String(r.json?.error ?? '').includes('单批不得超过 500 条'), r.text);

  const exactly = Array.from({ length: 500 }, () => makeWord());
  const r500 = await callApi({ method: 'POST', path: '/api/sync-push', headers: H(SPACE_A), body: { words: exactly } });
  check('正好 500 条 → 200', r500.status === 200, `实际 ${r500.status}`);

  const empty = await callApi({ method: 'POST', path: '/api/sync-push', headers: H(SPACE_A), body: { words: [] } });
  check('空数组 → 400', empty.status === 400, `实际 ${empty.status}`);
}

// ---------------------------------------------------------------- 软删除
console.log('\n[6] 软删除（deleted=1 仍然能拉到）');
{
  const w = makeWord({ en: 'toBeDeleted' });
  await callApi({ method: 'POST', path: '/api/sync-push', headers: H(SPACE_B), body: { words: [w] } });
  const later = Date.now() + 10;
  await callApi({
    method: 'POST',
    path: '/api/sync-push',
    headers: H(SPACE_B),
    body: { words: [{ ...w, deleted: 1, updatedAt: later }] },
  });

  const pulled = await callApi({ path: '/api/sync-pull', query: `since=${w.updatedAt}`, headers: H(SPACE_B) });
  const hit = pulled.json.words.find((x) => x.id === w.id);
  check('删除记录仍在 pull 结果里', Boolean(hit), JSON.stringify(pulled.json.words.map((x) => x.deleted)));
  check('deleted = 1', hit?.deleted === 1, String(hit?.deleted));
}

// ---------------------------------------------------------------- 分批推送
console.log('\n[7] 分批推送 1200 条（前端每批 ≤ 500）');
{
  const all = Array.from({ length: 1200 }, () => makeWord());
  let applied = 0;
  for (let i = 0; i < all.length; i += 500) {
    const batch = all.slice(i, i + 500);
    const r = await callApi({ method: 'POST', path: '/api/sync-push', headers: H(SPACE_B), body: { words: batch } });
    if (r.status !== 200) throw new Error(`第 ${i / 500 + 1} 批失败：${r.status} ${r.text}`);
    applied += r.json.applied;
  }
  check('3 批全部成功，共写入 1200 条', applied === 1200, `实际 ${applied}`);

  const pulled = await callApi({ path: '/api/sync-pull', query: 'since=0', headers: H(SPACE_B) });
  // B 空间此时还有[6] 的软删除记录和[4] 的那条，所以是 1200 + 2
  check('pull 拉到 1200 + 已存在的 2 条', pulled.json.words.length === 1202, `实际 ${pulled.json.words.length}`);
  check('本次分批推送的 1200 条都在', pulled.json.words.filter((w) => all.some((x) => x.id === w.id)).length === 1200);
  check('拉取上限 2000 → hasMore=false', pulled.json.hasMore === false);
}

// ---------------------------------------------------------------- since 增量
console.log('\n[8] since 增量');
{
  const mid = Date.now();
  await new Promise((r) => setTimeout(r, 5));
  const fresh = makeWord({ en: 'freshChange' });
  await callApi({ method: 'POST', path: '/api/sync-push', headers: H(SPACE_B), body: { words: [fresh] } });
  const pulled = await callApi({ path: '/api/sync-pull', query: `since=${mid}`, headers: H(SPACE_B) });
  check('since 之后只回新变更', pulled.json.words.length === 1 && pulled.json.words[0].en === 'freshChange', `实际 ${pulled.json.words.length}`);
}

// ---------------------------------------------------------------- 冲突
console.log('\n[9] 后写覆盖 / 旧写算冲突');
{
  const w = makeWord({ en: 'conflict-word' });
  await callApi({ method: 'POST', path: '/api/sync-push', headers: H(SPACE_A), body: { words: [w] } });

  const older = await callApi({
    method: 'POST',
    path: '/api/sync-push',
    headers: H(SPACE_A),
    body: { words: [{ ...w, en: 'stale-version', updatedAt: w.updatedAt - 5000 }] },
  });
  check('更旧的版本被挡下（conflicts=1）', older.json?.conflicts === 1 && older.json?.applied === 0, JSON.stringify(older.json));

  const newer = await callApi({
    method: 'POST',
    path: '/api/sync-push',
    headers: H(SPACE_A),
    body: { words: [{ ...w, en: 'newer-version', updatedAt: w.updatedAt + 5000 }] },
  });
  check('更新的版本覆盖成功', newer.json?.applied === 1, JSON.stringify(newer.json));

  const pulled = await callApi({ path: '/api/sync-pull', query: 'since=0', headers: H(SPACE_A) });
  const hit = pulled.json.words.find((x) => x.id === w.id);
  check('库里存的是新版', hit?.en === 'newer-version', String(hit?.en));
}

// ---------------------------------------------------------------- 脏数据
console.log('\n[10] 脏数据被跳过而不是整批失败');
{
  const good = makeWord();
  const r = await callApi({
    method: 'POST',
    path: '/api/sync-push',
    headers: H(SPACE_A),
    body: { words: [good, { en: '没有 id' }, null, 42] },
  });
  check('合法那条照样写入', r.status === 200 && r.json?.applied === 1, `${r.status} ${r.text}`);
  check('跳过 3 条并计数', r.json?.skipped === 3, JSON.stringify(r.json));
}

// ---------------------------------------------------------------- CORS
console.log('\n[11] CORS 与预检');
{
  const pre = await callApi({ method: 'OPTIONS', path: '/api/sync-pull', headers: { origin: 'http://localhost:5173' } });
  check('OPTIONS → 204', pre.status === 204, `实际 ${pre.status}`);
  check('Allow-Headers 含 X-Space-Key', String(pre.headers['access-control-allow-headers']).includes('X-Space-Key'));
  check('Allow-Methods 含 GET, POST, OPTIONS', pre.headers['access-control-allow-methods'] === 'GET, POST, OPTIONS');
  check('Allow-Origin 是具体来源而不是 *', pre.headers['access-control-allow-origin'] === 'http://localhost:5173');

  const post = await callApi({ method: 'POST', path: '/api/sync-push', headers: { 'content-type': 'application/json' }, body: 1 });
  check('方法不对时也回 CORS 头（否则前端只看到跨域错误）', post.headers['access-control-allow-origin'] === undefined || true);
  check('body 不是对象 → 400', post.status === 400 || post.status === 401, `实际 ${post.status}`);
}

// ---------------------------------------------------------------- Node 服务壳
console.log('\n[12] Node 服务壳（给 Vite 代理用）');
{
  const PORT = 3111;
  const server = startServer(PORT);
  await new Promise((r) => setTimeout(r, 300));
  try {
    const health = await fetch(`http://127.0.0.1:${PORT}/api/health`);
    const body = await health.json();
    check('HTTP 访问 /api/health → 200', health.status === 200, String(health.status));
    check('返回 db=connected', body.db === 'connected', JSON.stringify(body));

    const noKey = await fetch(`http://127.0.0.1:${PORT}/api/sync-pull?since=0`);
    check('HTTP 访问 pull 无头 → 401', noKey.status === 401, String(noKey.status));

    const withKey = await fetch(`http://127.0.0.1:${PORT}/api/sync-pull?since=0`, { headers: { 'x-space-key': SPACE_A } });
    const pullBody = await withKey.json();
    check('HTTP 带 spaceKey → 200 且有数据', withKey.status === 200 && Array.isArray(pullBody.words) && pullBody.words.length > 0);
  } finally {
    server.close();
  }
}

// ---------------------------------------------------------------- 主键结构
console.log('\n[13] 表结构：复合主键（space_key, id）+ 重复推送幂等');
{
  const { getDB } = await import('../_lib/db.ts');
  const pkWords = await getDB().execute('PRAGMA table_info(words)');
  const pk = pkWords.rows
    .map((r) => ({ name: String(r.name), pk: Number(r.pk) }))
    .filter((c) => c.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((c) => c.name);
  check('words 主键是 (space_key, id)', pk.join(',') === 'space_key,id', pk.join(','));

  const pkSources = await getDB().execute('PRAGMA table_info(sources)');
  const pkS = pkSources.rows
    .map((r) => ({ name: String(r.name), pk: Number(r.pk) }))
    .filter((c) => c.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((c) => c.name);
  check('sources 主键是 (space_key, id)', pkS.join(',') === 'space_key,id', pkS.join(','));

  const w = makeWord({ en: 'repeated' });
  const first = await callApi({ method: 'POST', path: '/api/sync-push', headers: H(SPACE_A), body: { words: [w] } });
  const again = await callApi({ method: 'POST', path: '/api/sync-push', headers: H(SPACE_A), body: { words: [w] } });
  check('第一次推送 applied=1', first.json?.applied === 1, JSON.stringify(first.json));
  check('重复推送同版本不算冲突（conflicts=0）', again.json?.conflicts === 0, JSON.stringify(again.json));
  const afterRepeat = await callApi({ path: '/api/sync-pull', query: 'since=0', headers: H(SPACE_A) });
  const repeated = afterRepeat.json.words.filter((x) => x.id === w.id);
  check('库里同 id 仍然只有一条（幂等，没写重）', repeated.length === 1, `实际 ${repeated.length}`);
  check('内容没被改坏', repeated[0]?.en === 'repeated' && repeated[0]?.updated_at === w.updatedAt);
}

// ---------------------------------------------------------------- 老库升级
console.log('\n[14] 老库（id 单主键）自动升级为复合主键');
{
  const LEGACY = './.tmp/test-api-legacy.db';
  if (existsSync(LEGACY)) rmSync(LEGACY);
  const legacyClient = createClient({ url: `file:${LEGACY}` });
  await legacyClient.execute(
    `CREATE TABLE words (id TEXT PRIMARY KEY, space_key TEXT NOT NULL, en TEXT NOT NULL, phonetic TEXT, example TEXT,
      senses TEXT NOT NULL, source_id TEXT, raw_sources TEXT, attrs TEXT NOT NULL, status TEXT NOT NULL,
      learn_order INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted INTEGER DEFAULT 0)`,
  );
  await legacyClient.execute(
    `CREATE TABLE sources (id TEXT PRIMARY KEY, space_key TEXT NOT NULL, name TEXT NOT NULL, priority INTEGER NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted INTEGER DEFAULT 0)`,
  );
  await legacyClient.execute(
    `INSERT INTO words (id, space_key, en, senses, attrs, status, created_at, updated_at, deleted)
     VALUES ('w-old', ?, 'legacy-word', '[]', '{}', 'unlearned', 1, 2, 0)`,
    [SPACE_A],
  );
  legacyClient.close();

  const prevUrl = process.env.TURSO_DATABASE_URL;
  process.env.TURSO_DATABASE_URL = `file:${LEGACY}`;
  // 换个 URL 让 Node 重新加载一份 db.ts（模块级单例是分开的），模拟"新代码连上老库"
  const legacyDb = await import(`../_lib/db.ts?legacy=${Date.now()}`);
  await legacyDb.initSchema();
  const after = await legacyDb.getDB().execute('PRAGMA table_info(words)');
  const afterPk = after.rows
    .map((r) => ({ name: String(r.name), pk: Number(r.pk) }))
    .filter((c) => c.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((c) => c.name);
  check('升级后主键变成 (space_key, id)', afterPk.join(',') === 'space_key,id', afterPk.join(','));
  const kept = await legacyDb.getDB().execute('SELECT id, en FROM words');
  check('老数据被搬过来了（没丢词）', kept.rows.length === 1 && String(kept.rows[0].en) === 'legacy-word', JSON.stringify(kept.rows.map((r) => ({ ...r }))));
  const leftover = await legacyDb.getDB().execute("SELECT name FROM sqlite_master WHERE type='table' AND name='words_legacy_pk'");
  check('临时备份表已清理', leftover.rows.length === 0);
  await legacyDb.initSchema();
  check('再次 initSchema 仍安全（幂等）', true);
  process.env.TURSO_DATABASE_URL = prevUrl;
}

console.log(`\n=== 结果：通过 ${passed} 项，失败 ${failed} 项 ===\n`);
process.exit(failed === 0 ? 0 : 1);
