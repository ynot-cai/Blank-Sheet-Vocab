/**
 * 二期的「考核方式标签」小工具。
 *
 * 题型表本身（`EXAM_TYPES`）在 `kcTypes.ts`，**新增题型只需要往那个数组加一项**，
 * 这里和别处都不许写死「4 种题型」之类的分支。
 */

// RULES-R1: 此处禁止任何强制时间限制（无倒计时 / 无超时提交 / 无超时判错）
import { EXAM_TYPES, findExamType } from './kcTypes';
/** 已知的题型 id 集合（给「把 AI 输出的标签过滤成合法 id」用） */
export const KNOWN_EXAM_TYPE_IDS: readonly string[] = EXAM_TYPES.map((t) => t.id);

/**
 * 把任意字符串数组过滤成合法题型标签（去重、保序）。
 * 说明：未知题型不是错误，但**不认识的标签进不了 examTags**，
 * 否则阶段 05 出题时会拿到一个没有提示词模板的题型。
 * @param tags 原始标签
 */
export function filterExamTags(tags: readonly string[]): string[] {
  const out: string[] = [];
  for (const t of tags) {
    const id = String(t).trim();
    if (id === '' || out.includes(id)) continue;
    if (findExamType(id) === undefined) continue;
    out.push(id);
  }
  return out;
}
