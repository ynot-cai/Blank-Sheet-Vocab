/**
 * 开发用自测脚本（只在 `npm run dev` 下挂到 window.__selftest，**不自动执行**）。
 * 用法：打开页面 → F12 控制台 → `await __selftest.run()` / `__selftest.parser()` / `__selftest.endpoint()`
 */
import {
  normalizeEn,
  senseMatch,
  createSense,
  createWord,
  validateWord,
  formatSensesBrief,
  stripPosPrefix,
  splitPackedSenses,
} from '../core/model';
import { DEFAULT_SETTINGS } from '../core/config';
import { parseText } from '../core/parser';
import { validateExpr, PRESETS, computePriority } from '../core/priority';
import { jitteredGrid } from '../core/layout';
import { groupWords, pickForMemorize, recommendReviewCount } from '../core/pick';
import type { Session, Word } from '../core/types';
import { normalizeEndpoint } from '../services/ai';
import * as dao from '../dao';

/** 自测结果 */
export interface SelfTestResult {
  name: string;
  ok: boolean;
  detail: string;
}

/** 等待一小会（IndexedDB 事务提交用） */
const tick = (ms = 30): Promise<void> => new Promise((r) => window.setTimeout(r, ms));

/**
 * 数据层自测：插入 3 条假词 → getAll → updateAttrs → chop → query(chopped) → clearAll。
 */
export async function runDataSelfTest(): Promise<SelfTestResult[]> {
  const out: SelfTestResult[] = [];
  const source = await dao.sources.ensureByName('__selftest__');
  const words = [
    createWord('selftest-alpha', [createSense('n. 测试甲', ['甲'])], source.id),
    createWord('selftest-beta', [createSense('n. 测试乙')], source.id),
    createWord('selftest-gamma', [createSense('v. 测试丙')], source.id),
  ];

  const upsert = await dao.words.bulkUpsert(words);
  out.push({ name: 'bulkUpsert 插入 3 条', ok: upsert.inserted === 3, detail: JSON.stringify(upsert) });

  const all = await dao.words.getAll();
  const mine = all.filter((w) => w.en.startsWith('selftest-'));
  out.push({ name: 'getAll 能取回 3 条', ok: mine.length === 3, detail: `取回 ${mine.length} 条` });

  const first = mine[0];
  if (first) {
    await dao.words.updateAttrs(first.id, { failCount: 2, failCountTotal: 5 });
    const reloaded = await dao.words.getById(first.id);
    out.push({
      name: 'updateAttrs 改 failCount',
      ok: reloaded?.attrs.failCount === 2 && reloaded?.attrs.failCountTotal === 5,
      detail: JSON.stringify(reloaded?.attrs),
    });

    await dao.words.chop(first.id);
    const chopped = await dao.words.query({ status: ['chopped'], page: 1, pageSize: 50 });
    out.push({
      name: 'chop 后能在「已斩」里查到',
      ok: chopped.items.some((w) => w.id === first.id),
      detail: `已斩 ${chopped.total} 条`,
    });
  }

  const byEn = await dao.words.getByEn('SELFTEST-ALPHA');
  out.push({ name: 'getByEn 忽略大小写', ok: byEn !== null, detail: byEn ? byEn.en : 'null' });

  const removed = await dao.words.query({ keyword: '测试甲', page: 1, pageSize: 10 });
  out.push({
    name: '中文义项可搜到（keyword）',
    ok: removed.total >= 1,
    detail: `命中 ${removed.total} 条`,
  });

  // 清理自测数据
  await dao.words.removeMany(words.map((w) => w.id));
  await dao.sources.remove(source.id);
  const after = (await dao.words.getAll()).filter((w) => w.en.startsWith('selftest-'));
  out.push({ name: '清理自测数据', ok: after.length === 0, detail: `剩余 ${after.length} 条` });

  return out;
}

/**
 * 解析规则自测（阶段 02 验收第 6 条）：期望 3 条，义项分别 3 / 2 / 2 个。
 */
export function runParserSelfTest(): SelfTestResult[] {
  const sample = ['abandon  v. 放弃；抛弃；遗弃', 'ability\tn. 能力；才能', '# 这是注释', 'absorb  v. 吸收 / 吸引'].join('\n');
  const { entries, errors } = parseText(sample, { fieldSep: 'auto', senseSep: '；;／/|' });
  const counts = entries.map((e) => e.senses.length);
  const out: SelfTestResult[] = [
    {
      name: '规则解析：3 条词条',
      ok: entries.length === 3,
      detail: JSON.stringify(entries.map((e) => e.en)),
    },
    {
      name: '规则解析：义项数 3 / 2 / 2',
      ok: counts.join(',') === '3,2,2',
      detail: counts.join(' / '),
    },
    { name: '规则解析：注释行被跳过', ok: errors.length === 0 && !entries.some((e) => e.en.startsWith('#')), detail: `错误 ${errors.length} 条` },
  ];
  return out;
}

/**
 * 接口地址规范化自测（阶段 02 验收第 3b 条）。
 */
export function runEndpointSelfTest(): SelfTestResult[] {
  const cases: [string, string][] = [
    ['https://api.deepseek.com', 'https://api.deepseek.com/chat/completions'],
    ['https://api.deepseek.com/', 'https://api.deepseek.com/chat/completions'],
    ['https://api.deepseek.com/v1', 'https://api.deepseek.com/v1/chat/completions'],
    ['https://proxy.example.com/v1/chat/completions', 'https://proxy.example.com/v1/chat/completions'],
  ];
  return cases.map(([input, expected]) => {
    const got = normalizeEndpoint(input);
    return { name: `endpoint: ${input}`, ok: got === expected, detail: got };
  });
}

/**
 * 判分与优先度自测。
 */
export function runCoreSelfTest(): SelfTestResult[] {
  const sense = createSense('n. 苹果', ['苹果', 'apple']);
  const out: SelfTestResult[] = [
    { name: 'senseMatch 忽略大小写与标点', ok: senseMatch('  APPLE. ', sense), detail: 'APPLE. → apple' },
    { name: 'senseMatch 命中 aliases', ok: senseMatch('苹果', sense), detail: '苹果 → aliases' },
    { name: 'senseMatch 忽略词性前缀', ok: senseMatch('苹果', createSense('n. 苹果')), detail: 'n. 苹果 vs 苹果' },
    { name: 'normalizeEn 去首尾标点', ok: normalizeEn('  "Apple." ') === 'Apple', detail: normalizeEn('  "Apple." ') },
    {
      name: '默认值：无 30 词上限、背完条件默认 1 次',
      ok: !('learnMaxCount' in DEFAULT_SETTINGS) && DEFAULT_SETTINGS.memorizeTargetCount === 1,
      detail: `memorizeTargetCount=${DEFAULT_SETTINGS.memorizeTargetCount}`,
    },
    {
      name: '表达式白名单拦住非法表达式',
      ok: validateExpr('failCount *').ok === false && validateExpr('window.alert(1)').ok === false,
      detail: 'failCount * / window.alert(1) 都应被拒',
    },
    {
      name: '预设表达式可用',
      ok: (Object.keys(PRESETS) as (keyof typeof PRESETS)[]).every((k) => validateExpr(PRESETS[k].expr).ok),
      detail: '三个预设都通过校验',
    },
  ];
  const word = createWord('probe', [sense], 'src');
  const value = computePriority(word, DEFAULT_SETTINGS);
  out.push({ name: 'computePriority 不崩', ok: Number.isFinite(value), detail: String(value) });
  return out;
}

/**
 * 抽词算法自测（阶段 05~07）：pickForMemorize 只抽已出现 + 必抽/上限规则、groupWords 分组、推荐值。
 */
export function runPickSelfTest(): SelfTestResult[] {
  const out: SelfTestResult[] = [];
  const mk = (id: string, status: Word['status'] = 'unlearned'): Word => ({
    ...createWord(id, [createSense('n. 测试')], 'src'),
    status,
  });
  const words = [mk('a'), mk('b'), mk('c'), mk('d'), mk('e'), mk('f')];
  const aId = words[0]?.id ?? '';
  const bId = words[1]?.id ?? '';
  const cId = words[2]?.id ?? '';
  const shown = [aId, bId, cId];
  const session: Session = {
    id: 't',
    type: 'learn',
    wordIds: words.map((w) => w.id),
    placements: {},
    shownIds: shown,
    memorizeCount: { [aId]: 5, [bId]: 1 },
    spellEnabled: false,
    failedIds: [bId],
    failDeltas: {},
    groupId: 0,
    groups: [words.map((w) => w.id)],
    finished: false,
    createdAt: 0,
  };

  const pick1 = pickForMemorize(session, words, { maxPick: 10, targetCount: 3 });
  out.push({
    name: 'pickForMemorize：只抽已出现的词（未出现的不进记忆）',
    ok: pick1.length === 3 && pick1.every((id) => shown.includes(id)),
    detail: pick1.join(','),
  });
  out.push({
    name: 'pickForMemorize：已出现不满 maxPick 时按已出现数量抽',
    ok: pick1.length === shown.length,
    detail: `抽了 ${pick1.length}/${shown.length} 个`,
  });
  out.push({
    name: 'pickForMemorize：必抽的未通过词必在结果里',
    ok: pick1.includes(bId),
    detail: pick1.join(','),
  });

  // 记忆次数最少的优先：maxPick=2 时（mandatory=b + 次数最少的 c）
  const pick2 = pickForMemorize(session, words, { maxPick: 2, targetCount: 3 });
  out.push({
    name: 'pickForMemorize：记忆次数最少的优先补位',
    ok: pick2.length === 2 && pick2.includes(bId) && pick2.includes(cId),
    detail: pick2.join(','),
  });

  // 已出现的必抽词超过 maxPick 时全部纳入
  const manyFailed: Session = { ...session, failedIds: shown };
  const pick3 = pickForMemorize(manyFailed, words, { maxPick: 2, targetCount: 3 });
  out.push({
    name: 'pickForMemorize：必抽词超过 maxPick 时全部纳入',
    ok: pick3.length === 3,
    detail: `抽了 ${pick3.length} 个`,
  });

  // 顺序切分：65 个 → 3 组（30/30/5），rank 0 在第 1 组、rank 59 在第 2 组
  const groups = groupWords(Array.from({ length: 65 }, (_, i) => String(i)), 30);
  out.push({
    name: 'groupWords：65 个 → 3 组（30/30/5）',
    ok: groups.length === 3 && groups[0]?.length === 30 && groups[1]?.length === 30 && groups[2]?.length === 5,
    detail: groups.map((g) => g.length).join('/'),
  });
  out.push({
    name: 'groupWords：顺序切分（rank 0 → 第1组，rank 59 → 第2组）',
    ok: groups[0]?.includes('0') === true && groups[1]?.includes('59') === true && groups[2]?.includes('64') === true,
    detail: `第1组首尾 ${groups[0]?.[0]},${groups[0]?.at(-1)}；第3组 ${groups[2]?.join(',')}`,
  });

  const learned: Word[] = words.map((w, i) => ({
    ...w,
    status: 'learned' as const,
    attrs: { ...w.attrs, reviewPriority: i + 1, lastReviewAt: Date.now() - i * 86_400_000 },
  }));
  const rec = recommendReviewCount(learned, DEFAULT_SETTINGS);
  out.push({
    name: 'recommendReviewCount：有已背词时给正数推荐',
    ok: rec.count > 0 && rec.count <= DEFAULT_SETTINGS.reviewGroupSize * 3,
    detail: `推荐 ${rec.count} 个（阈值 ${rec.threshold.toFixed(2)}）`,
  });
  const recEmpty = recommendReviewCount([], DEFAULT_SETTINGS);
  out.push({
    name: 'recommendReviewCount：空库返回 0',
    ok: recEmpty.count === 0 && recEmpty.threshold === 0,
    detail: `${recEmpty.count}/${recEmpty.threshold}`,
  });
  return out;
}

/**
 * 布点算法自测：seed 可复现、数量正确、坐标在 0~1、两两不重叠。
 */
export function runLayoutSelfTest(): SelfTestResult[] {
  const out: SelfTestResult[] = [];
  const a = jitteredGrid(20, { aspect: 16 / 9, seed: 42 });
  const b = jitteredGrid(20, { aspect: 16 / 9, seed: 42 });
  const same = a.every((p, i) => Math.abs(p.x - (b[i]?.x ?? -1)) < 1e-9 && Math.abs(p.y - (b[i]?.y ?? -1)) < 1e-9);
  out.push({ name: 'jitteredGrid：同 seed 结果可复现', ok: a.length === 20 && same, detail: `${a.length} 个点` });
  out.push({
    name: 'jitteredGrid：坐标都在 0~1',
    ok: a.every((p) => p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1),
    detail: `x:${Math.min(...a.map((p) => p.x)).toFixed(2)}~${Math.max(...a.map((p) => p.x)).toFixed(2)}`,
  });
  let minDist = Number.MAX_VALUE;
  for (let i = 0; i < a.length; i += 1) {
    for (let j = i + 1; j < a.length; j += 1) {
      const p = a[i];
      const q = a[j];
      if (!p || !q) continue;
      const d = Math.hypot(p.x - q.x, p.y - q.y);
      if (d < minDist) minDist = d;
    }
  }
  out.push({ name: 'jitteredGrid：无重叠（最近间距 > 0.02）', ok: minDist > 0.02, detail: `最近间距 ${minDist.toFixed(3)}` });

  // 最小间距约束：100 个词但纸面只放得下 4×2 时截断，且两两间距不小于约束
  const gapped = jitteredGrid(100, { aspect: 2, seed: 7, margin: 0.05, minGapW: 0.22, minGapH: 0.42 });
  let gMin = Number.MAX_VALUE;
  for (let i = 0; i < gapped.length; i += 1) {
    for (let j = i + 1; j < gapped.length; j += 1) {
      const p = gapped[i];
      const q = gapped[j];
      if (!p || !q) continue;
      const dx = Math.abs(p.x - q.x);
      const dy = Math.abs(p.y - q.y);
      // 两个方向都小于间距才算冲突（留 1e-6 浮点容差）
      if (!(dx < 0.22 - 1e-6 && dy < 0.42 - 1e-6)) continue;
      if (dx < gMin) gMin = dx;
    }
  }
  out.push({
    name: 'jitteredGrid：最小间距约束（放不下的截断）',
    ok: gapped.length <= 8 && gapped.length > 0 && gMin === Number.MAX_VALUE,
    detail: `容量 ${gapped.length}（请求 100）`,
  });
  return out;
}

/**
 * 短语/缩写支持自测：含空格的短语、带点的缩写都应合法且可判分。
 */
export function runPhraseSelfTest(): SelfTestResult[] {
  const out: SelfTestResult[] = [];
  const phrase = createWord('give up', [createSense('v. 放弃', ['认输'])], 'src');
  const abbr = createWord('U.S.A.', [createSense('n. 美国', ['美利坚合众国'])], 'src');
  out.push({ name: '短语：validateWord 合法', ok: validateWord(phrase).length === 0, detail: phrase.en });
  out.push({ name: '缩写：validateWord 合法', ok: validateWord(abbr).length === 0, detail: abbr.en });
  out.push({
    name: 'normalizeEn 支持短语/缩写',
    ok: normalizeEn('  "give   up!" ') === 'give up' && normalizeEn('etc.') === 'etc',
    detail: `${normalizeEn('  "give   up!" ')} / ${normalizeEn('etc.')}`,
  });
  const { entries, errors } = parseText('give up\tv. 放弃；认输\nNASA\tn. 美国国家航空航天局\netc.\tabbr. 等等', {
    fieldSep: 'auto',
    senseSep: '；;／/|',
  });
  out.push({
    name: '规则解析：短语/缩写都进第一段',
    ok: entries.length === 3 && entries[0]?.en === 'give up' && entries[1]?.en === 'NASA' && errors.length === 0,
    detail: entries.map((e) => e.en).join(' / '),
  });
  // 白纸上的简版中文意思：词性.①义项1②义项2，只显示代表、不含近义词
  const brief = formatSensesBrief([
    createSense('n. 苹果', ['apple', '苹果树']),
    createSense('n. 苹果树', []),
  ]);
  out.push({
    name: 'formatSensesBrief：词性.①义项1②义项2 且不含近义词',
    ok: brief === 'n. ①苹果②苹果树',
    detail: brief,
  });
  const mixed = formatSensesBrief([createSense('n. 苹果'), createSense('v. 咬')]);
  out.push({
    name: 'formatSensesBrief：词性不同则逐条罗列',
    ok: mixed === 'n. 苹果；v. 咬',
    detail: mixed,
  });
  // 多词性前缀：adj./adv. 逆时针的 → 逆时针的
  out.push({
    name: '多词性前缀：stripPosPrefix("adj./adv. 逆时针的") = 逆时针的',
    ok: stripPosPrefix('adj./adv. 逆时针的') === '逆时针的',
    detail: stripPosPrefix('adj./adv. 逆时针的'),
  });
  out.push({
    name: '多词性前缀：senseMatch 判分不受影响',
    ok: senseMatch('逆时针的', createSense('adj./adv. 逆时针的')),
    detail: '输入「逆时针的」→ 命中 adj./adv. 逆时针的',
  });
  out.push({
    name: '多词性前缀：formatSensesBrief 原样保留词性',
    ok: formatSensesBrief([createSense('adj./adv. 逆时针的')]) === 'adj./adv. ①逆时针的',
    detail: formatSensesBrief([createSense('adj./adv. 逆时针的')]),
  });
  // 顿号打包的义项自动拆开：n. 量纲、维度 → 两个义项
  const packed = splitPackedSenses('n. 量纲、维度');
  out.push({
    name: 'splitPackedSenses：n. 量纲、维度 → [n. 量纲, n. 维度]',
    ok: packed.length === 2 && packed[0] === 'n. 量纲' && packed[1] === 'n. 维度',
    detail: packed.join(' | '),
  });
  const packedParse = parseText('dimension\tn. 量纲、维度', { fieldSep: 'auto', senseSep: '；;／/|' });
  out.push({
    name: '规则解析：顿号打包的义项拆成两个',
    ok: packedParse.entries[0]?.senses.length === 2,
    detail: (packedParse.entries[0]?.senses ?? []).join(' | '),
  });
  return out;
}

/**
 * 把自测挂到 window.__selftest（开发模式专用）。
 */
export function attachSelfTest(): void {
  const api = {
    /** 全部跑一遍 */
    run: async (): Promise<SelfTestResult[]> => {
      const results: SelfTestResult[] = [
        ...runEndpointSelfTest(),
        ...runParserSelfTest(),
        ...runCoreSelfTest(),
        ...runPickSelfTest(),
        ...runLayoutSelfTest(),
        ...runPhraseSelfTest(),
        ...(await runDataSelfTest()),
      ];
      const failed = results.filter((r) => !r.ok);
      console.table(results.map((r) => ({ 项目: r.name, 结果: r.ok ? '✅' : '❌', 详情: r.detail })));
      console.info(`[selftest] ${results.length - failed.length}/${results.length} 通过`);
      await tick();
      return results;
    },
    data: runDataSelfTest,
    parser: runParserSelfTest,
    endpoint: runEndpointSelfTest,
    core: runCoreSelfTest,
    pick: runPickSelfTest,
    layout: runLayoutSelfTest,
    phrase: runPhraseSelfTest,
  };
  (window as unknown as { __selftest: typeof api }).__selftest = api;
  console.info('[selftest] 已挂到 window.__selftest，手动执行：await __selftest.run()');
}
