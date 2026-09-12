/**
 * 构建期生成「预设词库」：`npm run presets`。
 *
 * 输入：`一期预设词库/*.txt`（原始词表，手工收集，乱序、格式不统一）
 * 输出：
 *   - `public/presets/<tier>.json`  —— 每档一份，前端按需 fetch
 *   - `src/core/presets.ts`         —— 档位清单（id / 名称 / 优先级 / 词数），前端据此渲染按钮
 *
 * ★ 为什么生成产物要提交进仓库，而不是每次构建现算：
 *   产物是「可复核的数据」，而不是构建中间物。入库后：
 *     1. 前端构建不依赖 `一期预设词库/`（那是原始素材，可以随时挪走）；
 *     2. `git diff` 能看出「哪个词被加进来/剔出去了」，改词表这件事才可审计；
 *     3. 自检脚本可以拿产物和原始词表**独立复算一遍**，验证没有算错（见 api/_dev/test-presets.mjs）。
 *
 * 用法：
 *   node scripts/build-presets.mjs          正常生成
 *   node scripts/build-presets.mjs --check  只校验产物是否与原始词表一致（CI / 自检用，不写文件）
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TIERS, parseList, buildPresets, toRows } from './preset-lib.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
/** 原始词表目录（素材） */
const SRC_DIR = join(ROOT, '一期预设词库');
/** 产物目录（前端按 ./presets/<id>.json 取） */
const OUT_DIR = join(ROOT, 'public', 'presets');
/** 档位清单产物 */
const MANIFEST_TS = join(ROOT, 'src', 'core', 'presets.ts');

const CHECK_ONLY = process.argv.includes('--check');

/**
 * 读出五份原始词表并解析。
 */
function loadLists() {
  if (!existsSync(SRC_DIR)) {
    console.error(`✗ 找不到原始词表目录：${SRC_DIR}`);
    console.error('  这个目录是生成预设词库的输入，删掉它就没法重新生成了。');
    process.exit(1);
  }
  const present = readdirSync(SRC_DIR);
  const lists = {};
  const problemsAll = {};

  for (const tier of TIERS) {
    if (!present.includes(tier.file)) {
      console.error(`✗ 缺少词表文件：${tier.file}`);
      process.exit(1);
    }
    const raw = readFileSync(join(SRC_DIR, tier.file), 'utf8');
    const parsed = parseList(tier.file, raw);
    lists[tier.id] = parsed.byKey;
    problemsAll[tier.id] = parsed.problems;
  }
  return { lists, problemsAll };
}

/**
 * 生成 `src/core/presets.ts` 的内容。
 * @param report buildPresets 的报告
 */
function manifestSource(report) {
  const lines = report.map((r) => {
    const { id, label } = r;
    const tier = TIERS.find((t) => t.id === id);
    return (
      `  {\n` +
      `    id: '${id}',\n` +
      `    label: '${label}',\n` +
      `    sourceName: '${tier.sourceName}',\n` +
      `    priority: ${tier.priority},\n` +
      `    count: ${r.final},\n` +
      `    file: '${id}.json',\n` +
      `  },`
    );
  });

  const chain = report
    .map((r) => ` *   ${r.label}：原表 ${r.raw} → 剔除 ${r.removed} → 保留 ${r.final}`)
    .join('\n');

  return `/**
 * 预设词库清单。
 *
 * ★ 这个文件由 \`npm run presets\` 自动生成，**不要手改**。
 *   （手改会被下次生成覆盖；要改词表请改 \`一期预设词库/\` 下的原始文件再重新生成。）
 *
 * 各档的实际词条在 \`public/presets/<id>.json\`，前端用 \`services/presetVocab.ts\` 按需加载。
 *
 * 剔除规则是**递归**的——每一档都减掉所有更低档：
 *   ${report.map((r) => r.label).join(' → ')}
${chain}
 *
 * ★ 请先看这组数字再改剔除规则：
 *   实测考研表 5047 词里有 4752 个（94.2%）本来就在初中/四级/六级表里，
 *   所以严格递归后考研档只剩 295 词。这是**有意为之**——换来的是「五个档位两两没有重复词」，
 *   把几档都导入也不会出现同一个词被两个来源争抢义项。
 *   如果哪天想改成「只减相邻下一档」（考研能到 2497 词，但会残留 2202 个初中词），
 *   改 \`scripts/preset-lib.mjs\` 的 TIERS[].excludes，然后重新跑 \`npm run presets\`。
 */

/** 一档预设词库 */
export interface PresetTier {
  /** 稳定 id，同时是 JSON 文件名（不含扩展名） */
  id: string;
  /** 按钮上显示的名字 */
  label: string;
  /** 入库时创建的来源名称 */
  sourceName: string;
  /** 来源优先级（数字越大越优先，与设置页方向一致） */
  priority: number;
  /** 词条数（生成时写入，用于按钮上显示「预计导入 N 词」） */
  count: number;
  /** 相对 \`public/presets/\` 的文件名 */
  file: string;
}

/** 全部档位，按从低到高排列 */
export const PRESET_TIERS: PresetTier[] = [
${lines.join('\n')}
];

/**
 * 按 id 取档位。
 * @param id 档位 id
 */
export function findTier(id: string): PresetTier | null {
  return PRESET_TIERS.find((t) => t.id === id) ?? null;
}
`;
}

// —— 主流程 ——
const { lists, problemsAll } = loadLists();

// 解析问题必须暴露出来：静默丢词是这类数据加工最危险的失败方式
let totalProblems = 0;
for (const tier of TIERS) {
  const problems = problemsAll[tier.id];
  totalProblems += problems.length;
  const mark = problems.length === 0 ? '✓' : '!';
  console.log(`${mark} ${tier.label.padEnd(4)} 解析出 ${String(lists[tier.id].size).padStart(5)} 词，问题行 ${problems.length}`);
  for (const p of problems.slice(0, 5)) {
    console.log(`    L${p.line} ${p.why} :: ${p.text.slice(0, 70)}`);
  }
}

const { kept, report } = buildPresets(lists);

console.log('\n=== 递归剔除结果 ===');
for (const r of report) {
  const by = r.removedBy.length
    ? '  ← 剔除 ' + r.removedBy.map((b) => `${b.label} ${b.count}`).join(' / ')
    : '';
  console.log(
    `${r.label.padEnd(4)} 原表 ${String(r.raw).padStart(5)} → 保留 ${String(r.final).padStart(5)}（剔除 ${r.removed}）${by}`,
  );
}

// ★ 核心不变量：各档两两不相交。
// 注意**不能**要求「逐级递减」——每档的原始词表是独立收集的，档间没有超集关系
// （实测四级保留 3104 > 初中 1987，这是完全正常的）。
// 真正要保证的是：任意两档没有重复词，这样用户把几档都导入也不会出现
// 「同一个词被两个来源争抢义项」，这正是这个需求的目的。
console.log('\n=== 不变量校验：各档两两不相交 ===');
let overlapTotal = 0;
for (let i = 0; i < TIERS.length; i += 1) {
  for (let j = i + 1; j < TIERS.length; j += 1) {
    const a = TIERS[i];
    const b = TIERS[j];
    let hit = 0;
    for (const key of kept[a.id].keys()) if (kept[b.id].has(key)) hit += 1;
    overlapTotal += hit;
    if (hit > 0) console.log(`  ✗ ${a.label} ∩ ${b.label} = ${hit} 个重复词`);
  }
}
if (overlapTotal > 0) {
  console.error(`\n✗ 剔除不彻底：各档之间还有 ${overlapTotal} 处重复。`);
  process.exit(1);
}
console.log('  ✓ 任意两档都没有重复词');

// —— 写出产物 ——
mkdirSync(OUT_DIR, { recursive: true });
const outputs = [];
for (const tier of TIERS) {
  const rows = toRows(kept[tier.id]);
  const json = JSON.stringify({ id: tier.id, label: tier.label, entries: rows });
  outputs.push({ file: join(OUT_DIR, `${tier.id}.json`), text: json, count: rows.length });
}
const manifest = manifestSource(report);
outputs.push({ file: MANIFEST_TS, text: manifest, count: report.length });

console.log('\n=== 产物 ===');
let mismatch = 0;
for (const out of outputs) {
  const rel = out.file.slice(ROOT.length + 1).replace(/\\/g, '/');
  const kb = (Buffer.byteLength(out.text, 'utf8') / 1024).toFixed(1);
  if (CHECK_ONLY) {
    const same = existsSync(out.file) && readFileSync(out.file, 'utf8') === out.text;
    if (!same) mismatch += 1;
    console.log(`${same ? '✓' : '✗'} ${rel}  ${kb} KB${same ? '' : '  ← 与磁盘上的不一致'}`);
  } else {
    writeFileSync(out.file, out.text, 'utf8');
    console.log(`✓ ${rel}  ${kb} KB`);
  }
}

const totalWords = report.reduce((sum, r) => sum + r.final, 0);
console.log(`\n共 ${report.length} 档、${totalWords} 词条。解析问题行 ${totalProblems} 条（已跳过，不计入）。`);

if (CHECK_ONLY && mismatch > 0) {
  console.error(`\n✗ ${mismatch} 份产物与原始词表不一致。跑 \`npm run presets\` 重新生成。`);
  process.exit(1);
}
if (CHECK_ONLY) console.log('✓ 产物与原始词表一致');
