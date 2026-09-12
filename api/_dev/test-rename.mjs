/**
 * 改名自检：`npm run test:rename`
 *
 * 背景：项目从「单词白纸 / wordpaper」改名为「白纸单词 / blank-sheet-vocab」。
 * 改名点很散——UI 文案、IndexedDB 库名、localStorage 键、落盘文件名、SW 缓存前缀、
 * PWA manifest、包名，还有 `api/_dev/*.mjs` 里**硬编码的断言字符串**。
 *
 * ★ 为什么必须有一条自动化的护栏：
 *   改名最容易的失败方式是「漏了一处」，而漏掉的地方往往**不报错**——
 *   比如界面顶部还挂着旧名字，或者某个 localStorage 键没改导致「iOS 语音解锁标记」失效。
 *   更阴的是：`api/_dev/` 里的断言写死了旧名，改名后**测试自己会红**，
 *   那时候很容易顺手把断言改回旧值来「修好」测试，等于把 bug 焊死。
 *   所以这里统一守住「新名/旧名到底该出现在哪」。
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

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
 * 递归列出文件。
 * @param {string} dir 目录
 * @param {(name: string) => boolean} filter 文件名过滤
 */
function walk(dir, filter) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git' || name === 'dist' || name === '.tmp') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full, filter));
    else if (filter(name)) out.push(full);
  }
  return out;
}

/**
 * 在若干文件里找包含某字符串的位置。
 * @param {string[]} files 文件列表
 * @param {string} needle 要找的字符串
 * @param {string[]} [skip] 要跳过的文件（相对仓库根的路径）
 */
function findIn(files, needle, skip = []) {
  const hits = [];
  const skipAbs = skip.map((s) => join(ROOT, s));
  for (const file of files) {
    if (skipAbs.includes(file)) continue;
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    text.split(/\r?\n/).forEach((line, i) => {
      if (line.includes(needle)) hits.push(`${relative(ROOT, file)}:${i + 1}`);
    });
  }
  return hits;
}

/**
 * 拼出旧品牌名。
 *
 * ★ 这里刻意不直接写那五个字：本文件自己就是「搜旧名」的执行者，
 *   如果把旧名写成字面量，它就会被自己搜出来（自指）。
 *   用拼接得到同样的字符串，语义不变，但字面量不存在。
 */
const OLD_BRAND = `${'单词'}${'白纸'}`;
/** 同理：自检文件里需要提到旧标识时的哨兵标记，带这个标记的行不算违规 */
const TEST_SENTINEL = 'rename-selftest-allow';

// 会被搜索的源码/配置：**运行时**会用到名字的地方
const CODE_FILES = [
  ...walk(join(ROOT, 'src'), (n) => /\.(ts|css)$/.test(n)),
  ...walk(join(ROOT, 'api', '_dev'), (n) => n.endsWith('.mjs')),
  ...walk(join(ROOT, 'scripts'), (n) => n.endsWith('.mjs')),
  ...walk(join(ROOT, 'public'), (n) => /\.(js|webmanifest)$/.test(n)),
  join(ROOT, 'index.html'),
  join(ROOT, 'package.json'),
  join(ROOT, 'vite.config.ts'),
];

/** 文档（旧名允许出现在「历史沿革」的说明里） */
const DOC_FILES = ['README.md', 'README-DEPLOY.md', 'HANDOVER.md', 'CHECKLIST.md']
  .map((f) => join(ROOT, f))
  .filter((f) => existsSync(f));

// ─────────────────────────────────────────── 1. 旧标识必须绝迹
// 扫描时跳过本文件（它自己就是搜旧名的执行者，见 TEST_SENTINEL 的说明）
const SELF = 'api/_dev/test-rename.mjs';

console.log('\n[1] 旧标识「wordpaper」在代码里必须绝迹');
const wordpaperHits = findIn(CODE_FILES, 'wordpaper', [SELF]);
check(
  '代码里没有任何 wordpaper',
  wordpaperHits.length === 0,
  wordpaperHits.length > 0 ? `${wordpaperHits.length} 处：${wordpaperHits.slice(0, 6).join(', ')}` : '',
);

console.log(`\n[2] 旧品牌名「${OLD_BRAND}」在代码里必须绝迹`);
const oldBrandHits = findIn(CODE_FILES, OLD_BRAND, [SELF]);
check(
  `代码里没有任何「${OLD_BRAND}」`,
  oldBrandHits.length === 0,
  oldBrandHits.length > 0 ? `${oldBrandHits.length} 处：${oldBrandHits.slice(0, 6).join(', ')}` : '',
);

// ─────────────────────────────────────────── 3. 新名必须出现在关键位置
console.log('\n[3] 新名出现在所有该出现的位置');
const NEW_BRAND = '白纸单词';
const NEW_SLUG = 'blank-sheet-vocab';
const NEW_DB = 'blank-sheet-vocab';

/** 文件内容必须包含某个字符串 */
const mustContain = [
  ['IndexedDB 库名', 'src/core/db.ts', `DB_NAME = '${NEW_DB}'`],
  ['错误边界的救火读取也指向新库名', 'src/ui/components/ErrorBoundary.ts', `indexedDB.open('${NEW_DB}')`],
  ['设置镜像键', 'src/dao/settings.ts', `${NEW_SLUG}.settings`],
  ['导入任务存档键', 'src/services/importJob.ts', `${NEW_SLUG}.importJob`],
  ['iOS 语音解锁标记', 'src/ui/components/SpeechGate.ts', `${NEW_SLUG}.speechUnlocked`],
  ['安装提示标记', 'src/services/pwa.ts', `${NEW_SLUG}.installHintShown`],
  ['本地文件夹备份文件名', 'src/services/localfile.ts', `${NEW_SLUG}-data.json`],
  ['SW 缓存前缀', 'public/sw.js', `${NEW_SLUG}-v1`],
  ['SW 清旧缓存的前缀', 'public/sw.js', `startsWith('${NEW_SLUG}-')`],
  ['PWA manifest 名称', 'public/manifest.webmanifest', NEW_BRAND],
  ['页面标题', 'index.html', NEW_BRAND],
  ['iOS 主屏幕名', 'index.html', NEW_BRAND],
  ['包名', 'package.json', `"name": "${NEW_SLUG}"`],
  ['顶栏品牌名', 'src/App.ts', NEW_BRAND],
  ['首页标题', 'src/ui/pages/HomePage.ts', NEW_BRAND],
  ['footer 品牌名', 'src/ui/components/Footer.ts', NEW_BRAND],
  ['备份文件名', 'src/services/backup.ts', `${NEW_BRAND}备份_`],
];

for (const [what, rel, needle] of mustContain) {
  const file = join(ROOT, rel);
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  check(`${what}用新名（${rel}）`, text.includes(needle), `找不到 ${JSON.stringify(needle)}`);
}

// ─────────────────────────────────────────── 4. 自检脚本不能把旧名写死
console.log('\n[4] 自检脚本里的断言没有把旧名写死');
// 这一条是防「测试自己红了，就把断言改回旧值」那种修法。
// 只找「断言里要求必须出现旧名」的写法（positive 断言），
// 因为「要求**不**出现旧名」的否定断言是正当的。
const selfTestFiles = walk(join(ROOT, 'api', '_dev'), (n) => n.endsWith('.mjs'));
const assertOldName = findIn(selfTestFiles, `includes('${OLD_BRAND}')`, [SELF]).concat(
  findIn(selfTestFiles, `includes("${OLD_BRAND}")`, [SELF]),
);
check('没有断言还要求出现旧品牌名', assertOldName.length === 0, assertOldName.join(', '));

// ─────────────────────────────────────────── 5. 文档应说明改名
console.log('\n[5] 文档记录了改名这件事');
const docText = DOC_FILES.map((f) => readFileSync(f, 'utf8')).join('\n');
check('文档里提到了新标识 blank-sheet-vocab', docText.includes(NEW_SLUG));
check('HANDOVER 记录了改名历史', readFileSync(join(ROOT, 'HANDOVER.md'), 'utf8').includes('改名'));

// ─────────────────────────────────────────── 6. 构建产物与逻辑名一致
console.log('\n[6] 生成物与清单一致');
const presetsTs = readFileSync(join(ROOT, 'src/core/presets.ts'), 'utf8');
check('预设清单没有被改名波及（仍能正常解析）', presetsTs.includes('PRESET_TIERS'));

// ─────────────────────────────────────────── 汇总
console.log(`\n改名自检：${passed} 项通过，${failed} 项失败`);
if (failed > 0) process.exit(1);
