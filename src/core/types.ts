/**
 * 全局类型定义（一期：单词）。
 * 这个文件除了二期设置的类型之外不 import 任何东西（否则容易产生循环依赖），只放类型。
 */
import type { KcSettings } from './kcTypes';

/** 单词状态：未背 / 学习中 / 已背 / 已斩 */
export type WordStatus = 'unlearned' | 'learning' | 'learned' | 'chopped';

/** 复习优先度预设：遗忘曲线型 / 未通过优先型 / 均衡型（自定义表达式通过 customExpr 表达） */
export type PriorityPreset = 'forgetting' | 'failFirst' | 'balanced';

/** 来源优先级方向：desc = 数字越大越优先；asc = 数字越小越优先 */
export type PriorityDir = 'desc' | 'asc';

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

/** 词库来源 */
export interface Source {
  id: string;
  name: string;
  priority: number; // 数字越大越优先（方向可在设置里反转）
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
  failedIds: string[]; // 本次会话内记过未通过的词 id（记忆环节必抽的依据）
  failDeltas: Record<string, number>; // 本次会话内每词累计未通过次数（正常结束时写回词库）
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
  parse: ParseSettings;
  memorize: MemorizeSettings;
  priority: PrioritySettings;
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
  sort?: 'learnOrder' | 'reviewPriority' | 'createdAt' | 'en';
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
