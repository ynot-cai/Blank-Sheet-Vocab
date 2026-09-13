/**
 * 二期的「卡片（KnowledgeCard）」：创建、校验、把脏数据归一化成合法卡片。
 *
 * 三层分工（改代码前先看清自己在哪一层）：
 * - `kcBlock`：卡片里的块怎么建、怎么校验；
 * - **本文件**：卡片整体怎么建、怎么校验、脏数据怎么救；
 * - `kcMastery`：掌握度怎么算。
 */
import { KC } from './config';
import { coerceBlocks, createBlock, validateBlock } from './kcBlock';
import { nextUpdatedAt } from './kcClock';
import { filterExamTags } from './kcExamTypes';
import { asNullableNumber, asNumber, asString, asStringArray, clamp01, newId, sanitizeText } from './kcText';
import {
  type ExamLoad,
  type KcAttrs,
  type KcSource,
  type KcStatus,
  type KnowledgeCard,
} from './kcTypes';

/** 合法状态 */
const KC_STATUSES: readonly KcStatus[] = ['unlearned', 'learning', 'learned', 'chopped'];

/** 空属性 */
export function createEmptyAttrs(): KcAttrs {
  return {
    learnedAt: null,
    lastReviewAt: null,
    reviewCount: 0,
    lastSelfScore: null,
    lastExamScore: null,
    mastery: KC.masteryInitial,
    reviewPriority: 0,
  };
}

/** 空出题量建议 */
export function createEmptyExamLoad(estMinutes: number): ExamLoad {
  return { types: [], estMinutes };
}

/**
 * 造一张空卡片（新建/录入都从这里起步）。
 *
 * 默认带一个 `heading` + 一个 `text` 空块，让块编辑器一打开就有东西可写
 * （阶段 03 的编辑器约定：卡片里至少有一个块）。
 *
 * ⚠️ 时间戳走 `nextUpdatedAt()`（单调时钟）而**不是** `Date.now()`：
 * 设备时钟倒退时，用 `Date.now()` 造出来的卡片会永远推不上云（见 `core/kcClock.ts`）。
 * 这里必须用单调时钟，因为同步层的 `bulkUpsert` **不能**替它兜底——
 * 那个函数同时也在写「从云端拉回来的卡片」，那些卡片的 `updatedAt` 必须原样保留。
 *
 * @param title 标题
 * @param estMinutes 出题量默认耗时（默认 4 分钟，来自设置）
 */
export function createEmptyCard(title: string, estMinutes: number = 4): KnowledgeCard {
  const now = nextUpdatedAt();
  return {
    id: newId(),
    title: sanitizeText(title, KC.maxTitleLength),
    summary: '',
    blocks: [createBlock('heading'), createBlock('text')],
    examTags: [],
    examLoad: createEmptyExamLoad(estMinutes),
    source: {},
    attrs: createEmptyAttrs(),
    status: 'unlearned',
    createdAt: now,
    updatedAt: now,
    deleted: 0,
  };
}

/**
 * 校验一张卡片。
 * @param c 卡片
 * @returns 错误说明数组，空数组 = 合法
 */
export function validateCard(c: KnowledgeCard): string[] {
  const errors: string[] = [];
  if (typeof c.id !== 'string' || c.id.trim() === '') errors.push('卡片缺少 id');
  if (typeof c.title !== 'string' || c.title.trim() === '') errors.push('卡片缺少标题');
  else if (c.title.length > KC.maxTitleLength) errors.push(`标题超过 ${KC.maxTitleLength} 字`);
  if (typeof c.summary !== 'string') errors.push('摘要必须是字符串');
  else if (c.summary.length > KC.maxSummaryLength) errors.push(`摘要超过 ${KC.maxSummaryLength} 字`);

  if (!Array.isArray(c.blocks)) errors.push('blocks 必须是数组');
  else {
    if (c.blocks.length === 0) errors.push('卡片至少要有一个块');
    c.blocks.forEach((b, i) => {
      for (const e of validateBlock(b)) errors.push(`第 ${i + 1} 个块：${e}`);
    });
  }

  if (!Array.isArray(c.examTags)) errors.push('examTags 必须是数组');
  // 说明：**不认识的题型标签不算错误**——题型表是可扩展的，
  // 别的设备（或更新的版本）可能存了本机还不认识的 id，报错会让人误以为数据坏了。

  if (c.examLoad === undefined || c.examLoad === null) errors.push('缺少出题量 examLoad');
  else {
    if (!Array.isArray(c.examLoad.types)) errors.push('examLoad.types 必须是数组');
    if (!Number.isFinite(c.examLoad.estMinutes)) errors.push('examLoad.estMinutes 必须是数字');
  }

  if (!KC_STATUSES.includes(c.status)) errors.push(`未知状态：${String(c.status)}`);
  if (!Number.isFinite(c.createdAt)) errors.push('createdAt 必须是数字');
  if (!Number.isFinite(c.updatedAt)) errors.push('updatedAt 必须是数字');
  return errors;
}

/**
 * 把任意 JSON 值安全地转成一张卡片（缺失字段补默认值、非法值丢弃）。
 *
 * 用途：从 IndexedDB / 云端拉回来的数据是 `unknown`，
 * 不能直接当成 `KnowledgeCard` 用（可能缺字段、可能被改坏）。
 * 这个函数保证「再坏的数据也只变成一张降级的卡片，不抛异常」。
 * @param raw 原始值
 * @param estMinutes 兜底耗时
 * @returns 解析失败（不是对象）时返回 null
 */
export function coerceCard(raw: unknown, estMinutes: number = 4): KnowledgeCard | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r['id'] === 'string' && r['id'] !== '' ? r['id'] : newId();
  const now = Date.now();
  const attrs = coerceAttrs(r['attrs']);
  const blocks = coerceBlocks(r['blocks']);
  const title = sanitizeText(asString(r['title']), KC.maxTitleLength).trim();
  return {
    id,
    // 标题缺失时给一个兜底名字，**不要产出一张过不了校验的卡**：
    // 列表里显示「未命名知识点」比「卡片消失」好得多（用户还能点进去补标题）。
    // 注意 `validateCard` 依然会对**用户输入**的卡片要求标题非空——两条路故意不同。
    title: title !== '' ? title : KC.untitledName,
    summary: sanitizeText(asString(r['summary']), KC.maxSummaryLength),
    // 卡片的不变量是「至少有一个块」（块编辑器也这么假设）。
    // 云端/老数据里可能一个块都没有，这里补一个空 text 块，
    // 保证 **coerceCard 的产物一定通过 validateCard**（否则卡片一打开就是坏的）。
    blocks: blocks.length > 0 ? blocks : [createBlock('text')],
    examTags: filterExamTags(asStringArray(r['examTags'])),
    examLoad: coerceExamLoad(r['examLoad'], estMinutes),
    source: coerceSource(r['source']),
    attrs,
    status: KC_STATUSES.includes(r['status'] as KcStatus) ? (r['status'] as KcStatus) : 'unlearned',
    createdAt: asNumber(r['createdAt'], now),
    updatedAt: asNumber(r['updatedAt'], now),
    deleted: r['deleted'] === 1 || r['deleted'] === true ? 1 : 0,
  };
}

/**
 * 归一化属性组。
 * @param raw 原始值
 */
function coerceAttrs(raw: unknown): KcAttrs {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  return {
    learnedAt: asNullableNumber(r['learnedAt']),
    lastReviewAt: asNullableNumber(r['lastReviewAt']),
    reviewCount: Math.max(0, Math.trunc(asNumber(r['reviewCount'], 0))),
    lastSelfScore: asNullableNumber(r['lastSelfScore']),
    lastExamScore: asNullableNumber(r['lastExamScore']),
    mastery: clamp01(asNumber(r['mastery'], KC.masteryInitial)),
    reviewPriority: asNumber(r['reviewPriority'], 0),
  };
}

/**
 * 归一化出题量。
 * @param raw 原始值
 * @param estMinutes 兜底耗时
 */
function coerceExamLoad(raw: unknown, estMinutes: number): ExamLoad {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  return {
    types: filterExamTags(asStringArray(r['types'])),
    estMinutes: Math.max(0, asNumber(r['estMinutes'], estMinutes)),
  };
}

/**
 * 归一化来源。
 * @param raw 原始值
 */
function coerceSource(raw: unknown): KcSource {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const out: KcSource = {};
  const chatId = asString(r['chatId']).trim();
  const rawText = asString(r['raw']);
  if (chatId !== '') out.chatId = chatId;
  if (rawText !== '') out.raw = sanitizeText(rawText);
  return out;
}
