/**
 * 线上接口冒烟测试：`npm run test:live [后端地址]`
 *
 * 为什么单独做一个：本地那几百项自检**全都是直接调用处理函数**的，
 * 完全不经过 URL 匹配和 Vercel 的部署映射，所以「前端请求的路径 ≠ 线上真实路径」
 * 这类问题一个都测不出来——而线上就真的这么炸过一次（/api/sync-pull 应为 /api/sync-pull）。
 *
 * 这个脚本按**真实 URL** 打一遍线上后端，覆盖：
 * 健康检查 / 401 / 非法 spaceKey / 空库拉取 / 推送 / 拉回 / 空间隔离 / 批量上限 / 来源白名单。
 *
 * 用法：
 *   npm run test:live                                    # 默认打 https://blank-sheet-vocab.vercel.app
 *   npm run test:live -- https://你的域名                # 指定后端
 *   npm run test:live -- http://localhost:3000           # 也能打本地后端（npm run api）
 *
 * 注意：会往线上数据库写入一个带前缀的测试词条（`__livecheck__`），跑完会清理。
 */
import { createHash, randomUUID } from 'node:crypto';

/** 后端地址：命令行第一个参数 > 环境变量 > 默认线上地址 */
const base = (process.argv[2] ?? process.env.LIVE_API_BASE ?? 'https://blank-sheet-vocab.vercel.app').replace(/\/+$/, '');

/** 测试用的同步码（用完即弃的空间，不影响你真实数据） */
const CODE_A = '__livecheck__-space-A';
const CODE_B = '__livecheck__-space-B';
const keyA = createHash('sha256').update(CODE_A).digest('hex');
const keyB = createHash('sha256').update(CODE_B).digest('hex');

/** 从 src/dao/syncServer.ts 读路由表，保证测的就是前端真正会请求的路径 */
const ROUTES = await loadRoutes();

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
 * 读前端的 API 路由表，避免这里手写一份又和代码不一致。
 */
async function loadRoutes() {
  const { readFileSync } = await import('node:fs');
  const text = readFileSync(new URL('../../src/dao/syncServer.ts', import.meta.url), 'utf8');
  const block = /export const API_ROUTES = \{([\s\S]*?)\} as const/.exec(text);
  if (!block) throw new Error('读不到 API_ROUTES，无法确定要测哪些路径');
  const out = {};
  for (const m of block[1].matchAll(/(\w+):\s*'([^']+)'/g)) out[m[1]] = m[2];
  return out;
}

/**
 * 发一个请求，返回 { status, text, json, error }。
 *
 * 网络不稳时（连 Vercel 会间歇性超时）**自动重试 3 次**，重试仍失败就返回 error
 * 而不是抛异常——否则一次网络抖动会让整个冒烟测试崩掉，看起来像代码坏了。
 * @param {string} path 路径
 * @param {object} [opts] method / headers / body
 */
async function call(path, opts = {}) {
  let lastError = '';
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25_000);
    try {
      const res = await fetch(`${base}${path}`, {
        method: opts.method ?? 'GET',
        headers: { 'Content-Type': 'application/json', ...(opts.headers ?? {}) },
        body: opts.body,
        signal: controller.signal,
      });
      const text = await res.text();
      let json = null;
      try {
        json = text === '' ? null : JSON.parse(text);
      } catch {
        json = null;
      }
      return { status: res.status, text, json, error: '' };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (attempt < 3) {
        console.log(`    （第 ${attempt} 次请求失败：${lastError}，2 秒后重试）`);
        await new Promise((r) => setTimeout(r, 2000));
      }
    } finally {
      clearTimeout(timer);
    }
  }
  return { status: 0, text: '', json: null, error: lastError };
}

console.log(`\n=== 线上接口冒烟测试：${base} ===\n`);
console.log(`路由表（来自 src/dao/syncServer.ts）：${JSON.stringify(ROUTES)}\n`);

// ─────────────────────────────── 0. 先确认连得上（连不上就别继续，免得刷一堆假失败）
{
  const probe = await call(ROUTES.health);
  if (probe.status === 0) {
    console.log(`✗ 连不上 ${base}：${probe.error}`);
    console.log('  可能原因：本机到 Vercel 的网络不稳（已重试 3 次）、域名写错、或部署还没起来。');
    console.log('  稍后再跑一次即可：npm run test:live\n');
    process.exit(2);
  }
}

// ─────────────────────────────── 1. 路由是否存在（最容易错的一步）
console.log('[1] 路由可达性：路径写错会直接 404');
{
  for (const [name, path] of Object.entries(ROUTES)) {
    if (name === 'aiProxy') continue; // 需要 POST，单独测
    const res = await call(`${path}${name === 'syncPull' ? '?since=0' : ''}`, {
      headers: { 'X-Space-Key': keyA },
    });
    check(
      `${name.padEnd(11)} ${path} 不是 404`,
      res.status !== 404,
      `返回 404 —— 路径可能写错了（Vercel 按文件名映射，连字符不是斜杠）`,
    );
  }
}

// ─────────────────────────────── 2. 健康检查
console.log('\n[2] 健康检查');
{
  const res = await call(ROUTES.health);
  check(`${ROUTES.health} → 200`, res.status === 200, `实际 ${res.status}`);
  check('db = connected（数据库连通）', res.json?.db === 'connected', JSON.stringify(res.json));
  check('不泄露连接串', !res.text.includes('TURSO') && !res.text.includes('libsql'), res.text.slice(0, 120));
}

// ─────────────────────────────── 3. spaceKey 校验
console.log('\n[3] X-Space-Key 校验');
{
  const noKey = await call(`${ROUTES.syncPull}?since=0`);
  check('不带 spaceKey → 401', noKey.status === 401, `实际 ${noKey.status}`);

  const badKey = await call(`${ROUTES.syncPull}?since=0`, { headers: { 'X-Space-Key': 'abc' } });
  check('非法 spaceKey → 401', badKey.status === 401, `实际 ${badKey.status}`);

  const ok = await call(`${ROUTES.syncPull}?since=0`, { headers: { 'X-Space-Key': keyA } });
  check('合法 spaceKey → 200', ok.status === 200, `实际 ${ok.status} ${ok.text.slice(0, 120)}`);
  check('返回结构含 words / sources / serverTime', Array.isArray(ok.json?.words) && typeof ok.json?.serverTime === 'number');
}

// ─────────────────────────────── 4. push → pull
console.log('\n[4] 推送 → 拉回（端到端）');
const marker = `__livecheck__${randomUUID().slice(0, 8)}`;
{
  const now = Date.now();
  const word = {
    id: marker,
    en: marker,
    phonetic: '/test/',
    example: 'live smoke test',
    senses: [{ id: 's1', text: 'n. 冒烟测试', aliases: [], enabled: true }],
    sourceId: '',
    rawSources: [],
    attrs: { needSpell: false, failCount: 0, failCountTotal: 0, reviewCount: 0, lastReviewAt: null, learnedAt: null, reviewPriority: 0 },
    status: 'unlearned',
    learnOrder: null,
    createdAt: now,
    updatedAt: now,
    deleted: 0,
  };

  const pushed = await call(ROUTES.syncPush, {
    method: 'POST',
    headers: { 'X-Space-Key': keyA },
    body: JSON.stringify({ words: [word] }),
  });
  check(`push → 200（期望 applied=1）`, pushed.status === 200 && pushed.json?.applied === 1, `${pushed.status} ${pushed.text}`);

  const pulled = await call(`${ROUTES.syncPull}?since=0`, { headers: { 'X-Space-Key': keyA } });
  const hit = pulled.json?.words?.find((w) => w.id === marker);
  check('pull 能取回刚推的词', Boolean(hit), `words=${pulled.json?.words?.length}`);
  check('JSON 字段完整（senses / attrs 可解析）', typeof hit?.senses === 'string' && JSON.parse(hit.senses)[0].text === 'n. 冒烟测试');

  // 空间隔离
  const other = await call(`${ROUTES.syncPull}?since=0`, { headers: { 'X-Space-Key': keyB } });
  check('另一个 spaceKey 拉不到这条（隔离生效）', !other.json?.words?.some((w) => w.id === marker), `words=${other.json?.words?.length}`);
}

// ─────────────────────────────── 5. 批量上限
console.log('\n[5] 批量上限 500 条');
{
  const now = Date.now();
  const words = Array.from({ length: 501 }, (_, i) => ({
    id: `${marker}-bulk-${i}`,
    en: `bulk${i}`,
    phonetic: '',
    example: '',
    senses: [],
    sourceId: '',
    rawSources: [],
    attrs: {},
    status: 'unlearned',
    learnOrder: null,
    createdAt: now,
    updatedAt: now,
    deleted: 0,
  }));
  const res = await call(ROUTES.syncPush, {
    method: 'POST',
    headers: { 'X-Space-Key': keyA },
    body: JSON.stringify({ words }),
  });
  check('501 条 → 400', res.status === 400, `实际 ${res.status}`);
  check('提示含「单批不得超过 500 条」', String(res.json?.error ?? '').includes('500'), res.text.slice(0, 160));
}

// ─────────────────────────────── 6. 来源白名单
console.log('\n[6] AI 代理来源白名单');
{
  const res = await call(ROUTES.aiProxy, {
    method: 'POST',
    headers: {
      Origin: 'https://evil.example.com',
      'X-Target-Url': 'https://api.deepseek.com/chat/completions',
      Authorization: 'Bearer sk-fake-live-check',
    },
    body: '{}',
  });
  check('非白名单来源 → 403', res.status === 403, `实际 ${res.status} ${res.text.slice(0, 120)}`);
}

// ─────────────────────────────── 7. 清理
console.log('\n[7] 清理测试数据');
{
  const res = await call(ROUTES.syncPurge, {
    method: 'POST',
    headers: { 'X-Space-Key': keyA },
    body: JSON.stringify({ confirm: 'DELETE' }),
  });
  check('清空 A 空间测试数据 → 200', res.status === 200, `实际 ${res.status} ${res.text.slice(0, 120)}`);

  const after = await call(`${ROUTES.syncPull}?since=0`, { headers: { 'X-Space-Key': keyA } });
  check('清理后 A 空间为空', after.json?.words?.length === 0, `words=${after.json?.words?.length}`);
}

console.log(`\n=== 结果：通过 ${passed} 项，失败 ${failed} 项 ===\n`);
process.exit(failed === 0 ? 0 : 1);
