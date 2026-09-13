/**
 * 阶段 05 的三套提示词：**每日语境词 / 出题 / 评分**。
 *
 * 为什么与录入提示词（`kcPrompts.ts`）分开：
 * 1. 单文件 ≤ 300 行的硬约束；
 * 2. 「录入」与「考核」是两条完全不同的链路，改一个的时候不该滚动另一个。
 *    （阶段 02 时它们曾在一个文件里，结果阶段 05 改写时把录入提示词覆盖没了——
 *     这就是分文件的实际理由。）
 *
 * ⚠️ 三条硬性要求（都在提示词里写死了）：
 * 1. **语境词必须互不相关**（用户明确要求，防止 AI 硬凑成一个主题）；
 * 2. 每道题**只关联其中一个**语境词，由 AI 挑最贴切的那个并输出选了哪个；
 * 3. 评分必须**按每种题型的 rubric** 来，不能凭感觉给分。
 */
import { EXAM_TYPES } from '../core/kcTypes';

/** 题型清单（提示词里要用，从 `EXAM_TYPES` 生成，**不许手写第二份**） */
const EXAM_TYPE_LIST = EXAM_TYPES.map((t) => `- \`${t.id}\`（${t.name}）${t.desc ? `：${t.desc}` : ''}`).join('\n');

// ══════════════════════════════════════════════════════════════
// 一、每日语境词
// ══════════════════════════════════════════════════════════════

/**
 * 生成每日语境词的 System 提示词。
 *
 * 「互不相关」是**用户明确要求**的：如果 5 个词都围绕「环保」，
 * 那 5 道题就会长得像同一个题的变体，起不到「每天换语境」的作用。
 */
export const KC_CONTEXT_SYSTEM_PROMPT = `你是一个英语学习语境词生成器。
输出**严格 JSON**，不要 markdown 代码块，不要解释。

输出 schema：
{"words":["photosynthesis","telescope","jam","deadline","thunderstorm"]}

规则：
1. 生成 **5 个**英语单词或短语，用于给学生出题时提供语境。
2. ★ **这 5 个词必须互不相关，甚至主题完全不同**（例如一个食物、一个科技、一个天气、
   一个情绪、一个动作）。**不要**把它们凑成一个主题，不要围绕同一个场景。
3. 每个词都要是**常见、好学、能自然融入句子的实词**（名词/动词/形容词），
   不要抽象名词（如 "situation"）、不要虚词、不要专有名词。
4. 避免与「近期已用过的词」重复（用户会给列表），也不要给它们的同源词。
5. 可以结合当前日期/季节给一点点倾向（例如临近节日给一个相关词），但**不要**因此让 5 个词相关。
6. 只输出 JSON，不要任何多余文字。`;

/**
 * 生成每日语境词的 User 提示词。
 * @param recentWords 近 N 天已用过的词（避免重复）
 * @param date 今天的自然日（'YYYY-MM-DD'）
 */
export function kcContextUserPrompt(recentWords: string[], date: string): string {
  const list = recentWords.map((w) => w.trim()).filter((w) => w !== '');
  const avoid = list.length === 0 ? '（暂无历史记录）' : list.map((w) => `- ${w}`).join('\n');
  return `今天是 ${date}。

近期已经用过的语境词（**不要重复，也不要给同源词**）：
${avoid}

请按 schema 生成今天这一组 5 个互不相关的语境词，输出 JSON。`;
}

// ══════════════════════════════════════════════════════════════
// 二、出题
// ══════════════════════════════════════════════════════════════

/** 每种题型的特定要求（**新增题型只加一行，不改分支逻辑**） */
const EXAM_TYPE_REQUIREMENTS: Record<string, string> = {
  fill: '- `fill` 语法填空：明确标出提示词（括号里的原词）与挖空处（用 `____` 表示），确保只有一个空。',
  sentence: '- `sentence` 独立写句子：给明确、可执行的造句要求（如「用定语从句写一句关于…的话」），并给出参考答案。',
  choice: '- `choice` 选择题：给 4 个选项 A/B/C/D（写在题目里），并**在 expected 里写明正确答案是哪个字母 + 为什么**。',
  judge: '- `judge` 判断正误：给一个有明确对错的句子，并**在 expected 里写明「对/错」+ 理由**。',
};

/**
 * 出题的 System 提示词。
 *
 * 提示词里刻意保留 `contextWord` 字段：**每道题只与一个语境词关联**，
 * 由 AI 从今日 5 个词里挑最贴切的那个（用户明确要求「不强求全部关联」）。
 */
export const KC_EXAM_SYSTEM_PROMPT = `你是一个英语教师，负责为一个知识点出练习题。
输出**严格 JSON**，不要 markdown 代码块，不要解释。

输出 schema：
{"question":"题干（可含换行）","contextWord":"你选的语境词","expected":"参考答案与要点"}

题型清单：
${EXAM_TYPE_LIST}

规则：
1. 题目必须**考到给定知识点**的核心内容，不要出偏题、怪题。
2. ★ 题目要与**语境词**有关联：从用户给的几个语境词里选**最贴切的一个**自然地融入题干，
   并把选中的那个词原样写在 \`contextWord\` 字段里。**不必**强行让所有词都出现。
3. ★ **避免**与「近期已出过的题」重复或雷同（用户会给列表）：换语境、换问法、换考的角度。
4. 如果用户给了「参考样题」，请**模仿它们的风格、难度与表述方式**（但不要照抄题目）。
5. \`expected\` 要写清楚参考答案与评分要点，供评分环节参考。
6. 题干用中文说明 + 英文题目，简洁清楚。
7. 只输出 JSON，不要任何多余文字。`;

/**
 * 出题的 User 提示词。
 * @param cardTitle 知识点标题
 * @param cardSummary 知识点摘要
 * @param cardBlocksText 卡片正文的纯文本（让 AI 知道这张卡到底讲了什么）
 * @param type 本次题型 id
 * @param contextWords 今日 5 个语境词
 * @param recentQuestions 近 N 天已出过的题（防重复）
 * @param bankSamples 同题型参考样题（风格参考）
 */
export function kcExamUserPrompt(args: {
  cardTitle: string;
  cardSummary: string;
  cardBlocksText: string;
  type: string;
  contextWords: string[];
  recentQuestions: string[];
  bankSamples: string[];
}): string {
  const typeName = EXAM_TYPES.find((t) => t.id === args.type)?.name ?? args.type;
  const requirement = EXAM_TYPE_REQUIREMENTS[args.type] ?? `- \`${args.type}\`：按这个题型的一般要求出题。`;

  const words = args.contextWords.length === 0 ? '（今天没有语境词，可以不关联语境）' : args.contextWords.map((w) => `- ${w}`).join('\n');
  const recent =
    args.recentQuestions.length === 0
      ? '（暂无历史题目）'
      : args.recentQuestions.slice(0, 20).map((q) => `- ${q.replace(/\s+/g, ' ').slice(0, 120)}`).join('\n');
  const samples =
    args.bankSamples.length === 0
      ? '（暂无参考样题）'
      : args.bankSamples.slice(0, 5).map((s, i) => `【样题 ${i + 1}】\n${s.slice(0, 600)}`).join('\n\n');

  return `请为下面这个知识点出一道【${typeName}】题。

【知识点标题】${args.cardTitle}
【一句话摘要】${args.cardSummary}
【卡片正文】
${args.cardBlocksText.slice(0, 3000)}

【本次题型要求】
${requirement}

【今日语境词】（从中挑**最贴切的一个**关联，写进 contextWord）
${words}

【近期已出过的题】（**不要**重复或雷同）
${recent}

【参考样题】（模仿风格与难度，**不要照抄**）
${samples}

请输出 JSON。`;
}

// ══════════════════════════════════════════════════════════════
// 三、评分（rubric 化）
// ══════════════════════════════════════════════════════════════

/**
 * 每种题型的评分标准（3 分制）。
 *
 * ★ **rubric 写在这里而不是让 AI 自由发挥**：主观题（独立写句子）如果只说
 * 「打个分」，模型会飘；拆成三项之后，理由也能逐项列出来，用户才知道差在哪。
 */
const GRADE_RUBRICS: Record<string, string> = {
  fill: '3 = 完全正确；2 = 词根对但形式错（时态/单复数/词性错）；1 = 错误或空缺。',
  choice: '3 = 选对；1 = 选错。',
  judge: '3 = 判断对且理由对；2 = 判断对但理由错/不完整；1 = 判断错。',
  sentence:
    '按三项拆解打分：**语法正确(1) + 用对了目标结构(1) + 语义通顺(1)**。' +
    '三项全得 = 3 分；得两项 = 2 分；只得一项或全错 = 1 分。',
};

/**
 * 评分的 System 提示词。
 *
 * 硬性要求：`reason` 必须具体到扣分点；主观题必须**逐项列出三项得分情况**
 * （用户明确要求 —— 「让用户知道哪里错了」）。
 */
export const KC_GRADE_SYSTEM_PROMPT = `你是一个英语教师，负责按评分标准给学生答案打分。
输出**严格 JSON**，不要 markdown 代码块，不要解释。

输出 schema：
{"score":2,"reason":"语法正确、用对了定语从句，但关系词误用了 which；此处从句完整，应用 where。"}

评分标准（**严格按标准打分，不要凭感觉**）：
- \`fill\` 语法填空：${GRADE_RUBRICS['fill']}
- \`choice\` 选择题：${GRADE_RUBRICS['choice']}
- \`judge\` 判断正误：${GRADE_RUBRICS['judge']}
- \`sentence\` 独立写句子：${GRADE_RUBRICS['sentence']}

规则：
1. \`score\` 只能是 1、2、3 三个整数之一。
2. \`reason\` 用中文，**必须具体说明扣分点**（哪里错了、应该怎么写），不要只说「有点问题」。
3. 主观题（\`sentence\`）的 \`reason\` **必须逐项列出三项得分情况**
   （例如：「语法正确 ✓；目标结构 ✓；语义基本通顺，但搭配不自然 ✗ → 得 2 分」）。
4. 学生答得空/答非所问 → 1 分，并在 reason 里说明原因。
5. 只输出 JSON，不要任何多余文字。`;

/**
 * 评分的 User 提示词。
 * @param type 题型 id
 * @param question 题干
 * @param expected 参考答案（出题时生成的）
 * @param userAnswer 学生答案
 */
export function kcGradeUserPrompt(args: {
  type: string;
  question: string;
  expected: string;
  userAnswer: string;
}): string {
  const typeName = EXAM_TYPES.find((t) => t.id === args.type)?.name ?? args.type;
  return `【题型】${typeName}（${args.type}）

【题目】
${args.question}

【参考答案与要点】
${args.expected === '' ? '（出题时没有给参考答案，请按知识点自行判断）' : args.expected}

【学生的答案】
${args.userAnswer.trim() === '' ? '（学生没有作答）' : args.userAnswer}

请严格按该题型的评分标准打分，输出 JSON。`;
}
