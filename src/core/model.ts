import { normalizeAliases } from './senseRules';
import type { Attrs, RawSourceRecord, Sense, Word } from './types';
import { WORD_PRIORITY_DEFAULT, WORD_PRIORITY_MAX, WORD_PRIORITY_MIN } from './types';

/**
 * 生成唯一 id（优先用 crypto.randomUUID，环境不支持时降级）。
 */
export function uid(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 默认属性值（新建单词用） */
export function defaultAttrs(): Attrs {
  return {
    needSpell: false,
    failCount: 0,
    failCountTotal: 0,
    reviewCount: 0,
    lastReviewAt: null,
    learnedAt: null,
    reviewPriority: 0,
    // ★ T2：新词从 0 起算（不是 null）——「已记录、确实考过 0 次」，
    //   这样迁移不会把它当成老数据去回填。
    examCount: 0,
  };
}

/**
 * ★ T2：历史数据的「总考核次数」回填 —— **实现见 `core/dbSchema.ts` 的
 * {@link backfillExamCountRow}**，这里只做一次转发导出。
 *
 * 为什么不把实现写在这个文件里：`dbSchema.ts` 刻意保持「零运行时依赖」
 * （连自己的模块都不 import），而 model.ts 会拉进 senseRules 一串东西；
 * 迁移逻辑住在 dbSchema 里能让那条约定不被破坏，同时保证
 * 「真实升级」与「测试入口」调的是**同一份**代码。
 */
export { backfillExamCountRow as backfillExamCount } from './dbSchema';

/**
 * 新建一个义项。
 *
 * ★ aliases 会过一遍 `normalizeAliases`（见 core/senseRules.ts 的约束 1）：
 *   把「跑步，奔跑」这种打包项拆成两项。不拆的话判分时整串比对，
 *   用户答「跑步」或「奔跑」都会判错，而界面上完全看不出来。
 *   所有非 AI 的写入路径（合并页、卡片编辑、预设导入）都经过这里，所以在这一层兜住。
 *
 * @param text 代表词（可含词性前缀，如 "n. 苹果"）
 * @param aliases 近义词/等价说法（允许传打包项，会被拆开）
 */
export function createSense(text: string, aliases: string[] = []): Sense {
  return { id: uid(), text: text.trim(), aliases: normalizeAliases(aliases), enabled: true };
}

/**
 * 新建一个单词（属性全默认、状态 unlearned）。
 * @param en 英文单词
 * @param senses 义项列表
 * @param sourceId 来源 id
 * @param priority 词级优先级（默认 3；录入批次把它传给每个词）
 */
export function createWord(en: string, senses: Sense[], sourceId: string, priority: number = WORD_PRIORITY_DEFAULT): Word {
  const now = Date.now();
  return {
    id: uid(),
    en: normalizeEn(en),
    phonetic: '',
    example: '',
    senses,
    sourceId,
    rawSources: [],
    attrs: defaultAttrs(),
    status: 'unlearned',
    priority: normalizeWordPriority(priority),
    learnOrder: null,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * 归一化词级优先级：任何来源的值（老数据 undefined / 备份里的字符串 / 越界数字）
 * 都收敛成 1~5 的整数。
 *
 * ★ 为什么必须有这个函数而不是各处写 `w.priority ?? 3`：
 *   老数据的 `priority` 是 `undefined`，云同步拉回来的可能是字符串，
 *   而「抽词绝对优先」是拿它做第一关键字的——一旦混进 `undefined`，
 *   比较结果会是 `NaN`，排序直接错乱，表现成「优先级高的词没被优先抽到」，
 *   而界面上完全看不出问题。
 *
 * @param value 原始值
 */
export function normalizeWordPriority(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return WORD_PRIORITY_DEFAULT;
  const int = Math.round(n);
  if (int < WORD_PRIORITY_MIN) return WORD_PRIORITY_MIN;
  if (int > WORD_PRIORITY_MAX) return WORD_PRIORITY_MAX;
  return int;
}

/**
 * 读一个词的词级优先级（老数据缺字段时按默认值 3）。
 * 所有业务代码都该走这里，不要直接读 `word.priority`。
 * @param word 单词
 */
export function wordPriorityOf(word: { priority?: unknown }): number {
  return normalizeWordPriority(word.priority);
}

/**
 * 归一化英文条目（单词 / 短语 / 缩写），得到用于去重的 key：
 * trim + 去首尾标点 + 连续空白压成一个空格，保持原大小写。
 * 例：'  "give   up!" ' → 'give up'；'U.S.A.' → 'U.S.A'（首尾点会被去掉，去重仍稳定）。
 * @param en 原始英文
 */
export function normalizeEn(en: string): string {
  return en
    .trim()
    .replace(/^[\s"'“”‘’(\[（【<]+/, '')
    .replace(/[\s"'“”‘’)\]）】>.,;:!?]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 校验英文条目（单词 / 短语 / 缩写）是否合法。
 * 短语（含空格）与缩写（含点，如 U.S.A. / etc.）都是合法输入。
 * @param w 待校验的词
 * @returns 错误信息数组，空数组表示合法
 */
export function validateWord(w: Word): string[] {
  const errors: string[] = [];
  const en = w.en.trim();
  if (!en) errors.push('英文为空');
  if (en.length > 50) errors.push('英文过长（超过 50 个字符）');
  if (/[\u4e00-\u9fa5\u3000-\u303f\uff00-\uffef]/.test(en)) errors.push('英文含中文或全角字符');
  if (!/[a-zA-Z]/.test(en)) errors.push('英文不含字母');
  if (!w.senses.some((s) => s.enabled && s.text.trim())) errors.push('至少需要一个未划掉的义项');
  if (!w.sourceId) errors.push('缺少来源');
  return errors;
}

/**
 * 取未划掉的义项。
 * @param w 单词
 */
export function activeSenses(w: Word): Sense[] {
  return w.senses.filter((s) => s.enabled && s.text.trim() !== '');
}

/** 判分/搜索比较时要去掉的标点与空白 */
const NOISE_RE = /[\s.,，。；;、/\\|()（）[\]【】"'“”‘’!！?？:：\-—_]/g;

/**
 * 把文本归一化成可比较的形式：去空白、去常见标点、转小写。
 * @param s 原始文本
 */
export function normalizeForCompare(s: string): string {
  return s.toLowerCase().replace(NOISE_RE, '');
}

/** 词性记号（一个） */
const POS_TOKEN = '(?:n|v|vt|vi|adj|adv|prep|pron|conj|interj|num|art|aux|abbr|phr|phrase)';

/**
 * 词性前缀：支持多词性写法，如 "adj./adv. "、"n. "、"v./n. "。
 * 以前只匹配一个词性，导致 "adj./adv. 逆时针的" 被错误地剥成 "/adv.逆时针的"。
 */
const POS_PREFIX_RE = new RegExp(
  `^${POS_TOKEN}(?:\\s*\\.\\s*[/／]\\s*${POS_TOKEN})*\\s*\\.\\s*`,
  'i',
);

/**
 * 取词性前缀（多词性原样返回，如 "adj./adv."；没有则空串）。
 * @param text 义项文本
 */
export function posPrefixOf(text: string): string {
  const m = POS_PREFIX_RE.exec(text);
  if (!m) return '';
  return m[0].trim().replace(/\s+$/, '');
}

/**
 * 去掉义项文本开头的词性前缀，如 "adj./adv. 逆时针的" → "逆时针的"、"n. 苹果" → "苹果"。
 * @param text 义项文本
 */
export function stripPosPrefix(text: string): string {
  return text.replace(POS_PREFIX_RE, '').trim();
}

/**
 * 把一个「打包」的义项文本拆开：顿号/逗号连接的多个含义拆成多个义项，
 * 并把词性前缀复制到每一段上（"n. 量纲、维度" → ["n. 量纲", "n. 维度"]）。
 * 没有分隔符时原样返回单元素数组。
 * @param text 义项文本
 */
export function splitPackedSenses(text: string): string[] {
  const trimmed = text.trim();
  const prefix = posPrefixOf(trimmed);
  const rest = trimmed.slice(prefix.length).trim();
  const pieces = rest
    .split(/[、,，]/)
    .map((p) => p.trim())
    .filter((p) => p !== '');
  if (pieces.length <= 1) return [trimmed];
  return pieces.map((p) => `${prefix} ${p}`.trim());
}

/** 圈号序号：①~⑩，超过 10 用 (11) 兜底 */
const CIRCLED = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩'];

/**
 * 把生效义项拼成白纸上显示的简版中文意思。
 *
 * ★ 只显示每个义项的**代表词**（`s.text`），近义词（aliases）一律不显示。
 *   这是「资料整理规范」的第 2 条硬约束（见 core/senseRules.ts）：
 *   一个义项可能有七八个近义词，全铺在白纸上会糊成一片，
 *   所以挑代表词这件事是有实际后果的——代表词必须能独立看懂。
 *
 * 两种格式：
 *   · 统一形式 → `词性.①义项1②义项2`
 *     什么算「统一」：① 每个义项都带**同一个**词性前缀（"n. 苹果" / "n. 梨"）；
 *     或者 ② **都不带**前缀。后者是常见情况——按规范第 4 步，
 *     同源跨词性合并起来的义项（如 run 的「跑」把动词性、名词性合在一起）
 *     **本来就不该加词性前缀**。
 *   · 形式不统一（有的带前缀、有的不带，或前缀各不相同）→ 退化成 `义项；义项` 逐条罗列，
 *     因为这时候丢掉前缀会让用户分不清词性。
 *
 * @param senses 义项列表
 */
export function formatSensesBrief(senses: Sense[]): string {
  const active = senses.filter((s) => s.enabled && s.text.trim() !== '');
  if (active.length === 0) return '';
  const prefixOf = (s: Sense): string => posPrefixOf(s.text);
  const firstPrefix = prefixOf(active[0]);
  // 「统一」= 全部同一个非空前缀，或全部都没有前缀
  const uniform = active.every((s) => prefixOf(s) === firstPrefix);
  // 只有一个义项时不该出现圈号（"①跑" 是噪音，"跑" 就够了）
  if (uniform && active.length > 1) {
    const numbered = active
      .map((s, i) => `${CIRCLED[i] ?? `(${i + 1})`}${stripPosPrefix(s.text)}`)
      .join('');
    return `${firstPrefix} ${numbered}`.trim();
  }
  if (uniform && active.length === 1) return stripPosPrefix(active[0].text);
  return active.map((s) => s.text.trim()).join('；');
}

/**
 * 判分：输入与义项是否匹配。
 * 规则：忽略大小写、忽略所有空白和常见标点（.,，。；;、/ 等），
 * 命中 text（含去掉词性前缀后的形式）或任一 aliases 即算通过。
 * @param input 用户输入
 * @param sense 目标义项
 */
export function senseMatch(input: string, sense: Sense): boolean {
  const target = normalizeForCompare(input);
  if (!target) return false;
  const candidates = [sense.text, stripPosPrefix(sense.text), ...sense.aliases];
  return candidates.some((c) => {
    const n = normalizeForCompare(c);
    return n !== '' && n === target;
  });
}

/**
 * 判断整词是否答对（任一生效义项命中即算通过）。
 * @param input 用户输入
 * @param w 单词
 */
export function wordMatch(input: string, w: Word): boolean {
  return activeSenses(w).some((s) => senseMatch(input, s));
}

/**
 * 把时间戳转成人类可读的「多久以前」。
 * @param ts 时间戳（null 表示从未发生）
 * @param now 当前时间戳（默认取现在，便于测试）
 * @param emptyLabel 从未发生时的文案（复习列用「未复习」，背诵列用「未背」）
 */
export function humanizeDays(ts: number | null, now: number = Date.now(), emptyLabel = '未复习'): string {
  if (ts === null || !Number.isFinite(ts)) return emptyLabel;
  const diffMs = Math.max(0, now - ts);
  const days = Math.floor(diffMs / 86_400_000);
  if (days <= 0) return '今天';
  if (days < 90) return `${days} 天前`;
  const months = Math.max(1, Math.round(days / 30));
  return `${months} 个月前`;
}

/**
 * 把 rawSources 里某条来源的义项采纳为主义项（原主义项反向塞回 rawSources）。
 * @param w 单词
 * @param sourceId 要采纳的来源 id
 * @returns 新的单词对象（不改原对象）
 */
export function adoptRawSource(w: Word, sourceId: string): Word {
  const record = w.rawSources.find((r) => r.sourceId === sourceId);
  if (!record) return w;
  const nextRaw: RawSourceRecord[] = w.rawSources.filter((r) => r.sourceId !== sourceId);
  nextRaw.push({ sourceId: w.sourceId, senses: w.senses });
  return { ...w, senses: record.senses, sourceId, rawSources: nextRaw, updatedAt: Date.now() };
}
