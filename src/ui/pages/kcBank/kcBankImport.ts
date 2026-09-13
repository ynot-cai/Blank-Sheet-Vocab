/**
 * 题库的**批量导入**（阶段 07 §2）：粘贴一批题目 → 自动按题型分类。
 *
 * 分类策略（用户要求「调一次 AI 做分类，或按简单规则切分」）：
 * **先用规则分**（离线、零成本、可预期），分不出来才交给 AI。
 * 规则看的是题目的形状：
 * - 有 `A. B. C. D.` 四个选项 → 选择题
 * - 有 `____` 或括号提示词 → 语法填空
 * - 含「判断」「对错」「正误」→ 判断正误
 * - 含「造句」「用…写一句」「写一句」→ 独立写句子
 * - 都认不出来 → 用用户选定的默认题型
 *
 * 与 AI 分类相比的取舍：规则对「真题混排」的准确率不高，但**不会乱花钱、不会把
 * 200 道题塞进一次请求**，而且用户可以在导入后按题型再改。阶段 07 先做规则版。
 */
import { EXAM_TYPES } from '../../../core/kcTypes';

/** 一次批量导入里的一道题 */
export interface ParsedBankItem {
  type: string;
  content: string;
}

/** 题型判定的规则（**加题型只加一行**） */
const RULES: { type: string; re: RegExp; why: string }[] = [
  // 两种排版都要认：一行一个选项（A. xxx\nB. xxx），或一行内联（A. x B. y C. z）
  { type: 'choice', re: /(^|\s)[A-D]\s*[.、:：)]\s*\S/g, why: '有 A/B/C/D 选项' },
  { type: 'fill', re: /_{3,}|（\s*[a-zA-Z]+\s*）|\(\s*[a-zA-Z]+\s*\)/, why: '有挖空或括号提示词' },
  { type: 'judge', re: /判断|正误|对错|是否正确/, why: '含「判断/正误」字样' },
  { type: 'sentence', re: /造句|写一句|写一个句子|用.{1,12}写/, why: '含「造句/写一句」字样' },
];

/**
 * 猜一道题的题型。
 * @param content 题目文本
 * @param fallback 都认不出来时用的题型
 */
export function guessBankType(content: string, fallback: string): { type: string; why: string } {
  for (const rule of RULES) {
    if (rule.re.test(content)) return { type: rule.type, why: rule.why };
  }
  return { type: fallback, why: '没认出特征，用默认题型' };
}

/**
 * 把一段粘贴文本切成多道题。
 *
 * 切分规则（按优先级）：
 * 1. 有分隔线（`---` 单独一行）→ 按它切；
 * 2. 有编号行（`1.` / `1、` / `(1)` 开头）→ 按编号切（编号留给题目内容）；
 * 3. 空行分隔的段落 → 每个段落当一题；
 * 4. 都没有 → 整段当一题。
 *
 * @param text 粘贴的文本
 * @param fallbackType 认不出题型时用哪个
 * @param source 来源标注（整批共用）
 */
export function splitBankText(text: string, fallbackType: string, source = ''): ParsedBankItem[] {
  const raw = text.replace(/\r\n?/g, '\n').trim();
  if (raw === '') return [];

  let blocks: string[];
  if (/^\s*-{3,}\s*$/m.test(raw)) {
    blocks = raw.split(/^\s*-{3,}\s*$/m);
  } else if (/^\s*(?:\d+[.、)]|\(\d+\))\s+/m.test(raw)) {
    // 在编号行**之前**切（用 lookahead 保留编号本身）
    blocks = raw.split(/\n(?=\s*(?:\d+[.、)]|\(\d+\))\s+)/);
  } else {
    blocks = raw.split(/\n\s*\n/);
  }

  const out: ParsedBankItem[] = [];
  for (const block of blocks) {
    const content = block.trim();
    if (content === '') continue;
    const guessed = guessBankType(content, fallbackType);
    out.push({
      type: guessed.type,
      content: source === '' ? content : `${content}\n（来源：${source}）`,
    });
  }
  return out;
}

/**
 * 题库文本导出（用户要求「全部导出」）。
 *
 * 格式：每题一段，段间用 `---` 分隔（正好是导入时的分隔符，**导出再导入不会丢结构**）。
 * @param rows 题库
 */
export function exportBankText(rows: { type: string; content: string; source: string }[]): string {
  return rows
    .map((r) => {
      const name = EXAM_TYPES.find((t) => t.id === r.type)?.name ?? r.type;
      const head = r.source === '' ? `【${name}】` : `【${name}】${r.source}`;
      return `${head}\n${r.content}`;
    })
    .join('\n\n---\n\n');
}
