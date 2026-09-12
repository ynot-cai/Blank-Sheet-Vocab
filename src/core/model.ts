import type { Attrs, RawSourceRecord, Sense, Word } from './types';

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
  };
}

/**
 * 新建一个义项。
 * @param text 义项文本（可含词性前缀）
 * @param aliases 近义词/等价写法
 */
export function createSense(text: string, aliases: string[] = []): Sense {
  return { id: uid(), text: text.trim(), aliases: aliases.map((a) => a.trim()).filter(Boolean), enabled: true };
}

/**
 * 新建一个单词（属性全默认、状态 unlearned）。
 * @param en 英文单词
 * @param senses 义项列表
 * @param sourceId 来源 id
 */
export function createWord(en: string, senses: Sense[], sourceId: string): Word {
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
    learnOrder: null,
    createdAt: now,
    updatedAt: now,
  };
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
 * 格式：`词性.①义项1②义项2`（只显示每个义项的「代表」，近义词 aliases 不显示；
 * 如果各义项词性不同，就退化成「词性. 义项；词性. 义项」逐条罗列）。
 * @param senses 义项列表
 */
export function formatSensesBrief(senses: Sense[]): string {
  const active = senses.filter((s) => s.enabled && s.text.trim() !== '');
  if (active.length === 0) return '';
  const prefixOf = (s: Sense): string => posPrefixOf(s.text);
  const firstPrefix = prefixOf(active[0]);
  const samePrefix = firstPrefix !== '' && active.every((s) => prefixOf(s) === firstPrefix);
  if (samePrefix) {
    const numbered = active
      .map((s, i) => `${CIRCLED[i] ?? `(${i + 1})`}${stripPosPrefix(s.text)}`)
      .join('');
    return `${firstPrefix} ${numbered}`.trim();
  }
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
