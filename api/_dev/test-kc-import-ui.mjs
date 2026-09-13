/**
 * 阶段 02 的**真浏览器**冒烟：`npm run test:kc-import-ui`（需要本机有 Chrome / Edge）
 *
 * 为什么值得单独跑一遍（本地 Node 测不出来的那些）：
 * - Vite 的模块解析、`h()` 建 DOM、CSS 生效、路由挂载，只有真跑一遍才知道；
 * - 「AI 返回 → 界面渲染成卡片 → 点采纳 → 确认入库 → IndexedDB 里真有」这条**完整链路**，
 *   只有真浏览器能验（Node 里没有 DOM 事件）。
 *
 * 做法：起一个**本地假 AI 服务**（返回 `kcImportFixture.mjs` 里那份固定内容），
 * 把设置里的 AI 地址指到它，然后在无头 Chrome 里真的打字、点发送、点采纳、点入库。
 * 这样测的是**真实代码路径**（真的 fetch、chatComplete、解析、渲染、DAO），
 * 唯一被替换的是模型本身——这正是我们想要的（不然结果不可复现）。
 *
 * ⚠️ 不需要任何 AI 密钥：假服务不校验 Authorization。
 */
import { createServer } from 'node:http';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findBrowser, launch, openSession, serveStatic } from '../../scripts/cdp.mjs';
import { FAKE_IMPORT_REPLY, FAKE_GARBAGE_REPLY } from './kcImportFixture.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = 4183;
const CDP_PORT = 9224;
const AI_PORT = 4184;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const AI_BASE = `http://127.0.0.1:${AI_PORT}`;

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
 * 起本地假 AI 服务。`mode=ok` 返回正常 JSON，`mode=bad` 返回一段废话（测降级）。
 *
 * ⚠️ **必须带 CORS 头**：真实调用是「浏览器直连模型服务」，
 * 而 `fetch` 带 `Authorization` + `Content-Type: application/json` 会触发**预检（OPTIONS）**。
 * 假服务不回 CORS 头的话，浏览器会在预检阶段就把请求拦掉，
 * 表现成「连不上」（踩过一次，整轮冒烟全红）。
 *
 * @param {number} port 端口
 */
function startFakeAi(port) {
  /** 每次请求记一条，便于断言「真的调过来了」 */
  const calls = [];
  /** 允许的来源：被测页面在另一个端口，属于跨域 */
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Max-Age': '600',
  };
  const server = createServer((req, res) => {
    // 预检：直接回 204 + CORS 头
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      res.end();
      return;
    }
    const mode = req.url?.includes('bad') ? 'bad' : 'ok';
    if (req.method !== 'POST') {
      res.writeHead(405, cors).end('{}');
      return;
    }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      calls.push({ url: req.url, auth: req.headers.authorization ?? '', body });
      const content = mode === 'bad' ? FAKE_GARBAGE_REPLY : FAKE_IMPORT_REPLY;
      res.writeHead(200, { 'Content-Type': 'application/json', ...cors });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }));
    });
  });
  server.listen(port, '127.0.0.1');
  return { server, calls };
}

/**
 * 等服务器起来。
 * @param {string} url 地址
 */
async function waitForServer(url) {
  for (let i = 0; i < 80; i += 1) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status === 405) return true;
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/**
 * 把请求体里的所有文本拼成一个大字符串（含 system / user 消息）。
 *
 * 为什么要 parse 一遍：`JSON.stringify` 会把中文转成 `\uXXXX` 转义，
 * 直接对原始请求体做中文子串匹配会**假失败**（踩过一次）。
 * @param {string} raw 原始请求体
 */
function parseRequestBody(raw) {
  try {
    const parsed = JSON.parse(raw);
    const messages = Array.isArray(parsed?.messages) ? parsed.messages : [];
    return messages.map((m) => String(m?.content ?? '')).join('\n');
  } catch {
    return raw;
  }
}

/**
 * 取请求体里的 messages 数组（断言「历史真的发出去了」用）。
 *
 * 为什么单独一个函数：要检查的是**角色顺序**（system → 历史 → 本轮 user），
 * 拼成一个大字符串就看不出来了。
 * @param {string} raw 原始请求体
 */
function messagesOf(raw) {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.messages) ? parsed.messages : [];
  } catch {
    return [];
  }
}

/**
 * 等页面真正挂载（Vite dev 首次加载要现场编译整张模块图，可能好几秒）。
 *
 * 为什么必须等：`openSession` 的固定等待在 dev 模式下不可靠——
 * 第一次打开时 `#app` 还是空的，断言全都会假失败（踩过）。
 * @param {object} session CDP 会话
 * @param {number} timeoutMs 最长等待
 */
async function waitForMount(session, timeoutMs = 30_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const ok = await session.evaluate(`(() => {
      const app = document.getElementById('app');
      if (app === null) return false;
      // 顶栏（.nav）渲染出来就算挂载完成
      return app.querySelector('.nav') !== null;
    })()`);
    if (ok === true) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

/**
 * 把路由切到某个 hash 并等它渲染出来。
 * @param {object} session CDP 会话
 * @param {string} hash 目标 hash（如 '#/kc/import'）
 * @param {string} selector 渲染完成的标志元素
 */
async function goto(session, hash, selector) {
  await session.evaluate(`(async () => {
    location.hash = '${hash}';
    await new Promise((r) => setTimeout(r, 200));
  })()`);
  for (let i = 0; i < 60; i += 1) {
    const found = await session.evaluate(`document.querySelector('${selector}') !== null`);
    if (found === true) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

const browser = findBrowser();
if (!browser) {
  console.log('\n⚠ 本机没有 Chrome / Edge，跳过二期界面冒烟（解析层已由 test:kc-import 覆盖）');
  process.exit(0);
}
console.log(`  用 ${browser.split('\\').pop()} 跑无头检查`);

const fake = startFakeAi(AI_PORT);
const server = serveStatic({ root: ROOT, port: PORT, mode: 'dev' });

let chrome = null;
let session = null;
try {
  if (!(await waitForServer(`${AI_BASE}/`))) throw new Error('假 AI 服务没起来');
  if (!(await waitForServer(`${ORIGIN}/`))) throw new Error('dev 服务没起来');
  chrome = await launch(browser, CDP_PORT);

  // ── 先落一份设置：把 AI 地址指到假服务，密钥随便填（假服务不校验） ──
  // 用一期的 dao.settings 写，保证走的是真实存储路径。
  // 访问页面 → 用页面里的模块写设置（页面有 dao 的构建产物）。
  session = await openSession(CDP_PORT, `${ORIGIN}/#/kc`, { waitMs: 800 });
  const mounted = await waitForMount(session);
  check('应用真的挂载了（dev 模块图编译完成）', mounted === true, '等了 30 秒还没挂载');

  console.log('\n[1] 二期首页与路由');
  await goto(session, '#/kc', '.kc-home');
  const homeHtml = await session.html();
  check('★ 一期顶栏多了「知识点」入口', homeHtml.includes('知识点'), '');
  check('二期首页渲染出来（标题 + 副标题）', homeHtml.includes('知识点精学'), '');
  check('六个入口按钮都在', ['录入', '卡片列表', '学习', '复习', '题库', '设置'].every((t) => homeHtml.includes(t)), '');
  // ⚠️ 这条以前断言的是「未实现的入口标了待做」（阶段 02 的占位形态）。
  // 阶段 03~07 把入口全做完了，「待做」占位自然就没了；再断言它存在只会变成假红。
  // 现在反过来断言：**入口全是可用的**，一个「待做」都没有。
  check('★ 入口全部已实现（没有「待做」占位）', !homeHtml.includes('待做'), '');
  // 做题不再有独立入口（用户明确要求删掉，只剩学习/复习流程里的一步）
  check('★ 主界面没有独立的「做题」入口', !homeHtml.includes('>做题<'), '');
  check('页面没掉进错误边界', !homeHtml.includes('页面渲染失败'), '');

  // ── 写入 AI 设置（用页面里的 dao，走真实设置存储） ──
  const settingsOk = await session.evaluate(`(async () => {
    const mod = await import('/src/dao/settings.ts');
    await mod.set({ ai: { baseUrl: '${AI_BASE}', model: 'fake-model', key: 'fake-key-for-test', proxyUrl: '', forceProxy: false } });
    const s = await mod.get();
    return s.ai.baseUrl;
  })()`);
  check('AI 地址已写入设置（指向本地假服务）', settingsOk === AI_BASE, String(settingsOk));

  console.log('\n[2] 聊天录入页：真的走完一次「发送」');
  const onImportPage = await goto(session, '#/kc/import', '.kc-chat-input');
  check('聊天录入页渲染出来了', onImportPage === true, '等不到 .kc-chat-input');
  const sent = await session.evaluate(`(async () => {
    const input = document.querySelector('.kc-chat-input');
    if (input === null) return JSON.stringify({ fatal: 'no-input' });
    input.value = '我在定语从句这块不行';
    const btns = [...document.querySelectorAll('.kc-composer button')];
    const send = btns.find((b) => b.textContent === '发送');
    if (!send) return JSON.stringify({ fatal: 'no-send' });
    send.click();
    // 等 AI 往返 + 渲染
    for (let i = 0; i < 80; i += 1) {
      await new Promise((r) => setTimeout(r, 250));
      if (document.querySelectorAll('.kc-preview').length > 0) break;
    }
    return JSON.stringify({
      userBubble: document.querySelector('.kc-bubble--user')?.textContent ?? '',
      aiText: document.querySelector('.kc-bubble--ai .kc-bubble-text')?.textContent ?? '',
      cardCount: document.querySelectorAll('.kc-preview').length,
      titles: [...document.querySelectorAll('.kc-preview-title')].map((e) => e.textContent),
      chips: [...document.querySelectorAll('.kc-preview .kc-chip')].map((e) => e.textContent),
      minutes: [...document.querySelectorAll('.kc-preview-minutes')].map((e) => e.textContent),
      blocks: [...document.querySelectorAll('.kc-preview-blocks')].map((e) => e.textContent),
    });
  })()`);
  const ui = JSON.parse(sent);
  check('★ 真的把话发出去了（用户气泡出现）', ui.userBubble.includes('我在定语从句这块不行'), ui.userBubble);
  check('★ AI 气泡说拆成了 2 个知识点', ui.aiText.includes('2 个知识点'), ui.aiText);
  check('★ 渲染出 2 张卡片预览', ui.cardCount === 2, `实际 ${ui.cardCount}`);
  check('卡片标题正确', ui.titles[0] === '定语从句：关系代词 vs 关系副词', ui.titles.join(' | '));
  check('★ 考核标签 chip 正确显示（语法填空 + 选择题）', ui.chips.includes('语法填空') && ui.chips.includes('选择题'), ui.chips.join(','));
  check('未知题型 essay 没有变成 chip', !ui.chips.includes('essay'), ui.chips.join(','));
  check('★ 耗时显示为 5 分钟（AI 给的 12 被钳制）', ui.minutes[0] === '约 5 分钟', ui.minutes.join(','));

  console.log('\n[3] 块内容渲染（验收标准 3：各种块都要正常）');
  const expanded = await session.evaluate(`(async () => {
    // 弹出第一张卡的所有块（多张卡时默认收起，点「预览」展开）
    const cards = [...document.querySelectorAll('.kc-preview')];
    for (const card of cards) {
      const btn = [...card.querySelectorAll('button')].find((b) => b.textContent === '预览');
      if (btn) { btn.click(); await new Promise((r) => setTimeout(r, 120)); }
    }
    const hosts = [...document.querySelectorAll('.kc-preview-body')];
    return JSON.stringify({
      html: hosts.map((hh) => hh.innerHTML).join(''),
      types: [...document.querySelectorAll('.kc-preview-body .kc-block')].map((e) => [...e.classList].find((c) => c.startsWith('kc-block--'))),
      tables: document.querySelectorAll('.kc-preview-body table').length,
      ths: document.querySelectorAll('.kc-preview-body th').length,
      theads: document.querySelectorAll('.kc-preview-body thead').length,
      tds: document.querySelectorAll('.kc-preview-body td').length,
      lis: document.querySelectorAll('.kc-preview-body li').length,
      pres: document.querySelectorAll('.kc-preview-body pre').length,
      danger: document.querySelectorAll('.kc-preview-body script, .kc-preview-body img, .kc-preview-body svg, .kc-preview-body iframe').length,
      onAttrs: document.querySelectorAll('.kc-preview-body [onerror], .kc-preview-body [onload]').length,
      text: hosts.map((hh) => hh.textContent).join(''),
    });
  })()`);
  const dom = JSON.parse(expanded);
  // 注意：这里**不检查 `kc-block--unknown`** —— 本 fixture 里没有真正的未知类型块
  // （缺 type 的那个会被降级成 text，这是有意的行为，见 kcBlock.coerceBlock 的注释）。
  // 「未知类型降级」由 test-kc.mjs 单独覆盖。
  const wanted = ['kc-block--heading', 'kc-block--text', 'kc-block--example', 'kc-block--list', 'kc-block--table', 'kc-block--code', 'kc-block--quote', 'kc-block--tip'];
  check('★ 8 种块类型全部渲染出来', wanted.every((w) => dom.types.includes(w)), [...new Set(dom.types)].join(','));
  // ★ 表格无表头（用户明确要求）：fixture 的表格是 3 行（老格式里第一行是表头），
  //   现在**全部**按数据行渲染，所以是 9 个 td、0 个 th / thead。
  check('表格渲染成真 table', dom.tables === 1, `table=${dom.tables}`);
  check('★ 表格没有 th（表头不再渲染）', dom.ths === 0 && dom.theads === 0, `th=${dom.ths} thead=${dom.theads}`);
  check('★ 3 行全部按数据行渲染（9 个 td，含原来是表头的那一行）', dom.tds === 9, `td=${dom.tds}`);
  check('列表渲染成 li', dom.lis >= 5, `li=${dom.lis}`);
  check('代码块渲染成 pre', dom.pres === 1, `pre=${dom.pres}`);
  check('★ 页面里没有 script/img/svg/iframe 元素', dom.danger === 0, `找到 ${dom.danger} 个`);
  check('★ 页面里没有 onerror/onload 属性', dom.onAttrs === 0, `找到 ${dom.onAttrs} 个`);
  check('★ 攻击载荷以纯文本显示在页面上', dom.text.includes('<script>') && dom.text.includes('onerror'), '');
  check('哨兵未被置位（没有脚本执行）', (await session.evaluate('window.__kcXssFired === undefined')) === true, '');

  console.log('\n[4] 采纳 → 确认入库 → IndexedDB（验收标准 7）');
  const committed = await session.evaluate(`(async () => {
    const cards = [...document.querySelectorAll('.kc-preview')];
    for (const card of cards) {
      const btn = [...card.querySelectorAll('button')].find((b) => b.textContent === '采纳');
      if (btn) { btn.click(); await new Promise((r) => setTimeout(r, 80)); }
    }
    const commitBtn = [...document.querySelectorAll('.kc-import-bar button')].find((b) => b.textContent.includes('确认入库'));
    const label = commitBtn?.textContent ?? '';
    if (commitBtn) commitBtn.click();
    for (let i = 0; i < 40; i += 1) {
      await new Promise((r) => setTimeout(r, 200));
      if (document.querySelector('.modal-title')?.textContent === '入库完成') break;
    }
    const dao = await import('/src/dao/kc.ts');
    const all = await dao.getAll();
    // 按标题挑第一张卡（all 的顺序不保证，用下标会挑错卡）
    const first = all.find((c) => c.title.includes('定语从句')) ?? null;
    return JSON.stringify({
      commitLabel: label,
      modal: document.querySelector('.modal-title')?.textContent ?? '',
      count: all.length,
      first: first ? {
        title: first.title,
        status: first.status,
        blocks: first.blocks.length,
        tags: first.examTags,
        minutes: first.examLoad.estMinutes,
        mastery: first.attrs.mastery,
        hasId: typeof first.id === 'string' && first.id.length > 8,
      } : null,
    });
  })()`);
  const saved = JSON.parse(committed);
  check('★ 底部按钮显示采纳数量', saved.commitLabel.includes('2 张'), saved.commitLabel);
  check('★ 点入库后弹「入库完成」', saved.modal === '入库完成', saved.modal);
  check('★ IndexedDB 里真的有 2 张卡', saved.count === 2, `实际 ${saved.count}`);
  check('卡片字段完整（状态/块/标签/耗时/掌握度/id）',
    saved.first !== null &&
      saved.first.status === 'unlearned' &&
      saved.first.blocks === 9 &&
      saved.first.tags.length === 2 &&
      saved.first.minutes === 5 &&
      saved.first.mastery === 0 &&
      saved.first.hasId,
    JSON.stringify(saved.first),
  );

  console.log('\n[5] 假 AI 真的被调到了（证明走的是真实链路）');
  check('★ 假服务收到过 /chat/completions 请求', fake.calls.length >= 1, `收到 ${fake.calls.length} 次`);
  check('请求带了 Authorization（密钥来自浏览器设置）', (fake.calls[0]?.auth ?? '').startsWith('Bearer '), fake.calls[0]?.auth ?? '');
  // ⚠️ 请求体里的中文被 JSON.stringify 转成了 \uXXXX 转义，
  // 所以不能直接对原始 body 做中文子串匹配 —— 先 parse 回来再检查。
  const firstBody = parseRequestBody(fake.calls[0]?.body ?? '');
  check('请求体里含自动拆分规则（system 提示词发出去了）', firstBody.includes('自动拆分'), '');
  check('★ 请求体里含用户原话', firstBody.includes('我在定语从句这块不行'), firstBody.slice(0, 100));
  check('★ 请求体里含已有标题列表的位置（防重复生成的结构在）', firstBody.includes('我已经有这些知识点卡片了'), '');
  check('要求了 JSON 模式（response_format）', (fake.calls[0]?.body ?? '').includes('json_object'), '');
  check('第一轮没有历史（只有 system + user）', messagesOf(fake.calls[0]?.body ?? '').length === 2, messagesOf(fake.calls[0]?.body ?? '').map((m) => m.role).join(','));
  check('★ 提示词里已要求极简、表格无表头', firstBody.includes('记忆痛点') && firstBody.includes('表头行'), '');

  console.log('\n[6] 上下文记忆：连着说第二句，请求带上了上一轮');
  const secondTurn = await session.evaluate(`(async () => {
    const input = document.querySelector('.kc-chat-input');
    if (input === null) return JSON.stringify({ fatal: 'no-input' });
    input.value = '第二个再细一点';
    [...document.querySelectorAll('.kc-composer button')].find((b) => b.textContent === '发送').click();
    // 等这一轮回来：AI 气泡变成 2 条
    for (let i = 0; i < 80; i += 1) {
      await new Promise((r) => setTimeout(r, 250));
      if (document.querySelectorAll('.kc-bubble--ai').length >= 2 && !document.querySelector('.kc-typing')) break;
    }
    return JSON.stringify({
      userBubbles: [...document.querySelectorAll('.kc-bubble--user')].map((e) => e.textContent),
      aiBubbles: document.querySelectorAll('.kc-bubble--ai').length,
    });
  })()`);
  const turn2 = JSON.parse(secondTurn);
  check('★ 第二句真的发出去了（用户气泡 2 条）', (turn2.userBubbles ?? []).length === 2, JSON.stringify(turn2.userBubbles));
  check('第二轮的 AI 气泡也回来了', turn2.aiBubbles >= 2, String(turn2.aiBubbles));
  check('★ 假服务收到了第二次请求', fake.calls.length >= 2, `收到 ${fake.calls.length} 次`);
  const secondMessages = messagesOf(fake.calls[1]?.body ?? '');
  check(
    '★★ 第二轮请求按 system → 历史(user/assistant) → 本轮 user 排列',
    secondMessages.map((m) => m.role).join(',') === 'system,user,assistant,user',
    secondMessages.map((m) => m.role).join(','),
  );
  check('★ 历史里的 assistant 是上一轮 AI 的原始 JSON 返回', String(secondMessages[2]?.content ?? '').includes('关系副词的三种情况'), String(secondMessages[2]?.content ?? '').slice(0, 80));
  check('★ 本轮 user 消息在最后（"第二个"才有指代对象）', String(secondMessages[3]?.content ?? '').includes('第二个再细一点'), String(secondMessages[3]?.content ?? '').slice(0, 80));
  check('页面没有因为带历史而崩', (await session.evaluate(`document.querySelector('.kc-chat') !== null`)) === true, '');

  console.log('\n[7] AI 返回废话时的降级（验收标准 9）');
  const badUi = await session.evaluate(`(async () => {
    // 让假服务返回废话：把地址切到 /bad 通道
    const mod = await import('/src/dao/settings.ts');
    await mod.set({ ai: { baseUrl: '${AI_BASE}/bad' } });
    location.hash = '#/kc';
    await new Promise((r) => setTimeout(r, 600));
    location.hash = '#/kc/import';
    await new Promise((r) => setTimeout(r, 900));
    const input = document.querySelector('.kc-chat-input');
    input.value = '再试一次';
    [...document.querySelectorAll('.kc-composer button')].find((b) => b.textContent === '发送').click();
    for (let i = 0; i < 50; i += 1) {
      await new Promise((r) => setTimeout(r, 250));
      if (document.querySelector('.kc-bubble-error')) break;
    }
    const err = document.querySelector('.kc-bubble-error');
    const retry = [...document.querySelectorAll('.kc-bubble button')].some((b) => b.textContent === '重试');
    return JSON.stringify({ error: err?.textContent ?? '', retry, crashed: !document.querySelector('.kc-chat') });
  })()`);
  const bad = JSON.parse(badUi);
  check('★ 显示明确错误（不是白屏、不是崩掉）', bad.error.includes('JSON'), bad.error);
  check('错误提示里给了「重试」按钮', bad.retry === true, '');
  check('页面结构还在（没有崩）', bad.crashed === false, '');
} catch (err) {
  failed += 1;
  console.error(`\n✗ 冒烟过程出错：${err instanceof Error ? err.message : String(err)}`);
} finally {
  if (session) await session.close().catch(() => {});
  if (chrome) chrome.proc.kill();
  server.kill();
  fake.server.close();
}

console.log(`\n=== 阶段 02 界面冒烟：通过 ${passed} 项，失败 ${failed} 项 ===\n`);
process.exit(failed === 0 ? 0 : 1);
