/**
 * 二期「三张小表」的表定义（**列名只写一份**）。
 *
 * 单独一个文件的原因：`kcSmallInventory`（SQL）与 `kcSmallValidate`（请求体归一化）
 * 都要用它，放在任何一个里面都会形成「兄弟模块互相 import」的怪关系。
 *
 * 三张表都是「记录型」数据：语境词按天、题目历史按次、题库按条。
 */
import type { InValue } from '@libsql/client';

/** 三张表的列定义（顺序固定，INSERT 时复用） */
export const KC_SMALL_TABLES = {
  contextWords: {
    table: 'daily_context_words',
    columns: ['id', 'space_key', 'date', 'words', 'source', 'confirmed', 'created_at', 'updated_at', 'deleted'],
  },
  examRecords: {
    table: 'exam_records',
    columns: [
      'id',
      'space_key',
      'card_id',
      'date',
      'type',
      'question',
      'user_answer',
      'ai_score',
      'ai_reason',
      'context_word',
      'created_at',
      'updated_at',
      'deleted',
    ],
  },
  bankQuestions: {
    table: 'bank_questions',
    columns: ['id', 'space_key', 'type', 'content', 'source', 'created_at', 'updated_at', 'deleted'],
  },
} as const;

/** 三张表的键名 */
export type KcSmallTableKey = keyof typeof KC_SMALL_TABLES;

/** 待写入的一行（三张表共用的形状） */
export interface SyncRow {
  id: string;
  /** 列名 → 值（不含 id / space_key，那两个由 DAO 补） */
  values: Record<string, InValue>;
}
