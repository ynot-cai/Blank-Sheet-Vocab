/**
 * 阶段 07 验收脚本：`npm run test:about`
 *
 * 数据说明页的关键是「**内容与实际实现一致**，不夸大也不含糊」——
 * 这一条可以自动检查：把页面文案与代码事实对照着断言，防止以后改坏了页面却忘了改文案。
 * 另外错误边界、footer、备案号占位也在这里验。
 */
import { readFileSync } from 'node:fs';
import { loadEnvFiles } from './envFile.mjs';

loadEnvFiles('..');

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

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

const about = read('src/ui/pages/AboutPage.ts');
const footer = read('src/ui/components/Footer.ts');
const boundary = read('src/ui/components/ErrorBoundary.ts');
const app = read('src/App.ts');
const main = read('src/main.ts');

console.log('\n=== 阶段 07 验收：数据说明 + footer + 错误边界 ===\n');

// ─────────────────────────────────────────── 1. 路由与入口
console.log('[1] 页面入口');
{
  check('注册了 #/about 路由', app.includes("registerRoute('/about'"));
  check('首页 footer 里有「关于数据」入口', footer.includes('关于数据') && footer.includes("navigate('/about')"));
  check('设置页数据区也有入口', read('src/ui/pages/settings/DataSection.ts').includes("navigate('/about')"));
}

// ─────────────────────────────────────────── 2. 说明内容要点
console.log('\n[2] 数据说明页的要点（逐条对代码事实）');
{
  check('讲了「数据存在哪」三层', about.includes('浏览器本地（主）') && about.includes('云端数据库') && about.includes('本地备份文件'));
  // 库名住在 `src/core/dbSchema.ts`（`db.ts` 只发事务，见 HANDOVER §0.12 的分层）
  check('明确写了 IndexedDB 库名', about.includes('IndexedDB') && read('src/core/dbSchema.ts').includes("DB_NAME = 'blank-sheet-vocab'"));
  check('明确写了「断网也能用」', about.includes('断网也能用'));
  check('讲了服务器存什么（哈希）', about.includes('SHA-256') && about.includes('不知道你的明文同步码'));
  check('讲了服务器不存 AI 密钥', about.includes('不存：你的 AI 接口密钥'));
  check('讲了个人信息与追踪都不做', about.includes('个人信息') && about.includes('不做用户追踪'));
  check('讲了 HTTPS', about.includes('HTTPS'));
  check('讲了空间隔离', about.includes('空间隔离'));
  check('讲了怎么删数据（清空云端）', about.includes('清空云端数据'));
  check('讲了换同步码 = 换空间', about.includes('换一个全新的数据空间'));
  check('有免责说明', about.includes('按「现状」提供'));
  check('AI 释义可能有误的提醒', about.includes('可能有误'));

  // 内容必须与实现一致：哈希是 SHA-256、库名是 blank-sheet-vocab、代理不连库
  check('哈希算法与实现一致（SHA-256）', read('src/core/syncHelper.ts').includes('SHA-256'));
  check('代理不连库的说法与实现一致', !read('api/ai-proxy.ts').includes('_lib/db'));
}

// ─────────────────────────────────────────── 3. 状态回显
console.log('\n[3] 页面回显真实状态（不是写死的文案）');
{
  check('回显云同步开关', about.includes('cloud.enabled ?'));
  check('回显后端地址', about.includes('cloud.apiBase'));
  check('回显同步码状态但不显示明文', about.includes('cloud.syncCode.trim().length') && !about.includes('text: cloud.syncCode'));
  check('回显上次同步时间', about.includes('relativeTime(cloud.lastSyncAt)'));
  check('回显 AI 密钥是否已填（不显示内容）', about.includes("settings.ai.key.trim() === ''"));
  check('回显版本号', about.includes('appVersionLabel()'));
}

// ─────────────────────────────────────────── 4. footer
console.log('\n[4] 首页 footer');
{
  check('显示应用名', footer.includes('白纸单词'));
  check('显示版本号', footer.includes('appVersionLabel()'));
  check('有「关于数据」链接', footer.includes('关于数据'));
  check('有一行数据存放说明', footer.includes('数据存储在你自己的浏览器和私有数据库'));
  check('备案号默认隐藏（填了才显示）', /if \(beian !== ''\)/.test(footer));
  check('footer 挂在 App 里', app.includes('renderFooter()'));
  check('版本号来自构建注入', read('vite.config.ts').includes('__APP_VERSION__'));
}

// ─────────────────────────────────────────── 5. 错误边界
console.log('\n[5] 错误边界（不白屏）');
{
  check('监听 window error', boundary.includes("addEventListener('error'"));
  check('监听 unhandledrejection（异步错误最容易漏）', boundary.includes("addEventListener('unhandledrejection'"));
  check('有「返回首页」按钮', boundary.includes('返回首页'));
  check('有「导出数据」按钮', boundary.includes('导出数据'));
  const boundaryImports = boundary
    .split('\n')
    .filter((l) => /^\s*import\b/.test(l))
    .join('\n');
  check(
    '导出不依赖应用模块（直接读 IndexedDB）',
    boundary.includes("indexedDB.open('blank-sheet-vocab')") && !/services\/|dao\//.test(boundaryImports),
    boundaryImports,
  );
  check('导出内容是词库本身', boundary.includes('words, sources'));
  check('只显示一次（避免连环报错刷屏）', boundary.includes('if (shown) return'));
  check('错误文案不吓人、说明数据还在', boundary.includes('你的数据还在'));
  check('启动时最先装错误边界', /boot[\s\S]{0,400}mountErrorBoundary\(\)/.test(main));
}

// ─────────────────────────────────────────── 6. 同步连续失败提示
console.log('\n[6] 云同步连续失败 3 次后常驻提示');
{
  const banner = read('src/ui/components/SyncBanner.ts');
  check('失败 3 次起改成常驻', banner.includes('failStreak >= PERSISTENT_FROM_STREAK') && banner.includes('PERSISTENT_FROM_STREAK = 3'));
  check('前几次失败自动消失（5 秒）', banner.includes('AUTO_HIDE_MS = 5_000'));
  check('常驻文案提到「数据已存本地」', banner.includes('数据已存本地'));
  check('提供「重试」按钮', banner.includes('重试'));
  check('同步中不打扰（顶部保持干净）', /state\.phase !== 'error'[\s\S]{0,80}dismiss\(\)/.test(banner));
}

// ─────────────────────────────────────────── 7. 收尾文档
console.log('\n[7] 文档（按用户要求清理过，见下）');
{
  const { existsSync } = await import('node:fs');
  // ★ 用户明确要求（2026-09）：把上一轮删掉的那批 md（含旧提示词全套、
  //   上线清单、README 系列、几份验收单）**从 git 里一并删掉**，
  //   规则与文档统一收敛到 AI_RULES.md + HANDOVER.md。
  //   （这里刻意不写旧品牌名，test:rename 会扫全库。）
  //   所以这里不再断言那些文件存在（原来的断言会让测试永远红），
  //   改成断言「留下来的两份文档在，且规则原文没丢」——
  //   约束的是**现在真正该在的东西**，而不是把删除当成 bug。
  check('AI_RULES.md 在（项目铁律，规则的家）', existsSync('./AI_RULES.md'));
  check('HANDOVER.md 在（交接文档）', existsSync('./HANDOVER.md'));
  const rules = read('AI_RULES.md');
  for (const section of ['R1 · 任何考察都不得设置强制时间限制', 'R2 · 义项系统规则', 'R3 · 「斩」不弹确认，但必须可撤销', 'R4 · 安全底线']) {
    check(`AI_RULES.md 含「${section}」`, rules.includes(section), section);
  }
  check('AI_RULES.md 保留了运行时提示词的必含片段', rules.includes('不得设置任何时间限制') && rules.includes('含义相近的中文意思合并为一个义项'));
}

console.log(`\n=== 结果：通过 ${passed} 项，失败 ${failed} 项 ===\n`);
process.exit(failed === 0 ? 0 : 1);
