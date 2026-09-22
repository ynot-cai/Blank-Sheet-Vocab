/**
 * 全局类型定义（一期：单词）。
 * 这个文件除了二期设置的类型之外不 import 任何东西（否则容易产生循环依赖），只放类型。
 */
import type { KcSettings } from './kcTypes';

/** 单词状态：未背 / 学习中 / 已背 / 已斩 */
export type WordStatus = 'unlearned' | 'learning' | 'learned' | 'chopped';

/**
 * 复习优先度预设。
 *
 * - `forgetting` 遗忘曲线型
 * - `failFirst` 失败率优先型
 * - `balanced` 均衡型
 * - `failRateBalanced` ★ T2 新增：**失败率均衡型** —— 与 balanced 同量纲口径，
 *   但把失败率的权重提高、去掉复习次数的降权，适合想「按错误率严格排序」的用户。
 *   单独给一个预设而不是直接改 balanced，是为了**不动老用户的现有选择**：
 *   已选 balanced 的人升级后公式不变（只是里面那个变量从次数换成了比率，见 PRESETS 注释）。
 *
 * 自定义表达式通过 `customExpr` 表达（非空时优先于这里的预设）。
 */
export type PriorityPreset = 'forgetting' | 'failFirst' | 'balanced' | 'failRateBalanced';

/**
 * 来源优先级的排序方向。
 *
 * ⚠️ **已废弃**：早期版本里来源有自己的优先级，用这个字段决定「数字大的优先还是小的优先」。
 * 现在优先级只有一套、挂在词上（`Word.priority`，固定 5 最高），
 * 「同一个词重复录入要不要覆盖」由那个单独的确认框决定，不再有方向概念。
 *
 * 类型与设置项都**保留**只是为了两件事：老备份文件能继续被解析、设置结构不用改。
 * 新代码不许再读它。
 */
export type PriorityDir = 'desc' | 'asc';

/**
 * ★ 优先级（**只有这一个概念**）。
 *
 *   · 值 1~5，5 为最高，默认 3；
 *   · 它决定**背诵先抽谁**——高优先级是**绝对优先**：5 的词全部抽完才开始抽 4 的；
 *   · 也是**唯一**的优先级：不存在第二套「来源优先级」。
 *     重复录入同一个词时要不要覆盖，由那条**单独的确认框**决定
 *     （它拿「库里那条的 priority」和「本次的 priority」比，不同才问）。
 *
 * 落在数据上就是 `Word.priority`，一个字段。
 */
export const WORD_PRIORITY_MIN = 1;
export const WORD_PRIORITY_MAX = 5;
export const WORD_PRIORITY_DEFAULT = 3;

/** 合法的优先级（1~5） */
export type WordPriority = 1 | 2 | 3 | 4 | 5;

/** 优先级选项（录入页单选框、列表页筛选/编辑下拉共用同一份，避免各处写死） */
export const WORD_PRIORITY_OPTIONS: { value: WordPriority; label: string }[] = [
  { value: 1, label: '1 低' },
  { value: 2, label: '2' },
  { value: 3, label: '3 中' },
  { value: 4, label: '4' },
  { value: 5, label: '5 高' },
];

/** 义项 */
export interface Sense {
  id: string;
  text: string; // 义项文本，可含词性前缀，如 "n. 苹果"
  aliases: string[]; // 近义词/等价写法，记忆判分时视为通过
  enabled: boolean; // false = 被划掉
}

/** 属性组（属性①~⑥） */
export interface Attrs {
  needSpell: boolean; // 属性1 是否拼写
  failCount: number; // 属性2 未通过次数（有上限，默认 2）
  failCountTotal: number; // 内部真实累计，不设上限
  reviewCount: number; // 属性3 复习次数
  lastReviewAt: number | null; // 属性4 上次复习时间戳
  learnedAt: number | null; // 属性5 首次背诵完成时间
  reviewPriority: number; // 属性6 复习综合优先度
  /**
   * ★ T2：**总考核次数** —— 这个词一共被考察过多少次（对 + 错都算一次）。
   *
   * 为什么需要它：优先度公式以前直接用 `failCount`（绝对次数），对老词不公平 ——
   * 「考 2 次错 1 次」和「考 20 次错 5 次」的 `failCount` 是 1 和 5，老词看起来
   * 更该复习，可它的失败率 25% 其实比新词的 50% 低。用户要求改成**比率**
   * （`failRate = 失败次数 / 总考核次数`），分母就是它。
   *
   * 累加时机：**每一次判分都 +1**（不论对错），与 `failCount` 的累加在同一处
   * （见 `ui/pages/paper/rounds.ts` 的 recordExam）。
   *
   * 为什么类型是 `number | null` 而不是 `number`：
   *   `null` 明确表示「这个词还没有总考核次数的记录」（老数据），
   *   与「确实考过 0 次」区分开 —— 迁移（`backfillExamCount`）只处理 null，
   *   0 是有意义的真实值，不能被回填覆盖。跑过迁移之后这个字段不再为 null。
   */
  examCount: number | null;
}

/** 某个低优先级来源留下的义项记录，供列表页手动采纳 */
export interface RawSourceRecord {
  sourceId: string;
  senses: Sense[];
}

/** 单词 */
export interface Word {
  id: string;
  en: string;
  phonetic: string;
  example: string;
  senses: Sense[];
  sourceId: string;
  rawSources: RawSourceRecord[]; // 低优先级来源记录，供手动采纳
  attrs: Attrs;
  status: WordStatus;
  /**
   * ★ 优先级（**唯一的那一个**）：1~5，5 为最高，默认 3。
   *
   * 决定背诵先抽谁（绝对优先），也是重复录入时确认框用来判断「要不要问」的字段。
   * 兼容性：老数据没有这个字段，读的时候一律用 `wordPriorityOf()` 兜底成 3，
   * 所以任何地方都**不要**直接比 `w.priority`（可能是 undefined）。
   */
  priority: number;
  learnOrder: number | null; // 背诵顺序序号，已背词排序用
  createdAt: number;
  updatedAt: number; // 每次写回自动刷新（云同步按它做增量）
  /**
   * 软删除标记：1 = 已删除（墓碑行）。
   * 本地删除**不真的删行**，而是留一条 deleted=1 的墓碑，
   * 否则「A 设备删了、B 设备还留着」会在下次同步时被 B 复活。
   * 缺字段当 0 处理（老数据没有这个字段）。
   */
  deleted?: 0 | 1;
}

/**
 * 词库来源。
 *
 * ★ 来源**没有**优先级：它是「这批词是从哪来的」的分组标签（四级 / 六级 / 自己粘的…），
 *   供列表页筛选、以及「同一个词在别的来源里已存在时把旧义项留档（rawSources）」用。
 *   优先级只有一套，挂在词上（见 `Word.priority`）。
 *
 * 兼容性：老数据里可能有 `priority` 字段（那是历史遗留的「来源优先级」，已废弃）
 * 或者完全没有这个字段。两边都不会被读取，也不需要迁移。
 */
export interface Source {
  id: string;
  name: string;
  createdAt: number;
  updatedAt?: number; // 云同步用的版本号，老数据缺省时退回 createdAt
  deleted?: 0 | 1; // 软删除标记（含义同 Word.deleted）
}

/** 一次背诵/复习会话 */
export interface Session {
  id: string;
  type: 'learn' | 'review';
  wordIds: string[]; // 本轮词单（复习 = 所有分组合并后的全量）
  placements: Record<string, { x: number; y: number }>; // 白纸落点（「保存并退出」时一并持久化，续跑恢复）
  shownIds: string[]; // 已在纸上出现过的词
  memorizeCount: Record<string, number>; // 每词被「记忆」次数（保存并退出时持久化）
  spellEnabled: boolean;
  failedIds: string[]; // 本次会话内记过未通过的词 id（历史记录，界面/收尾用）
  failDeltas: Record<string, number>; // 本次会话内每词累计未通过次数（正常结束时写回词库）
  /**
   * ★ T2：本次会话内每词累计的**总考核次数**（正常结束时写回 `attrs.examCount`）。
   *
   * 为什么和 `failDeltas` 一样存「增量」而不是在会话里直接改词：
   * 中途退出（保存并退出 / 关页面）时这份会话原样落库，**不该**已经把
   * 总考核次数写进词库 —— 否则「复习到一半退出」也会算作词汇被完整考核过。
   * 只有正常收尾（`finishReview` / 一次复习会话结束）才把增量合并回词库。
   *
   * 可选（`?`）：老会话存档里没有这个字段，读回来当 `{}` 处理即可。
   */
  examDeltas?: Record<string, number>;
  /**
   * **上一轮**记忆里没通过的词 id（每次记忆结束刷新）。
   *
   * 用途：记忆抽词的第 4 步 —— 上一轮没通过、又没被「遍数最少」抽到的词，
   * 作为**额外项**加入本轮（总数允许超过 `memorizeMaxPick`）。规则由用户口头定稿，
   * 见 `core/pick.ts` 的 `pickForMemorize`。
   * 老数据/老存档没有这个字段 → 按空数组处理（不额外抽词）。
   */
  lastRoundFailedIds?: string[];
  groupId: number; // 复习：当前第几组（0-based）；learn 恒为 0
  groups: string[][]; // 复习：全部分组，仅内存
  finished: boolean;
  createdAt: number;
}

/** 纸张设置 */
export interface PaperSettings {
  mode: 'auto' | 'ratio' | 'fixed';
  ratio: 'A4' | '16:9' | '4:3';
  width: number;
  height: number;
}

/** 显示设置 */
export interface DisplaySettings {
  fontFamily: string;
  fontSize: number;
  wordColor: string;
  bgColor: string;
  animation: boolean;
  /**
   * 备案号（可选，默认空 = 不显示）。
   * 自用工具本来不需要，留这个位置是为了将来真要公开时不用改代码。
   */
  beian?: string;
}

/** 解析设置 */
export interface ParseSettings {
  fieldSep: string; // 'auto' 或具体分隔符
  senseSep: string; // 义项分隔符集合，如 '；;／/|'
  /** ⚠️ 已废弃（来源优先级时代的遗留），保留只为兼容老备份；新代码不许读它 */
  priorityDir: PriorityDir;
}

/** 记忆环节设置 */
export interface MemorizeSettings {
  position: 'origin' | 'centerTop';
  offsetY: number; // 0~1，距顶部百分比
}

/** 复习优先度设置 */
export interface PrioritySettings {
  preset: PriorityPreset;
  customExpr: string; // 非空时优先于 preset
}

/**
 * 背诵抽词设置（R3）。
 *
 * 优先级永远是第一关键字（绝对优先，不可配置）——这里只调**同一优先级内部**的顺序。
 */
export interface LearnPickSettings {
  /** 同级内按什么排：createdAt = 先录入的先背（默认，可预测）；random = 同级内确定性地打乱 */
  samePriorityOrder: 'createdAt' | 'random';
}

/** AI 设置：地址/模型/密钥三项全部由用户在设置页自己填 */
export interface AiSettings {
  proxyUrl: string; // 可选：自建转发地址（阶段 08），留空则直接用 baseUrl
  baseUrl: string;
  model: string;
  key: string; // 密钥只存这台设备的浏览器，服务器全程不接触（方案 B）
  /**
   * 是否强制走「无状态代理」转发（阶段 03）。
   * 默认 false = 先试浏览器直连，被跨域拦截时自动切到代理；
   * 打开 = 直接走代理，不再尝试直连（CORS 反复失败的场景更省事）。
   */
  forceProxy: boolean;
}

/** 练习（朗读）设置 */
export interface PracticeSettings {
  autoSpeak: boolean;
  speakRate: number;
  speakLang: string;
}

/** 备份设置 */
export interface BackupSettings {
  remindOnClose: boolean; // 关闭页面前提醒导出
  lastManualExportAt: number | null; // 上次手动导出时间
}

/**
 * 云同步设置（阶段 02）。
 *
 * **安全前提**：`syncCode` 是明文同步码，只存在这台设备的浏览器里；
 * 发请求前先 SHA-256，服务器只看到哈希（方案 A/B 的 B 方案：服务器不碰明文，更不碰 AI 密钥）。
 */
export interface CloudSettings {
  enabled: boolean; // 是否开启云同步
  apiBase: string; // 后端地址，如 https://blank-sheet-vocab.vercel.app（不要带 /api，代码自动拼）
  syncCode: string; // 同步码（明文，只存本机）
  lastSyncAt: number; // 上次同步成功的时间戳（0 = 从未同步）
  autoSync: boolean; // 数据变动后防抖自动同步
  /** 已推送到云端的最大 updatedAt；推送时只发比它新的（0 = 首次全量） */
  lastPushAt: number;
  /** 是否已经给用户讲过「同步码是什么」（首次开启时弹一次说明） */
  introShown: boolean;
  /** 上次同步失败的原因（空串 = 没失败过；只给界面显示，不含密钥） */
  lastError: string;
}

/**
 * 一档设备形态的布局参数（阶段 M2：手机布点重构）。
 *
 * 所有影响「一屏放几个词」的数字都在这里，**不许散落成魔法数字**：
 * 布点（core/layout.ts 的 computeGrid / layoutWords）+ 避让区（ui/device.ts）
 * + 底部圆形按钮（styles/paper.css）三方都读这一份。
 */
export interface LayoutTier {
  /** 布点边距（像素）：与纸张边界的最小距离 */
  edgeMarginPx: number;
  /** 相邻单词的最小空隙（像素，字号之外再留的） */
  minGapPx: number;
  /** 单词字号（像素，手机档直接就是渲染字号） */
  fontSizePx: number;
  /** 期望一屏放几个词（算法尽量逼近；放不下就按实际最大值） */
  targetCount: number;
  /** 底部圆形按钮 */
  button: {
    /** 直径（像素） */
    diameterPx: number;
    /** 按钮之间的横向间距（像素） */
    gapPx: number;
    /** 圆形按钮下方小字的字号（像素） */
    labelFontPx: number;
  };
}

/** 响应式布局参数（按断点分三档，见 core/config.ts 的 DEFAULT_LAYOUT） */
export interface LayoutSettings {
  /** 手机（< 768px） */
  mobile: LayoutTier;
  /** 平板（768~1024px） */
  tablet: LayoutTier;
  /** 桌面（> 1024px） */
  desktop: LayoutTier;
}

/**
 * ★ S3：手动列数覆盖。
 * `'auto'` = 按屏幕宽度自然推导；`3 | 4 | 5 | 6 | 8 | 10` = 强制用该列数
 * （可选值见 core/config.ts 的 `LAYOUT_COLS_OPTIONS`）。
 *
 * 为什么要有：自动算法再周全也可能在某个尺寸/某批词上不合适，
 * 用户自己选一个列数就能立刻用起来 —— 算法兜底 + 人工兜底。
 */
export type LayoutColsOverride = 'auto' | 3 | 4 | 5 | 6 | 8 | 10;

/** 全局设置（结构对应 config.ts 的 DEFAULT_SETTINGS） */
export interface Settings {
  memorizeMaxPick: number;
  memorizeTargetCount: number;
  memorizeEvery: number;
  failCountCap: number;
  reviewGroupSize: number;
  paperWordGapFactor: number;
  paper: PaperSettings;
  display: DisplaySettings;
  /** ★ M2：布点与按钮的响应式参数（手机一屏放几个词就靠它） */
  layout: LayoutSettings;
  /** ★ S3：手动列数覆盖（'auto' 之外的取值直接决定列数，见 LayoutColsOverride） */
  layoutColsOverride: LayoutColsOverride;
  parse: ParseSettings;
  memorize: MemorizeSettings;
  priority: PrioritySettings;
  /** ★ R3：背诵抽词（优先级绝对优先，这里只调同级内顺序） */
  learnPick: LearnPickSettings;
  ai: AiSettings;
  practice: PracticeSettings;
  backup: BackupSettings;
  cloud: CloudSettings;
  /**
   * 二期（知识点精学）设置。
   * 说明：和一期共用同一份 `Settings` 存储，但字段互不干扰——
   * 二期读 `settings.kc.*`，一期读其余字段，谁都不会覆盖谁。
   */
  kc: KcSettings;
}

/**
 * 深一层可选的补丁类型：允许 `{ cloud: { enabled: true } }` 这种嵌套局部更新。
 * 深层合并逻辑（config.deepMergeSettings）本来就支持，这里只是把类型放开。
 */
export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

/** 列表页查询条件 */
export interface WordQuery {
  keyword?: string;
  status?: WordStatus[];
  sourceId?: string;
  minFailCount?: number;
  needSpell?: boolean;
  minPriority?: number;
  /** ★ 按**词级**优先级精确筛选（R1 加的，与上面的 minPriority/复习优先度无关） */
  priority?: number;
  sort?: 'learnOrder' | 'reviewPriority' | 'createdAt' | 'en' | 'priority';
  order?: 'asc' | 'desc';
  page: number;
  pageSize: number;
}

/** 词库统计（列表页顶部统计条 / 设置页数据区共用） */
export interface WordStats {
  total: number;
  unlearned: number;
  learning: number;
  learned: number;
  chopped: number;
}
