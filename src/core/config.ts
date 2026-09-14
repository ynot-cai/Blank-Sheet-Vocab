import type { DeepPartial, PriorityPreset, Settings } from './types';

/** 星号参数：所有可调数字集中在这里，代码里不许写死 */
export const DEFAULTS = {
  memorizeMaxPick: 10, // 一次「记忆」最多抽几个（只抽已出现在纸上的词）
  memorizeTargetCount: 1, // 每词至少记忆几次，「背完了」按钮才出现（默认 1 = 至少记一次）
  memorizeEvery: 3, // 每背几个新词，「再背一个」按钮自动变成「记忆」
  failCountCap: 2, // 属性② 未通过次数上限
  reviewGroupSize: 30, // 复习每组上限
  paperWordGapFactor: 2.4, // 白纸上相邻单词的最小间距 = 字号 × 这个系数
};

/**
 * 响应式（移动端适配）参数。
 * 断点：手机 < 768px / 平板 768~1024px / 桌面 > 1024px。
 */
export const DEVICE = {
  /** 手机断点（小于它算手机） */
  phoneMaxWidth: 767,
  /** 平板断点（小于等于它算平板） */
  tabletMaxWidth: 1024,
  /** 右下角按钮区尺寸（像素）：手机 */
  controlsPhone: { width: 140, height: 220 },
  /** 右下角按钮区尺寸（像素）：平板 */
  controlsTablet: { width: 180, height: 260 },
  /** 布点时要避开的屏幕边缘（像素），防止词贴着边不好点 */
  controlsMargin: 20,
  /** 只避让按钮区还不够——再留一点余量，避免视觉上压住 */
  controlsPadding: 12,
  /** 触摸热区最小尺寸（像素）：可点元素都不能小于它 */
  minTapSize: 44,
  /** 手机上的最小字号（iOS 上输入框小于 16px 会触发页面自动放大） */
  minInputFontSize: 16,
  /** 手机上布点密度上限（每屏最多几个词） */
  phoneMaxPerScreen: 12,
  /** 手机上单词字号的放大系数（布点密度也跟着降） */
  phoneFontScale: 1.15,
  /** 浅灰义项序号的字号与单词字号的比例 */
  senseBadgeScale: 0.5,
  /** 义项序号的最小字号（确保能看清） */
  senseBadgeMinFontSize: 12,
  /** 义项序号颜色（浅灰，不抢单词的视觉） */
  senseBadgeColor: '#bbb',
};

/**
 * IndexedDB 相关的固定参数。
 *
 * `openTimeoutMs` 是**踩过坑才加的**：老版本的标签页占着同一个库时，
 * 版本升级会被阻塞（onblocked），而**重试打开会一直挂着不返回**——
 * 用户看到的是「点了没反应 / 一直转圈」，比报错还难查。
 * 有超时兜底之后，最坏情况是给一句「关掉其它标签页」的提示。
 */
export const DB = {
  /** 打开/升级数据库的超时（毫秒）。超时按「多半是老标签页占着」处理 */
  openTimeoutMs: 8_000,
};

/**
 * 云同步相关的固定参数（同样不许散落在代码里）。
 * 说明：`pushBatchSize` 必须 ≤ 后端 `api/_lib/limits.ts` 里的 MAX_PUSH_BATCH（500），
 * 改这里的时候两边要一起改——后端超限会直接返回 400。
 */
export const SYNC = {
  debounceMs: 5_000, // 数据变动后等几秒再同步，把连续操作合并成一次
  requestTimeoutMs: 15_000, // 单次请求超时；超时算失败但不阻断使用
  retryDelayMs: 2_000, // 失败后等多久重试一次
  retryCount: 1, // 失败后重试几次（1 = 再试一次，仍失败就交给下次防抖）
  pushBatchSize: 500, // 每批推送条数上限（对应 Vercel 4.5MB 请求体限制）
  scanPageSize: 5_000, // 推送前的「一页扫描」上限：一次多读一点，避免分页漏数据
  pullPageLimit: 2_000, // 单次拉取最多条数（和后端 MAX_PULL_ROWS 保持一致）
  minCodeLength: 8, // 同步码最短长度
  healthTimeoutMs: 10_000, // 「测试连接」的超时（比同步短，别让用户干等）
};

/**
 * 二期（知识点）的固定参数。
 *
 * 和 `DEFAULT_KC` 的分工：能调的（用户会想改的）放 `DEFAULT_KC`（进设置页），
 * 不能调的（安全/格式/上限）放这里。**两边都不许在业务代码里写死字面量。**
 */
export const KC = {
  /** 单个块的最大字符数：超长就截断（AI 偶尔会吐一整篇，别把页面撑爆） */
  maxBlockTextLength: 5_000,
  /** 摘要最大长度 */
  maxSummaryLength: 200,
  /** 标题最大长度 */
  maxTitleLength: 120,
  /**
   * 标题缺失时的兜底文案。
   * 为什么要有：`validateCard` 对用户输入是严格的（必须填标题），
   * 但从云端/老备份拉回来的数据可能真的没有标题——那种情况下
   * 「拒绝这张卡」比「显示成未命名」更糟（用户会以为卡片丢了）。
   */
  untitledName: '未命名知识点',
  /** 一次复习/学习最少选几张卡 */
  minStudyCount: 1,
  /** 一次复习/学习最多选几张卡 */
  maxStudyCount: 50,
  /** 卡片列表默认每页条数 */
  defaultPageSize: 20,
  /** 卡片列表每页条数可选项 */
  pageSizeOptions: [10, 20, 50, 100] as const,
  /** 自评/考核的分制：1=不会 / 2=模糊 / 3=会了（归一化时除以它） */
  maxScore: 3,
  /** 掌握度小数位（保留 3 位，界面显示不抖） */
  masteryDigits: 3,
  /** `attrs.mastery` 还没算过时的初值 */
  masteryInitial: 0,
  /** 没学过时给复习优先度的「很久没看」天数（与一期 NO_RECORD_DAYS 同口径） */
  noRecordDays: 999,
  /** 「自评 vs 考核」差距超过它才提醒用户（抓盲目自信） */
  blindSpotGap: 0.34,
  /**
   * 只有单边分数（比如还没考过）时，差距计算的折扣系数。
   * 理由：「还没考过」不等于「考砸了」，不能和真正的盲目自信同等看待。
   */
  missingSideGapDiscount: 0.5,
  /**
   * 录入对话带多少条历史消息（一条 user + 一条 assistant = 一轮，默认 6 = 最近 3 轮）。
   *
   * 为什么必须有上限（两条都是硬理由）：
   * 1. **token 成本**：历史里 assistant 那条是上一轮完整的卡片 JSON（一张卡几百字），
   *    不设上限的话第 10 轮请求要付 10 倍的输入费，用户完全无感；
   * 2. **超上下文会直接报错**：模型服务的上下文窗口有限，超了不是「效果差一点」，
   *    而是**整个请求 400 失败**——录入功能当场不可用。
   */
  maxChatHistoryMessages: 6,
  /**
   * 历史消息的字符总预算（UTF-16 码元，中文按 1 算）。
   *
   * 为什么在条数之外还要卡字符数：条数管不住**单条特别长**的情况——
   * 用户粘贴一大段课文、或模型一次回了 12 张卡，一条消息就能顶掉好几轮的预算。
   * 两个上限取更严的那个，并且**从最旧的一端开始丢**（最近一轮永远保留）。
   */
  maxChatHistoryChars: 4000,
  /**
   * 批量出题时的并发数（用户明确要求「开始第一题前一口气把所有题都出完」）。
   *
   * 为什么是 3：串行出 7 道题要等 7 个来回（用户就在出题页干等），
   * 全并发又容易撞上模型服务的速率限制（一道题失败就要用户手动重试）。
   * 3 是「总耗时压在 2~3 个来回」与「不触发限流」之间的折中值。
   */
  examGenConcurrency: 3,
};

/** 云同步的默认值（默认关闭：不填也能正常用，纯本地） */
const DEFAULT_CLOUD: Settings['cloud'] = {
  enabled: false,
  apiBase: '',
  syncCode: '',
  lastSyncAt: 0,
  autoSync: true,
  lastPushAt: 0,
  introShown: false,
  lastError: '',
};

/**
 * 二期（知识点精学）的默认值。
 *
 * 这些数字原来散落在公式和界面里，集中到这里以后：
 * - 用户能在设置页改（阶段 07 会做界面）；
 * - 代码里不再出现魔法数字（`kcModel.calcMastery` 只认参数，不认字面量）。
 */
const DEFAULT_KC: Settings['kc'] = {
  /**
   * 综合掌握度公式参数：自评权重 0.6 > 考核权重 0.4（原因见 kcModel.calcMastery 注释）。
   *
   * `asymmetry` 是**惩罚项的方向系数**：自评高于考核（盲目自信）时惩罚 ×2，
   * 自评低于考核（低估自己）时惩罚 ÷2。为什么必须有它：
   * 对称的惩罚项在 0.6/0.4 的权重下会算出「盲目自信(0.2) 比 低估(0.067) 还高」，
   * 与「盲目自信是最危险状态、必须被自动提上来复习」的要求正好相反（阶段 01 验收项 3）。
   */
  mastery: { w1: 0.6, w2: 0.4, penalty: 0.8, asymmetry: 2 },
  /** 每日语境词数量：用户明确要求每天 5 个，且互不相关 */
  contextWordCount: 5,
  /** 生成语境词时回看多少天的历史（防重复） */
  contextGenLookbackDays: 30,
  /** 出题时回看多少天的历史题目（防重复） */
  examDedupeLookbackDays: 3,
  /** 复习流程里桥接「一期背单词」的词数上限 */
  reviewWordLimit: 5,
  /** 出题量没给建议时的默认耗时（分钟） */
  examLoadDefaultMinutes: 4,
  /** 出题量允许的耗时区间（分钟）：AI 不一定会听话，解析后统一钳到这里 */
  examLoadMinMinutes: 3,
  examLoadMaxMinutes: 5,
  /** 二期云同步的游标（沿用一期 cloud 的思路，但互不影响） */
  cloud: { lastSyncAt: 0, lastPushAt: 0, lastError: '' },
  /**
   * 复习优先度（阶段 07）：**表达式机制**（与一期 priority.ts 同款），
   * 预设三档见 `kcPriorityExpr.KC_PRIORITY_PRESETS`；customExpr 非空且合法时优先。
   * 三个权重是「表达式为空/非法时的兜底」用的老公式参数，保留以兼容阶段 01 的数据。
   */
  priority: {
    preset: 'balanced',
    customExpr: '',
    masteryWeight: 1,
    staleWeight: 0.02,
    gapWeight: 0.5,
  },
};

/** 默认设置（缺字段时用它补齐；AI 三项只是预填，用户可随意改） */
export const DEFAULT_SETTINGS: Settings = {
  ...DEFAULTS,
  paper: { mode: 'auto', ratio: 'A4', width: 1200, height: 800 },
  display: {
    fontFamily: 'system-ui',
    fontSize: 24,
    wordColor: '#111111',
    bgColor: '#ffffff',
    animation: true,
  },
  // priorityDir 已废弃（来源优先级时代的遗留），保留只为兼容老备份；见 types.ts 的说明
  parse: { fieldSep: 'auto', senseSep: '；;／/|', priorityDir: 'desc' },
  memorize: { position: 'centerTop', offsetY: 0.3 },
  priority: { preset: 'balanced' satisfies PriorityPreset, customExpr: '' },
  // R3：同级内先录入的先背（可预测，便于复核）；用户可在设置页改成 random
  learnPick: { samePriorityOrder: 'createdAt' },
  ai: {
    proxyUrl: '',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    key: '',
    forceProxy: false,
  },
  practice: { autoSpeak: true, speakRate: 1, speakLang: 'en-US' },
  backup: { remindOnClose: true, lastManualExportAt: null },
  cloud: DEFAULT_CLOUD,
  kc: DEFAULT_KC,
};

/**
 * 判断某个值是否是「普通对象」，用于深合并前的类型守卫（不许用 any）。
 * @param v 待判断的值
 */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * 深合并设置：以 base 为底，用 patch 覆盖，缺字段补默认值。
 * 只处理一层对象嵌套（设置结构只有两层），数组直接替换。
 * @param base 底（通常是 DEFAULT_SETTINGS）
 * @param patch 待合并的补丁（可能来自旧版本备份文件，字段可能缺失/多余）
 */
export function deepMergeSettings(base: Settings, patch: unknown): Settings {
  const out: Record<string, unknown> = { ...(base as unknown as Record<string, unknown>) };
  if (isPlainObject(patch)) {
    for (const [key, value] of Object.entries(patch)) {
      const current = out[key];
      if (isPlainObject(value) && isPlainObject(current)) {
        out[key] = { ...current, ...value };
      } else if (value !== undefined && value !== null) {
        out[key] = value;
      }
    }
  }
  return out as unknown as Settings;
}

let cachedSettings: Settings = DEFAULT_SETTINGS;

/**
 * 把最新的设置写进模块级缓存（由 main.ts 在启动时和 store 变化时调用）。
 * @param next 最新设置
 */
export function setSettingsCache(next: Settings): void {
  cachedSettings = next;
}

/**
 * 取当前设置快照（同步）。
 * 说明：真实读取走 `dao/settings.ts`，这里只是它的一份缓存副本，
 * 供 core 层同步函数（如 computePriority）使用，避免 core → dao 的循环依赖。
 */
export function getSettings(): Settings {
  return cachedSettings;
}

/**
 * 读取单项设置（同步读缓存）。
 * @param k 设置键名
 */
export function getSetting<K extends keyof Settings>(k: K): Settings[K] {
  return cachedSettings[k];
}

/**
 * 把补丁合并到当前设置上，返回一份新对象（不改原对象）。
 * @param patch 设置补丁（支持 { cloud: { enabled: true } } 这类嵌套局部更新）
 */
export function mergeSettingsPatch(patch: DeepPartial<Settings>): Settings {
  return deepMergeSettings(cachedSettings, patch);
}
