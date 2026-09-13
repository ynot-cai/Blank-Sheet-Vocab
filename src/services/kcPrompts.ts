/**
 * 二期的**录入解析**提示词（阶段 02）。
 *
 * 出题 / 评分 / 语境词的提示词在 `kcExamPrompts.ts`（阶段 05 拆出去的，
 * 理由见那个文件的头注释）。
 *
 * 与一期同样的纪律：**规则只写一份** —— 输出格式在本文件，
 * 共享的语义规则（如「义项怎么整理」）放 `core/senseRules.ts` 并被引用，不复制。
 */
import { EXAM_TYPES } from '../core/kcTypes';

/** 题型清单（提示词里要用，从 `EXAM_TYPES` 生成，**不许手写第二份**） */
const EXAM_TYPE_LIST = EXAM_TYPES.map((t) => `- \`${t.id}\`（${t.name}）${t.desc ? `：${t.desc}` : ''}`).join('\n');

/**
 * 录入解析：System 提示词。
 *
 * 职责：把用户模糊的「我这块不行」整理成结构化的知识点卡片。
 *
 * ★ 两条来自用户实测反馈的硬要求（改动前先读，别改回去）：
 * 1. **篇幅导向极简**：原来写的是「内容完整 / 讲透 / 定义规则例句易错点都要」，
 *    模型据此产出的是**教科书式长篇**——一段段抽象定义，用户复习时根本记不住
 *    （「这个知识点很重要」这种废话也照写）。卡片的用处是**提醒记忆痛点**，
 *    不是替代教材，所以现在只允许 2~4 个块、每块一句话，并且**明确禁止**复述常识。
 * 2. **表格不带表头行**：用户明确要求。表头行（「关系词 / 先行词 / 从句成分」）
 *    既占地方，又和卡片标题、正文重复；对照式内容直接两列数据一行一条最好读。
 *    ⚠️ **schema 示例里的表必须也是无表头的**——示例是模型最当真的东西，
 *    示例里带表头，规则里写「不要表头」也会被无视（这是本次改动最容易改漏的地方）。
 *    渲染端（`core/blockRender.ts`）对存量老卡片的表头行**不做特殊处理**，
 *    统一按数据行渲染，见那边的注释。
 *
 * 「自动拆分」那条保持原样：用户只会说一个模糊的点，
 * 模型必须主动拆成若干个独立知识点，而不是把一整章塞进一张卡。
 */
export const KC_IMPORT_SYSTEM_PROMPT = `你是一个英语教师，擅长把学生模糊的"我这块不行"整理成结构化的知识点卡片。
输出**严格 JSON**，不要 markdown 代码块，不要解释。
学生是用碎片时间**扫一眼卡片找回记忆**，不是读教材——所以宁可短，绝不许长。

输出 schema：
{"cards":[{"title":"charge 的短语：有 the / 无 the","summary":"有 the 用介词短语，无 the 用 that 从句","blocks":[{"type":"heading","content":"看有没有 the"},{"type":"text","content":"有 the：the + 名词 + of doing；无 the：直接跟 that 从句"},{"type":"example","content":"She was in charge of the project.","translation":"她负责这个项目。"},{"type":"list","items":["有 the → charge of + 名词/动名词","无 the → charge that + 从句（指控）"]},{"type":"table","rows":[["in charge of + 名词","负责（有 the）"],["in the charge of + 人","由…负责（有 the）"],["charge that + 从句","指控（无 the）"]]},{"type":"tip","content":"in charge of 和 in the charge of 方向正好相反"}],"examTags":["fill","choice"],"examLoad":{"types":["fill","choice"],"estMinutes":4}}]}

规则：
1. **自动拆分**：用户说一个模糊的点，你要拆成**若干个**独立、完整的知识点（通常 2~5 个）。
   每个卡片只讲一件事。
2. **只留记忆痛点，越简洁越好**：一张卡 **2~4 个块**，每块**一句话**讲清。
   - 不复述常识；不写长篇定义；不写"这个知识点很重要"这类废话。
   - 能不给定义就不给——直接给"什么时候用哪个"。
3. **用对照式表述抓痛点**（这条最重要）：优先写
   - "有 the 时：前面是…，后面是…；无 the 时：…"
   - "A 情况用 X，B 情况用 Y"
   这种**二分对照**，比抽象定义好记得多。
4. **表格的 rows 全是数据行，第一行也是数据**：
   不要写"关系词 / 先行词 / 从句成分"这种**表头行**，也不要写和卡片标题重复的表头。
   正确例子（两列数据，一行一条）：
   \`{"type":"table","rows":[["where","先行词是地点 + 从句完整"],["which/that","先行词是地点 + 从句缺主语"]]}\`
5. **块类型选择**：按内容性质选合适的 type，让卡片结构清晰：
   - \`heading\` 小标题 / \`text\` 一句话规则 / \`example\` 例句（配 translation 中文翻译）
   - \`list\` 多个并列要点 / \`table\` 对照（**无表头**，见规则 4）/ \`code\` 代码 / \`quote\` 引用 / \`tip\` 易错点
   易错点用 \`tip\`，对照用 \`table\`，多个并列要点用 \`list\`，不要全用 text 段落。
6. **考核标签** examTags：从下面这些题型 id 里选**该知识点适合的 1~3 种**（这就是"有多少种考法"）：
${EXAM_TYPE_LIST}
7. **出题量** examLoad：\`estMinutes\` 控制在 **3~5 分钟**；\`types\` 给出具体题型组合（要和 examTags 一致）。
8. **例句最多 1~2 个**，只留最能体现痛点的那个；必须真实、地道，并且一定要配中文翻译（放在 \`translation\` 字段）。
9. 每个块的 \`content\` 是**纯文本**，不要在里面写 HTML 标签、不要写 markdown 语法。
10. 只输出 JSON，不要任何多余文字。`;

/**
 * 录入解析：User 提示词。
 *
 * ⚠️ **对话历史不塞进这里**，而是按真实角色逐条发给模型
 * （见 `services/kcAi.ts` 的 `buildKcMessages`）。理由有两个：
 * 1. 塞进一条 user 消息里的话，模型容易把「历史里 AI 自己写的卡片」
 *    当成要重新生成的内容，第二轮会重复吐一遍；
 * 2. 用户说「第二个再细一点」时，模型靠的是**上面那条 assistant 消息里的编号**，
 *    角色分明才对得上号。
 *
 * @param userMessage 用户说的原话
 * @param existingTitles 已有知识点标题（避免重复生成同一张卡）
 */
export function kcImportUserPrompt(userMessage: string, existingTitles: string[]): string {
  const titles = existingTitles.map((t) => t.trim()).filter((t) => t !== '');
  const avoid = titles.length === 0 ? '（暂无已有知识点）' : titles.map((t) => `- ${t}`).join('\n');
  return `学生说：「${userMessage}」

我已经有这些知识点卡片了：
${avoid}

请按 schema 输出 JSON。如果学生说的内容与上面某个已有知识点**高度重合**，
就不要重复生成那一张，只生成新的、不重合的知识点；如果全部重合，返回 {"cards":[]}。
如果学生是在对**上一轮你已经给出的卡片**提修改意见（例如"第二个再细一点"、"刚才那个再加个例子"），
就按他的意思重新给出**修改后的完整卡片**（张数与标题尽量与原来一致，方便他替换）。`;
}
