/**
 * 录入解析的**解析层**：把 AI 返回的原始文本变成合法卡片。
 *
 * 为什么和 `kcAi.ts`（发请求）分开：
 * 1. 这里是**不可信输入的边界**（模型输出可能缺字段、类型错、夹带 HTML），
 *    是最需要测的一段，而它**不需要网络** —— 分开以后可以直接喂字符串测；
 * 2. 单文件 ≤ 300 行的硬约束。
 *
 * 三条处理原则：
 * - **坏块丢掉、好块留下**，绝不因为一个块写坏就丢整张卡；
 * - 所有文本过 `sanitizeText`（去控制字符 + 限长），为渲染层的 XSS 防线再垫一层；
 * - 数值越界一律钳制（`estMinutes` 钳到设置的区间），因为**模型不一定会听话**。
 */
import { KC, getSettings } from '../core/config';
import { coerceBlock, createBlock, sanitizeText } from '../core/kcModel';
import { filterExamTags } from '../core/kcExamTypes';
import { EXAM_TYPES, findExamType, type Block, type ExamLoad, type ParsedKcCard } from '../core/kcTypes';

/** 模型一次最多回几张卡（超出部分丢掉，防止一次吐几十张把界面卡死） */
const MAX_CARDS_PER_REPLY = 12;
/** 单张卡最多几个块 */
const MAX_BLOCKS_PER_CARD = 40;
/** 摘要最大长度（与 `KC.maxSummaryLength` 同口径，这里只是显式写出来便于阅读） */
const SUMMARY_LIMIT = 200;

/**
 * 去掉模型可能加的 markdown 代码块围栏与前后废话。
 * @param text 模型返回的文本
 */
export function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return fence?.[1] ? fence[1].trim() : trimmed;
}

/**
 * 从一段文本里抠出第一个**配对完整**的 JSON 对象。
 *
 * 为什么要自己配对而不是 `indexOf('{')` + `lastIndexOf('}')`：
 * 模型经常在 JSON 后面再写一段解释（哪怕提示词说了不要），
 * 用 lastIndexOf 会把解释里的 `}` 也圈进来，直接 parse 失败。
 * 这里做一次「括号计数 + 字符串/转义感知」的扫描，取真正配对的第一个对象。
 *
 * @param text 文本
 * @returns 找不到返回 null
 */
export function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i] as string;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** 解析结果 */
export interface ParsedImport {
  cards: ParsedKcCard[];
  /** 被丢掉的卡片数（结构完全不合法） */
  droppedCards: number;
  /** 被丢掉的块数（那一张卡里其它块保留） */
  droppedBlocks: number;
  error?: string;
}

/**
 * 把 `estMinutes` 钳到设置允许的区间。
 *
 * **必须钳**：提示词里写了「3~5 分钟」，但模型不保证听话
 * （实测经常给 10 或 0）。越界值直接钳到边界，非法值用默认值。
 * @param raw 原始值
 */
export function clampEstMinutes(raw: unknown): number {
  const kc = getSettings().kc;
  const min = kc?.examLoadMinMinutes ?? 3;
  const max = kc?.examLoadMaxMinutes ?? 5;
  const fallback = kc?.examLoadDefaultMinutes ?? 4;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/**
 * 归一化出题量。
 *
 * `types` 取 `examLoad.types` 与 `examTags` 的并集（都过滤成合法题型 id）：
 * 模型经常只在其中一处写了题型，另一处漏掉，取并集比报错友好得多。
 * @param raw 原始 examLoad
 * @param examTags 已归一化的标签
 * @param defaultType 兜底题型（全都没有时用第一个题型）
 */
function coerceExamLoad(raw: unknown, examTags: string[], defaultType: string): ExamLoad {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const fromLoad = filterExamTags(Array.isArray(r['types']) ? r['types'].filter((t): t is string => typeof t === 'string') : []);
  const types = fromLoad.length > 0 ? fromLoad : examTags;
  return {
    types: types.length > 0 ? types : [defaultType],
    estMinutes: clampEstMinutes(r['estMinutes']),
  };
}

/**
 * 归一化块数组。
 *
 * - 非对象的项直接丢；
 * - `type` 不认识的**降级成 text**（保留内容，别白丢一段知识）；
 * - 空块（没有任何文本）丢掉——模型偶尔会吐一堆空壳块占位。
 * @param raw 原始数组
 */
function coerceImportBlocks(raw: unknown): { blocks: Block[]; dropped: number } {
  if (!Array.isArray(raw)) return { blocks: [], dropped: 0 };
  const blocks: Block[] = [];
  let dropped = 0;
  for (const item of raw.slice(0, MAX_BLOCKS_PER_CARD)) {
    const parsed = coerceBlock(item);
    if (parsed === null) {
      dropped += 1;
      continue;
    }
    if (isEmptyBlock(parsed)) {
      dropped += 1;
      continue;
    }
    blocks.push(parsed);
  }
  return { blocks, dropped };
}

/**
 * 判断一个块是不是「空的」（没有任何可显示文本）。
 * @param b 块
 */
function isEmptyBlock(b: Block): boolean {
  if (b.type === 'list') return !b.items || b.items.every((it) => it.trim() === '');
  if (b.type === 'table') {
    return !b.rows || b.rows.every((row) => row.every((cell) => cell.trim() === ''));
  }
  return (b.content ?? '').trim() === '';
}

/**
 * 归一化单张卡片。
 * @param raw 原始对象
 * @param userMessage 用户原话（存进 `source.raw`，便于回溯）
 * @returns 完全不可用（没标题且没内容）时返回 null
 */
export function coerceImportCard(raw: unknown, userMessage: string): ParsedKcCard | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;

  const { blocks } = coerceImportBlocks(r['blocks']);
  const title = sanitizeText(typeof r['title'] === 'string' ? r['title'] : '', KC.maxTitleLength).trim();
  if (title === '' && blocks.length === 0) return null;

  const examTags = filterExamTags(
    Array.isArray(r['examTags']) ? r['examTags'].filter((t): t is string => typeof t === 'string') : [],
  );
  const fallbackType = EXAM_TYPES[0]?.id ?? 'fill';
  const examLoad = coerceExamLoad(r['examLoad'], examTags, fallbackType);
  // 标签为空时用 examLoad 里的题型兜底（反过来也一样），保证「至少有一种考法」
  const finalTags = examTags.length > 0 ? examTags : examLoad.types;

  return {
    title: title !== '' ? title : KC.untitledName,
    summary: sanitizeText(typeof r['summary'] === 'string' ? r['summary'] : '', SUMMARY_LIMIT).trim(),
    // 一个块都没有时补一个空 text 块：卡片的硬性不变量是「至少一个块」
    blocks: blocks.length > 0 ? blocks : [createBlock('text')],
    examTags: finalTags,
    examLoad,
    source: { raw: sanitizeText(userMessage, 2000) },
  };
}

/**
 * 把 AI 返回的文本解析成一批合法卡片（**录入流程的总入口**）。
 *
 * 三级降级（对应验收标准 9「AI 返回非法 JSON 时有明确提示，不崩溃」）：
 * 1. 直接 `JSON.parse`；
 * 2. 失败 → 剥掉 markdown 围栏再 parse；
 * 3. 再失败 → 抠出第一个配对完整的 `{...}` 再 parse；
 * 4. 全都失败 → 返回 `error`，由界面提示「重试 / 手动录入」。
 *
 * @param reply AI 返回的原始文本
 * @param userMessage 用户原话（写进卡片来源）
 */
export function parseImportReply(reply: string, userMessage: string): ParsedImport {
  const text = typeof reply === 'string' ? reply : '';
  const candidates = [stripCodeFence(text), extractFirstJsonObject(stripCodeFence(text)) ?? ''];
  let parsed: unknown = null;
  for (const candidate of candidates) {
    if (candidate.trim() === '') continue;
    try {
      parsed = JSON.parse(candidate) as unknown;
      break;
    } catch {
      /* 试下一种 */
    }
  }
  if (parsed === null) {
    return { cards: [], droppedCards: 0, droppedBlocks: 0, error: 'AI 返回的内容不是合法 JSON' };
  }

  const rawCards = extractCardsArray(parsed);
  if (rawCards === null) {
    return { cards: [], droppedCards: 0, droppedBlocks: 0, error: 'AI 返回的 JSON 里没有 cards 数组' };
  }

  const cards: ParsedKcCard[] = [];
  let droppedCards = 0;
  let droppedBlocks = 0;
  for (const item of rawCards.slice(0, MAX_CARDS_PER_REPLY)) {
    const before = Array.isArray((item as { blocks?: unknown })?.blocks)
      ? ((item as { blocks: unknown[] }).blocks.length)
      : 0;
    const card = coerceImportCard(item, userMessage);
    if (card === null) {
      droppedCards += 1;
      continue;
    }
    cards.push(card);
    // 丢掉的块数 = 原始块数 - 保留块数（不含补的那个空块）
    const after = card.blocks.length;
    if (before > after) droppedBlocks += before - after;
  }
  if (rawCards.length > MAX_CARDS_PER_REPLY) droppedCards += rawCards.length - MAX_CARDS_PER_REPLY;

  return { cards, droppedCards, droppedBlocks };
}

/**
 * 从解析出来的 JSON 里取 cards 数组（兼容几种常见写法）。
 *
 * 模型除了标准的 `{cards:[...]}`，还经常给：
 * - 直接一个数组 `[...]`；
 * - 用别的键名（`knowledgePoints` / `items` / `data`）；
 * - 只有一张卡时直接给卡片对象 `{title:...}`。
 * 都认一下，能救回一次调用就救一次。
 * @param parsed 已 parse 的值
 */
export function extractCardsArray(parsed: unknown): unknown[] | null {
  if (Array.isArray(parsed)) return parsed;
  if (typeof parsed !== 'object' || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  for (const key of ['cards', 'knowledgePoints', 'items', 'data', 'result']) {
    const v = obj[key];
    if (Array.isArray(v)) return v;
  }
  // 只有一张卡：整个对象就是卡片（有 title 或 blocks 就当它是卡）
  if (typeof obj['title'] === 'string' || Array.isArray(obj['blocks'])) return [obj];
  return null;
}

/**
 * 题型的中文名（界面显示标签用；未知 id 原样返回）。
 * @param id 题型 id
 */
export function examTypeName(id: string): string {
  return findExamType(id)?.name ?? id;
}
