/**
 * 二期（知识点精学）的类型定义。
 *
 * 与一期的关系：**两套数据完全独立**（独立表、独立 DAO、独立路由），
 * 唯一的桥接点是「复习流程里调起一期背单词界面」（见主提示词第 7 节）。
 *
 * 这个文件和 `core/types.ts` 一样，**不 import 任何东西**（只放类型，避免循环依赖）；
 * 唯一例外是 `KcSettings` 需要嵌进一期的 `Settings`，那是通过 `types.ts` 反向引用的。
 */

/** 块类型：卡片「结构自由」的基础，新增类型只需往这里加 */
export type BlockType =
  | 'heading' // 小标题
  | 'text' // 正文段落
  | 'example' // 例句（可带翻译）
  | 'list' // 列表
  | 'table' // 表格
  | 'code' // 代码块
  | 'quote' // 引用
  | 'tip'; // 提示/易错点

/**
 * 块：知识点内容的最小单位。
 *
 * 安全前提：块里的文本一律当作**纯文本**，渲染时只走 `textContent`，
 * 绝不当 HTML 插入 DOM（见 `core/blockRender.ts`）。
 */
export interface Block {
  id: string;
  type: BlockType;
  /** heading / text / tip / quote / code 的正文 */
  content?: string;
  /** example 的中文翻译 */
  translation?: string;
  /** list 的每一项 */
  items?: string[];
  /**
   * table 的行，**全部是数据行**（没有表头行，第一行也是数据）。
   *
   * 用户明确要求「表格不要写表头」：表头行占地方，而且常常和卡片标题重复。
   * 库里存量数据可能存在按旧格式写入的「第一行是表头」的表格，
   * 渲染端统一按数据行显示，不做猜测（见 `core/blockRender.ts` 的 renderTable）。
   */
  rows?: string[][];
  /** code 的语言标记，只作 CSS class，不做任何解析 */
  lang?: string;
  /** example 的补充说明 */
  note?: string;
}

/** 卡片状态：未学 / 学习中 / 已学 / 已斩 */
export type KcStatus = 'unlearned' | 'learning' | 'learned' | 'chopped';

/** 自评与考核的分数：1=不会，2=模糊，3=会了 */
export type SelfRating = 1 | 2 | 3;

/** 出题量建议（录入时由 AI 决定，用户可改） */
export interface ExamLoad {
  /** 本次建议的题型组合，元素是 `EXAM_TYPES` 的 id */
  types: string[];
  /** 预计耗时（分钟） */
  estMinutes: number;
}

/** 卡片来源（聊天式录入时的原始对话） */
export interface KcSource {
  chatId?: string;
  raw?: string;
}

/** 卡片的六个属性（+ 掌握度与优先度） */
export interface KcAttrs {
  /** 属性1 首次学习时间 */
  learnedAt: number | null;
  /** 属性2 上次复习时间 */
  lastReviewAt: number | null;
  reviewCount: number;
  /** 最近一次自评（1~3），没评过是 null */
  lastSelfScore: number | null;
  /** 最近一次考核（1~3），没考过是 null */
  lastExamScore: number | null;
  /** 属性3 综合掌握程度（0~1，算法见 kcModel.calcMastery） */
  mastery: number;
  /** 属性4 综合复习优先度（越大越该先复习，算法见 kcPriority） */
  reviewPriority: number;
}

/** 知识卡片 */
export interface KnowledgeCard {
  id: string;
  /** 知识点标题，如「定语从句：关系代词 vs 关系副词」 */
  title: string;
  /** 一句话摘要 */
  summary: string;
  /** 结构自由靠块的任意组合 */
  blocks: Block[];
  /** 考核方式标签（可多个 = 多种考法），元素是 `EXAM_TYPES` 的 id */
  examTags: string[];
  /** 出题量 */
  examLoad: ExamLoad;
  /** 来源 */
  source: KcSource;
  attrs: KcAttrs;
  status: KcStatus;
  createdAt: number;
  updatedAt: number;
  /** 软删除（1 = 墓碑）。与一期 Word.deleted 同口径，缺省当 0 */
  deleted?: 0 | 1;
}

/**
 * 考核方式标签表（可扩展）。
 *
 * **新增题型只需要往这个数组加一项**，不要在任何地方写死「4 种题型」的分支判断。
 * 阶段 05 的出题提示词会读它来生成 prompt。
 */
export const EXAM_TYPES = [
  { id: 'fill', name: '语法填空', desc: '提示词 + 挖空练习' },
  { id: 'sentence', name: '独立写句子', desc: '给要求造句（如用定语从句）' },
  { id: 'choice', name: '选择题', desc: '' },
  { id: 'judge', name: '判断正误', desc: '' },
] as const;

/** 题型 id 联合类型（由 EXAM_TYPES 推导，新增题型自动包含） */
export type ExamTypeId = (typeof EXAM_TYPES)[number]['id'];

/**
 * 按 id 找题型定义（找不到返回 undefined）。
 * 说明：只认 `EXAM_TYPES` 里的 id，未知 id 一律当作「无此题型」。
 * @param id 题型 id
 */
export function findExamType(id: string): (typeof EXAM_TYPES)[number] | undefined {
  return EXAM_TYPES.find((t) => t.id === id);
}

/** 每日语境词（防重复：生成看 30 天、出题看 3 天） */
export interface DailyContextWords {
  id: string;
  spaceKey: string;
  /** 'YYYY-MM-DD'，自然日（过零点换新一组） */
  date: string;
  /** 5 个，互不相关 */
  words: string[];
  source: 'ai' | 'manual';
  /** 用户确认后才生效 */
  confirmed: boolean;
  createdAt: number;
}

/** 已出过的题（防重复 + 复盘） */
export interface ExamRecord {
  id: string;
  spaceKey: string;
  cardId: string;
  /** 'YYYY-MM-DD' */
  date: string;
  /** `EXAM_TYPES` 的 id */
  type: string;
  question: string;
  userAnswer: string;
  /** AI 打分 1~3 */
  aiScore: number;
  /** AI 评分理由 */
  aiReason: string;
  /** 关联的语境词 */
  contextWord: string;
  createdAt: number;
}

/** 「添加题库」按钮存入的参考样题 */
export interface BankQuestion {
  id: string;
  spaceKey: string;
  /** `EXAM_TYPES` 的 id */
  type: string;
  /** 题目原文（含答案） */
  content: string;
  /** 来源标注，如「2023全国甲卷」 */
  source: string;
  createdAt: number;
}

/** 卡片列表查询条件 */
export interface KcQuery {
  /** 关键词：匹配标题 / 摘要（不区分大小写） */
  keyword?: string;
  /** 状态过滤（多选） */
  status?: KcStatus[];
  /** 考核方式标签过滤：命中最少几个才算（默认 1） */
  examTag?: string;
  /** 排序字段 */
  sort?: 'reviewPriority' | 'createdAt' | 'mastery' | 'title';
  order?: 'asc' | 'desc';
  page: number;
  pageSize: number;
}

/** 掌握度公式参数（设置页可改，阶段 07 做界面） */
export interface MasteryConfig {
  /** 自评权重（默认 0.6，比考核高——主观题 AI 评分不一定准） */
  w1: number;
  /** 考核权重（默认 0.4） */
  w2: number;
  /** 不一致惩罚系数（默认 0.8） */
  penalty: number;
  /**
   * 惩罚项的方向系数（默认 2）：
   * - 自评 > 考核（盲目自信）→ 惩罚 `penalty * asymmetry`
   * - 自评 < 考核（低估自己）→ 惩罚 `penalty / asymmetry`
   *
   * 为什么需要方向：对称惩罚在 0.6/0.4 的权重下会算出「盲目自信的掌握度
   * 反而比低估自己更高」，与「盲目自信最危险」的结论相反。
   */
  asymmetry: number;
}

/** 二期云同步游标（独立于一期 cloud，互不影响） */
export interface KcCloudCursor {
  lastSyncAt: number;
  lastPushAt: number;
  lastError: string;
}

/** 复习优先度权重（阶段 07 做设置界面） */
export interface KcPriorityWeights {
  /** 掌握度越低越优先：`(1 - mastery) * masteryWeight` */
  masteryWeight: number;
  /** 越久没复习越优先：`daysSinceReview * staleWeight` */
  staleWeight: number;
  /** 自评与考核差距越大越优先（盲目自信要被抓出来）：`gap * gapWeight` */
  gapWeight: number;
}

/**
 * 二期会话（学习 / 复习的进度）。
 *
 * 用途：每一步都能「保存并退出」，重进时问「继续上次（剩 N 张）/ 重新开始」。
 * 结构与一期的 `Session` 不同：二期是**逐张卡片**推进（不是白纸撒点），
 * 所以进度就是「第几张 + 每张的分数」。
 */
export interface KcSession {
  id: string;
  type: 'study' | 'review';
  /** 本轮要过的卡片 id（顺序 = 展示顺序） */
  cardIds: string[];
  /** 当前在第几张（0-based；等于 cardIds.length 表示卡片看完了） */
  currentIndex: number;
  /** cardId → 自评 1|2|3 */
  selfScores: Record<string, number>;
  /** cardId → 考核 1|2|3（阶段 05 用） */
  examScores: Record<string, number>;
  /**
   * 流程阶段（复习流程用；学习流程只用 `cards` 与 `done`）：
   * - `cards` 正在看卡片
   * - `words` 正在背单词（一期桥接中，阶段 06）
   * - `exam` 正在做题（阶段 05）
   * - `done` 完成
   */
  stage: 'cards' | 'words' | 'exam' | 'done';
  /** 桥接背单词时的词单（阶段 06 用；为空表示还没进这一段） */
  wordIds: string[];
  /** 已完成背单词（阶段 06 用来判断「背完才能继续」） */
  wordsDone: boolean;
  /** 上一道题的序号（阶段 05 用，0-based） */
  examIndex: number;
  finished: boolean;
  createdAt: number;
  updatedAt: number;
}

/** 二期设置（嵌在一期 `Settings.kc` 里） */
export interface KcSettings {
  /** 复习优先度的表达式机制（阶段 07）：customExpr 非空且合法时优先于 preset */
  priority: KcPriorityWeights & { preset: 'balanced' | 'weakFirst' | 'forgetting'; customExpr: string };
  mastery: MasteryConfig;
  contextWordCount: number;
  contextGenLookbackDays: number;
  examDedupeLookbackDays: number;
  reviewWordLimit: number;
  examLoadDefaultMinutes: number;
  /** 出题量允许的耗时下限（分钟），解析 AI 输出时钳制用 */
  examLoadMinMinutes: number;
  /** 出题量允许的耗时上限（分钟） */
  examLoadMaxMinutes: number;
  cloud: KcCloudCursor;
}

/**
 * 录入解析出来的卡片（**还没有 id / 属性 / 状态**——那些由 `createEmptyCard` 或 DAO 补）。
 *
 * 为什么单独定义而不是 `Omit<KnowledgeCard, ...>`：这里描述的是「AI 输出经过校验后的形状」，
 * 和「库里存的卡片」是两个不同的东西；写成独立类型，将来 AI 输出的字段变了，
 * 编译器会直接指着这里报错，不会悄悄漏改。
 */
export interface ParsedKcCard {
  title: string;
  summary: string;
  blocks: Block[];
  examTags: string[];
  examLoad: ExamLoad;
  /** 来源（聊天录入的原始用户消息，便于以后回溯「我是怎么想到这个知识点的」） */
  source: KcSource;
}
