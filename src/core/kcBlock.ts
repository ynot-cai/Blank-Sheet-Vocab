/**
 * 二期的「块（Block）」：创建、校验、把脏数据归一化成合法块。
 *
 * 块是卡片结构自由的基础（小标题 / 正文 / 例句 / 列表 / 表格 / 代码 / 引用 / 提示）。
 * 这里只做**数据**层面的处理，渲染在 `core/blockRender.ts`（那边只管安全地变成 DOM）。
 */
import { asString, asStringArray, newId, sanitizeText } from './kcText';
import type { Block, BlockType } from './kcTypes';

/** 所有合法的块类型（校验时用，顺序无关） */
const BLOCK_TYPES: readonly BlockType[] = [
  'heading',
  'text',
  'example',
  'list',
  'table',
  'code',
  'quote',
  'tip',
];

/**
 * 造一个空块（不同类型给不同骨架，编辑器直接能用）。
 * @param type 块类型
 */
export function createBlock(type: BlockType): Block {
  const id = newId();
  switch (type) {
    case 'heading':
      return { id, type, content: '' };
    case 'text':
    case 'quote':
    case 'tip':
      return { id, type, content: '' };
    case 'example':
      return { id, type, content: '', translation: '', note: '' };
    case 'list':
      return { id, type, items: [''] };
    case 'table':
      return { id, type, rows: [['', ''], ['', '']] };
    case 'code':
      return { id, type, content: '', lang: '' };
    default:
      // 兜底：未知类型也造出一个能编辑的 text 块，绝不抛异常
      return { id, type: 'text', content: '' };
  }
}

/**
 * 校验一个块。
 *
 * **只校验结构，不校验内容是否填满**：块刚被 `createBlock()` 造出来时内容都是空的，
 * 那是「合法的空块」（编辑器需要它），不是「坏数据」。
 * 所以这里检查的是「字段类型对不对、结构完不完整」。
 *
 * @param b 块
 * @returns 错误说明数组，空数组 = 合法
 */
export function validateBlock(b: Block): string[] {
  const errors: string[] = [];
  if (typeof b.id !== 'string' || b.id.trim() === '') errors.push('块缺少 id');
  if (!BLOCK_TYPES.includes(b.type)) {
    errors.push(`未知的块类型：${String(b.type)}`);
    return errors; // 类型都不认识，后面的字段检查没有意义
  }
  if (b.type === 'list') {
    if (!Array.isArray(b.items)) errors.push('列表块缺少 items');
    else if (b.items.some((it) => typeof it !== 'string')) errors.push('列表项必须是字符串');
  } else if (b.type === 'table') {
    if (!Array.isArray(b.rows)) errors.push('表格块缺少 rows');
    else if (b.rows.some((r) => !Array.isArray(r) || r.some((c) => typeof c !== 'string'))) {
      errors.push('表格的每一行都必须是字符串数组');
    }
  } else if (typeof b.content !== 'string' && b.content !== undefined) {
    errors.push('块的 content 必须是字符串');
  }
  return errors;
}

/**
 * 归一化块数组（坏块直接丢掉）。
 * @param raw 原始值
 */
export function coerceBlocks(raw: unknown): Block[] {
  if (!Array.isArray(raw)) return [];
  const out: Block[] = [];
  for (const item of raw) {
    const b = coerceBlock(item);
    if (b !== null) out.push(b);
  }
  return out;
}

/**
 * 归一化单个块。
 *
 * 两条不同的降级策略（**不要混为一谈**）：
 * - 传进来的东西**根本不是对象**（null / 字符串 / 数字）→ 返回 null，由调用方丢掉；
 * - 是对象但 `type` 不认识 → **降级成 text**，保留内容（卡片宁可显示得朴素，也不能白屏）。
 * @param raw 原始值
 */
export function coerceBlock(raw: unknown): Block | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const rawType = asString(r['type']);
  const type = (BLOCK_TYPES as readonly string[]).includes(rawType) ? (rawType as BlockType) : 'text';
  const id = asString(r['id']) !== '' ? asString(r['id']) : newId();
  const content = typeof r['content'] === 'string' ? sanitizeText(r['content']) : undefined;

  switch (type) {
    case 'list': {
      const items = asStringArray(r['items']).map((it) => sanitizeText(it));
      return { id, type, items: items.length > 0 ? items : [''] };
    }
    case 'table': {
      const rows = Array.isArray(r['rows'])
        ? r['rows']
            .filter((row): row is unknown[] => Array.isArray(row))
            .map((row) => row.map((cell) => sanitizeText(asString(cell))))
        : [];
      return { id, type, rows: rows.length > 0 ? rows : [['', '']] };
    }
    case 'example':
      return {
        id,
        type,
        content: content ?? '',
        translation: sanitizeText(asString(r['translation'])),
        note: sanitizeText(asString(r['note'])),
      };
    case 'code':
      return { id, type, content: content ?? '', lang: asString(r['lang']).slice(0, 24) };
    default:
      return { id, type, content: content ?? '' };
  }
}
