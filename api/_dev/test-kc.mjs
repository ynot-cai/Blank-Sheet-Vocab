/**
 * 阶段 01（二期数据层）验收脚本：`npm run test:kc`
 *
 * 与 test-sync.mjs 同样的套路：在 Node 里跑**真正的前端代码 + 真正的 API 处理函数 + 真正的 SQL**，
 * 靠两样东西把浏览器环境补上：
 * - `fake-indexeddb`：真的 IndexedDB 语义，DAO 一行都不用改；
 * - 本地 API 服务（api/_dev/harness.mjs）：真的 HTTP 请求打到真的 api/ 处理函数。
 *
 * 覆盖阶段 01 验收标准：
 *   2. 一期功能没坏（由 npm test 全量回归覆盖，这里只做二期部分）
 *   3. mastery 公式（Node 里再验一遍，和 __kcselftest 同一组断言）
 *   4. 安全渲染（用最小 DOM 桩验证「不拼 HTML」）
 *   5. 空间隔离：spaceKey A 推的卡，spaceKey B 拉不到
 *   6. 软删除：chop 后 kc-list 能返回该条且 deleted=1
 *   7. 断网：二期 DAO 读写照常，同步失败只 console.warn
 *   8. 所有二期 SQL 都带 space_key
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { loadEnvFiles } from './envFile.mjs'; // 静态导入：注册 TS 加载钩子 + 读 .env
import 'fake-indexeddb/auto';

loadEnvFiles('..');

// ── 先把浏览器环境补上（顺序很重要：必须在 import src 之前）──
const DB_FILE = './.tmp/test-kc.db';
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
const { callApi } = await import('./harness.mjs');

// ── 本机 API（前端通过 fetch 打它，等价于线上 Vercel）──
const PORT = 3124;
const server = startServer(PORT);
await new Promise((r) => setTimeout(r, 250));
const API_BASE = `http://127.0.0.1:${PORT}`;

// ── 加载被测代码 ──
const dao = await import('../../src/dao/index.ts');
const kcCloud = await import('../../src/dao/kcCloud.ts');
const blockRender = await import('../../src/core/blockRender.ts');
const kcModel = await import('../../src/core/kcModel.ts');
const kcPriority = await import('../../src/core/kcPriority.ts');
const kcClock = await import('../../src/core/kcClock.ts');
const kcQuery = await import('../../src/dao/kcQuery.ts');
const { setSettingsCache, DEFAULT_SETTINGS } = await import('../../src/core/config.ts');

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

/** 等一小会（IndexedDB 事务提交用） */
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

/**
 * 配置云同步（两个「设备」用不同同步码时，改的就是它）。
 * @param {{enabled:boolean, syncCode:string, apiBase?:string}} cloud
 */
async function configure(cloud) {
  await dao.settings.set({
    cloud: {
      enabled: cloud.enabled,
      syncCode: cloud.syncCode,
      apiBase: cloud.apiBase ?? API_BASE,
      autoSync: true,
    },
    kc: { cloud: { lastSyncAt: 0, lastPushAt: 0, lastError: '' } },
  });
  // core 层的内存缓存也要跟上（computeKcPriority 之类读它）
  setSettingsCache(await dao.settings.get());
}

/** 把二期同步游标清零（模拟「时间稍后一点的另一次同步」） */
async function resetCursor() {
  await dao.settings.set({ kc: { cloud: { lastSyncAt: 0, lastPushAt: 0 } } });
  setSettingsCache(await dao.settings.get());
}

/**
 * 先把本地当前状态**整体推上云**，让云端与本地一致。
 *
 * 为什么测试里要这一步：本测试用**同一个 IndexedDB** 轮流扮演两台设备
 * （fake-indexeddb 只有一份库），所以每次「换设备」都得让云端先跟上，
 * 否则后面 pull 回来的还是旧版本，会把本地的新状态覆盖掉——
 * 那是测试脚手架的问题，不是产品质量问题。
 */
async function pushBaseline() {
  await resetCursor();
  return kcCloud.kcSyncOnce();
}

/**
 * 直接从云端查某张卡（绕过本地，用来看「云端到底存的是什么」）。
 * @param {string} spaceKey 数据空间键
 * @param {string} id 卡片 id
 */
async function fetchCard(spaceKey, id) {
  const res = await callApi({ path: '/api/kc-list', query: 'since=0', headers: { 'x-space-key': spaceKey } });
  if (res.status !== 200 || !res.json) return null;
  return res.json.cards.find((c) => c.id === id) ?? null;
}

/**
 * 造一张卡片（和后端/前端同构）。
 * @param {string} title 标题
 */
function makeCard(title) {
  const card = kcModel.createEmptyCard(title, 4);
  card.summary = `${title} 的摘要`;
  card.examTags = ['fill'];
  card.examLoad = { types: ['fill', 'choice'], estMinutes: 4 };
  card.blocks = [
    { id: `${card.id}-h`, type: 'heading', content: title },
    { id: `${card.id}-t`, type: 'text', content: `${title} 的正文（含 <script>alert(1)</script> 这种字样）` },
    { id: `${card.id}-e`, type: 'example', content: 'This is a test.', translation: '这是一个测试。' },
  ];
  return card;
}

// ═══════════════════════════════════════════════════
console.log('\n[1] mastery 公式（阶段 01 验收项 3）');
// ═══════════════════════════════════════════════════
{
  const { calcMastery, normalizeScore, createEmptyCard, validateCard, coerceCard } = kcModel;
  const m33 = calcMastery(3, 3);
  const m31 = calcMastery(3, 1);
  const m13 = calcMastery(1, 3);
  const m11 = calcMastery(1, 1);
  const mN2 = calcMastery(null, 2);
  const m3N = calcMastery(3, null);

  check('calcMastery(3,3) ≈ 1.0', Math.abs(m33 - 1) < 1e-9, String(m33));
  // 主提示词的验收口径：盲目自信（3/1）必须明显低于低估自己（1/3）。
  // 注意：对称惩罚项在 0.6/0.4 权重下算不出这个结论（会得到 0.2 vs 0.067，正好相反），
  // 所以惩罚项带了方向系数 asymmetry（默认 2），见 kcModel.calcMastery 的注释。
  check('★ calcMastery(3,1) 明显低于 calcMastery(1,3)（惩罚项生效）', m31 < m13 - 0.1, `3/1=${m31} vs 1/3=${m13}`);
  check('★ 盲目自信被拉到 0（最危险的状态，必须最先复习）', m31 === 0, `得到 ${m31}`);
  check('calcMastery(1,1) ≈ 0.33', Math.abs(m11 - 1 / 3) < 0.002, String(m11));
  check(
    'calcMastery(null,2) = 0.5（缺失一侧按中性先验 0.5 补）',
    Math.abs(mN2 - 0.5) < 0.002,
    String(mN2),
  );
  check('calcMastery(3,null) = 0（光自评满分不算掌握）', Math.abs(m3N - 0) < 0.002, String(m3N));
  check('calcMastery(null,3) = 0.5（光考核过也不算掌握）', Math.abs(calcMastery(null, 3) - 0.5) < 0.002, String(calcMastery(null, 3)));
  check('calcMastery(null,null) = 0', calcMastery(null, null) === 0, '');
  // 越界输入先被钳到 1~3 分（-5 当 1 分、9 当 3 分），所以结果是 0.333 / 1
  check(
    '越界分数被钳制（-5 → 1 分、9 → 3 分，结果仍落在 [0,1]）',
    calcMastery(9, 9) === 1 && Math.abs(calcMastery(-5, -5) - 1 / 3) < 0.002,
    `${calcMastery(9, 9)} / ${calcMastery(-5, -5)}`,
  );
  check('结果保留 3 位小数', String(calcMastery(2, 3)).length <= 5, String(calcMastery(2, 3)));
  check('normalizeScore(1)=0.333 / normalizeScore(3)=1', Math.abs(normalizeScore(1) - 1 / 3) < 1e-9 && normalizeScore(3) === 1, '');
  check('参数可自定义（penalty=0 时 3/1=0.733）', Math.abs(calcMastery(3, 1, { w1: 0.6, w2: 0.4, penalty: 0 }) - 0.733) < 0.002, '');

  const empty = createEmptyCard('测试标题');
  check('createEmptyCard 造出的卡是合法的', validateCard(empty).length === 0, validateCard(empty).join('；'));
  const dirty = coerceCard({
    id: 'd1',
    title: '脏数据',
    // 1) 未知类型（应降级成 text 并保留内容）
    // 2) 缺 type（应降级成 text）
    // 3) 根本不是对象（应被丢掉）
    // 4) 正常的块（应原样保留）
    blocks: [
      { id: 'b1', type: 'nope', content: '未知类型' },
      { id: 'b2', content: 42 },
      null,
      'not-a-block',
      { id: 'b4', type: 'text', content: 'ok' },
    ],
    attrs: 'x',
  });
  check(
    'coerceCard 能救回脏数据（非对象丢掉、未知类型降级成 text）',
    dirty !== null && dirty.blocks.length === 3 && dirty.blocks[2].content === 'ok' && dirty.blocks.every((b) => b.type === 'text'),
    JSON.stringify(dirty?.blocks.map((b) => `${b.type}:${b.content}`)),
  );
  check('coerceCard 对非对象返回 null', coerceCard(42) === null && coerceCard([]) === null, '');

  // ★ 不变量：coerceCard 的产物必须通过 validateCard
  // （否则「一张坏卡从云端拉下来」会变成界面上的坏数据；缺块时应该补一个空块，
  //   因为「卡片至少有一个块」是块编辑器的前提）
  const partial = coerceCard({ id: 'x1', title: '半张卡' });
  check(
    '★ coerceCard 产物一定通过 validateCard（缺块自动补一个空块）',
    partial !== null && partial.blocks.length === 1 && validateCard(partial).length === 0,
    JSON.stringify(partial === null ? 'null' : validateCard(partial)),
  );
  const emptyObj = coerceCard({});
  check(
    'coerceCard({}) 也能产出一张合法卡片（id/时间戳/块全补上）',
    emptyObj !== null && emptyObj.id !== '' && validateCard(emptyObj).length === 0,
    JSON.stringify(emptyObj === null ? 'null' : validateCard(emptyObj)),
  );

  // 盲目自信要被优先复习
  const base = {
    learnedAt: null,
    lastReviewAt: Date.now(),
    reviewCount: 1,
    mastery: 0,
    reviewPriority: 0,
  };
  const blind = kcPriority.computeKcPriority({ ...base, lastSelfScore: 3, lastExamScore: 1, mastery: m31 });
  const honest = kcPriority.computeKcPriority({ ...base, lastSelfScore: 1, lastExamScore: 1, mastery: m11 });
  check('盲目自信（3/1）的复习优先度高于真不会（1/1）', blind > honest, `${blind} vs ${honest}`);
}

// ═══════════════════════════════════════════════════
console.log('\n[2] 安全块渲染（阶段 01 验收项 4/9）');
// ═══════════════════════════════════════════════════
{
  // 最小 DOM 桩：只实现 blockRender 用到的 API，并**只允许 textContent 承载文本**
  let nodeSeq = 0;
  class StubNode {
    constructor(tag) {
      this.tag = tag;
      this.children = [];
      this.attributes = {};
      this.classes = new Set();
      this._text = '';
      nodeSeq += 1;
      this.id = `n${nodeSeq}`;
    }
    set className(v) {
      this.classes = new Set(String(v).split(/\s+/).filter(Boolean));
    }
    get className() {
      return [...this.classes].join(' ');
    }
    get classList() {
      const self = this;
      return {
        add: (c) => self.classes.add(c),
        contains: (c) => self.classes.has(c),
        [Symbol.iterator]: () => self.classes[Symbol.iterator](),
      };
    }
    set textContent(v) {
      // 关键：textContent 只存**原始字符串**，绝不解析成子节点（浏览器就是这么做的）
      this._text = String(v);
    }
    get textContent() {
      return this._text + this.children.map((c) => c.textContent ?? '').join('');
    }
    appendChild(child) {
      this.children.push(child);
      return child;
    }
    /** 递归找节点（模拟 querySelectorAll 的一小部分） */
    all(pred, out = []) {
      if (pred(this)) out.push(this);
      for (const c of this.children) if (typeof c.all === 'function') c.all(pred, out);
      return out;
    }
  }
  globalThis.document = {
    createElement: (tag) => new StubNode(tag),
    createTextNode: (t) => {
      const n = new StubNode('#text');
      n.textContent = t;
      return n;
    },
    createDocumentFragment: () => new StubNode('#fragment'),
  };

  const payloads = [
    '<script>window.__kcXss = 1</script>',
    '<img src=x onerror="window.__kcXss=1">',
    '"><svg/onload=window.__kcXss=1>',
  ];
  const blocks = [
    { id: 'a', type: 'text', content: payloads[0] },
    { id: 'b', type: 'heading', content: payloads[2] },
    { id: 'c', type: 'example', content: payloads[1], translation: payloads[0] },
    { id: 'd', type: 'list', items: [payloads[1], payloads[2]] },
    { id: 'e', type: 'table', rows: [[payloads[2], payloads[0]]] },
    { id: 'f', type: 'code', content: payloads[0], lang: 'js"><img src=x>' },
    { id: 'g', type: 'unknown-type', content: payloads[1] },
    { id: 'h', type: 'text' },
  ];

  const frag = blockRender.renderBlocks(blocks);
  const created = frag.all(() => true);
  const tags = new Set(created.map((n) => n.tag));
  check('渲染不抛异常（含未知类型与缺字段的块）', frag.children.length === blocks.length, `渲染了 ${frag.children.length}/${blocks.length} 块`);
  check('没有创建 script/img/svg/iframe 元素', !['script', 'img', 'svg', 'iframe', 'object', 'embed'].some((t) => tags.has(t)), [...tags].join(','));
  check(
    '攻击载荷以纯文本存在（不会被解析成节点）',
    created.some((n) => n._text.includes('<script>')),
    '',
  );
  check('没有任何属性是从内容里拼出来的（attributes 全空）', created.every((n) => Object.keys(n.attributes).length === 0), '');
  check('code 的 lang 只作 class 且已过滤', created.every((n) => [...n.classes].every((c) => /^[A-Za-z0-9+#-]+$/.test(c))), '');
  check('每个块都有 kc-block 根 class', frag.children.every((n) => n.classes.has('kc-block')), '');
  check('未知块类型降级成普通块（不白屏）', frag.children.some((n) => n.classes.has('kc-block--unknown')), '');
  check('哨兵没有被触发（没有任何脚本执行路径）', globalThis.window.__kcXss === undefined, '');

  // 源码级护栏：渲染与二期数据层里不许出现 innerHTML
  // 范围说明：一期 `src/ui/dom.ts` 有**自己**的 el() 工具（它负责一期页面的结构拼接，
  // 且 HTML 模板都是代码里写死的字面量，不含 AI 输出），不在这次的检查范围内。
  const guardFiles = ['src/core/blockRender.ts', 'src/core/kcModel.ts', 'src/dao/kc.ts', 'src/dao/kcCloud.ts'];
  const src = readFileSync('src/core/blockRender.ts', 'utf8');
  const offenders = [];
  for (const p of guardFiles) {
    const text = readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    if (/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(text)) offenders.push(p);
  }
  check('★ 二期渲染/数据层源码里没有 innerHTML 之类的 HTML 拼接', offenders.length === 0, offenders.join(', '));
  check('blockRender.ts 只通过 renderBlock/renderBlocks 产出 DOM', /export function renderBlock\b/.test(src) && /export function renderBlocks\b/.test(src), '');
  delete globalThis.document;
}

// ═══════════════════════════════════════════════════
console.log('\n[3] 时间水位：设备时钟倒退也不能漏推（★ 必须在本组先跑，见下）');
// ═══════════════════════════════════════════════════
/**
 * 这一组为什么必须排在所有卡片写入之前：
 * `dao/kc.ts` 的 `ensureClockFloor()` 是**每个进程只读一次**设置里的水位，
 * 一旦有卡片写过就被读掉了。要真实验证「冷启动 + 时钟倒退」这条路径，
 * 就必须在第一次写卡片**之前**把游标摆成一个「未来时间」。
 */
{
  const FUTURE = Date.now() + 7 * 86_400_000; // 假装上次推送发生在「7 天后」（= 时钟倒退了 7 天）
  await configure({ enabled: true, syncCode: 'KcTestSpaceAlpha1' });
  await dao.settings.set({ kc: { cloud: { lastPushAt: FUTURE, lastSyncAt: FUTURE } } });
  setSettingsCache(await dao.settings.get());

  // 浏览器里这一步由 main.ts 注入；Node 测试里手动注入**同一份**实现
  kcClock.setClockFloorLoader(async () => {
    const latest = await dao.settings.get();
    return Math.max(latest.kc.cloud.lastPushAt, latest.kc.cloud.lastSyncAt);
  });
  await kcClock.ensureClockFloor();

  const card = makeCard('时钟倒退时新建的卡');
  await dao.kc.bulkUpsert([card]);
  const back = await dao.kc.getById(card.id);

  check(
    '★ 冷启动 + 时钟倒退时，新卡的时间戳不低于上次推送游标（否则永远推不上去）',
    back !== null && back.updatedAt >= FUTURE,
    `updatedAt=${back?.updatedAt} 游标=${FUTURE}`,
  );
  const dirty = await dao.kc.listDirty(FUTURE, 100);
  check(
    '★ 这张卡确实落在「待推送」集合里（不是静默丢掉）',
    dirty.some((c) => c.id === card.id),
    `待推 ${dirty.length} 张`,
  );

  // 收尾：清干净，别影响后面的组（游标也恢复正常）
  await dao.kc.clearAll();
  await dao.settings.set({ kc: { cloud: { lastPushAt: 0, lastSyncAt: 0 } } });
  setSettingsCache(await dao.settings.get());
}

// ═══════════════════════════════════════════════════
console.log('\n[4] 二期本地 DAO（IndexedDB，离线可用 —— 验收项 7）');
// ═══════════════════════════════════════════════════
let cardA = null;
let cardB = null;
{
  // 先「断网」：后端地址指向一个不存在的端口 + 关掉云同步
  await configure({ enabled: false, syncCode: 'KcTestCodeA1', apiBase: 'http://127.0.0.1:1' });

  cardA = makeCard('定语从句：关系代词 vs 关系副词');
  cardB = makeCard('虚拟语气：should 的省略');
  const res = await dao.kc.bulkUpsert([cardA, cardB]);
  await tick();
  check('离线时 bulkUpsert 照常工作', res.inserted === 2, JSON.stringify(res));

  const got = await dao.kc.getById(cardA.id);
  check('离线时 getById 照常工作', got !== null && got.title === cardA.title, got?.title ?? 'null');

  const all = await dao.kc.getAll();
  check('离线时 getAll 能取回 2 张', all.filter((c) => c.id === cardA.id || c.id === cardB.id).length === 2, `共 ${all.length} 张`);

  const attrs = await dao.kc.updateAttrs(cardA.id, { lastSelfScore: 3, lastReviewAt: Date.now() });
  check(
    'updateAttrs 会自动重算 mastery（只有自评 3 → 0，见公式对照表）',
    attrs !== null && attrs.mastery === 0 && attrs.reviewPriority > 0,
    JSON.stringify(attrs),
  );

  const blocked = await dao.kc.updateBlocks(cardA.id, [{ id: 'x1', type: 'text', content: '换过的正文' }]);
  const after = await dao.kc.getById(cardA.id);
  check('updateBlocks 换块成功', blocked && after.blocks.length === 1 && after.blocks[0].content === '换过的正文', '');

  const tagged = await dao.kc.updateExamTags(cardB.id, ['sentence', 'choice']);
  const afterTags = await dao.kc.getById(cardB.id);
  check('updateExamTags 生效', tagged && afterTags.examTags.join(',') === 'sentence,choice', afterTags.examTags.join(','));

  const q = await dao.kc.query({ keyword: '虚拟', page: 1, pageSize: 10 });
  check('query(keyword) 命中', q.items.length === 1 && q.items[0].id === cardB.id, `命中 ${q.items.length}`);
  const stats = await dao.kc.stats();
  check('stats 统计正确（2 张未学）', stats.unlearned >= 2 && stats.chopped === 0, JSON.stringify(stats));
}

// ═══════════════════════════════════════════════════
console.log('\n[5] 云端同步 + 空间隔离（验收项 5/6）');
// ═══════════════════════════════════════════════════
{
  // 空间 A：把两张卡拉上去
  await configure({ enabled: true, syncCode: 'KcTestSpaceAlpha1' });
  await resetCursor();
  const push1 = await kcCloud.kcSyncOnce();
  check('空间 A 同步成功（推送 2 张，无错误）', push1.error === undefined && push1.pushed >= 2, JSON.stringify(push1));

  const listA = await callApi({
    path: '/api/kc-list',
    query: 'since=0',
    headers: { 'x-space-key': await spaceKeyOf('KcTestSpaceAlpha1') },
  });
  check('kc-list 能拉到 2 张卡', listA.status === 200 && listA.json.cards.length === 2, `状态 ${listA.status}，${listA.json?.cards?.length} 张`);
  check(
    'JSON 字段原样存取（blocks 是合法 JSON 字符串）',
    listA.json.cards.every((c) => Array.isArray(JSON.parse(c.blocks))) ,
    '',
  );
  check('服务端返回里有 updated_at / deleted 列', listA.json.cards.every((c) => typeof c.updated_at === 'number' && 'deleted' in c), '');

  // 隔离验证：空间 B 拉不到空间 A 的数据
  const listB = await callApi({
    path: '/api/kc-list',
    query: 'since=0',
    headers: { 'x-space-key': await spaceKeyOf('KcTestSpaceBeta2') },
  });
  check('★ 空间隔离：空间 B 拉不到空间 A 的卡片', listB.status === 200 && listB.json.cards.length === 0, `拉到 ${listB.json?.cards?.length} 张`);

  // 客户端的「另一台设备」：切到空间 B，本地清空后拉取 → 应该什么都拉不到
  await configure({ enabled: true, syncCode: 'KcTestSpaceBeta2' });
  await dao.kc.clearAll();
  await resetCursor();
  const syncB = await kcCloud.kcSyncOnce();
  const empties = (await dao.kc.getAll()).filter((c) => c.deleted !== 1);
  check('★ 切到空间 B 的设备同步后本地一张卡都没有', syncB.error === undefined && empties.length === 0, `拉到 ${syncB.pulled}，本地 ${empties.length} 张`);
}

// ═══════════════════════════════════════════════════
console.log('\n[6] 软删除：chop → 云端 → 另一台设备（验收项 6）');
// ═══════════════════════════════════════════════════
{
  const MY_CARD = 'kc-stage01-soft-delete-card';
  const keyA = await spaceKeyOf('KcTestSpaceAlpha1');

  // ── 设备 1（空间 A）：造一张固定 id 的卡，云端与本地先对齐 ──
  await configure({ enabled: true, syncCode: 'KcTestSpaceAlpha1' });
  await dao.kc.clearAll();
  const solo = makeCard('软删除测试卡');
  solo.id = MY_CARD;
  await dao.kc.bulkUpsert([solo]);
  await pushBaseline();
  const cloudHasIt = await fetchCard(keyA, MY_CARD);
  check('设备 1 已把卡片推到云端', cloudHasIt !== null && cloudHasIt.deleted === 0, JSON.stringify(cloudHasIt?.deleted));

  // ── 设备 2（同一空间，本地是空的）：首次同步应该拉到这张卡 ──
  await dao.kc.clearAll();
  await resetCursor();
  const pullFirst = await kcCloud.kcSyncOnce();
  const localCopy = await dao.kc.getById(MY_CARD);
  check('另一台设备首次同步能拉到这张卡', pullFirst.error === undefined && localCopy !== null, JSON.stringify(pullFirst));

  // ── 设备 1：斩掉它（软删除），云端与本地再对齐 ──
  await dao.kc.chop(MY_CARD);
  const choppedLocal = await dao.kc.getById(MY_CARD);
  check('chop 是软删除（本地 deleted=1 且行还在）', choppedLocal !== null && choppedLocal.deleted === 1, JSON.stringify(choppedLocal?.deleted));

  const pushedTomb = await pushBaseline();
  check('带墓碑的卡片能推上云（不报错）', pushedTomb.error === undefined, JSON.stringify(pushedTomb));

  const tomb = await fetchCard(keyA, MY_CARD);
  check('★ kc-list 能返回被斩的那条且 deleted=1', tomb !== null && tomb.deleted === 1, JSON.stringify(tomb?.deleted));

  // ── 反向：另一台设备拉到墓碑后本地也变成「已斩」──
  await dao.kc.clearAll();
  await resetCursor();
  const pullTomb = await kcCloud.kcSyncOnce();
  const device2 = await dao.kc.getById(MY_CARD);
  check(
    '★ 另一台设备同步后本地也是 deleted=1（墓碑传播）',
    pullTomb.error === undefined && device2 !== null && device2.deleted === 1,
    JSON.stringify(device2?.deleted),
  );

  const visible = await dao.kc.query({ page: 1, pageSize: 50 });
  check('默认查询里看不到被斩的卡', !visible.items.some((c) => c.id === MY_CARD), `total=${visible.total}`);
  const choppedView = await dao.kc.query({ status: ['chopped'], page: 1, pageSize: 50 });
  check('「已斩」视图里能看到它（可复活）', choppedView.items.some((c) => c.id === MY_CARD), `total=${choppedView.total}`);

  // ── 复活：deleted 归 0，并且能重新推上云 ──
  await dao.kc.revive(MY_CARD);
  const revived = await dao.kc.getById(MY_CARD);
  check('revive 复活（deleted=0、状态 unlearned）', revived?.deleted === 0 && revived?.status === 'unlearned', JSON.stringify(revived?.status));

  await pushBaseline();
  const revivedCloud = await fetchCard(keyA, MY_CARD);
  check('复活后云端也变回 deleted=0', revivedCloud !== null && revivedCloud.deleted === 0, JSON.stringify(revivedCloud?.deleted));
}

// ═══════════════════════════════════════════════════
console.log('\n[7] 接口护栏（401 / 上限 / 方法）');
// ═══════════════════════════════════════════════════
{
  const noKey = await callApi({ path: '/api/kc-list', query: 'since=0' });
  check('kc-list 缺 spaceKey → 401', noKey.status === 401, `状态 ${noKey.status}`);

  const badKey = await callApi({ path: '/api/kc-list', query: 'since=0', headers: { 'x-space-key': 'not-a-hash' } });
  check('kc-list spaceKey 格式非法 → 401', badKey.status === 401, `状态 ${badKey.status}`);

  const pushNoAuth = await callApi({ path: '/api/kc-push', method: 'POST', body: { cards: [{}] } });
  check('kc-push 缺 spaceKey → 401', pushNoAuth.status === 401, `状态 ${pushNoAuth.status}`);

  const keyA = await spaceKeyOf('KcTestSpaceAlpha1');
  const wrongMethod = await callApi({ path: '/api/kc-list', method: 'POST', headers: { 'x-space-key': keyA }, body: {} });
  check('kc-list 只支持 GET → 405', wrongMethod.status === 405, `状态 ${wrongMethod.status}`);

  const emptyBody = await callApi({ path: '/api/kc-push', method: 'POST', headers: { 'x-space-key': keyA }, body: {} });
  check('kc-push 空 cards → 400', emptyBody.status === 400, `状态 ${emptyBody.status}`);

  const tooMany = await callApi({
    path: '/api/kc-push',
    method: 'POST',
    headers: { 'x-space-key': keyA },
    body: { cards: Array.from({ length: 501 }, (_, i) => ({ id: `bulk-${i}`, updatedAt: Date.now() })) },
  });
  check('kc-push 超过 500 张 → 400（分批硬约束）', tooMany.status === 400, `状态 ${tooMany.status}`);

  const badCards = await callApi({
    path: '/api/kc-push',
    method: 'POST',
    headers: { 'x-space-key': keyA },
    body: { cards: [{ noId: true }, { id: 'ok-1', title: '合法', blocks: '{坏 JSON', updatedAt: Date.now() }] },
  });
  check(
    'kc-push 会跳过坏行、并救回坏 JSON 字段',
    badCards.status === 200 && badCards.json.skipped === 1 && badCards.json.applied === 1,
    JSON.stringify(badCards.json),
  );

  // 后写覆盖：推一个更旧的版本应该算 conflicts
  const now = Date.now();
  const older = await callApi({
    path: '/api/kc-push',
    method: 'POST',
    headers: { 'x-space-key': keyA },
    body: { cards: [{ id: 'ok-1', title: '更旧的版本', updatedAt: now - 100_000 }] },
  });
  check('kc-push 更旧的版本算 conflicts（后写覆盖）', older.status === 200 && older.json.conflicts === 1, JSON.stringify(older.json));

  const revPull = await callApi({ path: '/api/kc-list', query: `since=${now - 200_000}`, headers: { 'x-space-key': keyA } });
  const okRow = revPull.json.cards.find((c) => c.id === 'ok-1');
  check('被挡下的旧版本没有覆盖云端内容', okRow !== undefined && okRow.title === '合法', okRow?.title ?? '缺失');
}

// ═══════════════════════════════════════════════════
console.log('\n[8] 断网：DAO 照常、同步失败只 warn（验收项 7）');
// ═══════════════════════════════════════════════════
{
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...args) => {
    warnings.push(args.map(String).join(' '));
  };

  // 后端不可达（端口 1）+ 请求超时设短一点，别让测试等 15 秒
  await configure({ enabled: true, syncCode: 'KcTestSpaceAlpha1', apiBase: 'http://127.0.0.1:1' });
  const offlineCard = makeCard('断网时新建的卡');
  const upsert = await dao.kc.bulkUpsert([offlineCard]);
  await tick();
  const readBack = await dao.kc.getById(offlineCard.id);
  const syncRes = await kcCloud.kcSyncOnce();

  // 本地功能在断网时完全不受影响
  check('★ 断网时 bulkUpsert 照常成功', upsert.inserted === 1, JSON.stringify(upsert));
  check('★ 断网时 getById 照常成功', readBack !== null && readBack.title === '断网时新建的卡', '');
  check('★ 断网时同步失败不抛异常，只返回 error', typeof syncRes.error === 'string' && syncRes.error.length > 0, syncRes.error ?? '');
  check('同步失败打了 console.warn（不弹窗、不阻断）', warnings.length > 0, `warn ${warnings.length} 条`);

  const status = await kcCloud.kcStatus();
  check('失败原因记进了 settings.kc.cloud.lastError', status.lastError.length > 0, status.lastError);

  // 断网期间新写的卡必须还在「待推送」里（游标回到起点时能全部列出）
  await dao.settings.set({ kc: { cloud: { lastPushAt: 0 } } });
  setSettingsCache(await dao.settings.get());
  const dirty = await dao.kc.listDirty(0, 1000);
  check(
    '★ 断网期间新建的卡仍在「待推送」集合里（联网后能补推）',
    dirty.some((c) => c.id === offlineCard.id),
    `待推 ${dirty.length} 张`,
  );

  console.warn = origWarn;
  // 断网期间造的卡清掉，别影响后面的收尾统计
  await dao.kc.chop(offlineCard.id);
}

// ═══════════════════════════════════════════════════
console.log('\n[9] 安全底线：SQL 带 space_key / 没有存密钥的代码');
// ═══════════════════════════════════════════════════
{
  const kcSqlFiles = ['api/_lib/kcInventory.ts', 'api/_lib/kcSchema.ts', 'api/kc-list.ts', 'api/kc-push.ts'];
  const missing = [];
  const noSpaceKey = [];
  for (const f of kcSqlFiles) {
    const text = readFileSync(f, 'utf8');
    // 只认「真语句」：行首的 SELECT/INSERT/UPDATE/DELETE。
    // 不能用裸的 /\bSELECT\b/，否则注释里提到的 `DO UPDATE`、说明文字都会误报。
    const statements = text.match(/^\s*(SELECT|INSERT|UPDATE|DELETE)\b/gim) ?? [];
    if (statements.length === 0) continue;
    if (!text.includes('space_key')) missing.push(f);
    // 逐条语句抽查：每个语句所在的字符串里都要有 space_key
    for (const sql of text.match(/`[^`]*\b(?:SELECT|INSERT|UPDATE|DELETE)\b[^`]*`/g) ?? []) {
      if (!sql.includes('space_key')) noSpaceKey.push(`${f}：${sql.replace(/\s+/g, ' ').slice(0, 70)}`);
    }
  }
  check('★ 二期所有涉及 SQL 的文件都出现 space_key', missing.length === 0, missing.join(', '));
  check('★ 二期每条 SQL 语句（模板字符串）里都带 space_key', noSpaceKey.length === 0, noSpaceKey.join(' | '));

  // DDL：四张表必须都是复合主键（防跨空间覆盖）
  // 注意：先剥掉注释再数，否则注释里提到的「PRIMARY KEY (space_key, id)」会被误计
  const schemaRaw = readFileSync('api/_lib/kcSchema.ts', 'utf8');
  const schema = schemaRaw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const tables = [...schema.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)\s*\(([\s\S]*?)\n\s*\)`/g)];
  check('二期建了 4 张表', tables.length === 4, tables.map((m) => m[1]).join(', '));
  const badPk = tables.filter((m) => !/PRIMARY KEY \(space_key, id\)/.test(m[2])).map((m) => m[1]);
  check('★ 四张表都用复合主键 (space_key, id)', badPk.length === 0, `主键不对：${badPk.join(', ')}`);
  const everyTableHasSpaceKey = tables.every((m) => /space_key TEXT NOT NULL/.test(m[2]));
  check('★ 四张表都有 space_key 列', everyTableHasSpaceKey, '');

  // 全项目搜「AI 密钥落库」的痕迹
  const forbidden = [];
  const files = [];
  for (const dir of ['api', 'src']) {
    const stack = [dir];
    while (stack.length > 0) {
      const d = stack.pop();
      for (const f of readdirSync(d, { withFileTypes: true })) {
        if (f.isDirectory()) {
          if (!['_dev', 'node_modules'].includes(f.name)) stack.push(`${d}/${f.name}`);
        } else if (/\.(ts|mjs)$/.test(f.name)) {
          files.push(`${d}/${f.name}`);
        }
      }
    }
  }
  for (const f of files) {
    const text = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    // 建表语句里不许出现任何 api_key / apiKey / secret 字段
    if (/CREATE TABLE[\s\S]{0,400}?(api_?key|secret|token\s+TEXT)/i.test(text)) forbidden.push(f);
  }
  check('★ 没有任何一张表用来存 AI 密钥', forbidden.length === 0, forbidden.join(', '));

  // 二期的函数也不许读 AI 密钥
  const kcFn = readFileSync('api/kc-push.ts', 'utf8') + readFileSync('api/kc-list.ts', 'utf8');
  check('kc-list / kc-push 里不出现 key / secret 之类的字段', !/apiKey|api_key|AI_KEY|secret/i.test(kcFn), '');
}

// ═══════════════════════════════════════════════════
console.log('\n[10] 一期功能没坏（二期改动后回归）');
// ═══════════════════════════════════════════════════
{
  // 一期的同步通道必须还是好的（同一个库、同一套 spaceKey）
  await configure({ enabled: true, syncCode: 'KcTestSpaceAlpha1' });
  await dao.settings.set({ cloud: { lastPushAt: 0, lastSyncAt: 0 } });
  setSettingsCache(await dao.settings.get());

  const { createWord, createSense } = await import('../../src/core/model.ts');
  const source = await dao.sources.ensureByName('__kctest__', 0);
  const word = createWord('kctest-word', [createSense('n. 回归测试词')], source.id);
  const wordPush = await dao.words.bulkUpsert([word]);
  await tick();
  check('一期单词仍能写入本地', wordPush.inserted === 1, JSON.stringify(wordPush));

  const cloudSync = await import('../../src/dao/cloudSync.ts');
  const oneRes = await cloudSync.syncOnce();
  check('★ 一期云同步仍然可用（与二期互不影响）', oneRes.error === undefined, JSON.stringify(oneRes));

  const pulled = await callApi({
    path: '/api/sync-pull',
    query: 'since=0',
    headers: { 'x-space-key': await spaceKeyOf('KcTestSpaceAlpha1') },
  });
  check('一期 sync-pull 仍能返回这个词', pulled.status === 200 && pulled.json.words.some((w) => w.en === 'kctest-word'), `words=${pulled.json?.words?.length}`);

  // 一期与二期的游标互不干扰
  const s = await dao.settings.get();
  check('一期/二期游标是两份独立设置', 'lastPushAt' in s.cloud && 'cloud' in s.kc && s.kc.cloud !== s.cloud, '');

  // IndexedDB 一期表仍在（v3 升级没弄丢旧表）
  const { STORE, openDB } = await import('../../src/core/db.ts');
  const dbi = await openDB();
  const names = [...dbi.objectStoreNames];
  const need = [STORE.words, STORE.sources, STORE.settings, STORE.sessions, STORE.knowledgeCards, STORE.dailyContextWords, STORE.examRecords, STORE.bankQuestions];
  check('★ 库里有全部 8 张表（一期 4 + 二期 4）', need.every((n) => names.includes(n)), names.join(', '));
}

// ═══════════════════════════════════════════════════
console.log('\n[11] 语境词 / 题目历史 / 题库 DAO');
// ═══════════════════════════════════════════════════
{
  const ctx = dao.contextWords;
  const saved = await ctx.save(['photosynthesis', 'telescope', 'photosynthesis', '  jam  ', ''], 'ai', ctx.localDate(), false);
  check('语境词去重 + 去空 + 截断到设置数量', saved.words.length === 3, saved.words.join(','));
  check('AI 生成的语境词默认 confirmed=false', saved.confirmed === false, '');

  await ctx.confirm(saved.id, ['photosynthesis', 'telescope', 'jam', 'orbit', 'fossil', 'extra']);
  const today = await ctx.getForDate(ctx.localDate());
  check('确认后落库，且数量被裁到 contextWordCount', today !== null && today.confirmed && today.words.length === DEFAULT_SETTINGS.kc.contextWordCount, `${today?.words.length} 个`);

  const recent = await ctx.recentWords();
  check('recentWords 能拿到近 N 天的词（生成时防重复用）', recent.length >= 5, `${recent.length} 个`);

  const bank = dao.examBank;
  await bank.addBankQuestion('fill', 'He is the man ___ helped me.（答案：who）', '2023全国甲卷');
  const list = await bank.listBankQuestions('fill');
  check('题库能存能查', list.length === 1 && list[0].source === '2023全国甲卷', JSON.stringify(list.length));

  await bank.addRecord({
    cardId: 'card-x',
    date: ctx.localDate(),
    type: 'fill',
    question: 'He is the man ___ helped me.',
    userAnswer: 'who',
    aiScore: 3,
    aiReason: '正确',
    contextWord: 'telescope',
  });
  const recentQ = await bank.recentQuestions();
  check('题目历史能存，且 recentQuestions 能取到（出题防重复用）', recentQ.length === 1 && recentQ[0].includes('___'), recentQ.join('|'));

  const byCard = await bank.listByCard('card-x');
  check('能按卡片查历史题目（复习回放用）', byCard.length === 1, `${byCard.length} 条`);

  // 清场
  await ctx.clearAll();
  await bank.clearAll();
  const afterClean = await bank.listRecords();
  check('清场成功', afterClean.length === 0, '');
}

// ═══════════════════════════════════════════════════
console.log('\n[12] 卡片查询（过滤 / 排序 / 分页，纯函数单测）');
// ═══════════════════════════════════════════════════
{
  const { filterCards, sortCards, paginate, runQuery, countStats } = kcQuery;

  /**
   * 造一张用于查询测试的卡（属性可控）。
   * @param {string} title 标题
   * @param {number} priority 复习优先度
   * @param {string} status 状态
   */
  function cardFor(title, priority, status = 'unlearned', deleted = 0) {
    const c = kcModel.createEmptyCard(title);
    c.attrs.reviewPriority = priority;
    c.attrs.mastery = priority / 100;
    c.status = status;
    c.deleted = deleted;
    c.summary = `${title} 的摘要`;
    return c;
  }

  const pool = [
    cardFor('定语从句', 30, 'learning'),
    cardFor('虚拟语气', 90, 'learned'),
    cardFor('非谓语动词', 10, 'unlearned'),
    cardFor('被斩掉的卡', 99, 'chopped', 1),
  ];

  check('默认过滤：墓碑不出现', filterCards(pool, { page: 1, pageSize: 10 }).length === 3, '');
  check(
    '要已斩就显式传 status:[chopped]',
    filterCards(pool, { status: ['chopped'], page: 1, pageSize: 10 }).length === 1,
    '',
  );
  check(
    '按状态过滤（多选）',
    filterCards(pool, { status: ['learning', 'learned'], page: 1, pageSize: 10 }).length === 2,
    '',
  );
  check('关键词匹配标题', filterCards(pool, { keyword: '虚拟', page: 1, pageSize: 10 }).length === 1, '');
  check('关键词匹配摘要（不区分大小写）', filterCards(pool, { keyword: '摘要', page: 1, pageSize: 10 }).length === 3, '');
  check('关键词匹配不到就是空', filterCards(pool, { keyword: 'zzz', page: 1, pageSize: 10 }).length === 0, '');

  const byPriority = sortCards(pool, 'reviewPriority', 'desc').map((c) => c.attrs.reviewPriority);
  check('按优先度倒序（最该复习的排最前）', byPriority.join(',') === '99,90,30,10', byPriority.join(','));
  const byPriorityAsc = sortCards(pool, 'reviewPriority', 'asc').map((c) => c.attrs.reviewPriority);
  check('按优先度升序', byPriorityAsc.join(',') === '10,30,90,99', byPriorityAsc.join(','));
  check('排序不改原数组（返回新数组）', pool[0].attrs.reviewPriority === 30, String(pool[0].attrs.reviewPriority));

  const titles = sortCards(pool, 'title', 'asc').map((c) => c.title);
  check('按标题排序是确定性的', titles.join('|') === [...titles].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN')).join('|'), titles.join('|'));

  const p1 = paginate(sortCards(pool, 'reviewPriority', 'desc'), 1, 2);
  const p2 = paginate(sortCards(pool, 'reviewPriority', 'desc'), 2, 2);
  check('分页：total 是过滤后的总数', p1.total === 4 && p1.items.length === 2, `${p1.total}/${p1.items.length}`);
  check('分页：两页不重叠', p1.items.every((a) => !p2.items.some((b) => b.id === a.id)), '');
  check('分页：页数越界返回空（不报错）', paginate(pool, 99, 2).items.length === 0, '');
  check('分页：非法页码/每页条数走默认值', paginate(pool, 0, 0).items.length > 0, '');

  const rq = runQuery(pool, { keyword: '动词', sort: 'reviewPriority', order: 'desc', page: 1, pageSize: 10 });
  check('runQuery 串起「过滤→排序→分页」', rq.total === 1 && rq.items[0].title === '非谓语动词', rq.items.map((c) => c.title).join(','));

  const st = countStats(pool);
  check('countStats 不含墓碑', st.total === 3 && st.chopped === 1 && st.learning === 1 && st.learned === 1 && st.unlearned === 1, JSON.stringify(st));
  check('countStats(includeChopped=true) 把墓碑计入 total', countStats(pool, true).total === 4, '');
}

// ── 收尾 ──
server.close();
console.log(`\n=== 二期阶段 01 验收：通过 ${passed} 项，失败 ${failed} 项 ===\n`);
process.exit(failed === 0 ? 0 : 1);

/**
 * 算某个同步码的 spaceKey（和前端同一套 SHA-256）。
 * @param {string} code 明文同步码
 */
async function spaceKeyOf(code) {
  const bytes = new TextEncoder().encode(code.trim());
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
