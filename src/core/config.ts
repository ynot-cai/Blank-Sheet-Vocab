import type { DeepPartial, LayoutColsOverride, LayoutSettings, LayoutTier, PriorityPreset, Settings } from './types';

/** 星号参数：所有可调数字集中在这里，代码里不许写死 */
export const DEFAULTS = {
  memorizeMaxPick: 10, // 一次「记忆」最多抽几个（只抽已出现在纸上的词；上一轮未通过的词作为额外项，可超过它）
  memorizeTargetCount: 1, // 每词至少记忆几次，「背完了」按钮才出现（默认 1 = 至少记一次）
  memorizeEvery: 3, // 每背几个新词，「再背一个」按钮自动变成「记忆」
  failCountCap: 2, // 属性② 未通过次数上限
  reviewGroupSize: 30, // 复习每组上限
  // ★ S3：这个系数只影响已退役的 `spacingBudget` 口径（见 core/layout.ts），
  //   真实布点的最小空隙现在由 settings.layout.<档位>.minGapPx 决定。
  //   保留默认值只为兼容老备份（设置页没有暴露它）。
  paperWordGapFactor: 2.4,
};

/**
 * 响应式布局参数（阶段 M2：手机端「一屏放几个词」）。
 *
 * ★ 为什么必须参数化（用户明确要求）：手机上一屏只显示 10~12 个词，
 *   而每一个「放不下」的判断都由这里的数字直接决定，硬编码在算法里就没法调。
 *
 * 派生量（都不写死，由参数算出来，见 core/layout.ts 的 computeGrid）：
 * - 格宽 = 平均词宽 × 1.15 + minGapPx（15% 余量留给比平均宽的词）
 * - 格高 = 行高 + minGapPx
 * - 底部按钮带高 = 直径 × 3 + max(labelFontPx, 10) + 12 + 安全区
 *
 * 手机档为什么是 fontSizePx 16 / minGapPx 8（全部由 390×844 实测算出，不是拍脑袋）：
 *   可用宽 = 390 − 2×8 = 374，2 列 → 格宽 187；
 *   平均词宽（字号 16 实测）≈ 57.2 + 点击热区左右 padding 8 = 65.2
 *     → 需要 65.2×1.15 + 8 = 83.0 ≤ 187 ✓（余量很大）
 *   最长的 14 字母词 photosunthesis 实测 119.3 + 8 = 127.3 < 187 ✓（塞得进格，不会互相压）
 *   按钮带高 = 50×3 + 12 + 12 = 174 → 可用高 844 − 8 − 174 = 662；
 *   一行词实高 = 文字行盒 28.8 + 上下热区 padding 16 = 44.8（★ 真机 DOM 实测值，
 *     不是「字号×1.45」算出来的 23.2 —— 那个估算让上下两行只差 3.4px，根本放不下 8 行）；
 *   格高 = 44.8 + 8 = 52.8 → 可放 12 行 → 容量 24 ≥ 目标 16 ✓
 *   实际落成「2 列 × 8 行 = 16 个」，词间最小空隙 = minGapPx = 8px。
 */
const DEFAULT_LAYOUT: Settings['layout'] = {
  mobile: {
    edgeMarginPx: 8,
    minGapPx: 8,
    fontSizePx: 16,
    targetCount: 16,
    button: { diameterPx: 50, gapPx: 16, labelFontPx: 12 },
  },
  tablet: {
    edgeMarginPx: 14,
    minGapPx: 16,
    fontSizePx: 22,
    targetCount: 24,
    button: { diameterPx: 56, gapPx: 18, labelFontPx: 13 },
  },
  desktop: {
    edgeMarginPx: 24,
    minGapPx: 20,
    fontSizePx: 24,
    targetCount: 40,
    button: { diameterPx: 44, gapPx: 12, labelFontPx: 12 },
  },
};

/**
 * ★ T1：布局参数的可调区间（**唯一一份**，设置页的控件范围与净化函数都读它）。
 *
 * 为什么必须集中：以前「输入框能填多少」只写在 `LayoutSection` 的 `min/max` 属性上，
 * 而**写库、读库、渲染**三条路都没有第二道校验 —— 输入框能绕过（手输、粘贴、
 * 老备份、手改 localStorage），一绕过就直接进布点算法。这里把它变成真正的护栏。
 *
 * 区间口径：以 `DEFAULT_LAYOUT` 各档的默认值为基准的宽容范围（默认值 ×0.2~×6），
 * 再夹到硬上下限。这样「用户正常想调的范围」全都放得下，而
 * `1e9` / `-1e9` / `NaN` / 字符串这类值一定被夹回可用值。
 */
export const LAYOUT_LIMITS = {
  edgeMarginPx: { min: 0, max: 120 },
  minGapPx: { min: 0, max: 80 },
  fontSizePx: { min: 8, max: 96 },
  targetCount: { min: 1, max: 200 },
  diameterPx: { min: 24, max: 160 },
  gapPx: { min: 0, max: 120 },
  labelFontPx: { min: 8, max: 32 },
} as const;

/** 布局参数里「可调数值字段」的键名 */
export type LayoutNumericKey = keyof typeof LAYOUT_LIMITS;

/** 一个数值区间 */
export interface NumRange {
  min: number;
  max: number;
}

/**
 * 把任意输入夹进区间（**唯一入口**，所有布局数字都必须过它）。
 *
 * 处理四种脏输入，全部有确定行为：
 * - 非数字类型（字符串 / null / undefined / 对象）→ 返回 `fallback`；
 * - `NaN` / `±Infinity` → 返回 `fallback`；
 * - 小于 `min` / 大于 `max` → 夹到边界；
 * - 正常数字 → 原样返回（**不做取整**，字号允许小数）。
 *
 * @param value 原始值（可能来自输入框、localStorage、老备份、URL 参数）
 * @param range 允许区间
 * @param fallback 非数字时用什么兜底（通常给默认值）
 */
export function clampNum(value: unknown, range: NumRange, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(range.max, Math.max(range.min, n));
}

/**
 * 取某个布局数值字段的区间。
 * @param key 字段名
 */
export function layoutRangeOf(key: LayoutNumericKey): NumRange {
  return LAYOUT_LIMITS[key];
}

/**
 * ★ T1：把「一份可能残缺/越界的档位参数」净化成**一定能安全渲染**的档位参数。
 *
 * 三道防线里的最后一道，也是最关键的一道：
 * 1. 写库前净化（设置页应用时）；
 * 2. 读库后净化（{@link getPresetParams} / {@link sanitizeLayoutSettings}）；
 * 3. 渲染前净化（设置页分组渲染时）。
 *
 * 为什么必须防「字段缺失」而不只是「数值越界」：T1 诊断实测的崩溃数据就是
 * `layout.mobile = { edgeMarginPx: 18 }` —— `button` 整个不见了。
 * 旧代码直接读 `.button.diameterPx` 当场抛错；净化后缺失字段一律补默认值，
 * 老版本/被剪过的数据也能正常打开设置页（**不再需要用户清数据**）。
 *
 * @param raw 原始档位参数（未知形状）
 * @param fallback 该档的默认值（`DEFAULT_SETTINGS.layout[tier]`）
 */
export function getPresetParams(raw: unknown, fallback: LayoutTier): LayoutTier {
  const src = isPlainObject(raw) ? raw : {};
  const srcButton = isPlainObject(src['button']) ? src['button'] : {};
  return {
    edgeMarginPx: clampNum(src['edgeMarginPx'], LAYOUT_LIMITS.edgeMarginPx, fallback.edgeMarginPx),
    minGapPx: clampNum(src['minGapPx'], LAYOUT_LIMITS.minGapPx, fallback.minGapPx),
    fontSizePx: clampNum(src['fontSizePx'], LAYOUT_LIMITS.fontSizePx, fallback.fontSizePx),
    targetCount: Math.round(clampNum(src['targetCount'], LAYOUT_LIMITS.targetCount, fallback.targetCount)),
    button: {
      diameterPx: clampNum(srcButton['diameterPx'], LAYOUT_LIMITS.diameterPx, fallback.button.diameterPx),
      gapPx: clampNum(srcButton['gapPx'], LAYOUT_LIMITS.gapPx, fallback.button.gapPx),
      labelFontPx: clampNum(srcButton['labelFontPx'], LAYOUT_LIMITS.labelFontPx, fallback.button.labelFontPx),
    },
  };
}

/**
 * 净化整份三档布局设置（手机 / 平板 / 桌面各过一遍 {@link getPresetParams}）。
 *
 * 用途：`dao.settings.get()` 读回设置之后调一次，保证**任何**进内存的形状都合法。
 * 这是「脏数据在源头被修好，而不是等某个页面崩了才发现」的那一层。
 * @param raw 设置里的 `layout` 字段（未知形状）
 */
export function sanitizeLayoutSettings(raw: unknown): LayoutSettings {
  const src = isPlainObject(raw) ? raw : {};
  return {
    mobile: getPresetParams(src['mobile'], DEFAULT_LAYOUT.mobile),
    tablet: getPresetParams(src['tablet'], DEFAULT_LAYOUT.tablet),
    desktop: getPresetParams(src['desktop'], DEFAULT_LAYOUT.desktop),
  };
}

/**
 * 三档布局的默认值副本（供设置页「恢复这一档的默认值」使用）。
 *
 * ★ 为什么返回副本而不是 `DEFAULT_LAYOUT` 本身：调用方拿到就直接塞进设置对象，
 *   共享引用的话「恢复默认」会**改到全局默认值**，之后再新建的用户就不是默认了。
 * @param tier 档位名
 */
export function defaultTierCopy(tier: keyof LayoutSettings): LayoutTier {
  const src = DEFAULT_LAYOUT[tier];
  return { ...src, button: { ...src.button } };
}

/**
 * 响应式（移动端适配）参数。
 * 断点：手机 < 768px / 平板 768~1024px / 桌面 > 1024px。
 */
export const DEVICE = {
  /** 手机断点（小于它算手机） */
  phoneMaxWidth: 767,
  /** 平板断点（小于等于它算平板） */
  tabletMaxWidth: 1024,
  /**
   * ★ S3：各设备形态的**列数硬下限**（防退化）。
   *
   * 为什么需要硬下限：M2 的网格推导是「够放 target 个就停」，宽屏行数多，
   * 于是 2 列就够放十几个词 —— 桌面因此退化成「像手机一样两列」。
   * 光把「够用就停」换成自然列数还不够：极端参数（超大字号、超长词）下
   * 自然列数仍可能算出 2，所以再加一道硬下限兜底。
   * 桌面 4 / 平板 4 / 手机 3，与验收口径一致（探针 `--min-columns`）。
   */
  minColsPhone: 3,
  minColsTablet: 4,
  minColsDesktop: 4,
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
 * ★ S3：手动列数覆盖的可选值（设置页下拉与背诵页快捷选择条共用这一份）。
 *
 * `'auto'` = 按屏幕宽度自然推导；具体数字 = **强制**用这个列数（自动推导与 minCols 让路）。
 * 为什么要有：自动算法再周全也可能在某个尺寸/某批词上不合适，
 * 用户自己选一个列数就能立刻用起来 —— 这是「算法兜底 + 人工兜底」的双保险。
 */
export const LAYOUT_COLS_OPTIONS = ['auto', 3, 4, 5, 6, 8, 10] as const;

/**
 * 手动列数覆盖的取值类型。
 *
 * ★ T1：改成从 `core/types.ts` 重新导出，**不再自己定义一份**。
 *   以前这里写 `(typeof LAYOUT_COLS_OPTIONS)[number]`、types.ts 里又手写了一遍
 *   `'auto' | 3 | 4 | 5 | 6 | 8 | 10` —— 两处同形不同源，谁加一个可选列数
 *   而忘了改另一处，就会出现「设置页能选、类型不认」的怪问题。
 *   `Settings['layoutColsOverride']` 是同一个类型的唯一真源。
 */
export type { LayoutColsOverride } from './types';

/**
 * 把设置里的 `layoutColsOverride` 解析成 `computeGrid` 要的 `colsOverride`。
 *
 * ★ 为什么要过一道校验：设置是从 localStorage/老备份读回来的，可能被手改成
 *   任意字符串（"abc" / 0 / 负数 / null）。脏值不许传进布局计算 ——
 *   非 `'auto'` 且不是合法数字时一律按「自动」处理（与 R4/稳健性口径一致）。
 * @param value 设置里的原始值
 * @returns 合法列数，或 null（= 自动）
 */
export function parseColsOverride(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const n = Math.floor(value);
  return n >= 2 && n <= 24 ? n : null;
}

/**
 * 判断一个值是否是**合法的列数覆盖取值**（`'auto'` 或选项表里的数字）。
 *
 * 用途：URL 参数 / 老设置 / 备份文件里的值都要先过这一关，
 * 才有资格写进 `settings.layoutColsOverride`（类型收窄，不用 `as` 硬转）。
 * @param v 待判断的值
 */
export function isColsOverrideValue(v: unknown): v is LayoutColsOverride {
  return v === 'auto' || (typeof v === 'number' && (LAYOUT_COLS_OPTIONS as readonly unknown[]).includes(v));
}

/**
 * 把任意输入解析成合法的列数覆盖取值（非法一律 `'auto'`）。
 * @param raw 原始输入（URL 参数 / 设置里的值）
 */
export function coerceColsOverride(raw: unknown): LayoutColsOverride {
  return isColsOverrideValue(raw) ? raw : 'auto';
}

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
  /** ★ M2：手机/平板/桌面三档布点参数（设置页「布局参数」与调试页都能改） */
  layout: DEFAULT_LAYOUT,
  /**
   * ★ S3：手动列数覆盖（'auto' = 按屏幕宽度自然推导）。
   * 自动布局在任何设备上失效时，用户都能在这里（或背诵页的 ⊞ 快捷按钮）指定列数。
   */
  layoutColsOverride: 'auto' satisfies LayoutColsOverride,
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
 *
 * ★ 递归深合并（T1 修）：**这个函数以前只合并一层**，于是嵌套补丁会把
 *   兄弟字段整片覆盖掉 —— 最典型的就是设置页改「手机档边距」时的
 *   `{ layout: { mobile: { edgeMarginPx: 18 } } }`：
 *   第一层合上 layout，第二层里那个 patch 对象整体替换掉了 `layout.mobile`，
 *   **`button` 子树当场消失** → 设置页再读
 *   `currentSettings().layout.mobile.button.diameterPx` 就抛
 *   `TypeError: Cannot read properties of undefined (reading 'diameterPx')`，
 *   页面白屏；而且这份残缺数据**已经落库**，重进设置页照样崩（T1 诊断实测）。
 *
 *   现在按「设置结构有几层就合几层」递归：只覆盖 patch 里真正给出的叶子，
 *   兄弟字段一律保留。数组仍然整体替换（合并数组没有合理语义）；
 *   `null` 仍然被忽略（保持「缺字段补默认值」的老口径，脏备份不会把字段置空）。
 *
 * @param base 底（通常是 DEFAULT_SETTINGS）
 * @param patch 待合并的补丁（可能来自旧版本备份文件，字段可能缺失/多余）
 * @param depth 递归深度（内部递归用；外部调用不用传）
 */
export function deepMergeSettings(base: Settings, patch: unknown, depth = 0): Settings {
  return mergeRecords(base as unknown as Record<string, unknown>, patch, depth) as unknown as Settings;
}

/**
 * 深合并的递归深度上限。
 * 设置树实际只有 3~4 层（`layout.mobile.button.diameterPx`），留到 8 足够，
 * 同时挡住「补丁里带循环引用」这种能让递归爆栈的脏输入。
 */
const MAX_MERGE_DEPTH = 8;

/**
 * 递归合并两个「普通对象」。
 *
 * 独立于 {@link deepMergeSettings} 是为了让 `Settings` 类型断言只出现在一处
 * （递归里不必反复断言）。
 * @param base 底对象
 * @param patch 补丁（不是普通对象时原样返回 base）
 * @param depth 当前深度
 */
function mergeRecords(base: Record<string, unknown>, patch: unknown, depth: number): Record<string, unknown> {
  if (!isPlainObject(patch)) return base;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || value === null) continue;
    const current = out[key];
    // 两边都是普通对象 → 继续往下合；数组不是普通对象，所以会走 else 整体替换
    if (isPlainObject(value) && isPlainObject(current) && depth < MAX_MERGE_DEPTH) {
      out[key] = mergeRecords(current, value, depth + 1);
    } else {
      out[key] = value;
    }
  }
  return out;
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
