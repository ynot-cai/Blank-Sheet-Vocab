/**
 * R4 验收自检：`npm run test:r4`（纯 Node，不需要浏览器、不联网）
 *
 * 覆盖 R4 提示词里能自动验的项：
 *   [1] 规则文件与自检机制真的在（AI_RULES.md / scripts/checkRules.mjs / npm run rules:check）
 *   [2] AI_RULES.md 第 4 节的两段必含片段**逐字**出现在对应提示词模板里
 *   [3] R1：答题流程没有任何强制时间限制（含脚本扫不到的「等待上限」）
 *   [4] R2：义项系统的数据形态（bank / light / run / 高兴快乐愉快）
 *   [5] R3：斩的撤销窗口 ≥ 8 秒
 *   [6] R4：安全底线（块渲染不拼 HTML）
 *
 * ★ 与 checkRules.mjs 的分工：那个脚本是「违规探测器」（按模式扫全库），
 *   本文件是「验收断言」（按 R4 提示词的验收标准逐条打勾），而且能
 *   **import 真实源码**做行为验证——比如 R1 的「等待上限」是靠读
 *   `rounds.ts` 的循环写法验的，脚本按变量名扫永远扫不到。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const { MANDATORY_IMPORT_RULES, MANDATORY_EXAM_RULES } = await import('../../src/services/promptRules.ts');
const { PARSE_SYSTEM_PROMPT, coerceParsedWord } = await import('../../src/services/ai.ts');
const { KC_IMPORT_SYSTEM_PROMPT } = await import('../../src/services/kcPrompts.ts');
const { KC_EXAM_SYSTEM_PROMPT } = await import('../../src/services/kcExamPrompts.ts');
const { UNDO_WINDOW_MS } = await import('../../src/ui/components/Toast.ts');
const { createSense, activeSenses, senseMatch } = await import('../../src/core/model.ts');

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

/**
 * 抠出 `### 4.x` 之后第一个 ``` 代码块的内容（与 AI_RULES.md 的排版约定绑定）。
 * @param {string} src AI_RULES.md 全文
 * @param {string} heading 小标题
 */
function blockAfter(src, heading) {
  const at = src.indexOf(heading);
  if (at < 0) return null;
  const open = src.indexOf('```', at);
  const close = src.indexOf('```', open + 3);
  if (open < 0 || close < 0) return null;
  return src.slice(open + 3, close).replace(/^\r?\n/, '').replace(/\r?\n$/, '');
}

// ─────────────────────────────── [1] 规则文件与自检机制
console.log('\n[1] 规则固化：文件 + 机制都在');
check('项目根目录有 AI_RULES.md', existsSync(join(ROOT, 'AI_RULES.md')));
check('scripts/checkRules.mjs 存在', existsSync(join(ROOT, 'scripts', 'checkRules.mjs')));

const pkg = JSON.parse(read('package.json'));
check('package.json 里有 npm run rules:check', pkg.scripts?.['rules:check'] === 'node scripts/checkRules.mjs', String(pkg.scripts?.['rules:check']));

const rulesText = read('AI_RULES.md');
for (const r of ['R1', 'R2', 'R3', 'R4']) {
  check(`AI_RULES.md 里有 ${r} 条`, rulesText.includes(`## ${r}`), `找不到 "## ${r}"`);
}

// 真的跑一次自检脚本：退出码必须是 0（不改断言、不放水，脚本原样跑）
let rulesCheckOk = false;
let rulesCheckErr = '';
try {
  execFileSync(process.execPath, [join(ROOT, 'scripts', 'checkRules.mjs')], { cwd: ROOT, stdio: 'inherit' });
  rulesCheckOk = true;
} catch (err) {
  rulesCheckErr = err instanceof Error ? err.message : String(err);
}
check('npm run rules:check 退出码为 0（全绿）', rulesCheckOk, rulesCheckErr);

// ─────────────────────────────── [2] 第 4 节必含片段
console.log('\n[2] AI_RULES.md 第 4 节的必含片段真的进了提示词');
const wantImport = blockAfter(rulesText, '### 4.1');
const wantExam = blockAfter(rulesText, '### 4.2');
check('4.1 能从 AI_RULES.md 里抠出来', typeof wantImport === 'string' && wantImport.length > 100);
check('4.2 能从 AI_RULES.md 里抠出来', typeof wantExam === 'string' && wantExam.length > 50);

check('promptRules 里的录入片段与 AI_RULES.md **逐字相同**', MANDATORY_IMPORT_RULES === wantImport);
check('promptRules 里的出题片段与 AI_RULES.md **逐字相同**', MANDATORY_EXAM_RULES === wantExam);

check('一期录入提示词（PARSE_SYSTEM_PROMPT）含 4.1 原文', PARSE_SYSTEM_PROMPT.includes(MANDATORY_IMPORT_RULES));
check('二期录入提示词（KC_IMPORT_SYSTEM_PROMPT）含 4.1 原文', KC_IMPORT_SYSTEM_PROMPT.includes(MANDATORY_IMPORT_RULES));
check('二期出题提示词（KC_EXAM_SYSTEM_PROMPT）含 4.2 原文', KC_EXAM_SYSTEM_PROMPT.includes(MANDATORY_EXAM_RULES));

// 出题提示词里不许出现「限时」这类表述（4.2 第 2 条的反面）
check('出题提示词里没有「请在 X 分钟内完成」这类要求', !/请在\s*\d+\s*分钟内/.test(KC_EXAM_SYSTEM_PROMPT));

// ─────────────────────────────── [3] R1：没有强制时间限制
console.log('\n[3] R1：答题流程没有任何强制时间限制');
const roundsSrc = read('src/ui/pages/paper/rounds.ts');
check(
  '默写/拼写的等待循环**没有次数上限**（原来 400 次 × 25ms = 10 秒后自动判分）',
  !/for\s*\(\s*let\s+i\s*=\s*0\s*;\s*i\s*<\s*\d+\s*;/.test(roundsSrc),
);
check('等待循环写成不设时限的 for(;;)', /for\s*\(\s*;\s*;\s*\)/.test(roundsSrc));
check('默写环节每个义项一个输入框（几个义项就几个框）', /senses\.forEach\(\(_,\s*i\)/.test(roundsSrc));
check('判分是「每个义项都要命中」', /results\.every\(Boolean\)/.test(roundsSrc));

// 允许保留的计时不许被误删
const aiSrc = read('src/services/ai.ts');
check('网络超时保护还在（AbortController）', aiSrc.includes('AbortController'));
check('网络超时还可以配（timeoutMs）', aiSrc.includes('timeoutMs'));
check('防抖还在（debounce）', read('src/ui/dom.ts').includes('debounce'));

// 全库再无答题计时变量
const examSources = [
  'src/ui/pages/paper/rounds.ts',
  'src/ui/pages/paper/flow.ts',
  'src/ui/pages/MemorizePage.ts',
  'src/ui/components/ExamTaker.ts',
  'src/ui/pages/kcExam/kcExamController.ts',
  'src/ui/pages/kcExam/kcExamPrepare.ts',
  'src/ui/pages/KcExamPage.ts',
];
/**
 * 剥掉注释再扫（与 `test-build.mjs` 同样的做法）。
 *
 * 为什么必须剥：注释里**提到** timeLimit / countdown 往往正是在讲这条规则本身
 * （例如 rounds.ts 里写着「原来那个 10 秒上限就是超时自动提交」）。
 * 不剥的话，解释规则的话反而会被判成违规——那等于惩罚写注释。
 * @param {string} src 源码
 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const forbidden = /timeLimit|countdown|remainingTime|timeLeft|expireAt|deadline/i;
const dirty = examSources.filter((f) => forbidden.test(stripComments(read(f))));
check('考察相关文件里没有 timeLimit / countdown / deadline 之类', dirty.length === 0, dirty.join(', '));

// ─────────────────────────────── [4] R2：义项系统
console.log('\n[4] R2：义项系统的数据形态（R4 §3.2 的第 1、2 条）');
/** 走真实的「AI 解析结果 → 词」边界 */
const parse = (en, senses) => coerceParsedWord({ en, phonetic: '', example: '', senses });

const bank = parse('bank', [
  { text: 'n. 银行', aliases: [] },
  { text: 'n. 河岸', aliases: ['岸边'] },
]);
check('bank 解析出 2 个义项（银行 / 河岸，不许合并）', bank !== null && bank.senses.length === 2, JSON.stringify(bank?.senses));

const light = parse('light', [
  { text: 'n. 光', aliases: ['光线'] },
  { text: 'adj. 轻的', aliases: [] },
  { text: 'v. 点燃', aliases: ['点亮'] },
]);
check('light 解析出 3 个义项（光 / 轻的 / 点燃）', light !== null && light.senses.length === 3, JSON.stringify(light?.senses));

const happy = parse('glad', [{ text: '高兴', aliases: ['快乐，愉快'] }]);
check('高兴/快乐/愉快 合并成 1 个义项（不是平铺成 3 个）', happy !== null && happy.senses.length === 1, JSON.stringify(happy?.senses));
check('打包的近义词被拆成 2 项（否则判分永远对不上）', happy !== null && happy.senses[0].aliases.length === 2, JSON.stringify(happy?.senses[0].aliases));

// 手写路径（合并页 / 卡片编辑 / 预设导入）同样要过归一化
const manual = createSense('高兴', ['快乐，愉快']);
check('手写路径（createSense）也把打包近义词拆开', manual.aliases.length === 2, JSON.stringify(manual.aliases));

// 判分：命中代表义项 或 命中近义词 → 通过
const bankWord = { senses: bank.senses.map((s) => ({ ...createSense(s.text, s.aliases) })) };
const sensesOf = (w) => activeSenses(w);
check('判分：填「银行」算对', senseMatch('银行', sensesOf(bankWord)[0]));
check('判分：填「河岸」算对', senseMatch('河岸', sensesOf(bankWord)[1]));
check('判分：填「岸边」（近义词）也算对', senseMatch('岸边', sensesOf(bankWord)[1]));
check('判分：填「n. 河岸」（带词性前缀原样）也算对', senseMatch('n. 河岸', sensesOf(bankWord)[1]));
check('判分：填「大海」不算对', !senseMatch('大海', sensesOf(bankWord)[1]));

// ─────────────────────────────── [5] R3：斩可撤销
console.log('\n[5] R3：斩不弹确认 + 撤销窗口 ≥ 8 秒');
check(`撤销窗口常量 ≥ 8000ms（实际 ${UNDO_WINDOW_MS}）`, UNDO_WINDOW_MS >= 8000);
check('撤销 Toast 组件存在（showUndoToast）', read('src/ui/components/Toast.ts').includes('export function showUndoToast'));

const chopSites = [
  'src/ui/pages/paper/flow.ts', // 一期 背诵/复习
  'src/ui/pages/ListPage.ts', // 一期 列表页
  'src/ui/pages/KcStudyPage.ts', // 二期 学习
  'src/ui/pages/KcReviewPage.ts', // 二期 复习
  'src/ui/pages/KcCardListPage.ts', // 二期 列表页
  'src/ui/pages/KcCardEditPage.ts', // 二期 编辑页
  'src/ui/pages/kcList/KcListBatch.ts', // 二期 批量
];
for (const f of chopSites) {
  const src = read(f);
  check(`${f} 斩后给了撤销入口`, src.includes('showUndoToast') || src.includes('chopKcCardUndoable'), '没找到撤销入口');
  check(`${f} 斩前不再弹确认框`, !/confirm\s*\(\s*['"`][^'"`]*斩/.test(src), '还有 confirm');
}

// 撤销的语义：必须是「完全恢复」而不是「一律回到未学」
check('二期撤销走 restoreChopState（还原原状态，不是 revive）', read('src/ui/pages/kcChopUndo.ts').includes('restoreChopState'));
check('一期批量撤销走 restoreStatuses（逐词还原）', read('src/ui/pages/ListPage.ts').includes('restoreStatuses'));

// ─────────────────────────────── [6] R4：安全底线
console.log('\n[6] R4：安全底线');
const blockSrc = read('src/core/blockRender.ts');
check('块渲染文件里没有真正的 innerHTML 赋值', !/\.innerHTML\s*=/.test(blockSrc));
check('块渲染文件里不允许出现 innerHTML 的说明还在（注释）', blockSrc.includes('innerHTML'));
check('AI 代理不连数据库（方案 B）', !read('api/ai-proxy.ts').includes("_lib/db"));

// ─────────────────────────────── 汇总
console.log(`\nR4 验收自检：${passed} 项通过，${failed} 项失败`);
if (failed > 0) process.exit(1);
