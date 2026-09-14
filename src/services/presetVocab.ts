/**
 * 预设词库加载。
 *
 * 「预设词库」是内置的几套现成词表（初中 / 四级 / 六级 / 考研 / 雅思），
 * 用户点一下就能整档导入，不用自己去别处找词表、也不再需要 AI 解析。
 *
 * ★ 数据从 `public/presets/<id>.json` 按需 fetch，**不进 JS 包**：
 *   最大的一档 150 KB，五档合计 442 KB。打进包里会让首屏就背这么多字节，
 *   而大部分用户只会点其中一两档。产物由 `npm run presets` 生成，详见 scripts/build-presets.mjs。
 *
 * ★ 加载结果是 `ParsedWord`——与 AI 解析、规则解析**完全相同的中间格式**。
 *   这样预设导入往后走的还是合并确认页那条既有路径，
 *   没有「只在预设模式才跑」的分支，也就不会有只在某条路径上出现的 bug。
 */
import type { PresetTier } from '../core/presets';
import { normalizeEn } from '../core/model';
import type { ParsedWord } from './ai';

/**
 * 落盘的一行：[英文, 义项数组, 音标?]
 * 用数组不用对象是为了省约 40% 体积（几千条词时直接体现在下载量上）。
 * 音标只有雅思表有，所以是可选第三项。
 */
type PresetRow = [string, string[], string?];

/** JSON 文件结构 */
interface PresetFile {
  id: string;
  label: string;
  entries: PresetRow[];
}

/** 加载好的预设词库 */
export interface LoadedPreset {
  tier: PresetTier;
  words: ParsedWord[];
  /** 义项总数（给确认文案用） */
  senseCount: number;
}

/** 加载失败时抛这个，页面据此给出「检查网络」之类的提示 */
export class PresetLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PresetLoadError';
  }
}

/** 已加载过的档位缓存：同一档反复点不用重复下载 */
const cache = new Map<string, LoadedPreset>();

/**
 * 预设文件的基础路径。
 *
 * 用 `import.meta.env.BASE_URL` 而不是写死 `./`：
 * vite.config.ts 里 `base: './'`，构建产物可能被放在子路径下部署，
 * 写死相对路径在那种场景会 404。BASE_URL 由 Vite 按实际 base 注入。
 */
function presetUrl(file: string): string {
  const base = import.meta.env.BASE_URL || './';
  return `${base.endsWith('/') ? base : `${base}/`}presets/${file}`;
}

/**
 * 把一行落盘数据转成 ParsedWord。
 * @param row 落盘的一行
 */
function rowToWord(row: PresetRow): ParsedWord | null {
  const [rawEn, rawSenses, phonetic] = row;
  const en = normalizeEn(rawEn);
  if (en === '') return null;
  const senses = (rawSenses ?? [])
    .map((s) => s.trim())
    .filter((s) => s !== '')
    .map((s) => ({ text: s, aliases: [] as string[] }));
  if (senses.length === 0) return null;
  return { en, phonetic: (phonetic ?? '').trim(), example: '', senses };
}

/**
 * 加载一档预设词库（带内存缓存）。
 * @param tier 档位
 */
export async function loadPreset(tier: PresetTier): Promise<LoadedPreset> {
  const hit = cache.get(tier.id);
  if (hit) return hit;

  let res: Response;
  try {
    res = await fetch(presetUrl(tier.file));
  } catch (err) {
    throw new PresetLoadError(`预设词库「${tier.label}」下载失败，请检查网络后重试。（${String(err)}）`);
  }
  if (!res.ok) {
    throw new PresetLoadError(`预设词库「${tier.label}」下载失败（HTTP ${res.status}）。`);
  }

  let data: PresetFile;
  try {
    data = (await res.json()) as PresetFile;
  } catch {
    throw new PresetLoadError(`预设词库「${tier.label}」内容损坏，无法解析。`);
  }
  if (!data || !Array.isArray(data.entries)) {
    throw new PresetLoadError(`预设词库「${tier.label}」内容格式不对。`);
  }

  const words: ParsedWord[] = [];
  let senseCount = 0;
  for (const row of data.entries) {
    const word = rowToWord(row);
    if (!word) continue;
    senseCount += word.senses.length;
    words.push(word);
  }

  // 词条数与清单里记的对不上，说明产物和清单不同步。
  // 这时候不报错（用户还是能导入），但要说清楚，免得以为是丢词 bug。
  if (words.length !== tier.count) {
    console.warn(
      `[presets] ${tier.label} 实际加载 ${words.length} 词，清单里记的是 ${tier.count} 词。` +
        `跑 \`npm run presets\` 重新生成产物与清单。`,
    );
  }

  const loaded: LoadedPreset = { tier, words, senseCount };
  cache.set(tier.id, loaded);
  return loaded;
}

/**
 * 清掉缓存（导入完成后调，避免占着内存）。
 */
export function clearPresetCache(): void {
  cache.clear();
}

/**
 * 把一档预设词库转成**能粘进文本栏的纯文本**（一行一个词）。
 *
 * 格式与用户手打的一致：`英文 <Tab> 义项1<分隔符>义项2…`
 *   · 用 **Tab** 分隔英文与义项：解析器的 auto 探测里 Tab 优先级最高，
 *     不会因为英文短语里带空格（give up）而被切错；
 *   · 义项之间用**全角分号**（`；`）——它是项目默认的义项分隔符
 *     （`settings.parse.senseSep`），而且这个词表里本来就大量使用，不会引入新歧义。
 *
 * ★ 为什么不在这里就把义项整理好：预设 JSON 里的义项是原始词表直接生成的
 *   （一个词常常只有一条、塞着「v. 获取 n. 接近，入口」这种整串中文），
 *   哪几个算同一个义项、哪个当代表词、哪些是近义词——**这活是 AI 干的**
 *   （见《资料整理规范》core/senseRules.ts）。所以这里只负责「排版成文本」。
 *
 * @param words 预设词条
 * @param senseSep 义项分隔符（不传就用全角分号）
 */
export function presetToText(words: ParsedWord[], senseSep = '；'): string {
  const sep = senseSep.trim() === '' ? '；' : senseSep.trim()[0] ?? '；';
  return words
    .map((w) => {
      const senses = w.senses.map((s) => s.text.trim()).filter((s) => s !== '');
      return senses.length === 0 ? w.en : `${w.en}\t${senses.join(sep)}`;
    })
    .join('\n');
}
