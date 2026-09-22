/**
 * ★ T4：朗读前的文本预处理。
 *
 * ── 为什么需要（这是「念得怪」的大头）──
 * 词库里存的英文常常带着**不该念出来的东西**：
 * 音标 `/əˈbændən/`、词性括号 `run (v.)`、中文释义，
 * 还有缩写 `don't`（合成器会念成「dont」或者干脆吞掉）、连字符 `well-known`、
 * 数字 `1999`（有的合成器按位念成「one nine nine nine」）。
 *
 * ── 实现取向：一张映射表 + 几个正则，不过度设计 ──
 * 这里**不做分词、不做词形还原、不查词典**：输入是单词或短语，
 * 目标是「别把不该念的念出来」，不是做自然语言处理。
 * 规则多了反而会出现「把正常单词改坏」的问题（例如把 `no` 展开成 `number`）。
 */

/**
 * 常见缩写 → 展开形式。
 *
 * ★ 为什么专门维护这一张表而不是用通用规则：
 *   `don't → do not` 这种展开**没有通用规律**（`won't → will not` 完全不是
 *   `will` + `not` 的拼接），必须逐个写。表里覆盖的是用户明确要求的 8 个
 *   + 几个几乎必然出现的（`I've` / `they're` / `didn't` 之类）。
 *   查表时统一按小写匹配，输出保持小写（合成器不区分大小写）。
 */
const CONTRACTIONS: Record<string, string> = {
  "don't": 'do not',
  "can't": 'can not',
  "won't": 'will not',
  "it's": 'it is',
  "i'm": 'i am',
  "you're": 'you are',
  "we'll": 'we will',
  "let's": 'let us',
  // 常见补充（同样是「没有通用规则」的那一类）
  "isn't": 'is not',
  "aren't": 'are not',
  "wasn't": 'was not',
  "weren't": 'were not',
  "doesn't": 'does not',
  "didn't": 'did not',
  "haven't": 'have not',
  "hasn't": 'has not',
  "hadn't": 'had not',
  "couldn't": 'could not',
  "shouldn't": 'should not',
  "wouldn't": 'would not',
  "that's": 'that is',
  "there's": 'there is',
  "he's": 'he is',
  "she's": 'she is',
  "they're": 'they are',
  "i've": 'i have',
  "i'll": 'i will',
  "you'll": 'you will',
  "they'll": 'they will',
  "i'd": 'i would',
  "we're": 'we are',
  "you've": 'you have',
  "we've": 'we have',
  "they've": 'they have',
};

/** 缩写匹配（词边界 + 不区分大小写；撇号同时接受 ' 与 ’ 两种写法） */
const CONTRACTION_RE = new RegExp(
  `\\b(${Object.keys(CONTRACTIONS)
    // 把 don't 里的 ' 换成 ['’] 才能同时匹配两种撇号
    .map((k) => k.replace(/'/g, "['\u2019]"))
    .join('|')})\\b`,
  'gi',
);

/** 0~19 的英文（数字转读法用） */
const ONES = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
  'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen',
  'seventeen', 'eighteen', 'nineteen',
];
/** 整十位 */
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

/**
 * 把 0~9999 的整数读成英文单词。
 * @param n 整数
 */
function numberToWords(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 20) return ONES[n] ?? '';
  if (n < 100) {
    const t = TENS[Math.floor(n / 10)] ?? '';
    const rest = n % 10;
    return rest === 0 ? t : `${t} ${ONES[rest]}`;
  }
  if (n < 1000) {
    const h = `${ONES[Math.floor(n / 100)]} hundred`;
    const rest = n % 100;
    return rest === 0 ? h : `${h} ${numberToWords(rest)}`;
  }
  if (n < 10_000) {
    const th = `${ONES[Math.floor(n / 1000)]} thousand`;
    const rest = n % 1000;
    return rest === 0 ? th : `${th} ${numberToWords(rest)}`;
  }
  return '';
}

/**
 * 朗读前的文本归一化（**纯函数**，可单测）。
 *
 * 规则（按顺序执行，每一步都有明确的理由）：
 * 1. 剥离音标：`/əˈbændən/`、`[ˈæpl]` 这两种括号包裹的音标整体删掉；
 * 2. 剥离括号内容：`run (v.)` → `run`（词性标注不该念出来）；
 * 3. 剥离中文：`isChineseLang` 为 false 时删掉所有中文/全角标点
 *    （英文模式下不念中文释义；为 true 时保留，交给中文语音）；
 * 4. 缩写展开：查 {@link CONTRACTIONS}；
 * 5. 连字符 → 空格：`well-known` → `well known`；
 * 6. 数字转英文：`1999` → `nineteen ninety nine`
 *    ★ 年份口径：1000~2099 的四位数按「前两位 + 后两位」读（这是英文年份的常规读法），
 *    其余按普通基数词读；
 * 7. 合并多余空白并 trim；8. 去掉首尾的孤立标点。
 *
 * @param raw 原始文本（可能来自词库字段，带音标/词性/中文）
 * @param isChineseLang 目标语言是否中文（true = 保留中文）
 */
export function normalizeForSpeech(raw: string, isChineseLang = false): string {
  let s = String(raw ?? '');

  // 1. 音标：/.../ 与 [...]（要求内部不含斜杠/方括号，避免误吃正常括号内容）
  s = s.replace(/\/[^/\s][^/]*?\//g, ' ');
  s = s.replace(/\[[^\]\s][^\]]*?\]/g, ' ');

  // 2. 括号内容（中英文括号都算）：run (v.) → run
  s = s.replace(/\([^)]*\)/g, ' ');
  s = s.replace(/（[^）]*）/g, ' ');

  // 3. 中文：英文模式下不念
  if (!isChineseLang) {
    s = s.replace(/[\u4e00-\u9fff\u3400-\u4dbf]/g, ' ');
    s = s.replace(/[\u3000-\u303f\uff00-\uffef]/g, ' ');
  }

  // 4. 缩写展开
  s = s.replace(CONTRACTION_RE, (m) => CONTRACTIONS[m.toLowerCase().replace(/\u2019/g, "'")] ?? m);

  // 5. 连字符 → 空格（well-known → well known）
  s = s.replace(/[-–—]+/g, ' ');

  // 6. 数字 → 英文读法（1980 → nineteen eighty；1999 → nineteen ninety nine）
  s = s.replace(/\d+/g, (digits) => {
    const n = Number(digits);
    if (!Number.isFinite(n) || digits.length > 6) return digits; // 过长（手机号/ID）原样留给合成器
    if (digits.length === 4 && n >= 1000 && n <= 2099) {
      const hi = Math.floor(n / 100);
      const lo = n % 100;
      const hiWords = numberToWords(hi);
      if (lo === 0) return `${hiWords} hundred`;
      const loWords = lo < 10 ? `oh ${ONES[lo]}` : numberToWords(lo);
      return `${hiWords} ${loWords}`;
    }
    const words = numberToWords(n);
    return words === '' ? digits : words;
  });

  // 7. 合并空白（含各种不可见空白）
  s = s.replace(/[\s\u00a0\u200b]+/g, ' ').trim();

  // 8. 去掉首尾孤立标点（中间的标点保留：合成器会用它们做停顿）
  s = s.replace(/^[,.;:!?'"]+/, '').replace(/[,.;:!?'"]+$/, '').trim();

  return s;
}
