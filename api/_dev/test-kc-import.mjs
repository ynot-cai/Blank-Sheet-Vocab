/**
 * 阶段 02 验收脚本：`npm run test:kc-import`
 *
 * 这一份**不需要 AI 密钥**：它测的是「AI 返回之后」的全部逻辑
 * （解析、降级、逐块校验、清洗、钳制、入库）。真正的模型调用由用户在浏览器里跑一次。
 *
 * 覆盖阶段 02 验收标准：
 *   3. 各种块都能渲染（用最小 DOM 桩跑一遍 `renderBlocks`）
 *   4. XSS：含 `<script>` 的内容渲染成纯文本
 *   6. `examLoad.estMinutes` 在 3~5 之间
 *   7. 「采纳 → 确认入库」→ 数据库里能看到、字段完整
 *   8. 不重复生成：已有标题会传给 AI（检查提示词里真的带了标题）
 *   9. AI 返回非法 JSON 时有明确提示、不崩溃
 *  10. 一期功能完好（本脚本不动一期数据，由 npm test 全量回归覆盖）
 */
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { loadEnvFiles } from './envFile.mjs';
import 'fake-indexeddb/auto';

loadEnvFiles('..');

const DB_FILE = './.tmp/test-kc-import.db';
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

const parse = await import('../../src/services/kcImportParse.ts');
const kcAi = await import('../../src/services/kcAi.ts');
const kcPrompts = await import('../../src/services/kcPrompts.ts');
const kcModel = await import('../../src/core/kcModel.ts');
const blockRender = await import('../../src/core/blockRender.ts');
const kcTypes = await import('../../src/core/kcTypes.ts');
const dao = await import('../../src/dao/index.ts');
const { setSettingsCache, DEFAULT_SETTINGS, KC } = await import('../../src/core/config.ts');
const fixture = await import('./kcImportFixture.mjs');
/** 假 AI 返回（历史记忆那一组要拿它当"上一轮 AI 的原始返回"） */
const { FAKE_IMPORT_REPLY } = fixture;

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

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

/**
 * 装一个最小 DOM 桩（只允许 textContent 承载文本，与 test-kc.mjs / test-kc-edit.mjs 同款）。
 *
 * 为什么抽成函数：本次有三处要用（解析后的安全渲染、无表头表格渲染、历史压缩文本），
 * 各写一份的话改动一处就会漏掉另一处。
 */
function installDomStub() {
  let seq = 0;
  class StubNode {
    constructor(tag) {
      this.tag = tag;
      this.children = [];
      this.attributes = {};
      this.classes = new Set();
      this._text = '';
      seq += 1;
      this.id = `n${seq}`;
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
      this._text = String(v);
    }
    get textContent() {
      return this._text + this.children.map((c) => c.textContent ?? '').join('');
    }
    appendChild(child) {
      this.children.push(child);
      return child;
    }
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
}

// ───────────────────────────────────────────────
console.log('\n[1] 提示词：规则齐全、题型表只有一份');
// ───────────────────────────────────────────────
{
  const sys = kcPrompts.KC_IMPORT_SYSTEM_PROMPT;
  check('system 提示词要求「严格 JSON、不要 markdown」', /严格 JSON/.test(sys) && /不要 markdown/.test(sys), '');
  check('含自动拆分规则（2~5 个知识点）', /自动拆分/.test(sys) && /2~5/.test(sys), '');
  // ★ 用户反馈：原来写「内容完整 / 讲透」，模型就吐教科书式长篇，复习时根本记不住。
  //   现在明确要求极简，所以这里反过来断言「啰嗦导向的话已经删干净」。
  check('★ 不再要求「内容完整」（改成极简导向）', !/内容完整/.test(sys), '');
  check('★ 明确要求只留记忆痛点、越简洁越好', /记忆痛点/.test(sys) && /简洁/.test(sys), '');
  check('★ 限定了每张卡的块数与篇幅（2~4 个块）', /2~4 个块/.test(sys), '');
  check('★ 要求用对照式表述（有 the 时… / 无 the 时…）', /有 the 时/.test(sys) && /无 the 时/.test(sys) && /对照/.test(sys), '');
  check('★ 限制例句数量（最多 1~2 个）', /例句最多 1~2 个/.test(sys), '');
  check('★ 明确要求表格不写表头行（第一行也是数据）', /表头行/.test(sys) && /第一行也是数据/.test(sys), '');
  check('★ 示例里的表格本身也不含表头（示例最容易带坏模型）', /"type":"table","rows":\[\["in charge of/.test(sys), '');
  check('含 8 种块类型说明', ['heading', 'text', 'example', 'list', 'table', 'code', 'quote', 'tip'].every((t) => sys.includes(t)), '');
  check('含考核标签规则（1~3 种）', /考核标签/.test(sys), '');
  check('含出题量规则（3~5 分钟）', /3~5 分钟/.test(sys), '');
  check('要求例句配中文翻译', /中文翻译/.test(sys), '');
  check('明确要求 content 里不写 HTML/markdown', /不要在里面写 HTML/.test(sys), '');

  // 题型清单必须从 EXAM_TYPES 生成，不能手写第二份
  const ids = kcTypes.EXAM_TYPES.map((t) => t.id);
  check('提示词里的题型来自 EXAM_TYPES（四种 id 都在）', ids.every((id) => sys.includes(`\`${id}\``)), ids.join(','));

  const user = kcPrompts.kcImportUserPrompt('我在定语从句这块不行', ['虚拟语气', '非谓语动词']);
  check('user 提示词带上了用户原话', user.includes('我在定语从句这块不行'), '');
  check('★ user 提示词带上了已有标题（防重复生成）', user.includes('虚拟语气') && user.includes('非谓语动词'), '');
  check('没有已有标题时给占位说明（不出现空列表）', kcPrompts.kcImportUserPrompt('x', []).includes('暂无已有知识点'), '');
  check('已有标题里的空白项会被剔掉', !kcPrompts.kcImportUserPrompt('x', ['  ', '']).includes('-  '), '');

  // 阶段 05 把「出题/评分/语境词」三套提示词拆到了 kcExamPrompts.ts
  // （录入与考核是两条链路，分文件后改一个不用滚动另一个）
  const examPrompts = await import('../../src/services/kcExamPrompts.ts');
  check(
    '★ 出题/评分/语境词提示词在 kcExamPrompts.ts 里（与录入分开但同样集中）',
    typeof examPrompts.KC_EXAM_SYSTEM_PROMPT === 'string' &&
      typeof examPrompts.KC_GRADE_SYSTEM_PROMPT === 'string' &&
      typeof examPrompts.KC_CONTEXT_SYSTEM_PROMPT === 'string' &&
      examPrompts.KC_EXAM_SYSTEM_PROMPT.length > 100,
    '',
  );
  check('录入提示词仍在 kcPrompts.ts（各归各位）', kcPrompts.KC_IMPORT_SYSTEM_PROMPT.length > 100, '');
}

// ───────────────────────────────────────────────
console.log('\n[2] 解析：正常返回（验收标准 3 / 6）');
// ───────────────────────────────────────────────
let parsed = null;
{
  parsed = parse.parseImportReply(fixture.FAKE_IMPORT_REPLY, '我在定语从句这块不行');
  check('解析成功、无错误', parsed.error === undefined, parsed.error ?? '');
  check('拆出 2 张卡', parsed.cards.length === 2, `实际 ${parsed.cards.length}`);

  const first = parsed.cards[0];
  check('第一张卡标题正确', first?.title === '定语从句：关系代词 vs 关系副词', first?.title ?? '');
  check('摘要保留', first?.summary.includes('关系代词'), first?.summary ?? '');

  const types = new Set((first?.blocks ?? []).map((b) => b.type));
  const want = ['heading', 'text', 'example', 'list', 'table', 'quote', 'code', 'tip'];
  check(`★ 8 种块类型全部保留（${want.join('/')}）`, want.every((t) => types.has(t)), [...types].join(','));
  check('丢掉了 1 个「根本不是对象」的坏块（null）', parsed.droppedBlocks === 1, `droppedBlocks=${parsed.droppedBlocks}`);
  check(
    '★ 缺 type 的块被降级成 text 并**保留内容**（宁朴素不丢知识）',
    first?.blocks.length === 9 && first.blocks.some((b) => b.type === 'text' && b.content.includes('onerror')),
    `块数 ${first?.blocks.length}`,
  );
  check('坏块没影响好块（8 个正常块 + 1 个降级块）', first?.blocks.length === 9, `实际 ${first?.blocks.length}`);
  check('表格块结构正确（首行表头 3 列）', first?.blocks.find((b) => b.type === 'table')?.rows?.[0].length === 3, '');
  check('列表块每项是字符串', (first?.blocks.find((b) => b.type === 'list')?.items ?? []).every((i) => typeof i === 'string'), '');
  check('例句带翻译', (first?.blocks.find((b) => b.type === 'example')?.translation ?? '') !== '', '');

  check('★ 未知题型 essay 被过滤掉', !first?.examTags.includes('essay'), first?.examTags.join(','));
  check('合法题型保留（fill + choice）', first?.examTags.join(',') === 'fill,choice', first?.examTags.join(','));
  check('★ estMinutes 越界被钳到 5（AI 给了 12）', first?.examLoad.estMinutes === DEFAULT_SETTINGS.kc.examLoadMaxMinutes, String(first?.examLoad.estMinutes));
  check('第二张卡的 estMinutes=3 保持不变', parsed.cards[1]?.examLoad.estMinutes === 3, String(parsed.cards[1]?.examLoad.estMinutes));
  check('来源记下了用户原话', first?.source.raw === '我在定语从句这块不行', first?.source.raw ?? '');
  check(
    '每张卡都通过 validateCard（补上 id 后）',
    kcAi.toKnowledgeCards(parsed.cards, 4).every((c) => kcModel.validateCard(c).length === 0),
    JSON.stringify(kcAi.toKnowledgeCards(parsed.cards, 4).map((c) => kcModel.validateCard(c))),
  );
}

// ───────────────────────────────────────────────
console.log('\n[3] 解析降级：非法 JSON 处理（验收标准 9）');
// ───────────────────────────────────────────────
{
  const bad = parse.parseImportReply(fixture.FAKE_BAD_REPLY, '非谓语动词');
  check('★ 夹在解释文字里的 JSON 能被抠出来', bad.error === undefined && bad.cards.length === 1, bad.error ?? `cards=${bad.cards.length}`);
  check('抠出来的卡内容正确', bad.cards[0]?.title === '非谓语动词', bad.cards[0]?.title ?? '');

  const fenced = parse.parseImportReply(fixture.FAKE_FENCED_REPLY, '虚拟语气');
  check('★ markdown 代码围栏能被剥掉', fenced.error === undefined && fenced.cards.length === 1, fenced.error ?? '');

  const garbage = parse.parseImportReply(fixture.FAKE_GARBAGE_REPLY, '随便说点');
  check('★ 完全不是 JSON → 有明确 error，不抛异常', typeof garbage.error === 'string' && garbage.error.includes('JSON'), garbage.error ?? '');
  check('失败时 cards 是空数组（界面据此显示重试）', garbage.cards.length === 0, '');

  const empty = parse.parseImportReply(fixture.FAKE_EMPTY_REPLY, '全都说过了');
  check('cards:[] → 不报错、0 张卡（界面提示「都已有卡片」）', empty.error === undefined && empty.cards.length === 0, '');

  check('extractFirstJsonObject 能处理字符串里的花括号', parse.extractFirstJsonObject('{"a":"}{"}') === '{"a":"}{"}', '');
  check('extractFirstJsonObject 对无 JSON 返回 null', parse.extractFirstJsonObject('没有花括号') === null, '');
  check('clampEstMinutes(NaN) 用默认值', parse.clampEstMinutes(Number.NaN) === DEFAULT_SETTINGS.kc.examLoadDefaultMinutes, '');
  check('clampEstMinutes(0 / -1 / "x") 都用默认值', parse.clampEstMinutes(0) === 4 && parse.clampEstMinutes(-1) === 4 && parse.clampEstMinutes('x') === 4, '');
  check('clampEstMinutes(3.4) → 3（四舍五入到整数）', parse.clampEstMinutes(3.4) === 3, '');
}

// ───────────────────────────────────────────────
console.log('\n[4] 安全渲染：AI 输出里的攻击载荷（验收标准 4）');
// ───────────────────────────────────────────────
{
  // 最小 DOM 桩（与 test-kc.mjs 同款）：只允许 textContent 承载文本
  installDomStub();

  const cards = kcAi.toKnowledgeCards(parsed.cards, 4);
  const frag = blockRender.renderBlocks(cards[0].blocks);
  const nodes = frag.all(() => true);
  const tags = new Set(nodes.map((n) => n.tag));
  check('AI 内容渲染不抛异常', frag.children.length === cards[0].blocks.length, '');
  check('★ 没有创建 script/img/svg 元素', !['script', 'img', 'svg', 'iframe'].some((t) => tags.has(t)), [...tags].join(','));
  check('★ 攻击载荷以纯文本出现', nodes.some((n) => n._text.includes('<script>')), '');
  check(
    '★ 被降级成 text 的那块，img onerror 也只当普通文字（没变成 img 元素）',
    nodes.some((n) => n._text.includes('onerror')) && !tags.has('img'),
    '',
  );
  check('★ 没有任何属性被拼进 DOM', nodes.every((n) => Object.keys(n.attributes).length === 0), '');
  check('哨兵未被置位', globalThis.window.__kcXssFired === undefined, '');

  // ── 表格：无表头（用户明确要求） ──
  // 用**老格式的数据**（第一行就是表头文本）来测：库里存量卡片就是这样，
  // 渲染端不许去猜哪行是表头，否则会悄悄吃掉用户的一行数据。
  const legacyTable = {
    id: 'tb1',
    type: 'table',
    rows: [['关系词', '先行词', '从句成分'], ['where', '地点', '状语'], ['which', '物', '主语/宾语']],
  };
  const tf = blockRender.renderBlocks([legacyTable]);
  const tTags = tf.all(() => true).map((n) => n.tag);
  check('★ 表格不再生成 thead', !tTags.includes('thead'), tTags.join(','));
  check('★ 表格不再生成 th（老的"表头行"按普通数据行显示）', !tTags.includes('th'), tTags.join(','));
  check('★ 3 行全部渲染成数据行（3 个 tr / 9 个 td）', tTags.filter((t) => t === 'tr').length === 3 && tTags.filter((t) => t === 'td').length === 9, tTags.join(','));
  check('老表头行的文字没丢（只是不再当表头）', tf.textContent.includes('关系词') && tf.textContent.includes('状语'), '');
  const oneRow = blockRender.renderBlocks([{ id: 'tb2', type: 'table', rows: [['只有一行数据', '也是合法的']] }]);
  check('★ 只有 1 行的表格合法且能渲染（不再假设"表头 + 数据 ≥ 2 行"）', oneRow.all(() => true).filter((n) => n.tag === 'td').length === 2, '');
  check('validateBlock 接受单行表格（解析/校验层的一起放宽）', kcModel.validateBlock({ id: 'tb3', type: 'table', rows: [['a', 'b']] }).length === 0, '');
  check('coerceBlock 保留单行表格（不再补成两行）', kcModel.coerceBlock({ type: 'table', rows: [['a', 'b']] }).rows.length === 1, '');

  delete globalThis.document;
}

// ───────────────────────────────────────────────
console.log('\n[5] 上下文记忆：第二轮请求真的带上了历史（需求 B）');
// ───────────────────────────────────────────────
{
  /**
   * 起一个假的 AI 上游（OpenAI 兼容），把收到的请求体原样记下来。
   *
   * 为什么必须真发一次请求：光测 `buildKcMessages` 只能证明"数组拼对了"，
   * 证明不了**它真的被塞进请求体**——中间还有 chatComplete、路由兜底、JSON 序列化三层。
   * 二期其它 AI 测试也都是这个套路（假上游 + 断言收到的 body）。
   */
  const received = [];
  const upstream = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      received.push(Buffer.concat(chunks).toString('utf8'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: FAKE_IMPORT_REPLY } }] }));
    });
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const cfg = { endpoint: `http://127.0.0.1:${upstream.address().port}`, model: 'fake', key: 'fake-key' };
  /** 取第 n 次请求的 messages */
  const messagesOf = (n) => JSON.parse(received[n] ?? '{}').messages ?? [];

  // ── 第一轮：没有历史，就是以前的形状 ──
  const turn1 = await kcAi.analyzeWeakPoint('我在定语从句这块不行', [], cfg);
  check('第一轮照常返回 2 张卡', turn1.cards.length === 2, turn1.error ?? String(turn1.cards.length));
  check('没有历史时省略轮数是 0', turn1.omittedTurns === 0, String(turn1.omittedTurns));
  const m1 = messagesOf(0);
  check('★ 第一轮请求只有 system + user（不多发空历史）', m1.length === 2 && m1[0].role === 'system' && m1[1].role === 'user', m1.map((m) => m.role).join(','));

  // ── 第二轮：把第一轮的问答当历史带上 ──
  const history = [
    { role: 'user', content: '我在定语从句这块不行' },
    { role: 'assistant', content: FAKE_IMPORT_REPLY },
  ];
  const turn2 = await kcAi.analyzeWeakPoint('第二个再细一点', [], cfg, history);
  check('第二轮也正常返回', turn2.cards.length === 2, turn2.error ?? String(turn2.cards.length));
  const m2 = messagesOf(1);
  check('★ 历史按顺序排在本轮 user 之前（system 仍在最前）', m2.map((m) => m.role).join(',') === 'system,user,assistant,user', m2.map((m) => m.role).join(','));
  check('★ 历史里的用户原话原样带上', m2[1].content.includes('我在定语从句这块不行'), m2[1].content.slice(0, 60));
  check(
    '★ 历史里的 assistant 是上一轮 AI 的原始 JSON 返回（模型据此知道"第二个"是哪张卡）',
    m2[2].content.includes('关系副词的三种情况') && m2[2].content.trim().startsWith('{'),
    m2[2].content.slice(0, 60),
  );
  check('★ 本轮 user 消息排最后（顺序反了模型就对不上话）', m2[3].content.includes('第二个再细一点'), m2[3].content.slice(0, 60));

  // ── 截断：超过上限的老历史必须被丢掉，并如实回报丢了几条 ──
  const many = [];
  for (let i = 0; i < 10; i += 1) {
    many.push({ role: 'user', content: `第 ${i + 1} 句：虚拟语气又搞混了` });
    many.push({ role: 'assistant', content: `{"cards":[{"title":"第 ${i + 1} 轮的卡片"}]}` });
  }
  const capped = kcAi.buildKcMessages('再说说第三个', [], many);
  check(
    `★ 历史按条数截断（上限 ${KC.maxChatHistoryMessages} 条）`,
    capped.messages.length === KC.maxChatHistoryMessages + 2,
    `实际 ${capped.messages.length} 条`,
  );
  check('★ 被丢掉的条数如实回报（界面据此显示一行灰字）', capped.omittedTurns === many.length - KC.maxChatHistoryMessages, String(capped.omittedTurns));
  check('★ 丢的是最旧的（最近一轮必须留着，否则"第二个"就指不到了）', capped.messages.some((m) => m.content.includes('第 10 轮的卡片')), '');
  check('最旧的那条确实没了', !capped.messages.some((m) => m.content.includes('第 1 轮的卡片')), '');

  // 字符预算：一条超长历史就能顶掉好几轮，条数上限管不住它
  const fat = [
    { role: 'user', content: '一'.repeat(500) },
    { role: 'assistant', content: '二'.repeat(500) },
    { role: 'user', content: '三'.repeat(500) },
    { role: 'assistant', content: '四'.repeat(500) },
  ];
  const squeezed = kcAi.buildKcMessages('继续', [], fat, { maxChars: 1200 });
  // 2000 字 → 丢最旧的一条还剩 1500，仍超 1200 → 再丢一条（400 个字符一条，得丢两条）
  check('★ 字符预算也生效（超了就继续从最旧的丢，丢到不超为止）', squeezed.omittedTurns === 2, String(squeezed.omittedTurns));
  check('最近的那条一定保留', squeezed.messages.some((m) => m.content.startsWith('四')), '');

  // 单条就比整个预算还长：不能把历史清空，也不能把超长请求发出去
  const giant = [{ role: 'assistant', content: 'X'.repeat(9000) }];
  const clipped = kcAi.buildKcMessages('继续', [], giant, { maxChars: 500 });
  const giantMsg = clipped.messages.find((m) => m.role === 'assistant');
  check('★ 单条超长会被按字符硬截（而不是把这条丢掉或原样发出去）', [...String(giantMsg?.content ?? '')].length <= 520, String([...(giantMsg?.content ?? '')].length));

  // 真发一次"历史超长"的请求：确认截断发生在**发出去之前**（不是被服务端拒绝）
  const bigHistory = many.concat(many);
  const turn3 = await kcAi.analyzeWeakPoint('第三个再细一点', [], cfg, bigHistory);
  check('★ 超长历史不会让请求失败（截断在本地完成）', turn3.error === undefined, turn3.error ?? '');
  check('★ 这次请求同样如实回报了省略条数', (turn3.omittedTurns ?? 0) > 0, String(turn3.omittedTurns));
  const m3 = messagesOf(2);
  const historyChars = m3.slice(0, -1).reduce((sum, m) => sum + [...String(m.content)].length, 0);
  // 历史部分 = 总字符 - system - 本轮 user 提示词模板的固定长度，所以按它的长度放宽上限
  const promptOverhead = kcPrompts.kcImportUserPrompt('第三个再细一点', []).length + kcPrompts.KC_IMPORT_SYSTEM_PROMPT.length;
  check(
    `★ 请求体里的历史没超字符预算（${KC.maxChatHistoryChars}）`,
    historyChars <= KC.maxChatHistoryChars + promptOverhead,
    `实际 ${historyChars}（其中固定提示词约 ${promptOverhead}）`,
  );

  upstream.close();
}

// ───────────────────────────────────────────────
console.log('\n[6] 入库：采纳 → 确认入库 → 字段完整（验收标准 7）');
// ───────────────────────────────────────────────
{
  setSettingsCache(DEFAULT_SETTINGS);
  const cards = kcAi.toKnowledgeCards(parsed.cards, DEFAULT_SETTINGS.kc.examLoadDefaultMinutes);
  const res = await dao.kc.bulkUpsert(cards);
  await tick();
  check('入库 2 张', res.inserted === 2, JSON.stringify(res));

  const all = await dao.kc.getAll();
  const mine = all.filter((c) => c.id === cards[0].id || c.id === cards[1].id);
  check('数据库里能查到这 2 张', mine.length === 2, `查到 ${mine.length}`);
  const saved = mine.find((c) => c.id === cards[0].id);
  check('★ 字段完整（标题/摘要/块/标签/出题量/状态/时间戳）', 
    saved !== undefined &&
      saved.title !== '' &&
      saved.summary !== '' &&
      saved.blocks.length === 9 &&
      saved.examTags.length === 2 &&
      saved.examLoad.estMinutes >= 3 &&
      saved.status === 'unlearned' &&
      saved.createdAt > 0 &&
      saved.updatedAt > 0,
    JSON.stringify({ t: saved?.title, b: saved?.blocks.length, tag: saved?.examTags, min: saved?.examLoad.estMinutes, st: saved?.status }),
  );
  check('★ 新录入的卡是 unlearned（阶段 04 的入口条件）', saved?.status === 'unlearned', saved?.status ?? '');
  check('attrs 是初值（mastery 0、没学过）', saved?.attrs.mastery === 0 && saved.attrs.learnedAt === null, JSON.stringify(saved?.attrs));
  check('卡片能通过完整校验', saved !== undefined && kcModel.validateCard(saved).length === 0, '');
}

// ───────────────────────────────────────────────
console.log('\n[7] 防重复生成的前置条件（验收标准 8）');
// ───────────────────────────────────────────────
{
  const all = await dao.kc.getAll();
  const aliveTitles = all.filter((c) => c.deleted !== 1).map((c) => c.title);
  const prompt = kcPrompts.kcImportUserPrompt('我还想补一下定语从句', aliveTitles);
  check('★ 已有（未斩）标题会进提示词', prompt.includes('定语从句：关系代词 vs 关系副词'), '');

  // 已斩的卡片不该进提示词，否则 AI 会以为「这个知识点已经有了」
  const first = all.find((c) => c.title.startsWith('定语从句'));
  await dao.kc.chop(first.id);
  const after = (await dao.kc.getAll()).filter((c) => c.deleted !== 1).map((c) => c.title);
  check('★ 已斩的卡片标题不进提示词（getAll 含墓碑，用之前必须滤掉）', !after.includes(first.title), '');
  await dao.kc.revive(first.id);
}

// ───────────────────────────────────────────────
console.log('\n[8] 手动新建空白卡片（跳过 AI 的兜底路径）');
// ───────────────────────────────────────────────
{
  const blank = kcModel.createEmptyCard(DEFAULT_SETTINGS.kc.untitledName ?? '未命名知识点');
  check('空白卡片本身合法', kcModel.validateCard(blank).length === 0, kcModel.validateCard(blank).join('；'));
  const res = await dao.kc.bulkUpsert([blank]);
  await tick();
  check('空白卡片能入库', res.inserted === 1, JSON.stringify(res));
  await dao.kc.clearAll();
}

// ───────────────────────────────────────────────
console.log('\n[9] 聊天消息 → 请求上下文（entriesToHistory）');
// ───────────────────────────────────────────────
{
  // 这段逻辑住在 `ui/components/kcChatHistory.ts`（从聊天面板拆出来的纯函数）。
  // 为什么单独测：面板里最容易出的错是「把还没回来的占位消息也当历史带上」，
  // 那样模型会看到一条空的 assistant 消息，甚至以为用户同一句话说了两遍。
  const hist = await import('../../src/ui/components/kcChatHistory.ts');
  const oneCard = [{ title: 'T1', summary: 'S1', blocks: [], examTags: [], examLoad: { types: [], estMinutes: 4 }, source: '' }];

  const turns = hist.entriesToHistory([
    { role: 'user', text: '我在定语从句这块不行' },
    { role: 'ai', text: '', loading: true },
  ]);
  check('★ 还在请求中的占位消息不算历史', turns.length === 1 && turns[0].role === 'user', JSON.stringify(turns));

  const withRaw = hist.entriesToHistory([
    { role: 'user', text: '我在定语从句这块不行' },
    { role: 'ai', text: '我帮你拆成了 2 个知识点。', raw: '{"cards":[{"title":"A"}]}', cards: oneCard },
  ]);
  check('★ 回来的那一轮排成 user → assistant', withRaw.map((m) => m.role).join(',') === 'user,assistant', JSON.stringify(withRaw.map((m) => m.role)));
  check('★ assistant 侧优先用原始 JSON 返回（模型据此认得"第二个"）', withRaw[1].content.includes('"cards"'), withRaw[1].content);

  const noRaw = hist.entriesToHistory([
    { role: 'user', text: 'q' },
    { role: 'ai', text: '拆好了', cards: oneCard },
  ]);
  check('没有 raw 时退化成精简文本（序号 + 标题还在）', noRaw[1].content.includes('1. T1'), noRaw[1].content);

  const emptyText = hist.entriesToHistory([{ role: 'user', text: '   ' }, { role: 'ai', text: '' }]);
  check('空消息不进历史（不发空话给模型）', emptyText.length === 0, JSON.stringify(emptyText));
}

console.log(`\n=== 阶段 02 验收（解析层，无需密钥）：通过 ${passed} 项，失败 ${failed} 项 ===\n`);
process.exit(failed === 0 ? 0 : 1);
