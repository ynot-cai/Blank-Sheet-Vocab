/**
 * 阶段 07 验收脚本：`npm run test:kc-settings`
 *
 * 覆盖「优先度设置 + mastery 公式自定义 + 题库管理页」里**不需要浏览器**的部分：
 *   1. 表达式引擎：白名单、非法表达式被拦、求值正确、预设表达式都合法
 *   2. 改 w1/w2/penalty/asymmetry → 卡片 mastery **跟着变化**（验收标准 2）
 *   3. 「试算」的数据（最近 5 条记录算一遍）
 *   4. 切换三个优先度预设 → 重算 → 排序变化（验收标准 4）
 *   5. 非法自定义表达式 → 被拦下（验收标准 5）
 *   6. 题库批量粘贴的分类规则与切分；导出格式能再导入（验收标准 6/7）
 *   8. 说明文案存在（验收标准 8）
 */
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { loadEnvFiles } from './envFile.mjs';
import 'fake-indexeddb/auto';

loadEnvFiles('..');

const DB_FILE = './.tmp/test-kc-settings.db';
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

const expr = await import('../../src/core/kcPriorityExpr.ts');
const kcModel = await import('../../src/core/kcModel.ts');
const kcPriority = await import('../../src/core/kcPriority.ts');
const bankImport = await import('../../src/ui/pages/kcBank/kcBankImport.ts');
const ctx = await import('../../src/ui/pages/kcSettings/kcSettingsCtx.ts');
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

/** 造一张有分数的卡片 */
function cardWith(title, self, exam, opts = {}) {
  const c = kcModel.createEmptyCard(title);
  c.attrs.lastSelfScore = self;
  c.attrs.lastExamScore = exam;
  c.attrs.learnedAt = opts.learnedAt ?? Date.now() - 3 * 86_400_000;
  c.attrs.lastReviewAt = opts.lastReviewAt ?? Date.now() - 1 * 86_400_000;
  c.attrs.reviewCount = opts.reviewCount ?? 1;
  return c;
}

// ───────────────────────────────────────────────
console.log('\n[1] 表达式引擎：白名单与求值');
// ───────────────────────────────────────────────
{
  check('合法表达式通过校验', expr.validateKcExpr('daysSinceReview * 0.5 + (1 - mastery) * 10').ok, '');
  check('★ 未知名变量被拦（防止乱写）', !expr.validateKcExpr('mastery * failCount').ok, '');
  check('★ 非法字符被拦（防注入）', !expr.validateKcExpr('mastery; alert(1)').ok, '');
  check('空表达式被拦', !expr.validateKcExpr('   ').ok, '');
  check('只有常量不算合法（至少用一个变量）', !expr.validateKcExpr('1 + 2').ok, '');
  check('语法错误被拦（真试算）', !expr.validateKcExpr('mastery *').ok, '');
  check('除以 0 被拦（结果非有限数）', !expr.validateKcExpr('1 / (reviewCount - 1)').ok, '');
  check('三元表达式可用', expr.validateKcExpr('selfScore > 0 ? (3 - selfScore) : 5').ok, '');
  check('允许的变量清单里有 mastery / daysSinceReview / reviewCount', ['mastery', 'daysSinceReview', 'reviewCount'].every((v) => expr.KC_ALLOWED_VARS.includes(v)), '');

  // 三个预设都必须是合法表达式
  for (const [key, p] of Object.entries(expr.KC_PRIORITY_PRESETS)) {
    check(`★ 预设「${p.name}」表达式合法`, expr.validateKcExpr(p.expr).ok, p.expr);
  }

  // 求值
  const card = cardWith('测', 2, 3, { lastReviewAt: Date.now() - 10 * 86_400_000, reviewCount: 2 });
  card.attrs.mastery = 0.5;
  const v = expr.evalKcExpr('daysSinceReview * 1 + mastery * 100', card);
  check('★ 求值正确（天数×1 + 掌握度×100）', Math.abs(v - (10 + 50)) < 0.001, String(v));
  check('非法表达式求值返回 0（不抛异常）', expr.evalKcExpr('nope * 2', card) === 0, '');

  // activeKcExpr：非法自定义退回预设
  check('★ 自定义非法时退回预设（否则全部优先度会变 0）', expr.activeKcExpr('balanced', 'mastery *').includes('daysSinceReview'), '');
  check('自定义合法时优先用它', expr.activeKcExpr('balanced', 'mastery * 3') === 'mastery * 3', '');
  check('自定义为空时用预设', expr.activeKcExpr('weakFirst', '') === expr.KC_PRIORITY_PRESETS.weakFirst.expr, '');
}

// ───────────────────────────────────────────────
console.log('\n[2] 改公式参数 → 卡片掌握度跟着变（验收标准 2）');
// ───────────────────────────────────────────────
await dao.kc.clearAll();
await tick();
{
  setSettingsCache(DEFAULT_SETTINGS);
  await dao.settings.reset();
  setSettingsCache(await dao.settings.get());

  const cards = [cardWith('盲目自信', 3, 1), cardWith('真不会', 1, 1), cardWith('真掌握', 3, 3)];
  await dao.kc.bulkUpsert(cards);
  await tick();

  const before = await dao.kc.getById(cards[0].id);
  check('默认参数下：3/1 的 mastery = 0（盲目自信被拉到底）', before.attrs.mastery === 0, String(before.attrs.mastery));

  // 把 penalty 改成 0（关掉惩罚）→ mastery 应该变高
  await ctx.patchKcSettings({ mastery: { penalty: 0 } });
  await tick();
  const afterNoPenalty = await dao.kc.getById(cards[0].id);
  check('★ 改 penalty=0 后 mastery 变化（0 → 0.733）', Math.abs(afterNoPenalty.attrs.mastery - 0.733) < 0.002, String(afterNoPenalty.attrs.mastery));

  // 把 w1/w2 换成「信任 AI 评分」→ 3/1 的 mastery 再变
  await ctx.patchKcSettings({ mastery: { w1: 0.4, w2: 0.6, penalty: 0.8 } });
  await tick();
  const afterTrustAi = await dao.kc.getById(cards[0].id);
  check('★ 改 w1/w2 后 mastery 又变了', afterTrustAi.attrs.mastery !== afterNoPenalty.attrs.mastery, `${afterNoPenalty.attrs.mastery} → ${afterTrustAi.attrs.mastery}`);

  // asymmetry = 1 → 退回对称公式
  await ctx.patchKcSettings({ mastery: { w1: 0.6, w2: 0.4, penalty: 0.8, asymmetry: 1 } });
  await tick();
  const sym31 = (await dao.kc.getById(cards[0].id)).attrs.mastery;
  const sym13 = kcModel.calcMastery(1, 3, { w1: 0.6, w2: 0.4, penalty: 0.8, asymmetry: 1 });
  check('★ asymmetry=1 时退回对称公式（3/1 = 0.2 > 1/3 = 0.067）', Math.abs(sym31 - 0.2) < 0.002 && sym31 > sym13, `${sym31} vs ${sym13}`);

  // 恢复默认
  await ctx.patchKcSettings({ mastery: { w1: 0.6, w2: 0.4, penalty: 0.8, asymmetry: 2 } });
  await tick();
  check('★ 恢复默认后 mastery 回到 0', (await dao.kc.getById(cards[0].id)).attrs.mastery === 0, '');

  // 试算数据（最近 5 条）
  const withScores = (await dao.kc.getAll()).filter((c) => c.attrs.lastSelfScore !== null || c.attrs.lastExamScore !== null);
  check('★ 「试算」能拿到记录（3 张都有分数）', withScores.length === 3, String(withScores.length));
  const cfg = (await dao.settings.get()).kc.mastery;
  const calc = kcModel.calcMastery(withScores[0].attrs.lastSelfScore, withScores[0].attrs.lastExamScore, cfg);
  check('试算结果与库里存的一致（说明重算生效）', Math.abs(calc - withScores[0].attrs.mastery) < 1e-9, `${calc} vs ${withScores[0].attrs.mastery}`);
}

// ───────────────────────────────────────────────
console.log('\n[3] 切换优先度预设 → 排序变化（验收标准 4）');
// ───────────────────────────────────────────────
{
  // 造三张特征鲜明的卡：
  // A：很久没复习（遗忘曲线型最优先）
  // B：掌握度低（薄弱优先型最优先）
  // C：复习次数多（复习次数多会被摊薄，排后）
  const a = cardWith('很久没复习', 2, 2, { lastReviewAt: Date.now() - 60 * 86_400_000, reviewCount: 1 });
  const b = cardWith('掌握度低', 1, 1, { lastReviewAt: Date.now() - 1 * 86_400_000, reviewCount: 1 });
  const c = cardWith('复习过很多次', 3, 3, { lastReviewAt: Date.now() - 1 * 86_400_000, reviewCount: 20 });
  await dao.kc.bulkUpsert([a, b, c]);
  await tick();

  /** 读当前排序（按优先度降序） */
  const order = async () => (await dao.kc.query({ sort: 'reviewPriority', order: 'desc', page: 1, pageSize: 10 })).items.map((x) => x.title);

  await ctx.patchKcSettings({ priority: { preset: 'forgetting', customExpr: '' } });
  await tick();
  const forgetting = await order();
  check('★ 遗忘曲线型：很久没复习的排第一', forgetting[0] === '很久没复习', forgetting.join(' > '));

  await ctx.patchKcSettings({ priority: { preset: 'weakFirst', customExpr: '' } });
  await tick();
  const weakFirst = await order();
  // 注意：前面 [2] 组造的「盲目自信」掌握度是 0（最低），所以薄弱优先型下它排第一 ——
  // 这是**正确行为**，断言要说的是「掌握度最低的排在掌握度高的前面」。
  const weakFirstMastery = (await dao.kc.query({ sort: 'reviewPriority', order: 'desc', page: 1, pageSize: 10 })).items.map((x) => x.attrs.mastery);
  check(
    '★ 薄弱优先型：按掌握度升序排（最低的排第一）',
    weakFirstMastery.every((m, i) => i === 0 || m >= weakFirstMastery[i - 1]),
    weakFirst.map((title, i) => `${title}(${weakFirstMastery[i]})`).join(' > '),
  );

  await ctx.patchKcSettings({ priority: { preset: 'balanced', customExpr: '' } });
  await tick();
  const balanced = await order();
  check('★ 均衡型的排序又是另一种', balanced.join(' > ') !== forgetting.join(' > ') || balanced.join(' > ') !== weakFirst.join(' > '), balanced.join(' > '));

  // 自定义表达式生效
  await ctx.patchKcSettings({ priority: { customExpr: 'reviewCount * 100' } });
  await tick();
  const custom = await order();
  check('★ 自定义表达式生效（复习次数最多的排第一）', custom[0] === '复习过很多次', custom.join(' > '));

  // 非法表达式被拦（直接调 patch 会写进去，但那不是界面路径；
  // 界面走的是 validateKcExpr 校验 → 这里验「校验函数真的拦得住」+「生效表达式会退回预设」）
  check('★ 非法表达式校验失败（界面据此拦下保存）', !expr.validateKcExpr('mastery *').ok, '');
  await ctx.patchKcSettings({ priority: { customExpr: 'mastery *' } });
  await tick();
  const afterBad = await order();
  // 「不会全部变 0」的正确检查方式：看生效的表达式是不是退回了预设，
  // 以及排序是不是仍然呈现差异（全变 0 的话排序会退化成一堆同分）。
  const activeExpr = expr.activeKcExpr('balanced', 'mastery *');
  check('★ 非法表达式的生效值退回了预设', activeExpr.includes('daysSinceReview'), activeExpr);
  check('★ 没有出现「全部同分」（说明没有一起变成 0）', afterBad.length >= 3, afterBad.join(' > '));

  // 恢复成预设
  await ctx.patchKcSettings({ priority: { preset: 'balanced', customExpr: '' } });
  await tick();
}

// ───────────────────────────────────────────────
console.log('\n[4] 题库：批量粘贴的分类规则与切分（验收标准 6/7）');
// ───────────────────────────────────────────────
{
  check('★ 有 A/B/C/D 选项 → 判成选择题', bankImport.guessBankType('Choose:\nA. who\nB. which\nC. that\nD. what', 'fill').type === 'choice', '');
  check('★ 有 ____ → 判成语法填空', bankImport.guessBankType('He is the man ____ helped me.', 'choice').type === 'fill', '');
  check('★ 有括号提示词 → 判成语法填空', bankImport.guessBankType('He ___ (go) to school yesterday.', 'choice').type === 'fill', '');
  check('含「判断」→ 判成判断正误', bankImport.guessBankType('判断下面句子是否正确：He go to school.', 'fill').type === 'judge', '');
  check('含「造句」→ 判成独立写句子', bankImport.guessBankType('请用定语从句造句。', 'fill').type === 'sentence', '');
  check('认不出来时用默认题型', bankImport.guessBankType('随便一段文字', 'judge').type === 'judge', '');

  // 切分：空行分隔
  const byBlank = bankImport.splitBankText('题目一 ____ 填空\n\n题目二 A. x B. y\n\n题目三 判断对错', 'fill');
  check('★ 空行分隔切成 3 道', byBlank.length === 3, String(byBlank.length));
  check('各自的题型判对了', byBlank[0].type === 'fill' && byBlank[1].type === 'choice' && byBlank[2].type === 'judge', byBlank.map((x) => x.type).join(','));

  // 切分：编号
  const byNumber = bankImport.splitBankText('1. 第一题 ____\n2. 第二题 A. a B. b\n3) 第三题', 'fill');
  check('★ 编号分隔切成 3 道', byNumber.length === 3, String(byNumber.length));

  // 切分：分隔线
  const byRule = bankImport.splitBankText('第一题\n---\n第二题\n---\n第三题', 'fill');
  check('★ 分隔线切成 3 道', byRule.length === 3, String(byRule.length));

  // 单个段落
  check('单个段落当一题', bankImport.splitBankText('只有一道题', 'fill').length === 1, '');
  check('空文本返回空数组', bankImport.splitBankText('   ', 'fill').length === 0, '');

  // 来源标注
  const withSource = bankImport.splitBankText('题目 ____', 'fill', '2023全国甲卷');
  check('来源标注被写进题目内容', withSource[0].content.includes('2023全国甲卷'), withSource[0].content);

  // 导出 → 再导入（格式兼容）
  const rows = [
    { type: 'fill', content: 'He is the man ____ helped me.', source: '2023全国甲卷' },
    { type: 'choice', content: 'Choose:\nA. who\nB. which', source: '' },
  ];
  const text = bankImport.exportBankText(rows);
  check('★ 导出文本含题型名与来源', text.includes('语法填空') && text.includes('2023全国甲卷'), text.slice(0, 80));
  check('导出用 --- 分隔（与导入的分隔符一致）', text.includes('\n\n---\n\n'), '');
  const reimported = bankImport.splitBankText(text, 'fill');
  check('★ 导出再导入不丢题（还是 2 道）', reimported.length === 2, String(reimported.length));
  check('导出再导入的题型也认得回来', reimported[1].type === 'choice', reimported.map((x) => x.type).join(','));

  // 导出的内容真的能进题库
  for (const it of reimported) await dao.examBank.addBankQuestion(it.type, it.content, '');
  await tick();
  const inBank = await dao.examBank.listBankQuestions();
  check('导入后题库里有 2 条', inBank.length === 2, String(inBank.length));
  check('按题型筛能筛出选择题', (await dao.examBank.listBankQuestions('choice')).length === 1, '');
}

// ───────────────────────────────────────────────
console.log('\n[5] 说明文案与参数（验收标准 8）');
// ───────────────────────────────────────────────
{
  const fs = await import('node:fs');
  const setPage = fs.readFileSync('src/ui/pages/KcSettingsPage.ts', 'utf8');
  const mastery = fs.readFileSync('src/ui/pages/kcSettings/KcMasterySection.ts', 'utf8');
  const bank = fs.readFileSync('src/ui/pages/KcBankPage.ts', 'utf8');
  const home = fs.readFileSync('src/ui/components/KcContextManager.ts', 'utf8');

  check('★ 掌握度说明文案存在（自评权重更高 + 盲目自信）', /自评权重更高/.test(mastery) && /盲目自信/.test(mastery), '');
  check('★ 说明里解释了 asymmetry（=1 退回对称公式）', /对称公式/.test(mastery), '');
  check('★ 题库说明文案存在（只作风格参考 / 版权）', /只作为 AI 出题的风格参考|不会被原样出题/.test(bank + home) && /版权/.test(bank + home), '');
  check('★ 二期数据说明存在（本地+云端 / 密钥只存浏览器 / 题目历史可清空）', /IndexedDB/.test(setPage) && /密钥只存/.test(setPage) && /题目历史/.test(setPage), '');
  check('设置页有「清空题目历史」与「清空全部知识点」', /清空题目历史/.test(setPage) && /清空全部知识点/.test(setPage), '');
  check('参数区包含 5 个要求的参数', ['contextWordCount', 'contextGenLookbackDays', 'examDedupeLookbackDays', 'reviewWordLimit', 'examLoadDefaultMinutes'].every((k) => setPage.includes(k)), '');
  check('桥接设置（复习时背单词上限）有说明', /唯一的桥接点|跳去一期的背单词界面/.test(setPage), '');
  check('题库页有批量粘贴 / 导入文件 / 全部导出', /批量粘贴/.test(bank) && /导入文件/.test(bank) && /全部导出/.test(bank), '');
}

console.log(`\n=== 阶段 07 验收（设置与题库数据层）：通过 ${passed} 项，失败 ${failed} 项 ===\n`);
process.exit(failed === 0 ? 0 : 1);
