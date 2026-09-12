/**
 * 预设词库自检：`npm run test:presets`
 *
 * 为什么值得单独写一整组断言：
 * 预设词库的产物是**一批静态数据**，出问题时不会报错，只会「悄悄不对」——
 * 比如剔除规则写错，导致四级里还混着初中词，用户导入后同一个词被两个来源争抢义项，
 * 界面看起来一切正常。这类错误只有把数据本身断言一遍才拦得住。
 *
 * 这里做四件事：
 * 1. 拿**原始词表**重新算一遍，验证产物与原始数据一致（而不是信任产物自己）；
 * 2. 验证「各档两两不相交」这个核心不变量；
 * 3. 验证前端的 key 归一化口径与生成脚本一致（不一致会导致判重错位）；
 * 4. 验证清单（src/core/presets.ts）与实际产物对得上。
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TIERS, parseList, buildPresets, toRows, keyOf } from '../../scripts/preset-lib.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC_DIR = join(ROOT, '一期预设词库');
const OUT_DIR = join(ROOT, 'public', 'presets');

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
 * 读一个文件（相对仓库根）。
 * @param {string} rel 相对路径
 */
function read(rel) {
  return readFileSync(join(ROOT, rel), 'utf8');
}

// —— [1] 产物存在且结构正确 ——
console.log('\n[1] 产物存在且结构正确');
const artifacts = {};
for (const tier of TIERS) {
  const file = join(OUT_DIR, `${tier.id}.json`);
  if (!existsSync(file)) {
    check(`${tier.label} 产物存在`, false, `缺 ${file}`);
    continue;
  }
  let data = null;
  try {
    data = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    check(`${tier.label} 产物是合法 JSON`, false, String(err));
    continue;
  }
  artifacts[tier.id] = data;
  check(`${tier.label} 产物是合法 JSON`, true);
  check(`${tier.label} 有 entries 数组`, Array.isArray(data.entries), typeof data.entries);
  check(`${tier.label} 词条数 > 0`, data.entries.length > 0, String(data.entries.length));

  // 每一行必须是 [英文, 义项数组, 音标?]，且英文/义项都不能为空
  const bad = data.entries.filter(
    (row) => !Array.isArray(row) || typeof row[0] !== 'string' || row[0].trim() === '' || !Array.isArray(row[1]) || row[1].length === 0,
  );
  check(`${tier.label} 每行都是「英文 + 至少一个义项」`, bad.length === 0, `有 ${bad.length} 行不合法`);
}

// —— [2] 从原始词表重新复算，验证产物没有算错 ——
console.log('\n[2] 用原始词表复算，验证产物一致');
if (!existsSync(SRC_DIR)) {
  check('原始词表目录存在', false, SRC_DIR);
} else {
  const lists = {};
  const problemTotal = { count: 0 };
  for (const tier of TIERS) {
    const parsed = parseList(tier.file, readFileSync(join(SRC_DIR, tier.file), 'utf8'));
    lists[tier.id] = parsed.byKey;
    problemTotal.count += parsed.problems.length;
  }
  check('原始词表全部解析成功（无问题行）', problemTotal.count === 0, `${problemTotal.count} 行解析失败`);

  const { kept } = buildPresets(lists);
  for (const tier of TIERS) {
    const expected = toRows(kept[tier.id]);
    const actual = artifacts[tier.id]?.entries ?? [];
    check(
      `${tier.label} 产物与原始词表复算结果一致（${expected.length} 词）`,
      JSON.stringify(expected) === JSON.stringify(actual),
      `复算 ${expected.length} 词，产物 ${actual.length} 词`,
    );
  }
}

// —— [3] ★ 核心不变量：各档两两不相交 ——
// 这条是整个设计的目的。破了就意味着用户导入多档时同一个词会被两个来源争抢义项。
console.log('\n[3] 核心不变量：任意两档没有重复词');
const keySets = {};
for (const tier of TIERS) {
  keySets[tier.id] = new Set((artifacts[tier.id]?.entries ?? []).map((row) => keyOf(row[0])));
}
let overlaps = 0;
for (let i = 0; i < TIERS.length; i += 1) {
  for (let j = i + 1; j < TIERS.length; j += 1) {
    const a = TIERS[i];
    const b = TIERS[j];
    const shared = [...keySets[a.id]].filter((k) => keySets[b.id].has(k));
    overlaps += shared.length;
    check(
      `${a.label} ∩ ${b.label} 为空`,
      shared.length === 0,
      shared.length > 0 ? `重复 ${shared.length} 个，例如 ${shared.slice(0, 5).join(', ')}` : '',
    );
  }
}
check('所有档位互不重复（汇总）', overlaps === 0, `共 ${overlaps} 处重复`);

// 档位内部也不能有重复（同一个词在表里出现两次）
for (const tier of TIERS) {
  const rows = artifacts[tier.id]?.entries ?? [];
  const seen = new Set();
  let dup = 0;
  for (const row of rows) {
    const k = keyOf(row[0]);
    if (seen.has(k)) dup += 1;
    seen.add(k);
  }
  check(`${tier.label} 档内无重复词`, dup === 0, `重复 ${dup} 个`);
}

// —— [4] 归一化口径与前端一致 ——
console.log('\n[4] 判重口径与前端 src/core/model.ts 一致');
const modelSrc = read('src/core/model.ts');
// 前端 normalizeEn 的实现细节：首尾去标点、空白压缩。这里断言关键正则真的在那，
// 以防有人改了 model.ts 却没想到会连带影响预设的判重口径。
check(
  'model.ts 的 normalizeEn 仍然会去掉首尾标点',
  modelSrc.includes('/^[\\s"\'“”‘’(\\[（【<]+/') && modelSrc.includes('/[\\s"\'“”‘’)\\]）】>.,;:!?]+$/'),
  '没找到预期的去标点正则',
);
check(
  'model.ts 的 normalizeEn 仍然会压缩连续空白',
  modelSrc.includes('replace(/\\s+/g, \' \')'),
  '没找到 \\s+ → 空格 的替换',
);
// 产物里的英文必须已经归一化过（否则入库时会与判重 key 不一致）
const notNormalized = [];
for (const tier of TIERS) {
  for (const row of artifacts[tier.id]?.entries ?? []) {
    const en = row[0];
    if (en !== en.trim() || /\s{2,}/.test(en) || /^["'“”‘’(\[（【<]/.test(en)) notNormalized.push(en);
  }
}
check('产物里的英文都已归一化（无首尾标点 / 无连续空格）', notNormalized.length === 0, notNormalized.slice(0, 5).join(', '));

// —— [5] 清单与实际产物对得上 ——
console.log('\n[5] 清单（src/core/presets.ts）与产物一致');
const manifestSrc = read('src/core/presets.ts');
for (const tier of TIERS) {
  const actual = artifacts[tier.id]?.entries.length ?? -1;
  // 清单里形如：id: 'cet4', ... count: 3104,
  const block = new RegExp(`id: '${tier.id}'[\\s\\S]*?count: (\\d+)`).exec(manifestSrc);
  check(`${tier.label} 清单里有该档位`, block !== null);
  if (block) {
    check(`${tier.label} 清单词数与产物一致`, Number(block[1]) === actual, `清单写 ${block[1]}，产物 ${actual}`);
  }
}
// 清单声明的档位数量与 TIERS 一致
const declaredIds = [...manifestSrc.matchAll(/id: '([a-z0-9]+)'/g)].map((m) => m[1]);
check(
  '清单里的档位与脚本里的档位完全相同',
  declaredIds.length === TIERS.length && TIERS.every((t) => declaredIds.includes(t.id)),
  `清单 ${declaredIds.join(',')} / 脚本 ${TIERS.map((t) => t.id).join(',')}`,
);

// —— [6] 前端确实在用这些档位 ——
console.log('\n[6] 前端接线正确');
const presetVocabSrc = read('src/services/presetVocab.ts');
check('presetVocab 从 public/presets 取数据', presetVocabSrc.includes('presets/'));
check('presetVocab 用 BASE_URL 拼路径（子路径部署不会 404）', presetVocabSrc.includes('import.meta.env.BASE_URL'));
const importPageSrc = read('src/ui/pages/ImportPage.ts');
check('录入页接了预设导入', importPageSrc.includes('importPreset') && importPageSrc.includes('loadPreset'));
check('预设导入后进合并确认页', importPageSrc.includes("navigate('/merge')"));
// SW 必须缓存 json，否则离线时点预设会失败
const swSrc = read('public/sw.js');
check('Service Worker 把 json 纳入缓存', /PRECACHE_EXT\s*=\s*\/\\\.\(\?:[^/]*json/.test(swSrc), 'PRECACHE_EXT 里没有 json');

// —— 汇总 ——
console.log(`\n预设词库自检：${passed} 项通过，${failed} 项失败`);
if (failed > 0) process.exit(1);
