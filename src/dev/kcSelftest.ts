/**
 * 二期验收自测（只在 `npm run dev` 下挂到 `window.__kcselftest`，**不自动执行**）。
 *
 * 用法：打开页面 → F12 控制台 →
 *   await __kcselftest.run()      // 全部验收项
 *   __kcselftest.mastery()        // 只验掌握度公式（同步、纯函数）
 *   __kcselftest.xss(true)        // 只验安全渲染（会把测试内容留在页面上肉眼确认）
 *   await __kcselftest.data()     // 只验二期 DAO（真 IndexedDB）
 *
 * 拆成三个文件：本文件（入口 + 数据层）、`kcXssSelftest`（安全渲染）、
 * `kcSelftestTypes`（公共类型与打印）。
 *
 * 覆盖阶段 01 验收项 3（mastery 公式）、验收项 4（XSS 安全渲染）、
 * 以及二期 DAO 的本地读写。验收项 5/6/7（空间隔离、软删除、断网）
 * 需要后端与多空间，由 `npm run test:kc` 在 Node 里跑真实链路验证。
 */
import { DEFAULT_SETTINGS, KC } from '../core/config';
import { calcMastery, coerceCard, createEmptyCard, validateCard } from '../core/kcModel';
import { computeKcPriority, isBlindSpot } from '../core/kcPriority';
import type { Block } from '../core/kcTypes';
import * as dao from '../dao';
import { runXssSelfTest } from './kcXssSelftest';
import { fmt, print, tick, type KcSelfTestResult } from './kcSelftestTypes';

/**
 * 掌握度公式验收（阶段 01 验收项 3）。
 *
 * 期望：
 * - `calcMastery(3,3)` ≈ 1.0（真掌握）
 * - `calcMastery(3,1)` **明显低于** `calcMastery(1,3)`（惩罚项生效：盲目自信被拉低）
 * - `calcMastery(1,1)` ≈ 0.33
 * - `calcMastery(null,2)` = 0.667
 * - 所有结果都在 [0,1] 内
 */
export function runMasterySelfTest(): KcSelfTestResult[] {
  const out: KcSelfTestResult[] = [];
  const push = (name: string, ok: boolean, detail: string): void => {
    out.push({ name, ok, detail });
  };

  const m33 = calcMastery(3, 3);
  const m31 = calcMastery(3, 1);
  const m13 = calcMastery(1, 3);
  const m11 = calcMastery(1, 1);
  const mN2 = calcMastery(null, 2);
  const m3N = calcMastery(3, null);
  const mNN = calcMastery(null, null);

  push('calcMastery(3,3) ≈ 1.0', Math.abs(m33 - 1) < 1e-9, `得到 ${fmt(m33)}`);
  push(
    '★ calcMastery(3,1) 明显低于 calcMastery(1,3)（惩罚项生效，抓盲目自信）',
    m31 < m13 - 0.1,
    `3/1=${fmt(m31)} vs 1/3=${fmt(m13)}`,
  );
  push('calcMastery(1,1) ≈ 0.33', Math.abs(m11 - 1 / 3) < 0.002, `得到 ${fmt(m11)}`);
  push(
    'calcMastery(null,2) = 0.5（缺失一侧按中性先验 0.5 补）',
    Math.abs(mN2 - 0.5) < 0.002,
    `得到 ${fmt(mN2)}`,
  );
  push('calcMastery(3,null) = 0（光自评满分不算掌握）', Math.abs(m3N) < 0.002, `得到 ${fmt(m3N)}`);
  push('calcMastery(null,null) = 0', mNN === 0, `得到 ${fmt(mNN)}`);

  const all = [m33, m31, m13, m11, mN2, m3N, mNN];
  push(
    '所有结果都在 [0,1] 内',
    all.every((v) => v >= 0 && v <= 1 && Number.isFinite(v)),
    all.map(fmt).join(', '),
  );
  push(
    '越界分数被钳制（calcMastery(9,9) 仍是 1）',
    calcMastery(9, 9) === 1,
    `得到 ${fmt(calcMastery(9, 9))}`,
  );

  // 自定义参数：把惩罚调成 0，盲目自信就不再被拉低（验证参数真的生效）
  const noPenalty = calcMastery(3, 1, { w1: 0.6, w2: 0.4, penalty: 0 });
  push('可自定义参数（penalty=0 时 3/1 = 0.733）', Math.abs(noPenalty - 0.733) < 0.002, `得到 ${fmt(noPenalty)}`);

  // 优先度：盲目自信的卡片应该排在前面
  const blind = computeKcPriority({
    learnedAt: null,
    lastReviewAt: Date.now(),
    reviewCount: 1,
    lastSelfScore: 3,
    lastExamScore: 1,
    mastery: m31,
    reviewPriority: 0,
  });
  const honest = computeKcPriority({
    learnedAt: null,
    lastReviewAt: Date.now(),
    reviewCount: 1,
    lastSelfScore: 1,
    lastExamScore: 1,
    mastery: m11,
    reviewPriority: 0,
  });
  push('盲目自信的卡片优先度更高', blind > honest, `盲目自信=${blind} vs 真不会=${honest}`);
  push(
    'isBlindSpot 能识别盲目自信',
    isBlindSpot({
      learnedAt: null,
      lastReviewAt: null,
      reviewCount: 0,
      lastSelfScore: 3,
      lastExamScore: 1,
      mastery: 0,
      reviewPriority: 0,
    }),
    '',
  );

  return out;
}

/**
 * 本地数据层验收（IndexedDB 读写、软删除墓碑、查询排序）。
 *
 * 全部用 `__kcselftest__` 前缀的临时数据，跑完自己删干净。
 */
export async function runDataSelfTest(): Promise<KcSelfTestResult[]> {
  const out: KcSelfTestResult[] = [];
  const push = (name: string, ok: boolean, detail: string): void => {
    out.push({ name, ok, detail });
  };

  const cards = [
    { ...createEmptyCard('__kcselftest__ 定语从句'), summary: '关系代词 vs 关系副词' },
    { ...createEmptyCard('__kcselftest__ 虚拟语气'), summary: 'should 的省略' },
    { ...createEmptyCard('__kcselftest__ 非谓语动词'), summary: 'doing vs done' },
  ];
  const inserted = await dao.kc.bulkUpsert(cards);
  push('bulkUpsert 插入 3 张卡', inserted.inserted === 3, JSON.stringify(inserted));
  await tick();

  const all = await dao.kc.getAll();
  const mine = all.filter((c) => c.title.startsWith('__kcselftest__'));
  push('getAll 能取回 3 张卡', mine.length === 3, `取回 ${mine.length} 张`);

  const first = mine[0];
  if (first === undefined) {
    push('后续自测', false, '第一张卡没取到，后面跳过');
    return out;
  }

  const card = await dao.kc.getById(first.id);
  push('getById 能取回同一张卡', card?.id === first.id, card?.title ?? 'null');

  // 自评 3 分（还没考核）：按公式对照表 mastery 应该是 0（光自评满分不算掌握），
  // 但 reviewPriority 必须 > 0（越该复习越靠前）
  const attrs = await dao.kc.updateAttrs(first.id, { lastSelfScore: 3, lastReviewAt: Date.now() });
  push(
    'updateAttrs 会同时重算 mastery / reviewPriority',
    attrs !== null && attrs.mastery === 0 && attrs.reviewPriority > 0,
    JSON.stringify(attrs),
  );

  const blocks: Block[] = [{ id: 'b1', type: 'text', content: '改过的块' }];
  const okBlocks = await dao.kc.updateBlocks(first.id, blocks);
  const reloaded = await dao.kc.getById(first.id);
  push('updateBlocks 换块成功', okBlocks && reloaded?.blocks.length === 1, `块数 ${reloaded?.blocks.length}`);

  // 斩 / 复活
  await dao.kc.chop(first.id);
  const chopped = await dao.kc.getById(first.id);
  push('chop 是软删除（deleted=1 且行还在）', chopped !== null && chopped.deleted === 1, JSON.stringify(chopped?.deleted));

  const q1 = await dao.kc.query({ status: ['chopped'], page: 1, pageSize: 50 });
  const inChopped = q1.items.some((c) => c.id === first.id);
  push('query(status:[chopped]) 能查到斩掉的卡', inChopped, `total=${q1.total}`);

  const q2 = await dao.kc.query({ page: 1, pageSize: 50 });
  push('默认查询不含墓碑', !q2.items.some((c) => c.id === first.id), `total=${q2.total}`);

  await dao.kc.revive(first.id);
  const revived = await dao.kc.getById(first.id);
  push('revive 复活（deleted=0、状态回到 unlearned）', revived?.deleted === 0 && revived.status === 'unlearned', JSON.stringify(revived?.status));

  // 关键词 / 排序
  const q3 = await dao.kc.query({ keyword: '虚拟', page: 1, pageSize: 50 });
  push('keyword 查询命中 1 张', q3.items.length === 1, `命中 ${q3.items.length} 张`);

  const q4 = await dao.kc.query({ sort: 'title', order: 'asc', page: 1, pageSize: 50 });
  const titles = q4.items.map((c) => c.title);
  push('按标题排序是升序', titles.join('|') === [...titles].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN')).join('|'), titles.join(' / '));

  // 分页
  const p1 = await dao.kc.query({ page: 1, pageSize: 2, sort: 'title', order: 'asc' });
  const p2 = await dao.kc.query({ page: 2, pageSize: 2, sort: 'title', order: 'asc' });
  push('分页不重复（第 1、2 页无交集）', p1.items.every((a) => !p2.items.some((b) => b.id === a.id)), `p1=${p1.items.length} p2=${p2.items.length}`);

  // 校验与容错
  const bad = coerceCard({ id: 'x', title: '半张卡' });
  push('coerceCard 能把残缺数据补成合法卡片', bad !== null && validateCard(bad).length === 0, JSON.stringify(validateCard(bad ?? createEmptyCard(''))));
  push('coerceCard 对非对象返回 null', coerceCard('not an object') === null && coerceCard(null) === null, '');

  // 清场：只删自己造的卡（不动用户数据）
  const cleanup = await dao.kc.query({ keyword: '__kcselftest__', page: 1, pageSize: 100, status: ['unlearned', 'learning', 'learned', 'chopped'] });
  let removed = 0;
  for (const c of cleanup.items) {
    if (!c.title.startsWith('__kcselftest__')) continue;
    const fresh = await dao.kc.getById(c.id);
    if (fresh === null) continue;
    // 直接写墓碑再清掉（走 chop 会改状态，这里只是清场）
    await dao.kc.chop(c.id);
    removed += 1;
  }
  push('自测数据已清理（走软删除，不留真行）', removed === mine.length, `清理 ${removed} 张`);

  return out;
}

/**
 * 跑全部二期验收自测。
 * @param options.visible 是否把 XSS 测试内容留在页面上
 */
export async function runAll(options: { visible?: boolean } = {}): Promise<KcSelfTestResult[]> {
  const out: KcSelfTestResult[] = [];
  out.push(...runMasterySelfTest());
  out.push(...runXssSelfTest(options.visible ?? false));
  out.push(...(await runDataSelfTest()));
  print(out);
  return out;
}

/** 挂到 window 上的对象形状 */
export interface KcSelfTestApi {
  run: (options?: { visible?: boolean }) => Promise<KcSelfTestResult[]>;
  mastery: () => KcSelfTestResult[];
  xss: (visible?: boolean) => KcSelfTestResult[];
  data: () => Promise<KcSelfTestResult[]>;
  settings: () => typeof DEFAULT_SETTINGS.kc;
  config: () => typeof KC;
}

/**
 * 挂到 `window.__kcselftest`（由 main.ts 在 DEV 下调一次，**不自动执行**）。
 */
export function attachKcSelfTest(): void {
  const api: KcSelfTestApi = {
    run: runAll,
    mastery: runMasterySelfTest,
    xss: runXssSelfTest,
    data: runDataSelfTest,
    settings: () => DEFAULT_SETTINGS.kc,
    config: () => KC,
  };
  (window as unknown as Record<string, unknown>)['__kcselftest'] = api;
  console.info('[kcselftest] 已挂载：控制台调 __kcselftest.run() 跑二期验收项');
}
