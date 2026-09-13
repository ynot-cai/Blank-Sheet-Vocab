/**
 * 阶段 03 验收脚本：`npm run test:kc-edit`
 *
 * 覆盖验收标准 3、4、5、6、8 里**不需要浏览器**的部分：
 *   3. 8 种块类型都能新建 / 编辑 / 保存 / 正确渲染
 *   4. 表格块能增删行列，保存后结构正确（矩形、**无表头**：第一行也是数据行）
 *   5. 搜索能命中**块内容**；按考法筛选；按掌握度排序
 *   6. 斩 → 默认视图消失；切「已斩」能看到并复活
 *   8. XSS：编辑器里输入 `<script>` → 保存后渲染为纯文本
 *
 * 「点按钮」的部分由 `test-kc-edit-ui.mjs`（真浏览器）覆盖。
 */
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { loadEnvFiles } from './envFile.mjs';
import 'fake-indexeddb/auto';

loadEnvFiles('..');

const DB_FILE = './.tmp/test-kc-edit.db';
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

const kcModel = await import('../../src/core/kcModel.ts');
const kcBlock = await import('../../src/core/kcBlock.ts');
const blockRender = await import('../../src/core/blockRender.ts');
const kcQuery = await import('../../src/dao/kcQuery.ts');
const kcTypes = await import('../../src/core/kcTypes.ts');
const dao = await import('../../src/dao/index.ts');
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

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

/** 最小 DOM 桩（与其它二期测试同款：只让 textContent 承载文本） */
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

/** 把一张卡的块渲染成字符串（用于断言「渲染正确」） */
function renderToString(blocks) {
  const frag = blockRender.renderBlocks(blocks);
  return { text: frag.textContent, tags: frag.all(() => true).map((n) => n.tag), classes: frag.all(() => true).flatMap((n) => [...n.classes]) };
}

// ───────────────────────────────────────────────
console.log('\n[1] 8 种块：新建 / 校验 / 渲染（验收标准 3）');
// ───────────────────────────────────────────────
const ALL_TYPES = ['heading', 'text', 'example', 'list', 'table', 'code', 'quote', 'tip'];
{
  installDomStub();
  for (const type of ALL_TYPES) {
    const blank = kcModel.createBlock(type);
    check(`createBlock('${type}') 造出的块合法`, kcModel.validateBlock(blank).length === 0, kcModel.validateBlock(blank).join('；'));
  }
  check('8 种类型全部覆盖（EXAM_TYPES 之外没有遗漏）', ALL_TYPES.every((t) => kcTypes.EXAM_TYPES !== undefined) && ALL_TYPES.length === 8, '');

  // 每种类型塞点内容 → 渲染 → 断言结构
  const filled = [
    { id: 'b1', type: 'heading', content: '小标题' },
    { id: 'b2', type: 'text', content: '正文段落' },
    { id: 'b3', type: 'example', content: 'This is a test.', translation: '这是一个测试。', note: '注意时态' },
    { id: 'b4', type: 'list', items: ['第一项', '第二项'] },
    { id: 'b5', type: 'table', rows: [['A', 'B'], ['1', '2']] },
    { id: 'b6', type: 'code', content: 'const a = 1;', lang: 'js' },
    { id: 'b7', type: 'quote', content: '引用一句' },
    { id: 'b8', type: 'tip', content: '易错点' },
  ];
  const out = renderToString(filled);
  check('8 种块全部渲染成功（不抛异常）', out.text.includes('小标题') && out.text.includes('易错点'), '');
  check('渲染结果包含 h3 / p / ul / table / pre 结构', ['h3', 'p', 'ul', 'table', 'pre'].every((t) => out.tags.includes(t)), [...new Set(out.tags)].join(','));
  check('每个块都挂了 kc-block 类', out.classes.filter((c) => c === 'kc-block').length === 8, `实际 ${out.classes.filter((c) => c === 'kc-block').length}`);
  check('list 渲染成 li（2 项）', out.tags.filter((t) => t === 'li').length === 2, '');
  check('example 的翻译与说明都渲染出来', out.text.includes('这是一个测试。') && out.text.includes('注意时态'), '');
  check('code 的 lang 只作安全 class', out.classes.includes('language-js'), out.classes.filter((c) => c.startsWith('language')).join(','));
  delete globalThis.document;
}

// ───────────────────────────────────────────────
console.log('\n[2] 表格与列表的「增删行列」结构（验收标准 4）');
// ───────────────────────────────────────────────
{
  installDomStub();
  // 表格：3 行 3 列。★ 第一行**不再是表头**（用户明确要求），全部按数据行渲染
  const table = { id: 't1', type: 'table', rows: [['关系词', '先行词', '成分'], ['where', '地点', '状语'], ['which', '物', '主宾']] };
  const out = renderToString([table]);
  check('表格渲染出 3 行（第一行也是数据行）', out.tags.filter((t) => t === 'tr').length === 3, String(out.tags.filter((t) => t === 'tr').length));
  check('★ 不再生成 th（表头不渲染）', out.tags.filter((t) => t === 'th').length === 0, '');
  check('★ 不再生成 thead', out.tags.filter((t) => t === 'thead').length === 0, '');
  check('★ 3 行 9 格全是 td', out.tags.filter((t) => t === 'td').length === 9, String(out.tags.filter((t) => t === 'td').length));
  check('表格内容正确（原来的"表头行"文字没丢）', out.text.includes('关系词') && out.text.includes('where'), '');

  // 单行表格：以前隐含"表头 + 数据 ≥ 2 行"的假设，现在 1 行就是合法表格
  const oneRow = { id: 't4', type: 'table', rows: [['只有一行数据', '也是合法的']] };
  const oneOut = renderToString([oneRow]);
  check('★ 单行表格能渲染（1 个 tr / 2 个 td）', oneOut.tags.filter((t) => t === 'tr').length === 1 && oneOut.tags.filter((t) => t === 'td').length === 2, oneOut.tags.join(','));
  check('★ 单行表格通过校验（校验层不再要求"表头 + 数据"）', kcModel.validateBlock(oneRow).length === 0, kcModel.validateBlock(oneRow).join('；'));

  // 参差不齐的行会被补齐（不然列会错位）
  const ragged = { id: 't2', type: 'table', rows: [['A', 'B', 'C'], ['1']] };
  const out2 = renderToString([ragged]);
  check('参差不齐的表格被补齐到最宽列（第二行补 2 个空格子）', out2.tags.filter((t) => t === 'td').length === 6, String(out2.tags.filter((t) => t === 'td').length));

  // 空表格不该崩
  const empty = { id: 't3', type: 'table', rows: [] };
  check('空表格渲染不抛异常', renderToString([empty]).tags.includes('table') === false, '');

  // 列表：单项与多项
  const list = { id: 'l1', type: 'list', items: ['a', 'b', 'c'] };
  check('列表 3 项渲染出 3 个 li', renderToString([list]).tags.filter((t) => t === 'li').length === 3, '');
  const listEmpty = { id: 'l2', type: 'list', items: [''] };
  check('空列表项渲染出 1 个空 li（不崩）', renderToString([listEmpty]).tags.filter((t) => t === 'li').length === 1, '');
  delete globalThis.document;
}

// ───────────────────────────────────────────────
console.log('\n[3] 保存与回读：改标题/加块/移块/删块（验收标准 2 的数据层）');
// ───────────────────────────────────────────────
let cardId = '';
{
  setSettingsCache(DEFAULT_SETTINGS);
  const card = kcModel.createEmptyCard('原始标题');
  cardId = card.id;
  await dao.kc.bulkUpsert([card]);
  await tick();

  // 模拟编辑页保存：updateMeta + updateBlocks
  const blocks = [
    { id: 'x1', type: 'heading', content: '核心区别' },
    { id: 'x2', type: 'text', content: '正文' },
    { id: 'x3', type: 'tip', content: '易错点' }, // ← 新加的 tip
  ];
  await dao.kc.updateMeta(cardId, { title: '改过的标题', examTags: ['fill'], examLoad: { types: ['fill'], estMinutes: 4 } });
  await dao.kc.updateBlocks(cardId, blocks);
  await tick();

  const reloaded = await dao.kc.getById(cardId);
  check('标题改动已保存', reloaded?.title === '改过的标题', reloaded?.title ?? '');
  check('新增的 tip 块已保存（3 个块）', reloaded?.blocks.length === 3 && reloaded.blocks.some((b) => b.type === 'tip'), `块数 ${reloaded?.blocks.length}`);
  check('考法与出题量已保存', reloaded?.examTags.join(',') === 'fill' && reloaded.examLoad.estMinutes === 4, '');

  // 上移：把 tip 提到第一位
  const moved = [reloaded.blocks[2], reloaded.blocks[0], reloaded.blocks[1]];
  await dao.kc.updateBlocks(cardId, moved);
  await tick();
  const afterMove = await dao.kc.getById(cardId);
  check('上移后顺序正确（tip 在第一位）', afterMove?.blocks[0].type === 'tip', afterMove?.blocks.map((b) => b.type).join(','));

  // 删除一块
  await dao.kc.updateBlocks(cardId, afterMove.blocks.filter((b) => b.type !== 'text'));
  await tick();
  const afterDelete = await dao.kc.getById(cardId);
  check('删除一块后剩 2 块', afterDelete?.blocks.length === 2, `块数 ${afterDelete?.blocks.length}`);
  check('删掉的是 text 块', !afterDelete.blocks.some((b) => b.type === 'text'), afterDelete.blocks.map((b) => b.type).join(','));

  // 复制一块（复制时要换新 id，否则两块 id 相同）
  const copySource = afterDelete.blocks[0];
  const copy = { ...copySource, id: kcModel.newId() };
  check('复制出的块换了新 id', copy.id !== copySource.id, '');
  await dao.kc.updateBlocks(cardId, [...afterDelete.blocks, copy]);
  await tick();
  const afterCopy = await dao.kc.getById(cardId);
  check('复制后 3 块，且 id 不重复', afterCopy.blocks.length === 3 && new Set(afterCopy.blocks.map((b) => b.id)).size === 3, '');
}

// ───────────────────────────────────────────────
console.log('\n[4] 列表页：搜索 / 筛选 / 排序 / 分页（验收标准 5）');
// ───────────────────────────────────────────────
{
  // 清场，造一批可预测的卡
  await dao.kc.clearAll();
  await tick();
  const mk = (title, summary, blocks, tags, mastery, priority) => {
    const c = kcModel.createEmptyCard(title);
    c.summary = summary;
    c.blocks = blocks;
    c.examTags = tags;
    c.attrs.mastery = mastery;
    c.attrs.reviewPriority = priority;
    return c;
  };
  const cards = [
    mk('定语从句', '关系代词', [{ id: 'a1', type: 'text', content: '关系代词在从句中作主语' }], ['fill', 'choice'], 0.2, 9),
    mk('虚拟语气', 'should 省略', [{ id: 'a2', type: 'heading', content: '虚拟语气的三种时态' }], ['sentence'], 0.8, 5),
    mk('非谓语动词', 'doing vs done', [{ id: 'a3', type: 'tip', content: '记住 being done 的用法' }], ['judge'], 0.5, 7),
  ];
  await dao.kc.bulkUpsert(cards);
  await tick();

  const all = await dao.kc.query({ page: 1, pageSize: 50 });
  check('列表页能查到 3 张卡', all.total === 3, `total=${all.total}`);

  // ★ 搜索块内容（验收标准 5 明确要求）
  const byBlock = await dao.kc.query({ keyword: '作主语', page: 1, pageSize: 50 });
  check('★ 搜「作主语」命中正文块（搜得到块内容）', byBlock.total === 1 && byBlock.items[0].title === '定语从句', `total=${byBlock.total}`);
  const byHeading = await dao.kc.query({ keyword: '三种时态', page: 1, pageSize: 50 });
  check('★ 搜小标题块的内容也能命中', byHeading.total === 1 && byHeading.items[0].title === '虚拟语气', `total=${byHeading.total}`);
  const byTip = await dao.kc.query({ keyword: 'being done', page: 1, pageSize: 50 });
  check('★ 搜 tip 块的内容也能命中', byTip.total === 1 && byTip.items[0].title === '非谓语动词', `total=${byTip.total}`);
  const bySummary = await dao.kc.query({ keyword: '关系代词', page: 1, pageSize: 50 });
  check('搜摘要仍能命中', bySummary.total >= 1, `total=${bySummary.total}`);
  const noHit = await dao.kc.query({ keyword: '不存在的词xyz', page: 1, pageSize: 50 });
  check('搜不到就是空', noHit.total === 0, '');

  // 按考法筛选
  const byTag = await dao.kc.query({ examTag: 'fill', page: 1, pageSize: 50 });
  check('按考法 fill 筛选命中 1 张', byTag.total === 1 && byTag.items[0].title === '定语从句', `total=${byTag.total}`);

  // 按状态筛选
  const byStatus = await dao.kc.query({ status: ['unlearned'], page: 1, pageSize: 50 });
  check('按状态「未学」筛选命中 3 张', byStatus.total === 3, `total=${byStatus.total}`);

  // 按掌握度排序
  const byMastery = await dao.kc.query({ sort: 'mastery', order: 'desc', page: 1, pageSize: 50 });
  check('★ 按掌握度降序排序正确', byMastery.items.map((c) => c.attrs.mastery).join(',') === '0.8,0.5,0.2', byMastery.items.map((c) => c.attrs.mastery).join(','));
  const byPriority = await dao.kc.query({ sort: 'reviewPriority', order: 'desc', page: 1, pageSize: 50 });
  check('按复习优先度降序排序正确', byPriority.items.map((c) => c.attrs.reviewPriority).join(',') === '9,7,5', byPriority.items.map((c) => c.attrs.reviewPriority).join(','));

  // 分页
  const p1 = await dao.kc.query({ page: 1, pageSize: 2, sort: 'mastery', order: 'desc' });
  const p2 = await dao.kc.query({ page: 2, pageSize: 2, sort: 'mastery', order: 'desc' });
  check('分页：第 1 页 2 条、第 2 页 1 条', p1.items.length === 2 && p2.items.length === 1, `${p1.items.length}/${p2.items.length}`);
  check('分页：两页不重复', p1.items.every((a) => !p2.items.some((b) => b.id === a.id)), '');
}

// ───────────────────────────────────────────────
console.log('\n[5] 斩 / 复活 / 批量操作（验收标准 6）');
// ───────────────────────────────────────────────
{
  const all = await dao.kc.query({ page: 1, pageSize: 50 });
  const target = all.items[0];

  await dao.kc.chop(target.id);
  await tick();
  const afterChop = await dao.kc.query({ page: 1, pageSize: 50 });
  check('★ 斩掉后默认视图里消失', !afterChop.items.some((c) => c.id === target.id), `total=${afterChop.total}`);
  const choppedView = await dao.kc.query({ status: ['chopped'], page: 1, pageSize: 50 });
  check('★ 切「已斩」能看到它', choppedView.items.some((c) => c.id === target.id), `total=${choppedView.total}`);
  const stats = await dao.kc.stats(true);
  check('统计里「已斩」+1', stats.chopped === 1, JSON.stringify(stats));

  await dao.kc.revive(target.id);
  await tick();
  const afterRevive = await dao.kc.query({ page: 1, pageSize: 50 });
  check('★ 复活后回到默认视图', afterRevive.items.some((c) => c.id === target.id), '');
  const revived = await dao.kc.getById(target.id);
  check('复活后状态是 unlearned、deleted=0', revived?.status === 'unlearned' && revived?.deleted === 0, `${revived?.status}/${revived?.deleted}`);

  // 批量：一次斩 2 张
  const ids = afterRevive.items.slice(0, 2).map((c) => c.id);
  const n = await dao.kcBatch.bulkSetDeleted(ids, 1);
  await tick();
  const afterBulk = await dao.kc.query({ page: 1, pageSize: 50 });
  check('★ 批量斩 2 张生效', n === 2 && afterBulk.total === 1, `斩了 ${n}，剩 ${afterBulk.total}`);
  check('批量斩也写了墓碑（能同步）', (await dao.kc.getById(ids[0])).deleted === 1, '');

  const back = await dao.kcBatch.bulkSetDeleted(ids, 0);
  await tick();
  check('批量复活生效', back === 2 && (await dao.kc.query({ page: 1, pageSize: 50 })).total === 3, '');

  // 批量加考法
  const added = await dao.kcBatch.bulkAddExamTags(ids, ['choice']);
  await tick();
  check('批量加考法生效', added === 2, `影响 ${added} 张`);
  const card0 = await dao.kc.getById(ids[0]);
  check('已存在的考法不重复加', new Set(card0.examTags).size === card0.examTags.length, card0.examTags.join(','));

  // 批量永久删除
  const removed = await dao.kcBatch.bulkRemovePermanently(ids);
  await tick();
  check('★ 批量永久删除生效', removed === 2 && (await dao.kc.query({ page: 1, pageSize: 50 })).total === 1, `删了 ${removed}`);
  check('永久删除后连墓碑都没有', (await dao.kc.getById(ids[0])) === null, '');
}

// ───────────────────────────────────────────────
console.log('\n[6] 编辑器里的 XSS（验收标准 8）');
// ───────────────────────────────────────────────
{
  installDomStub();
  // 模拟「在编辑器里输入 <script>alert(1)</script>」→ 保存 → 渲染
  const card = kcModel.createEmptyCard('XSS 测试');
  card.blocks = [
    { id: 'z1', type: 'text', content: '<script>window.__kcXss=1</script>' },
    { id: 'z2', type: 'heading', content: '"><img src=x onerror="window.__kcXss=1">' },
    { id: 'z3', type: 'list', items: ['<svg/onload=window.__kcXss=1>'] },
    { id: 'z4', type: 'table', rows: [['<iframe src=//evil>', 'x']] },
    { id: 'z5', type: 'code', content: '<script>alert(2)</script>', lang: 'js"><img src=x>' },
  ];
  await dao.kc.bulkUpsert([card]);
  await tick();
  const saved = await dao.kc.getById(card.id);
  check('含攻击载荷的块保存成功（不被拒绝）', saved?.blocks.length === 5, `块数 ${saved?.blocks.length}`);

  const out = renderToString(saved.blocks);
  const dangerous = out.tags.filter((t) => ['script', 'img', 'svg', 'iframe'].includes(t));
  check('★ 渲染结果里没有 script/img/svg/iframe 元素', dangerous.length === 0, dangerous.join(','));
  check('★ 攻击载荷以纯文本出现', out.text.includes('<script>') && out.text.includes('onerror'), '');
  check('★ code 的恶意 lang 被过滤成安全字符', out.classes.every((c) => /^(kc-|language-)?[A-Za-z0-9+#-]+$/.test(c)), out.classes.filter((c) => c.startsWith('language')).join(','));
  check('哨兵未被置位', globalThis.window.__kcXss === undefined, '');
  delete globalThis.document;

  // 清场
  await dao.kc.clearAll();
  await tick();
  check('清场成功', (await dao.kc.query({ page: 1, pageSize: 10 })).total === 0, '');
}

// ───────────────────────────────────────────────
console.log('\n[7] 块工具函数（编辑器用到的纯逻辑）');
// ───────────────────────────────────────────────
{
  const b = kcBlock.coerceBlock({ type: 'list', items: ['a', 'b'] });
  check('coerceBlock 深拷贝语义（复制块时用）', b !== null && b.items.length === 2, '');
  const clone = kcBlock.coerceBlock(JSON.parse(JSON.stringify(b)));
  check('深拷贝后改一个不影响原对象', clone !== null && clone !== b && clone.items !== b.items, '');
  check('coerceBlock 对未知类型降级成 text', kcBlock.coerceBlock({ type: 'nope', content: 'x' }).type === 'text', '');
  check('newId 生成的 id 不重复', kcModel.newId() !== kcModel.newId(), '');
  check('query 的纯函数与 DAO 结果一致', kcQuery.filterCards([], { page: 1, pageSize: 10 }).length === 0, '');
}

console.log(`\n=== 阶段 03 验收（数据层，无需浏览器）：通过 ${passed} 项，失败 ${failed} 项 ===\n`);
process.exit(failed === 0 ? 0 : 1);
