/**
 * 「已有词库整理」服务（R2 阶段新增）：用 AI 按《资料整理规范》重新整理已入库单词的义项。
 *
 * 和「录入」的区别（这是两件不同的事，别混）：
 *   · 录入（阶段 03）：**原文 → 词条**，产出的是新词，走合并确认页；
 *   · 这里（R2）：**已入库的词 → 更好的义项结构**，产出的是修改，走差异预览。
 *   所以这个模块**不解析原文**，只把现有数据重新组织一遍。
 *
 * ★★★ 铁律（提示词 2.5 节，写进代码和注释里，改代码的人一眼能看到）★★★
 *   只允许写：`senses` / `phonetic` / `example` / `updatedAt`
 *   绝不能碰：`priority`（R1 刚建好的优先级）/ `sourceId` / `rawSources`
 *             / `status`（未背/已背/已斩）/ `attrs`（拼写、未通过、复习次数、
 *               掌握度、复习优先度…）/ `id` / `createdAt`
 *   落实方式：写库一律走 `dao.words.applySenseRewriteMany()`——它只替换那三个字段。
 */
import { normalizeAliases, SENSE_RULES_FOR_AI } from '../core/senseRules';
import { splitPackedSenses } from '../core/model';
import type { Sense, Word } from '../core/types';
import { chatComplete, type AiConfig } from './ai';

/** 每批送多少个词给 AI */
export const REPARSE_BATCH_SIZE = 50;

/** 批与批之间的间隔（毫秒），避免撞上模型服务的速率限制 */
export const REPARSE_BATCH_DELAY_MS = 500;

/** 单批最多重试几次（首次 + 1 次重试） */
const MAX_ATTEMPTS_PER_BATCH = 2;

/** 整理后的义项结构（与 AI 输出 schema 一致） */
export interface ReparseSenses {
  senses: Sense[];
  phonetic?: string;
  example?: string;
}

/** 一个词的差异 */
export interface ReparseDiff {
  wordId: string;
  en: string;
  before: { senses: Sense[]; phonetic: string; example: string };
  after: { senses: Sense[]; phonetic: string; example: string };
  /** 实际有变化（结构比对，不是字符串比对） */
  changed: boolean;
  /** 变化了哪些方面（界面显示用，如 ['义项', '音标']） */
  fields: ('义项' | '音标' | '例句')[];
}

/** 一批的处理结果 */
export interface ReparseBatchOutcome {
  ok: boolean;
  error?: string;
}

/** 整理选项 */
export interface ReparseOptions {
  words: Word[];
  cfg: AiConfig;
  /** 进度回调（done = 已完成词数） */
  onProgress?: (done: number, total: number) => void;
  /** 已经处理过的 id（断点续传：跳过它们） */
  skipIds?: Set<string>;
  /** 中断信号 */
  signal?: AbortSignal;
}

/** 整理结果 */
export interface ReparseResult {
  diffs: ReparseDiff[];
  /** 失败的批次（批次序号从 1 开始 + 原因） */
  failedBatches: { index: number; error: string }[];
  /** AI 没有返回的词数（保留原样，不删除） */
  missingCount: number;
  /** 已成功处理过的词 id（用来存断点） */
  processedIds: string[];
}

/**
 * 整理用的 system prompt。
 *
 * ★ 规则正文直接复用 `SENSE_RULES_FOR_AI`（和录入时的 AI 解析是**同一份**），
 *   不在这里重写一遍：规则抄两份的话，改了那份忘了这份，AI 的行为就会自相矛盾。
 */
export const REPARSE_SYSTEM_PROMPT = `你是一个英语词库义项整理助手。用户会给你若干单词的**当前义项数据**。
请按下面的规范把它们重新整理一遍，只输出严格 JSON。

输出 schema（不要输出任何多余字段）：
{"words":[{"en":"abandon","phonetic":"/əˈbændən/","example":"He abandoned his car.","senses":[{"text":"放弃","aliases":["抛弃","遗弃"]}]}]}

整理规则：
1. 只输出 JSON，不要 markdown 代码块、不要任何解释文字。
2. 义项怎么分类、怎么挑代表、近义词怎么分隔、多词性怎么判断同源——**严格按下面这份规范执行**：

${SENSE_RULES_FOR_AI}

3. **只调整义项结构、音标、例句，不要新增单词、不要删除单词**。
   用户给你的每一个 en 都必须原样出现在结果里（同一个不许多、一个不许少），
   顺序与输入一致。已有的 en 拼写一个字都不要改。
4. 音标缺失（空字符串）就补一个国际音标，带斜杠；已有音标且看起来正确就保留原样。
5. 例句缺失（空字符串）就补一个地道、简短的例句；已有例句就保留原样。
6. 义项的代表词可以带词性前缀（n. v. adj. 等），但**判定为同源而合并起来的义项不要加前缀**
   （例如 run 的义项①写 "跑"，不要写 "v. 跑"）。
7. 近义词逐个分开写进 aliases，一个近义词只能是**一个纯中文说法**，
   不许打包（写成 "跑步，奔跑" 是错的）、不许夹英文、不许带解释。`;

/**
 * 把一批词打包成发给 AI 的 user message。
 *
 * 只发**整理需要的信息**（英文 / 音标 / 例句 / 义项），
 * 刻意不发 priority / status / attrs —— AI 看到那些字段就可能"顺手"改一改，
 * 而那些字段是铁律禁止改的。发过去的越少，它想动的就越少。
 *
 * @param words 这一批词
 */
function buildUserMessage(words: Word[]): string {
  const payload = words.map((w) => ({
    en: w.en,
    phonetic: w.phonetic,
    example: w.example,
    senses: w.senses.map((s) => ({ text: s.text, aliases: s.aliases })),
  }));
  return JSON.stringify({ words: payload });
}

/**
 * 去掉模型可能加的 markdown 代码块围栏。
 * @param text 模型返回的文本
 */
function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return fence && fence[1] ? fence[1].trim() : trimmed;
}

/**
 * 把 AI 返回的一条义项清洗成项目里的 Sense。
 *
 * 两处清洗都是**必须**的（和 `ai.ts` 的 coerceParsedWord 同一套理由）：
 *   1. `normalizeAliases`：模型经常把「跑步，奔跑」打包成一项，
 *      不拆开的话判分时整串比对，用户答哪个都判错，而界面上完全看不出来；
 *   2. `splitPackedSenses`：模型偶尔把「量纲、维度」塞进一个代表词，
 *      那说明它把多个含义打包了，强制拆成多个义项。
 *
 * @param raw 原始义项对象
 * @param fallbackId 生成 id 的兜底（用不上时忽略）
 */
function coerceSenses(raw: unknown): Sense[] {
  if (!Array.isArray(raw)) return [];
  const out: Sense[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const obj = item as Record<string, unknown>;
    const text = typeof obj.text === 'string' ? obj.text.trim() : '';
    if (text === '') continue;
    const aliases = normalizeAliases(
      Array.isArray(obj.aliases) ? obj.aliases.filter((a): a is string => typeof a === 'string') : [],
    );
    const pieces = splitPackedSenses(text);
    pieces.forEach((piece, i) => {
      out.push({
        id: newSenseId(),
        text: piece,
        aliases: i === 0 ? aliases : [],
        enabled: true,
      });
    });
  }
  return out;
}

/**
 * 生成一个义项 id。
 *
 * 说明：这里**刻意重新生成 id**而不是沿用旧义项的 id。
 * 因为 AI 重排义项后，第 1 个义项经常变成原来第 3 个的内容，
 * 沿用旧 id 会让「哪个 id 对应哪个意思」彻底错位。义项 id 只用于界面上的勾选/编辑，
 * 换一批无害；真正有语义的是 text / aliases。
 */
function newSenseId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 结构比对：两个义项列表是不是「一样」。
 *
 * 刻意不比较 id（见 newSenseId 的说明），只比 text / aliases / enabled。
 * @param a 义项列表 a
 * @param b 义项列表 b
 */
function sensesEqual(a: Sense[], b: Sense[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((sa, i) => {
    const sb = b[i];
    if (sb === undefined) return false;
    if (sa.text !== sb.text) return false;
    if (sa.enabled !== sb.enabled) return false;
    if (sa.aliases.length !== sb.aliases.length) return false;
    return sa.aliases.every((alias, j) => alias === sb.aliases[j]);
  });
}

/**
 * 解析一批词的 AI 返回。
 *
 * @param content 模型返回的文本
 * @param batch 这一批词（用来把结果对回原词，并检测「AI 漏词」）
 * @returns 每个词的新结构；AI 没返回的词不在 map 里（调用方保留原样）
 */
function parseBatchResponse(content: string, batch: Word[]): Map<string, ReparseSenses> {
  const jsonText = stripCodeFence(content);
  const data = JSON.parse(jsonText) as unknown;
  const wordsRaw = (data as { words?: unknown }).words;
  if (!Array.isArray(wordsRaw)) throw new Error('AI 返回缺少 words 字段');

  const byEn = new Map(batch.map((w) => [w.en.trim().toLowerCase(), w]));
  const out = new Map<string, ReparseSenses>();
  for (const item of wordsRaw) {
    if (typeof item !== 'object' || item === null) continue;
    const obj = item as Record<string, unknown>;
    const en = typeof obj.en === 'string' ? obj.en.trim().toLowerCase() : '';
    const origin = byEn.get(en);
    if (origin === undefined) continue; // AI 造出来的词，直接丢弃（铁律：不许新增）
    const senses = coerceSenses(obj.senses);
    if (senses.length === 0) continue; // 义项为空 = 无效结果，保留原样
    out.set(origin.id, {
      senses,
      phonetic: typeof obj.phonetic === 'string' ? obj.phonetic.trim() : undefined,
      example: typeof obj.example === 'string' ? obj.example.trim() : undefined,
    });
  }
  return out;
}

/**
 * 算出一个词的差异。
 *
 * @param word 原词
 * @param next AI 给的新结构
 */
function buildDiff(word: Word, next: ReparseSenses): ReparseDiff {
  // 「只补不覆盖」：AI 没给音标/例句（undefined 或空串）时保留原来的，
  // 免得它把用户手写的例句抹掉——那是最容易让人恼火的一类"整理"。
  const phonetic = next.phonetic !== undefined && next.phonetic !== '' ? next.phonetic : word.phonetic;
  const example = next.example !== undefined && next.example !== '' ? next.example : word.example;
  const senses = next.senses.length > 0 ? next.senses : word.senses;

  const fields: ('义项' | '音标' | '例句')[] = [];
  if (!sensesEqual(word.senses, senses)) fields.push('义项');
  if (phonetic !== word.phonetic) fields.push('音标');
  if (example !== word.example) fields.push('例句');

  return {
    wordId: word.id,
    en: word.en,
    before: { senses: word.senses, phonetic: word.phonetic, example: word.example },
    after: { senses, phonetic, example },
    changed: fields.length > 0,
    fields,
  };
}

/**
 * 等一会儿（批间间隔 / 重试前等待）。
 * @param ms 毫秒
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/**
 * 用 AI 重新整理一批词的义项（**只算差异，不写库**）。
 *
 * 健壮性设计（对应验收标准里的「单批失败时跳过并继续」）：
 *   · 分批 50，批间间隔 500ms，避免限流；
 *   · 单批失败重试 1 次，仍失败则记进 `failedBatches` 并**继续后面的批次**；
 *   · AI 漏掉的词保留原样（不删、不改）；
 *   · 中途取消（signal）时立即停止，已完成的部分照常返回。
 *
 * @param opts 词列表 / AI 配置 / 进度回调 / 断点
 */
export async function reparseWords(opts: ReparseOptions): Promise<ReparseResult> {
  const { words, cfg } = opts;
  const skip = opts.skipIds ?? new Set<string>();
  const pending = words.filter((w) => !skip.has(w.id));
  const diffs: ReparseDiff[] = [];
  const failedBatches: { index: number; error: string }[] = [];
  const processedIds: string[] = [];
  let missingCount = 0;
  let done = skip.size;

  opts.onProgress?.(done, words.length);

  for (let i = 0; i < pending.length; i += REPARSE_BATCH_SIZE) {
    if (opts.signal?.aborted) break;
    const batch = pending.slice(i, i + REPARSE_BATCH_SIZE);
    const batchIndex = Math.floor(i / REPARSE_BATCH_SIZE) + 1;

    let parsed: Map<string, ReparseSenses> | null = null;
    let lastError = '';
    for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_BATCH; attempt += 1) {
      try {
        const content = await chatComplete(
          cfg,
          [
            { role: 'system', content: REPARSE_SYSTEM_PROMPT },
            { role: 'user', content: buildUserMessage(batch) },
          ],
          { jsonMode: true },
        );
        parsed = parseBatchResponse(content, batch);
        break;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        if (attempt < MAX_ATTEMPTS_PER_BATCH) await delay(REPARSE_BATCH_DELAY_MS);
      }
    }

    if (parsed === null) {
      failedBatches.push({ index: batchIndex, error: lastError });
    } else {
      for (const word of batch) {
        const next = parsed.get(word.id);
        if (next === undefined) {
          // AI 漏了这个词：**保留原样**，不删除、不改动（验收标准 7 的要求）
          missingCount += 1;
          continue;
        }
        diffs.push(buildDiff(word, next));
        processedIds.push(word.id);
      }
    }

    done += batch.length;
    opts.onProgress?.(done, words.length);
    // 批间间隔：最后一个批次之后不用等
    if (i + REPARSE_BATCH_SIZE < pending.length && !opts.signal?.aborted) {
      await delay(REPARSE_BATCH_DELAY_MS);
    }
  }

  return { diffs, failedBatches, missingCount, processedIds };
}

// ══════════════════════════════════════════ 断点续传（sessionStorage）

/** 存档的键 */
const REPARSE_JOB_KEY = 'blank-sheet-vocab.reparseJob';

/** 一次整理任务的存档 */
export interface ReparseJobState {
  /** 这次整理选的范围（来源 id / __all__ / __untouched__），用来判断「还是不是同一次整理」 */
  scope: string;
  /** 这次整理针对哪些词（同一批词才算同一次任务） */
  wordIds: string[];
  /** 已经处理完（拿到 AI 结果）的词 id */
  processedIds: string[];
  /** 已经把差异应用到库里的词 id */
  appliedIds: string[];
  /** 存档时间 */
  savedAt: number;
}

/**
 * 存一份整理进度。
 * @param state 进度
 */
export function saveReparseJob(state: ReparseJobState): void {
  try {
    sessionStorage.setItem(REPARSE_JOB_KEY, JSON.stringify(state));
  } catch (err) {
    console.warn('[reparse] 进度存档失败（可能是词数太多）', err);
  }
}

/**
 * 读整理进度。
 */
export function loadReparseJob(): ReparseJobState | null {
  try {
    const raw = sessionStorage.getItem(REPARSE_JOB_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ReparseJobState;
    if (!parsed || !Array.isArray(parsed.wordIds)) return null;
    if (typeof parsed.scope !== 'string') parsed.scope = '';
    if (!Array.isArray(parsed.processedIds)) parsed.processedIds = [];
    if (!Array.isArray(parsed.appliedIds)) parsed.appliedIds = [];
    return parsed;
  } catch (err) {
    console.warn('[reparse] 读取进度存档失败', err);
    return null;
  }
}

/**
 * 清掉整理进度。
 */
export function clearReparseJob(): void {
  try {
    sessionStorage.removeItem(REPARSE_JOB_KEY);
  } catch (err) {
    console.warn('[reparse] 清理进度存档失败', err);
  }
}

/**
 * 判断一份存档是不是「针对同一批词」的（词集合完全一致才算）。
 *
 * 为什么要比对而不是直接复用：用户可能整理完四级词库后，又选六级词库点整理——
 * 那时候旧的进度必须作废，否则会把四级的进度当成六级的。
 *
 * @param state 存档
 * @param wordIds 这一次要整理的词 id
 */
export function sameReparseScope(state: ReparseJobState, wordIds: string[]): boolean {
  if (state.wordIds.length !== wordIds.length) return false;
  const a = new Set(state.wordIds);
  return wordIds.every((id) => a.has(id));
}
