/**
 * 做题状态机的**类型**（从 `kcExamController.ts` 拆出来的）。
 *
 * 为什么单独一个文件：控制器本体正好卡在 300 行的硬上限上，
 * 而状态/接口这两块是**纯类型**（编译后一行不剩），拆出去既腾了行数，
 * 也让「界面能看到什么」和「怎么推进」两件事分开。
 *
 * ⚠️ 文件名叫 `kcExamState` 而不是 `kcExamTypes`：`core/kcExamTypes.ts`
 * 已经存在（那是「考核方式标签」的小工具），同名不同目录太容易看错。
 *
 * `kcExamController.ts` 会把它们**再导出**一次，所以别处的
 * `import { ExamState } from './kcExamController'` 不用改。
 */
import type { KcSession, KnowledgeCard } from '../../../core/kcTypes';
import type { KcGradeResult, KcQuestion } from '../../components/ExamTaker';
import type { PrepareProgress } from './kcExamPrepare';

/** 阶段 */
export type ExamPhase = 'preparing' | 'loading' | 'answering' | 'grading' | 'graded' | 'done' | 'error';

/** 状态快照（界面只读它来渲染） */
export interface ExamState {
  phase: ExamPhase;
  /** 第几题（0-based） */
  questionIndex: number;
  /** 本轮共有几题 */
  total: number;
  /** 批量出题进度（preparing 阶段界面显示「正在出题 3/7」） */
  preparing: PrepareProgress;
  /** 当前题目（loading/error 时可能是上一题的，界面按 phase 决定要不要用） */
  question: KcQuestion | null;
  /** 当前这张卡（显示「知识点：xxx」用） */
  card: KnowledgeCard | null;
  /** 学生答案 */
  answer: string;
  /** 评分结果 */
  grade: KcGradeResult | null;
  /** 错误说明 */
  error: string;
  /** 当前 ExamRecord 的 id（改分要更新它） */
  recordId: string;
  /** 一轮结束时复习收尾后的卡片（复习流程用来显示小结；学习流程为空） */
  finishedCards?: KnowledgeCard[];
}

/** 控制器对外接口 */
export interface ExamController {
  /** 读当前状态（浅拷贝快照） */
  getState: () => ExamState;
  /** 订阅状态变化 */
  subscribe: (fn: (s: ExamState) => void) => void;
  /** 会话（保存并退出要用） */
  getSession: () => KcSession | null;
  /** 本轮卡片 */
  getCards: () => KnowledgeCard[];
  /** 一口气出完所有题，然后载入当前这一题 */
  start: () => Promise<void>;
  /** 提交答案 → 评分 → 存档 */
  submit: (answer: string) => Promise<void>;
  /** 手动改分 */
  regrade: (score: number) => Promise<void>;
  /** 下一题 / 结束 */
  next: () => Promise<void>;
  /** 重试当前题（出题失败后用，只重出这一道） */
  retry: () => Promise<void>;
}
