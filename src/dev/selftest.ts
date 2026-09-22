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

/**
 * 等待一小会（IndexedDB 事务提交用）。
 *
 * RULES-R1: 只在浏览器自测脚本里用的等待，不在任何产品流程里，
 * 与答题计时无关（铁律允许保留的计时只有网络超时 / 防抖 / 动画这几类，
 * 本条属于测试脚手架）。
 */
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
 * 抽词算法自测（阶段 05~07）：pickForMemorize 的「只抽已出现 / 遍数最少优先 /
 * 同级随机 / 上一轮未通过作为额外项」规则、groupWords 分组、推荐值。
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
    name: 'pickForMemorize：已出现不满 maxPick 时按已出现数量抽（只进行 3 次）',
    ok: pick1.length === shown.length,
    detail: `抽了 ${pick1.length}/${shown.length} 个`,
  });

  // ★ 用户口径：上限是「遍数最少的先抽」，同级随机
  //   memorizeCount: a=5, b=1, c=0（c 没记过）→ 遍数升序 = c, b, a
  const pick2 = pickForMemorize(session, words, { maxPick: 2, targetCount: 3 });
  out.push({
    name: 'pickForMemorize：记忆遍数最少的优先抽',
    ok: pick2.length === 2 && pick2.includes(cId) && pick2.includes(bId),
    detail: pick2.join(','),
  });

  // ★ 用户口径：上一轮未通过、又没被「遍数最少」抽到的词 → 作为**额外项**加入（总数可超过上限）
  const extraSession: Session = {
    ...session,
    memorizeCount: { [aId]: 0, [bId]: 5, [cId]: 1 },
    lastRoundFailedIds: [bId],
  };
  const pick3 = pickForMemorize(extraSession, words, { maxPick: 1, targetCount: 3 });
  out.push({
    name: 'pickForMemorize：上一轮未通过的词作为额外项加入（总数超过上限）',
    ok: pick3.length === 2 && pick3.includes(aId) && pick3.includes(bId),
    detail: pick3.join(','),
  });

  // ★ 反向：没有额外项时，基础项**不许**超过上限
  const pick4 = pickForMemorize({ ...extraSession, lastRoundFailedIds: [] }, words, { maxPick: 2, targetCount: 3 });
  out.push({
    name: 'pickForMemorize：没有额外项时不超过 maxPick',
    ok: pick4.length === 2,
    detail: `抽了 ${pick4.length} 个：${pick4.join(',')}`,
  });

  // ★ 同级（遍数相同）时随机：候选多于上限、且遍数全相同时，重复抽应出现不同组合
  const tieSession: Session = { ...session, memorizeCount: {} };
  const combos = new Set<string>();
  for (let i = 0; i < 40; i += 1) {
    combos.add([...pickForMemorize(tieSession, words, { maxPick: 2, targetCount: 3 })].sort().join(','));
  }
  out.push({
    name: 'pickForMemorize：遍数相同时是随机抽（重复 40 次不止一种组合）',
    ok: combos.size > 1,
    detail: `${combos.size} 种组合：${[...combos].join(' | ')}`,
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
 * ★ T4：有道 TTS 签名的自测与「参考值」输出。
 *
 * ── 为什么要有它 ──
 * 签名算错的表现是**有道返回 202「签名校验失败」**，而这条信息里没有任何线索
 * 指向「是 input 截断写错了还是拼接顺序写错了」。
 * 所以必须有一个**不联网、可对照**的自测：
 * 给定固定的 appKey / appSecret / salt / curtime / q，输出 sign，
 * 与 `node scripts/youdaoSign.mjs`（教程里那份 Node 脚本）算出的值比对 ——
 * 两个独立实现（WebCrypto vs Node crypto）算出同一个哈希，才能证明算法写对了。
 *
 * ⚠️ **不自动执行**（与其它 selftest 一致）：它只是挂在 window 上的一个函数，
 * 由用户/测试显式调用。
 */

/** 自测用的固定输入（改动它等于让已有的参考值失效，非必要不要动） */
export const YOUDAO_SIGN_SAMPLE = {
  appKey: 'test-app-key',
  appSecret: 'test-app-secret',
  salt: '2fa4f0d0-1e6b-4c2f-9c1a-3f8f2b7d5e10',
  curtime: '1700000000',
  q: 'abandon',
} as const;

/**
 * 用固定输入算一遍签名（同时覆盖「短文本」与「长文本」两条截断分支）。
 */
export async function runYoudaoSignSelfTest(): Promise<SelfTestResult[]> {
  const out: SelfTestResult[] = [];
  const { youdaoSign, youdaoSignInput, sha256Hex } = await import('../services/tts/youdao');

  // ① 短文本（q ≤ 20）：input 就是 q 本身
  const short = { ...YOUDAO_SIGN_SAMPLE };
  const shortInput = youdaoSignInput(short.q);
  const shortSign = await youdaoSign(short);
  out.push({
    name: 'T4 有道签名：短文本 input = q',
    ok: shortInput === short.q,
    detail: `${shortInput}`,
  });
  out.push({
    name: 'T4 有道签名：短文本 sign 长度 64（sha256 十六进制）',
    ok: shortSign.length === 64 && /^[0-9a-f]{64}$/.test(shortSign),
    detail: shortSign,
  });

  // ② 长文本（q > 20）：input = 前 10 + 长度 + 后 10
  const longQ = 'abcdefghijKLMNOPQRSTuvwxyz-0123456789';
  const longInput = youdaoSignInput(longQ);
  const expectedLong = `${longQ.slice(0, 10)}${longQ.length}${longQ.slice(-10)}`;
  out.push({
    name: 'T4 有道签名：长文本 input = 前10 + 长度 + 后10',
    ok: longInput === expectedLong,
    detail: `${longInput}（期望 ${expectedLong}）`,
  });

  // ③ 拼接顺序必须是 appKey + input + salt + curtime + appSecret
  const manual = await sha256Hex(
    `${short.appKey}${shortInput}${short.salt}${short.curtime}${short.appSecret}`,
  );
  out.push({
    name: 'T4 有道签名：拼接顺序 appKey+input+salt+curtime+appSecret',
    ok: manual === shortSign,
    detail: `手工串=${manual.slice(0, 16)}… 函数=${shortSign.slice(0, 16)}…`,
  });

  // ④ 换一个字符必须换一个签名（防止「函数根本不看输入」这类错误）
  const other = await youdaoSign({ ...short, q: 'abandon ' });
  out.push({
    name: 'T4 有道签名：输入变了签名就变',
    ok: other !== shortSign,
    detail: `q="abandon" → ${shortSign.slice(0, 12)}… / q="abandon " → ${other.slice(0, 12)}…`,
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
        ...(await runYoudaoSignSelfTest()),
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
    /**
     * ★ T4：有道 TTS 签名自测（**不自动执行**）。
     *
     * 用法（控制台）：
     * ```js
     * await __selftest.youdaoSign()          // 跑断言
     * await __selftest.youdaoSignValue()     // 只取参考值，拿去和 Node 脚本比对
     * ```
     */
    youdaoSign: runYoudaoSignSelfTest,
    /** 用固定输入算一个签名值（与 `node scripts/youdaoSign.mjs` 的输出必须一致） */
    youdaoSignValue: async (): Promise<string> => {
      const { youdaoSign } = await import('../services/tts/youdao');
      return youdaoSign({ ...YOUDAO_SIGN_SAMPLE });
    },
  };
  (window as unknown as { __selftest: typeof api }).__selftest = api;
  console.info('[selftest] 已挂到 window.__selftest，手动执行：await __selftest.run()');
}
