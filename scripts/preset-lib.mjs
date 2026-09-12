/**
 * 预设词库的核心逻辑（纯函数，不碰文件系统）。
 *
 * 拆出来单独放，是为了能同时被两处用：
 *   1. scripts/build-presets.mjs —— 构建期生成 JSON；
 *   2. api/_dev/test-presets.mjs —— 自检时独立复算一遍，验证产物没错。
 *
 * 设计要点：**剔除规则是「递归」的**，不是「只减相邻下一档」。
 * 因为实测数据里 四级表有 72.4% 的词本来就在初中表里，
 * 若只减相邻档，考研表里会残留 1232 个初中词。详见 buildPresets 的注释。
 */

/** 一个等级的定义 */
export const TIERS = [
  { id: 'junior', label: '初中', file: '1 初中-乱序.txt', sourceName: '初中词汇', priority: 1, excludes: [] },
  { id: 'cet4', label: '四级', file: '3 四级-乱序.txt', sourceName: '四级词汇', priority: 2, excludes: ['junior'] },
  {
    id: 'cet6',
    label: '六级',
    file: '4 六级-乱序.txt',
    sourceName: '六级词汇',
    priority: 3,
    excludes: ['junior', 'cet4'],
  },
  {
    id: 'kaoyan',
    label: '考研',
    file: '5 考研-乱序.txt',
    sourceName: '考研词汇',
    priority: 4,
    excludes: ['junior', 'cet4', 'cet6'],
  },
  {
    id: 'ielts',
    label: '雅思',
    file: 'IELTS Word List.txt',
    sourceName: '雅思词汇',
    priority: 5,
    excludes: ['junior', 'cet4', 'cet6', 'kaoyan'],
  },
];

/**
 * 规范化英文条目，作为跨表判重的唯一键。
 *
 * ★ 这里必须与 `src/core/model.ts` 的 `normalizeEn` + 入库时的 `.toLowerCase()` **逐字对齐**：
 * 预设判定「这个词属于四级」和入库时判定「这个词已存在」用的必须是同一个键，
 * 否则会出现「剔重时算两个词、入库时算一个词」的错位。
 * 自检里有一条专门比对这两处口径。
 *
 * @param en 英文原文
 */
export function keyOf(en) {
  return displayEn(en).toLowerCase();
}

/**
 * 与 `normalizeEn` 保留大小写的那一份（写入 JSON 的 `en` 字段用它）。
 * @param en 英文原文
 */
export function displayEn(en) {
  return en
    .trim()
    .replace(/\*+$/, '')
    .replace(/^[\s"'“”‘’(\[（【<]+/, '')
    .replace(/[\s"'“”‘’)\]）】>.,;:!?]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 合法的英文条目：允许字母、重音字母、空格、连字符、撇号，以及结尾的点（缩写如 etc.） */
const EN_RE = /^[A-Za-z\u00C0-\u024F][A-Za-z\u00C0-\u024F'’.\- ]*$/;

/** 义项里可能出现的前缀序号，如 "1." "2、" */
const LEADING_INDEX_RE = /^\s*\d+\s*[.、)）]\s*/;
/** 雅思表里紧跟在英文后面的音标：/…/ 或 […] 或 {…} */
const PHONETIC_RE = /^([/[{])([^/\]}]*)([/\]}])/;

/**
 * 解析「Tab / 连续空格」两列格式的前四个词表。
 * @param raw 文件全文
 */
export function parseTabbed(raw) {
  const entries = [];
  const problems = [];
  const lines = raw.split(/\r?\n/);

  lines.forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (line === '') return;

    let fields = line
      .split('\t')
      .map((s) => s.trim())
      .filter((s) => s !== '');
    if (fields.length < 2) {
      fields = line
        .split(/ {2,}/)
        .map((s) => s.trim())
        .filter((s) => s !== '');
    }
    if (fields.length < 2) {
      problems.push({ line: index + 1, text: line, why: '切不出「英文 + 义项」两列' });
      return;
    }

    const enRaw = fields[0];
    const en = enRaw.replace(/\*+$/, '').trim();
    if (!EN_RE.test(en)) {
      problems.push({ line: index + 1, text: line, why: `英文段不合法：${JSON.stringify(enRaw)}` });
      return;
    }
    // 注意：这里**不拆义项**。拆分交给前端既有的 parser / AI，
    // 预设只负责「给出一行行原文」，保证走的是与手动粘贴完全相同的代码路径。
    entries.push({ en, definition: fields.slice(1).join(' ').trim() });
  });

  return { entries, problems };
}

/**
 * 解析雅思表：格式是 `单词[*]  音标  词性 释义`（音标可能没有）。
 *
 * 文件开头有 15 行中文说明（README），从正文才开始是词条。
 * 这里用「跳过第一个 `Word List NN` 之前的所有内容」来处理，
 * 而不是逐行猜测哪句是说明——猜法一旦漏一句就会把说明当成词条混进去。
 *
 * @param raw 文件全文
 */
export function parseIelts(raw) {
  const entries = [];
  const problems = [];
  const allLines = raw.split(/\r?\n/);
  // 正文起点：第一个章节标题
  const firstSection = allLines.findIndex((l) => /^\s*Word List\s*\d+/i.test(l));
  const lines = firstSection >= 0 ? allLines.slice(firstSection) : allLines;

  lines.forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (line === '') return;
    if (/^Word List\s*\d+/i.test(line)) return; // 章节标题

    // 英文与其余部分之间至少两个空格（表格对齐）；退而求其次用单个空白
    const m = /^(\S+?)\s{2,}(\S.*)$/.exec(line) ?? /^(\S+?)\s+(\S.*)$/.exec(line);
    if (!m) {
      problems.push({ line: index + 1, text: line, why: '切不出「英文 + 其余」' });
      return;
    }
    const enRaw = m[1];
    const en = enRaw.replace(/\*+$/, '').trim();
    if (!EN_RE.test(en)) {
      problems.push({ line: index + 1, text: line, why: `英文段不合法：${JSON.stringify(enRaw)}` });
      return;
    }

    // 跳过紧跟其后的音标段
    let rest = m[2].trim();
    const ph = PHONETIC_RE.exec(rest);
    const phonetic = ph ? ph[2].trim() : '';
    if (ph) rest = rest.slice(ph[0].length).trim();

    if (rest === '') {
      problems.push({ line: index + 1, text: line, why: '只有英文，没有义项' });
      return;
    }
    rest = rest.replace(LEADING_INDEX_RE, '').trim();
    entries.push({ en, definition: rest, phonetic });
  });

  return { entries, problems };
}

/**
 * 解析一个词表文件：按格式选解析器，再按规范化 key 去重（保留首次出现的写法与义项）。
 * @param file 文件名（用于判断格式）
 * @param raw 文件全文
 */
export function parseList(file, raw) {
  const isIelts = /ielts/i.test(file);
  const parsed = isIelts ? parseIelts(raw) : parseTabbed(raw);
  const byKey = new Map();
  let duplicates = 0;

  for (const entry of parsed.entries) {
    const key = keyOf(entry.en);
    if (key === '') continue;
    if (byKey.has(key)) {
      duplicates += 1;
      continue;
    }
    byKey.set(key, entry);
  }

  return { byKey, problems: parsed.problems, duplicates };
}

/**
 * 递归剔除：每一档减掉**所有更低档**的词。
 *
 * 为什么是递归而不是「只减相邻下一档」：
 * 链路是 初中 → 四级 → 六级 → 考研/雅思，中间没有「高中」档。
 * 四级表本身含有大量初中词（实测 1439 个），所以「考研 = 考研原表 − 四级原表」
 * 并不能真的去掉考研表里的初中词（实测会残留 2202 个）。
 * 只有减掉「更低档的**产物**」才能保证**任意两档没有重复词**——这是设计目标。
 *
 * 代价（已与用户确认接受）：考研档会从 5047 词缩到 295 词，
 * 因为考研表 94.2% 的词本来就在低档表里。要背完整考研词，
 * 用户需要自己把初中/四级/六级几档也导入。
 *
 * @param lists 各档解析结果：{ [tierId]: Map<key, entry> }
 */
export function buildPresets(lists) {
  const kept = {};
  const report = [];

  for (const tier of TIERS) {
    const own = lists[tier.id];
    if (!own) throw new Error(`缺少词表：${tier.id}`);

    /** 所有更低档的产物里已经出现过的词 */
    const excluded = new Set();
    for (const lowerId of tier.excludes) {
      const lower = kept[lowerId];
      if (!lower) throw new Error(`档位顺序错误：${tier.id} 依赖的 ${lowerId} 还没算出来`);
      for (const key of lower.keys()) excluded.add(key);
    }

    const result = new Map();
    for (const [key, entry] of own) {
      if (excluded.has(key)) continue;
      result.set(key, entry);
    }
    kept[tier.id] = result;

    // 统计「被每一档各吃掉多少」，用于生成报告核对剔除是否符合预期。
    // 注意分母是 own（本档原表），且各档是独立计数、允许重复（一个词可能同时属于好几档）。
    report.push({
      id: tier.id,
      label: tier.label,
      raw: own.size,
      removed: own.size - result.size,
      final: result.size,
      removedBy: tier.excludes.map((id) => ({
        id,
        label: TIERS.find((t) => t.id === id).label,
        count: [...own.keys()].filter((k) => kept[id].has(k)).length,
      })),
    });
  }

  return { kept, report };
}

/**
 * 把一档的条目转成落盘的紧凑结构。
 *
 * 为什么用数组而不是对象：几千条词用 `["apple",["n. 苹果"]]` 比
 * `{"en":"apple","senses":["n. 苹果"]}` 省掉约 40% 体积，直接体现在首屏下载量上。
 * 音标只有雅思表有（且只有部分），有值时才写第三项，避免给另外四档塞满 null。
 *
 * @param entries Map<key, entry>
 */
export function toRows(entries) {
  const rows = [];
  for (const entry of entries.values()) {
    const row = [displayEn(entry.en), [entry.definition]];
    if (entry.phonetic) row.push(entry.phonetic);
    rows.push(row);
  }
  return rows;
}
