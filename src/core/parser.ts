/**
 * 规则解析（AI 不可用时的兜底）。
 * 逐行处理，第一段是英文，其余段按义项分隔符切开。
 */
import { splitPackedSenses } from './model';

/** 一行解析出的词条 */
export interface ParsedEntry {
  en: string;
  senses: string[];
}

/** 解析失败的行 */
export interface ParseError {
  line: number;
  raw: string;
  reason: string;
}

/** 解析结果 */
export interface ParseResult {
  entries: ParsedEntry[];
  errors: ParseError[];
}

/** 行首序号，如 "1." "12、" "3)" */
const LEADING_INDEX_RE = /^\s*\d+\s*[.、)）:：]?\s*/;
/** 中文/全角字符（英文单词不允许出现） */
const CJK_RE = /[\u4e00-\u9fa5\u3000-\u303f\uff00-\uffef]/;

/**
 * 把用户填的「义项分隔符」字符串转成正则字符类。
 * @param senseSep 例如 '；;／/|'
 */
function senseSepToRegExp(senseSep: string): RegExp {
  const chars = senseSep.trim() === '' ? ['；', ';', '／', '/', '|'] : Array.from(senseSep.trim());
  const escaped = chars.map((c) => c.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')).join('');
  return new RegExp(`[${escaped}]+`);
}

/**
 * 探测字段分隔符。auto 时按优先级：Tab > 连续 2 个以上空格 > 逗号 > 单个空格。
 * @param line 一行文本
 * @param fieldSep 用户设置（'auto' 或具体分隔符）
 */
function detectFieldSep(line: string, fieldSep: string): string {
  const configured = fieldSep.trim();
  if (configured !== '' && configured !== 'auto') return configured;
  if (line.includes('\t')) return '\t';
  if (/ {2,}/.test(line)) return '  ';
  if (line.includes(',') || line.includes('，')) return ',';
  return ' ';
}

/**
 * 按分隔符切分一行，兼容连续分隔符（'  ' 视为一个分隔符）。
 * @param line 一行文本
 * @param sep 分隔符
 */
function splitFields(line: string, sep: string): string[] {
  if (sep === '  ') {
    return line.split(/ {2,}/).map((s) => s.trim());
  }
  if (sep === ',') {
    return line.split(/[,，]/).map((s) => s.trim());
  }
  return line.split(sep).map((s) => s.trim());
}

/**
 * 校验英文段是否可用。
 * 支持单词 / 短语（含空格，用 Tab 或 2 个以上空格与义项分隔）/ 缩写（含点）。
 * @param en 英文段
 */
function checkEn(en: string): string | null {
  if (!en) return '英文为空';
  if (en.length > 50) return '英文长度超过 50 个字符';
  if (CJK_RE.test(en)) return '英文含中文或全角字符';
  if (!/[a-zA-Z]/.test(en)) return '英文不含字母';
  return null;
}

/**
 * 规则解析整段文本。
 * @param text 原始文本（多行）
 * @param opts fieldSep: 'auto' 或具体分隔符；senseSep: 义项分隔符集合
 */
export function parseText(text: string, opts: { fieldSep: string; senseSep: string }): ParseResult {
  const entries: ParsedEntry[] = [];
  const errors: ParseError[] = [];
  const senseRe = senseSepToRegExp(opts.senseSep);
  const lines = text.split(/\r?\n/);

  lines.forEach((rawLine, index) => {
    const lineNo = index + 1;
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) return; // 空行与注释跳过

    const cleaned = line.replace(LEADING_INDEX_RE, '').trim();
    const sep = detectFieldSep(cleaned, opts.fieldSep);
    const fields = splitFields(cleaned, sep).filter((f) => f !== '');
    if (fields.length === 0) return;

    const en = fields[0] ?? '';
    const reason = checkEn(en);
    if (reason) {
      errors.push({ line: lineNo, raw: rawLine, reason });
      return;
    }

    const sensePart = fields.slice(1).join(' ');
    // 先按义项分隔符切，再把「量纲、维度」这类顿号打包的义项拆成多个（词性前缀复制到每一段）
    const senses = sensePart
      .split(senseRe)
      .map((s) => s.trim())
      .filter((s) => s !== '')
      .flatMap((s) => splitPackedSenses(s));
    if (senses.length === 0) {
      errors.push({ line: lineNo, raw: rawLine, reason: '没有解析到义项' });
      return;
    }
    entries.push({ en, senses });
  });

  return { entries, errors };
}
