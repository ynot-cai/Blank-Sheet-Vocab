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
  parse: { fieldSep: 'auto', senseSep: '；;／/|', priorityDir: 'desc' },
  memorize: { position: 'centerTop', offsetY: 0.3 },
  priority: { preset: 'balanced' satisfies PriorityPreset, customExpr: '' },
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
