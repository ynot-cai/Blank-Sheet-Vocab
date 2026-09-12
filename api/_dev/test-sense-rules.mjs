/**
 * 资料整理规范自检：`npm run test:sense-rules`
 *
 * 为什么值得单独一整组：这套规则不是「文档好看」，每一条都对应一个**真实坏结果**。
 *   · 义项不拆开   → 代表词是一长串，用户答对一半也算错
 *   · 近义词打包   → 归一化后整串比对，**答哪个都判错**（本文件 [3] 组就是钉这个）
 *   · 同源不合并   → 同一个含义被拆成两三个义项，用户要多答好几次
 *   · 不同源不拆开 → 把「熊」和「忍受」并成一个义项，语义上就是错的
 *
 * 这个文件直接 import **真实源码**（走 api/_dev/loader-register.mjs 的加载钩子），
 * 不是把逻辑抄一遍——抄一遍的话测试永远绿，代码坏了也发现不了。
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// ★ 用相对说明符（不是拼出来的绝对路径）：
//   Node 的 ESM 只认 file:// 形式的绝对地址，Windows 上 `D:\...` 会被当成协议 `d:` 而报
//   ERR_UNSUPPORTED_ESM_URL_SCHEME。相对写法由加载钩子补 `.ts` 后缀，跨平台都稳。
const { normalizeAliases, validateSenseShape, SENSE_RULES_FOR_AI, ALIAS_SEPARATORS } = await import(
  '../../src/core/senseRules.ts'
);
const { createSense, senseMatch, formatSensesBrief, wordMatch } = await import('../../src/core/model.ts');
const { PARSE_SYSTEM_PROMPT, coerceParsedWord } = await import('../../src/services/ai.ts');

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
 * 读源码文本。
 * @param {string} rel 相对仓库根
 */
function read(rel) {
  return readFileSync(join(ROOT, rel), 'utf8');
}

// ─────────────────────────────────────────── [1] 规范写在了「醒目处」
console.log('\n[1] 规范写在醒目处，且 AI 提示词真的引用了它');
check('core/senseRules.ts 存在且导出规则正文', typeof SENSE_RULES_FOR_AI === 'string' && SENSE_RULES_FOR_AI.length > 500);
check(
  '规则里写清了四步流程',
  ['第 1 步', '第 2 步', '第 3 步', '第 4 步'].every((s) => SENSE_RULES_FOR_AI.includes(s)),
);
check('规则里包含 run 的范例', SENSE_RULES_FOR_AI.includes('run'));
check('规则里包含 bear 的反例（不同源要拆开）', SENSE_RULES_FOR_AI.includes('bear'));
check(
  'rules 文件顶部有醒目的大标题注释',
  read('src/core/senseRules.ts').includes('★★★'),
);
// 提示词必须是「引用」规则，而不是自己再抄一份——抄两份迟早矛盾
check('AI 提示词引用了 SENSE_RULES_FOR_AI', read('src/services/ai.ts').includes('${SENSE_RULES_FOR_AI}'));
check('运行时拼接后提示词里确实含规则正文', PARSE_SYSTEM_PROMPT.includes(SENSE_RULES_FOR_AI));
check('提示词里含「严禁把多个说法打包」', PARSE_SYSTEM_PROMPT.includes('严禁把多个说法打包'));
check('提示词里含第 4 步同源判断', PARSE_SYSTEM_PROMPT.includes('同源'));
// 导出给 AI 的规则里不能出现未展开的模板占位符
check('规则正文里没有残留模板占位符', !SENSE_RULES_FOR_AI.includes('${'));

// ─────────────────────────────────────────── [2] 拆包（第 3 步的执行点）
console.log('\n[2] 近义词必须逐个分隔（normalizeAliases）');
check(
  '打包项被拆开',
  JSON.stringify(normalizeAliases(['跑步，奔跑'])) === JSON.stringify(['跑步', '奔跑']),
  JSON.stringify(normalizeAliases(['跑步，奔跑'])),
);
check(
  '各种分隔符都认（，,、;；/|）',
  JSON.stringify(normalizeAliases(['跑，奔、走;跳'])) === JSON.stringify(['跑', '奔', '走', '跳']),
  JSON.stringify(normalizeAliases(['跑，奔、走;跳'])),
);
check('空串被丢掉', JSON.stringify(normalizeAliases(['', '  ', '跑'])) === JSON.stringify(['跑']));
check('重复项只留一个', JSON.stringify(normalizeAliases(['跑', '跑', '跑，跑'])) === JSON.stringify(['跑']));
check('前后空白被去掉', JSON.stringify(normalizeAliases(['  跑  '])) === JSON.stringify(['跑']));
check('英文夹在中文里也会被拆开（跑/run → 跑 + run）', normalizeAliases(['跑/run']).length === 2);
check('分隔符正则可被外部复用', ALIAS_SEPARATORS instanceof RegExp);

// ─────────────────────────────────────────── [3] ★ 这就是那个真实 bug
console.log('\n[3] 打包的近义词会让判分「答哪个都错」（回归防线）');
{
  // 旧行为：createSense 不拆包，alias 是整串 "跑步，奔跑"
  // 归一化后变成 "跑步奔跑"，用户答「跑步」不相等 → 判错
  const packed = { text: '跑', aliases: ['跑步，奔跑'] };
  const normalized = { text: '跑', aliases: normalizeAliases(packed.aliases) };
  const NOISE_RE = /[\s.,，。；;、/\\|()（）[\]【】"'“”‘’!！?？:：\-—_]/g;
  const norm = (s) => s.replace(NOISE_RE, '').toLowerCase();
  check(
    '证明旧写法确实会判错（答「跑步」→ 整串不相等）',
    norm(packed.aliases[0]) !== norm('跑步') && norm(packed.aliases[0]) === norm('跑步奔跑'),
    norm(packed.aliases[0]),
  );

  // 新行为：拆开后两个答案都判对
  const s = createSense('跑', ['奔跑，跑步，短途跑步']);
  check('createSense 已自动拆包', JSON.stringify(s.aliases) === JSON.stringify(['奔跑', '跑步', '短途跑步']), JSON.stringify(s.aliases));
  check('答「跑步」判对', senseMatch('跑步', s) === true);
  check('答「奔跑」判对', senseMatch('奔跑', s) === true);
  check('答「短途跑步」判对', senseMatch('短途跑步', s) === true);
  check('答代表词「跑」判对', senseMatch('跑', s) === true);
  check('答不相干的「走路」判错', senseMatch('走路', s) === false);
  check('拆包后归一化不会把两个词粘起来', norm(normalized.aliases[0]) !== norm(normalized.aliases[1]));

  // 真实写入路径：AI 解析结果也必须拆包
  const fromAi = coerceParsedWord({
    en: 'run',
    phonetic: '/rʌn/',
    example: 'He runs fast.',
    senses: [{ text: '跑', aliases: ['跑步，奔跑'] }],
  });
  check('AI 返回的打包近义词也会被拆开', JSON.stringify(fromAi?.senses?.[0]?.aliases) === JSON.stringify(['跑步', '奔跑']), JSON.stringify(fromAi?.senses?.[0]?.aliases));
  check('拆开后 AI 那条也能判对「跑步」', wordMatch('跑步', { ...fromAi, senses: fromAi.senses.map((x) => ({ ...x, id: 'x', enabled: true })) }) === true);
}

// ─────────────────────────────────────────── [4] 只有代表词会显示出来
console.log('\n[4] 「点单词显示中文」只显示代表词，不显示近义词');
{
  const run = [
    createSense('跑', ['奔跑', '跑步', '短途跑步']),
    createSense('经验', ['管理']),
    createSense('一段时间'),
  ];
  const brief = formatSensesBrief(run);
  check('显示的是代表词', brief.includes('跑') && brief.includes('经验') && brief.includes('一段时间'), brief);
  check('近义词一个都不出现', !brief.includes('奔跑') && !brief.includes('短途跑步') && !brief.includes('管理'), brief);
  check('多义项用圈号编号', brief.includes('①') && brief.includes('②') && brief.includes('③'), brief);

  // 不同词性的义项退化成逐条罗列，但仍然只显示代表词
  const bear = [createSense('n. 熊', ['狗熊']), createSense('v. 忍受', ['容忍'])];
  const bearBrief = formatSensesBrief(bear);
  check('不同词性时逐条罗列', bearBrief.includes('n. 熊') && bearBrief.includes('v. 忍受'), bearBrief);
  check('罗列时也不显示近义词', !bearBrief.includes('狗熊') && !bearBrief.includes('容忍'), bearBrief);
  check('单义项时不加圈号', formatSensesBrief([createSense('跑', ['奔跑'])]) === '跑');
}

// ─────────────────────────────────────────── [5] run 的范例整理结果
console.log('\n[5] run 的范例：同源跨词性合并');
{
  // 词表原文：run  v. 跑，经验，管理  n. 跑步，短途跑步，一段时间
  // 正确整理 = 3 个义项，①里跨词性合并
  const run = [createSense('跑', ['奔跑', '跑步', '短途跑步']), createSense('经验', ['管理']), createSense('一段时间')];
  check('整理成 3 个义项', run.length === 3, String(run.length));
  check('义项①的 near-synonyms 含名词性的「跑步」', run[0].aliases.includes('跑步'));
  check('义项①的 near-synonyms 含名词性的「短途跑步」', run[0].aliases.includes('短途跑步'));
  check('「经验」独立成义项②', run[1].text === '经验');
  check('「管理」是义项②的近义词', run[1].aliases.includes('管理'));
  check('「一段时间」独立成义项③', run[2].text === '一段时间');
  check('义项①的代表词没有词性前缀（它是跨词性的）', !/^[a-z]+\./.test(run[0].text), run[0].text);
}

// ─────────────────────────────────────────── [6] 不同源必须拆开
console.log('\n[6] bear 的反例：不同源必须拆成不同义项');
{
  const bear = [createSense('n. 熊'), createSense('v. 忍受', ['容忍'])];
  check('「熊」和「忍受」是两个义项', bear.length === 2);
  check('「熊」保留词性前缀以区分', bear[0].text.startsWith('n.'), bear[0].text);
  check('「忍受」保留词性前缀以区分', bear[1].text.startsWith('v.'), bear[1].text);
  check('答「熊」只命中第一个义项', senseMatch('熊', bear[0]) && !senseMatch('熊', bear[1]));
  check('答「忍受」只命中第二个义项', senseMatch('忍受', bear[1]) && !senseMatch('忍受', bear[0]));
}

// ─────────────────────────────────────────── [7] 违规能被检出
console.log('\n[7] 违规写法能被检测出来（validateSenseShape）');
check('合规义项无问题', validateSenseShape({ text: '跑', aliases: ['奔跑', '跑步'] }).length === 0);
check('代表词为空 → 报错', validateSenseShape({ text: '', aliases: [] }).length > 0);
check(
  '代表词里含顿号 → 报错（说明多个含义被打包了）',
  validateSenseShape({ text: 'n. 量纲、维度', aliases: [] }).length > 0,
  JSON.stringify(validateSenseShape({ text: 'n. 量纲、维度', aliases: [] })),
);
check(
  '近义词里含逗号 → 报错（会导致判分永远失败）',
  validateSenseShape({ text: '跑', aliases: ['跑步，奔跑'] }).length > 0,
  JSON.stringify(validateSenseShape({ text: '跑', aliases: ['跑步，奔跑'] })),
);
check('近义词里有空串 → 报错', validateSenseShape({ text: '跑', aliases: [''] }).length > 0);

// ─────────────────────────────────────────── [8] 所有写入路径都过了一遍拆包
console.log('\n[8] 各写入路径都接到了拆包');
{
  // createSense 是所有非 AI 写入路径的入口（合并页 / 卡片编辑 / 预设导入）
  check('合并页草稿走 createSense', read('src/ui/pages/merge/drafts.ts').includes('createSense'));
  check('预设导入走 createSense（经 draftsFromEntries）', read('src/ui/pages/merge/drafts.ts').includes('entry.senses.map'));
  check('createSense 内部调用了 normalizeAliases', read('src/core/model.ts').includes('normalizeAliases(aliases)'));
  check('AI 解析结果的兜底也调用了 normalizeAliases', read('src/services/ai.ts').includes('normalizeAliases('));
  // 规范文件不许 import 别的东西（避免循环依赖，也保证它是最底层的纯规则）
  const rulesSrc = read('src/core/senseRules.ts');
  check('senseRules.ts 不 import 任何模块（保持最底层）', !/^\s*import\s/m.test(rulesSrc));
  // model.ts 是目前唯一 import 它的核心模块
  check('model.ts 从 senseRules 取 normalizeAliases', read('src/core/model.ts').includes("from './senseRules'"));
}

// ─────────────────────────────────────────── [9] AI 重新分析：把结果盖回草稿
console.log('\n[9] AI 重新分析（合并页的那个按钮）');
{
  const { applyReanalysis, draftsToSourceLines, REANALYZE_BATCH_SIZE } = await import('../../src/ui/pages/merge/reanalyze.ts');

  /** 造一条草稿 */
  const mkDraft = (en, senses) => ({
    key: en,
    en,
    phonetic: '',
    example: '',
    senses: senses.map((t) => createSense(t)),
    dropped: false,
    hints: [],
  });

  // 9a. 预设形态：一条义项塞着整串原文 → AI 重排后变成规范的多义项
  const presetLike = [mkDraft('access', ['v. 获取 n. 接近，入口'])];
  const aiResult = [
    {
      en: 'access',
      phonetic: '/ˈækses/',
      example: '',
      senses: [
        { text: 'v. 获取', aliases: [] },
        { text: 'n. 接近', aliases: ['入口'] },
      ],
    },
  ];
  const applied = applyReanalysis(presetLike, aiResult);
  check('原来 1 个义项', presetLike[0].senses.length === 1);
  check('AI 重排后变成 2 个义项', applied.drafts[0].senses.length === 2, String(applied.drafts[0].senses.length));
  check('义项①是「v. 获取」', applied.drafts[0].senses[0].text === 'v. 获取');
  check('义项②代表词「n. 接近」', applied.drafts[0].senses[1].text === 'n. 接近');
  check('「入口」进了近义词而不是独立义项', applied.drafts[0].senses[1].aliases.includes('入口'), JSON.stringify(applied.drafts[0].senses[1].aliases));
  check('统计 updated=1', applied.stat.updated === 1, JSON.stringify(applied.stat));
  check('顺带补上了音标', applied.drafts[0].phonetic === '/ˈækses/', applied.drafts[0].phonetic);
  check('不修改原数组（纯函数）', presetLike[0].senses.length === 1);

  // 9b. AI 打包了近义词 → 也要被拆开（经 createSense）
  const packed = applyReanalysis([mkDraft('grab', ['v. 抢先'])], [
    { en: 'grab', phonetic: '', example: '', senses: [{ text: 'v. 抢先', aliases: ['抢占，抢夺'] }] },
  ]);
  check(
    'AI 打包的近义词在重新分析路径里也被拆开',
    JSON.stringify(packed.drafts[0].senses[0].aliases) === JSON.stringify(['抢占', '抢夺']),
    JSON.stringify(packed.drafts[0].senses[0].aliases),
  );
  check('拆开后答「抢夺」判对', senseMatch('抢夺', packed.drafts[0].senses[0]) === true);

  // 9c. AI 没返回的词必须**原样保留**，绝不能新建或清空
  const partial = applyReanalysis([mkDraft('apple', ['n. 苹果']), mkDraft('banana', ['n. 香蕉'])], [
    { en: 'apple', phonetic: '', example: '', senses: [{ text: 'n. 苹果', aliases: ['苹果树果实'] }] },
  ]);
  check('词数不变（不会因为 AI 漏返回就少词）', partial.drafts.length === 2, String(partial.drafts.length));
  check('AI 没返回的 banana 保持原样', partial.drafts[1].senses[0].text === 'n. 香蕉', partial.drafts[1].senses[0].text);
  check('统计 skipped=1', partial.stat.skipped === 1, JSON.stringify(partial.stat));

  // 9d. en 归一化配对：AI 改大小写/去尾点也要能配上
  const fuzzy = applyReanalysis([mkDraft('ETC.', ['abbr. 等等'])], [
    { en: 'etc', phonetic: '', example: '', senses: [{ text: 'abbr. 等等', aliases: ['及其它'] }] },
  ]);
  check('「ETC.」能配上 AI 返回的「etc」', fuzzy.stat.updated === 1, JSON.stringify(fuzzy.stat));
  check('配对成功后近义词写进去了', fuzzy.drafts[0].senses[0].aliases.includes('及其它'));

  // 9e. AI 返回空义项 → 保持原样，不能把词变成空的
  const emptyAi = applyReanalysis([mkDraft('x', ['n. 原样'])], [{ en: 'x', phonetic: '', example: '', senses: [] }]);
  check('AI 返回空义项时保持原样', emptyAi.drafts[0].senses[0].text === 'n. 原样', JSON.stringify(emptyAi.drafts[0].senses));
  check('空义项计入 empty', emptyAi.stat.empty === 1, JSON.stringify(emptyAi.stat));

  // 9f. 旧合并建议要清掉（重排后已经指向不存在的义项）
  const withHint = mkDraft('y', ['n. 甲']);
  withHint.hints = [{ en: 'y', keep: 'n. 甲', absorb: ['n. 乙'] }];
  const cleared = applyReanalysis([withHint], [
    { en: 'y', phonetic: '', example: '', senses: [{ text: 'n. 甲', aliases: ['乙'] }] },
  ]);
  check('重排后清掉过期的合并建议', cleared.drafts[0].hints.length === 0, JSON.stringify(cleared.drafts[0].hints));

  // 9g. 送给 AI 的原文格式
  const lines = draftsToSourceLines([mkDraft('run', ['v. 跑', 'n. 一段']), mkDraft('bear', [])]);
  check('原文行是「英文+Tab+义项拼接」', lines.split('\n')[0] === 'run\tv. 跑 n. 一段', JSON.stringify(lines.split('\n')[0]));
  check('没有义项的词也给一行（否则 AI 不会返回它）', lines.split('\n')[1].startsWith('bear\t'), JSON.stringify(lines.split('\n')[1]));
  check('批次大小是个合理的正数', Number.isInteger(REANALYZE_BATCH_SIZE) && REANALYZE_BATCH_SIZE > 0, String(REANALYZE_BATCH_SIZE));

  // 9h. 接线检查：合并页真的有这个按钮，且走的是同一份规范提示词
  const mergeSrc = read('src/ui/pages/MergePage.ts');
  check('合并页有「AI 重新分析义项」按钮', mergeSrc.includes('AI 重新分析义项'));
  check('按钮走 parseWordBatch（= 同一份 PARSE_SYSTEM_PROMPT）', mergeSrc.includes('parseWordBatch'));
  check('动手前先确认（会覆盖手动编辑）', mergeSrc.includes('会**覆盖**'));
  check('失败批次保留原样、不阻断', mergeSrc.includes('failedBatches'));
}

// ─────────────────────────────────────────── 汇总
console.log(`\n资料整理规范自检：${passed} 项通过，${failed} 项失败`);
if (failed > 0) process.exit(1);
