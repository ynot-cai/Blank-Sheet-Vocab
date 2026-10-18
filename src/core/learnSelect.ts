/**
 * 背诵选择的「临时优先级表」逻辑（版本 0.0.13）。
 *
 * 用户定义：在背诵选择页面用四种方式给**所有单词**算一张临时优先级表，
 * 白纸界面按它从高到低取词。表里 `0` 表示「这个词这一轮不选」。
 *
 * ⚠️ **这张表是临时的**：只活在当前这张纸上（存进 `PaperArchive.priorityTable`），
 * 绝不写回 `word.priority`——「背诵优先级」是词库里的长期属性，不能被一次选择改掉。
 */
import type { Word } from './types';

/** 临时优先级表：wordId → 优先级（0 = 不选） */
export type PriorityTable = Record<string, number>;

/** 方式1：默认 —— 临时优先级 = 背诵优先级 */
export function tableByDefault(words: Word[]): PriorityTable {
  const table: PriorityTable = {};
  for (const w of words) table[w.id] = normalize(w.priority);
  return table;
}

/**
 * 方式2：按来源 —— 被选中来源的词 = `1 + 背诵优先级`，其余 = 0。
 *
 * 为什么是「+1」而不是「直接用它」：选择本身代表一次**加权**，
 * 让入选的词整体压过未入选的（未入选是 0，任何入选词都 ≥ 1）。
 * @param words 全部词
 * @param sourceIds 选中的来源 id 集合
 */
export function tableBySources(words: Word[], sourceIds: Set<string>): PriorityTable {
  const table: PriorityTable = {};
  for (const w of words) {
    table[w.id] = sourceIds.has(w.sourceId) ? normalize(w.priority) + 1 : 0;
  }
  return table;
}

/** 方式3：从单词列表勾选 —— 勾中的词 = `1 + 背诵优先级`，其余 = 0 */
export function tableByPicked(words: Word[], pickedIds: Set<string>): PriorityTable {
  const table: PriorityTable = {};
  for (const w of words) {
    table[w.id] = pickedIds.has(w.id) ? normalize(w.priority) + 1 : 0;
  }
  return table;
}

/** 把任意数字收敛成 1~5（与 `Word.priority` 的取值域一致） */
function normalize(priority: number | undefined): number {
  const n = typeof priority === 'number' && Number.isFinite(priority) ? priority : 3;
  return Math.min(5, Math.max(1, Math.round(n)));
}

/**
 * 按临时优先级 **从高到低** 排；**同优先级按首字母顺序**（A→Z，忽略大小写）。
 *
 * 用户 1.3 明确定义了这条次级规则，所以这里不能用「随机」或「录入先后」。
 * 优先级为 0 的词**不进队列**——它们这一轮根本没被选。
 * @param words 全部词
 * @param table 临时优先级表
 */
export function orderByPriority(words: Word[], table: PriorityTable): Word[] {
  return words
    .filter((w) => (table[w.id] ?? 0) > 0)
    .sort((a, b) => {
      const pa = table[a.id] ?? 0;
      const pb = table[b.id] ?? 0;
      if (pb !== pa) return pb - pa;
      // 同优先级：首字母升序（用 localeCompare 处理大小写与带点缩写）
      return a.en.localeCompare(b.en, 'en', { sensitivity: 'base' });
    });
}

/**
 * 取「下一个要上纸的词」。
 *
 * 用户 1.4：若下一个词的优先级为 0，「下一个」按钮不可用（点击弹「没有单词了」）。
 * 所以这里显式判 0，而不是只判「队列取完」——两者在语义上等价，
 * 但判 0 能在「优先级表是外部传进来的」情况下也正确。
 * @returns 词；没有返回 null
 */
export function nextWord(queue: Word[], table: PriorityTable, shown: Set<string>): Word | null {
  for (const w of queue) {
    if (shown.has(w.id)) continue;
    if ((table[w.id] ?? 0) <= 0) return null;
    return w;
  }
  return null;
}
