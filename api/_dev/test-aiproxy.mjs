/**
 * 阶段 03 验收脚本：`npm run test:ai`
 *
 * 验证无状态 AI 代理 api/ai-proxy.ts 的每一条要求：
 * 来源白名单 / 目标校验 / 上游主机白名单 / Authorization 转发 / 流式透传 /
 * 错误透传 / **无状态**（不连数据库、日志里搜不到密钥、不缓存、不回显请求头）。
 *
 * 上游用一个本地 http 假服务：代理默认只允许 https，但**白名单里的主机允许 http**
 * （这条例外就是为本地开发与自动化测试留的），所以测试里把 127.0.0.1 放进白名单，
 * 这样测到的是真实的转发链路，而不是一个被砍掉的分支。
 */
import { createServer } from 'node:http';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { loadEnvFiles } from './envFile.mjs';

loadEnvFiles('..');

// 测试环境：白名单来源 + 允许本地假上游
process.env.ALLOWED_ORIGIN = 'http://localhost:5173';
process.env.AI_ALLOWED_HOSTS = '127.0.0.1';

const { callApi } = await import('./harness.mjs');

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

/** 测试用的假密钥：故意做成「一眼假」，同时保证它绝不出现在日志里 */
const FAKE_KEY = 'sk-fake-test-key-DO-NOT-LOG-abc123';
/** 第二把假密钥，用来验证「换了把密钥也不会漏进日志」 */
const FAKE_KEY_2 = 'Bearer sk-another-fake-key-xyz789';

/** 上游收到的请求（供断言用） */
const received = [];

/**
 * 起一个假的「上游 AI 服务」。
 */
async function startFakeUpstream() {
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      received.push({ url: req.url, headers: req.headers, body });

      if (req.url === '/sse') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        res.write('data: {"delta":"你"}\n\n');
        setTimeout(() => {
          res.write('data: {"delta":"好"}\n\n');
          res.end('data: [DONE]\n\n');
        }, 60);
        return;
      }
      if (req.url === '/unauthorized') {
        res.writeHead(401, { 'Content-Type': 'application/json', 'Set-Cookie': 'sid=should-not-pass' });
        res.end(JSON.stringify({ error: { message: 'Invalid API key' } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [{ message: { content: '你好，我是假上游' } }],
          echoAuth: req.headers.authorization === `Bearer ${FAKE_KEY}`,
        }),
      );
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

console.log('\n=== 阶段 03 验收：无状态 AI 代理 ===\n');
const upstream = await startFakeUpstream();
const ORIGIN = { origin: 'http://localhost:5173' };
const TARGET = (path, origin = ORIGIN) => ({
  ...origin,
  'x-target-url': `${upstream.base}${path}`,
  authorization: `Bearer ${FAKE_KEY}`,
});

// ─────────────────────────────────────────── 1. 来源校验
console.log('[1] 来源白名单（防止别人白用你的代理）');
{
  const bad = await callApi({
    method: 'POST',
    path: '/api/ai-proxy',
    headers: { origin: 'https://evil.example.com', 'x-target-url': `${upstream.base}/v1/chat/completions`, authorization: `Bearer ${FAKE_KEY}` },
    body: { hello: 1 },
  });
  check('非白名单来源 → 403', bad.status === 403, `实际 ${bad.status} ${bad.text}`);
  check('403 也带 CORS 头（前端能看见原因）', bad.headers['access-control-allow-origin'] === 'https://evil.example.com');
  check('403 时上游一次都没被调用', received.length === 0);

  const refererOnly = await callApi({
    method: 'POST',
    path: '/api/ai-proxy',
    headers: { referer: 'http://localhost:5173/#/import', 'x-target-url': `${upstream.base}/v1/chat/completions`, authorization: `Bearer ${FAKE_KEY}` },
    body: { hello: 1 },
  });
  check('只有 Referer 也认（按来源判定）', refererOnly.status === 200, `实际 ${refererOnly.status} ${refererOnly.text}`);

  const noOrigin = await callApi({
    method: 'POST',
    path: '/api/ai-proxy',
    headers: { 'x-target-url': `${upstream.base}/v1/chat/completions`, authorization: `Bearer ${FAKE_KEY}` },
    body: { hello: 1 },
  });
  check('没有来源（curl / 服务端调用）放行', noOrigin.status === 200, `实际 ${noOrigin.status}`);
}

// ─────────────────────────────────────────── 2. 目标校验
console.log('\n[2] X-Target-Url 校验');
{
  const missing = await callApi({ method: 'POST', path: '/api/ai-proxy', headers: { ...ORIGIN, authorization: `Bearer ${FAKE_KEY}` }, body: {} });
  check('缺少 X-Target-Url → 400', missing.status === 400, `实际 ${missing.status}`);

  const garbage = await callApi({ method: 'POST', path: '/api/ai-proxy', headers: { ...ORIGIN, 'x-target-url': 'not-a-url', authorization: `Bearer ${FAKE_KEY}` }, body: {} });
  check('非法 URL → 400', garbage.status === 400, `实际 ${garbage.status}`);

  const notAllowedHost = await callApi({
    method: 'POST',
    path: '/api/ai-proxy',
    headers: { ...ORIGIN, 'x-target-url': 'http://evil.internal/steal', authorization: `Bearer ${FAKE_KEY}` },
    body: {},
  });
  check('非白名单主机 → 403（防 SSRF）', notAllowedHost.status === 403, `实际 ${notAllowedHost.status} ${notAllowedHost.text}`);

  const noKey = await callApi({ method: 'POST', path: '/api/ai-proxy', headers: { ...ORIGIN, 'x-target-url': `${upstream.base}/v1/chat/completions` }, body: {} });
  check('没带 Authorization → 400', noKey.status === 400, `实际 ${noKey.status}`);

  const wrongMethod = await callApi({ method: 'GET', path: '/api/ai-proxy', headers: ORIGIN });
  check('GET → 405', wrongMethod.status === 405, `实际 ${wrongMethod.status}`);

  const pre = await callApi({ method: 'OPTIONS', path: '/api/ai-proxy', headers: ORIGIN });
  check('OPTIONS 预检 → 204', pre.status === 204, `实际 ${pre.status}`);
  check('Allow-Headers 含 X-Target-Url', String(pre.headers['access-control-allow-headers']).includes('X-Target-Url'));
}

// ─────────────────────────────────────────── 3. 正常转发
console.log('\n[3] 正常转发（密钥原样送到上游）');
{
  received.length = 0;
  const ok = await callApi({
    method: 'POST',
    path: '/api/ai-proxy',
    headers: TARGET('/v1/chat/completions'),
    body: { model: 'deepseek-chat', messages: [{ role: 'user', content: '你好' }], stream: false },
  });
  check('上游 200 → 代理 200', ok.status === 200, `实际 ${ok.status} ${ok.text}`);
  check('响应体原样透传', ok.json?.choices?.[0]?.message?.content === '你好，我是假上游', ok.text);
  check('上游确实收到了那把密钥（假上游回显校验通过）', ok.json?.echoAuth === true);
  check('响应带 no-store（不缓存）', String(ok.headers['cache-control']).includes('no-store'), String(ok.headers['cache-control']));
  check('响应带 CORS 头', ok.headers['access-control-allow-origin'] === 'http://localhost:5173');

  const got = received[0];
  check('body 原样转发', got.body.includes('deepseek-chat') && got.body.includes('你好'), got.body);
  check('Authorization 原样转发（不解析、不改写）', got.headers.authorization === `Bearer ${FAKE_KEY}`);
  check('没有把 origin 转发给上游', got.headers.origin === undefined, String(got.headers.origin));
  check('没有把 cookie 转发给上游', got.headers.cookie === undefined, String(got.headers.cookie));
  check('没有把 X-Target-Url 转发给上游', got.headers['x-target-url'] === undefined);
  check('没有把 x-forwarded-* 转发给上游', got.headers['x-forwarded-for'] === undefined);
  check('Content-Type 保留为 JSON', String(got.headers['content-type']).includes('application/json'), String(got.headers['content-type']));
}

// ─────────────────────────────────────────── 4. 错误透传
console.log('\n[4] 上游错误原样透传（前端能看到 401）');
{
  const bad = await callApi({ method: 'POST', path: '/api/ai-proxy', headers: TARGET('/unauthorized'), body: { model: 'x', messages: [] } });
  check('上游 401 → 代理也是 401', bad.status === 401, `实际 ${bad.status}`);
  check('401 详情原样透传', String(bad.json?.error?.message).includes('Invalid API key'), bad.text);
  check('上游 set-cookie 被剥掉', bad.headers['set-cookie'] === undefined, String(bad.headers['set-cookie']));
}

// ─────────────────────────────────────────── 5. 流式透传
console.log('\n[5] 流式（SSE）透传，不缓冲成一次性返回');
{
  const sse = await callApi({ method: 'POST', path: '/api/ai-proxy', headers: TARGET('/sse'), body: { model: 'x', messages: [], stream: true } });
  check('状态 200', sse.status === 200, `实际 ${sse.status}`);
  check('Content-Type 保持 text/event-stream', String(sse.headers['content-type']).includes('text/event-stream'), String(sse.headers['content-type']));
  check('三个数据块都在（含 [DONE]）', sse.text.includes('"你"') && sse.text.includes('"好"') && sse.text.includes('[DONE]'), sse.text);
  check('没有额外包装成 JSON', !sse.text.startsWith('{'), sse.text.slice(0, 40));
}

// ─────────────────────────────────────────── 6. 无状态验证（代码层）
console.log('\n[6] 无状态验证：代码层');
{
  const src = readFileSync(new URL('../ai-proxy.ts', import.meta.url), 'utf8');
  // 注意：注释里会特意写明「本文件不 import db」，所以这里匹配的是**真的 import 语句**
  const importLines = src
    .split('\n')
    .filter((l) => /^\s*import\b/.test(l))
    .join('\n');
  check('import 里没有数据库模块', !/db\.ts|inventory|getDB/.test(importLines), importLines);
  check('没有写文件的代码', !src.includes('writeFile') && !src.includes('createWriteStream'));
  check(
    '没有把密钥存进变量的逻辑',
    !/(let|const|var)\s+\w*(apiKey|secret|bearer)\w*\s*=/i.test(src),
  );
  check(
    'authorization 只用于当次转发（先读出、用完即弃）',
    src.split('\n').filter((l) => /authorization/i.test(l) && /(let|const|var)\s/.test(l)).length <= 1,
  );
  check('有 no-store 头', src.includes('no-store'));
  check('有来源校验', src.includes('isOriginAllowed'));
  check('有 https 校验', src.includes("url.protocol === 'https:'"));
  check('有上游主机白名单', src.includes('hostAllowed'));

  const logLines = src
    .split('\n')
    .filter((l) => /console\.(log|info|warn|error)/.test(l))
    .join('\n');
  check('日志行里不出现 authorization / key / token / body', !/authorization|\bkey\b|token|\bbody\b/i.test(logLines), logLines);
}

// ─────────────────────────────────────────── 7. 无状态验证（运行层）
console.log('\n[7] 无状态验证：运行层（日志里搜不到密钥）');
{
  const captured = [];
  const methods = ['log', 'info', 'warn', 'error'];
  const originals = {};
  for (const m of methods) {
    originals[m] = console[m];
    console[m] = (...args) => captured.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  }

  try {
    await callApi({
      method: 'POST',
      path: '/api/ai-proxy',
      headers: TARGET('/v1/chat/completions'),
      body: { model: 'x', messages: [{ role: 'user', content: '这次日志里不该出现密钥' }] },
    });
    await callApi({
      method: 'POST',
      path: '/api/ai-proxy',
      headers: { ...ORIGIN, 'x-target-url': `${upstream.base}/v1/chat/completions`, authorization: FAKE_KEY_2 },
      body: { model: 'x', messages: [] },
    });
  } finally {
    for (const m of methods) console[m] = originals[m];
  }

  const joined = captured.join('\n');
  check('确实有日志输出（说明断言有意义）', joined.length > 0, `${captured.length} 行`);
  check('日志里搜不到第一把密钥', !joined.includes(FAKE_KEY), joined.slice(0, 300));
  check('日志里搜不到第二把密钥', !joined.includes('sk-another-fake-key-xyz789'), joined.slice(0, 300));
  check('日志里搜不到 "Bearer"', !joined.includes('Bearer'), joined.slice(0, 300));
  check('日志里搜不到请求正文', !joined.includes('这次日志里不该出现密钥'), joined.slice(0, 300));
  check('日志只打了转发次数与上游状态', /第 \d+ 次转发/.test(joined), joined.slice(0, 200));
}

// ─────────────────────────────────────────── 8. 数据库层面
console.log('\n[8] 无状态验证：数据库层（代理根本不碰数据库）');
{
  const prev = process.env.TURSO_DATABASE_URL;
  const probeDb = './.tmp/should-never-be-created.db';
  process.env.TURSO_DATABASE_URL = `file:${probeDb}`;
  try {
    const res = await callApi({ method: 'POST', path: '/api/ai-proxy', headers: TARGET('/v1/chat/completions'), body: { model: 'x', messages: [] } });
    check('数据库地址指向不存在的库也照样能转发', res.status === 200, `实际 ${res.status} ${res.text}`);
    check('代理没有创建任何数据库文件', !existsSync(probeDb));
  } finally {
    process.env.TURSO_DATABASE_URL = prev;
  }

  const files = readdirSync(new URL('..', import.meta.url), { recursive: true })
    .map((f) => String(f))
    .filter((f) => f.endsWith('.ts'));
  let keyish = '';
  for (const f of files) {
    if (f.startsWith('_dev')) continue;
    const text = readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
    if (/CREATE TABLE[^;]*(api_key|apikey|secret|token)/i.test(text)) keyish += `${f} `;
  }
  check('api/ 里没有任何存密钥的表', keyish === '', keyish);
}

// ─────────────────────────────────────────── 9. 本地 API 壳的流式转发
console.log('\n[9] 本地 API 壳（Node HTTP）也要能流式转发');
{
  const { startServer } = await import('./harness.mjs');
  const PORT = 3151;
  const local = startServer(PORT);
  await new Promise((r) => setTimeout(r, 200));
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/ai-proxy`, {
      method: 'POST',
      headers: {
        origin: 'http://localhost:5173',
        'content-type': 'application/json',
        'x-target-url': `${upstream.base}/sse`,
        authorization: `Bearer ${FAKE_KEY}`,
      },
      body: JSON.stringify({ stream: true }),
    });
    const text = await res.text();
    check('本地壳返回 200', res.status === 200, String(res.status));
    check('SSE 内容完整', text.includes('[DONE]') && text.includes('"你"'), text.slice(0, 80));
    check('Content-Type 是 event-stream', String(res.headers.get('content-type')).includes('text/event-stream'));
  } finally {
    local.close();
  }
}

// ─────────────────────────────────────────── 10. https 默认要求
console.log('\n[10] 默认只允许 https');
{
  const prevHosts = process.env.AI_ALLOWED_HOSTS;
  process.env.AI_ALLOWED_HOSTS = 'api.deepseek.com';
  try {
    const res = await callApi({
      method: 'POST',
      path: '/api/ai-proxy',
      headers: { ...ORIGIN, 'x-target-url': `${upstream.base}/v1/chat/completions`, authorization: `Bearer ${FAKE_KEY}` },
      body: {},
    });
    check('白名单不含本地时，明文 http 目标被拒', res.status === 400 || res.status === 403, `实际 ${res.status} ${res.text}`);
  } finally {
    process.env.AI_ALLOWED_HOSTS = prevHosts;
  }
}

upstream.server.close();
console.log(`\n=== 结果：通过 ${passed} 项，失败 ${failed} 项 ===\n`);
process.exit(failed === 0 ? 0 : 1);
