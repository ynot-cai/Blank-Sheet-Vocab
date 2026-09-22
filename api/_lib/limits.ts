/**
 * API 的固定参数与上限。
 *
 * 这些数字直接对应 Vercel / libSQL 的硬限制，改之前请先读注释：
 * - Vercel 请求体上限 **4.5 MB** → 单批推送必须有上限，否则大词库首次同步会 413；
 * - SQLite 单条 SQL 的变量个数上限 999 → 生成的语句参数个数不能超；
 * - 一次拉太多会让前端一次解析上兆 JSON，卡主线程 → 拉取也要有上限。
 */

/** 单批推送的最大条数（硬约束：每批 ≤ 500 条） */
export const MAX_PUSH_BATCH = 500;

/** 单次拉取每一类记录的最大条数（超出请前端分次拉，见 sync-pull 注释） */
export const MAX_PULL_ROWS = 2000;

/** AI 代理的上游超时（毫秒）。对应 vercel.json 里 api/ai-proxy.ts 的 maxDuration: 120 */
export const AI_PROXY_TIMEOUT_MS = 60_000;

/**
 * ★ T4：TTS 代理的上游超时（毫秒）。
 *
 * 为什么比 AI 代理短得多：合成一个单词是**毫秒级**的动作，
 * 上游 15 秒还没回基本就是网络问题或额度问题，让用户干等 60 秒毫无意义；
 * 而且朗读是交互动作（点一下就期待出声），超时越短越早降级到浏览器语音。
 */
export const TTS_PROXY_TIMEOUT_MS = 15_000;

/** 单词条数上限提示（超过这个量级，前端列表页内存筛选会卡，属已知限制） */
export const WORDS_SOFT_LIMIT = 20_000;
