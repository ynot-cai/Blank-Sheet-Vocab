/**
 * 预设词库清单。
 *
 * ★ 这个文件由 `npm run presets` 自动生成，**不要手改**。
 *   （手改会被下次生成覆盖；要改词表请改 `一期预设词库/` 下的原始文件再重新生成。）
 *
 * 各档的实际词条在 `public/presets/<id>.json`，前端用 `services/presetVocab.ts` 按需加载。
 *
 * 剔除规则是**递归**的——每一档都减掉所有更低档：
 *   初中 → 四级 → 六级 → 考研 → 雅思
 *   初中：原表 1987 → 剔除 0 → 保留 1987
 *   四级：原表 4543 → 剔除 1439 → 保留 3104
 *   六级：原表 3991 → 剔除 1931 → 保留 2060
 *   考研：原表 5047 → 剔除 4752 → 保留 295
 *   雅思：原表 3592 → 剔除 2688 → 保留 904
 *
 * ★ 请先看这组数字再改剔除规则：
 *   实测考研表 5047 词里有 4752 个（94.2%）本来就在初中/四级/六级表里，
 *   所以严格递归后考研档只剩 295 词。这是**有意为之**——换来的是「五个档位两两没有重复词」，
 *   把几档都导入也不会出现同一个词被两个来源争抢义项。
 *   如果哪天想改成「只减相邻下一档」（考研能到 2497 词，但会残留 2202 个初中词），
 *   改 `scripts/preset-lib.mjs` 的 TIERS[].excludes，然后重新跑 `npm run presets`。
 */

/** 一档预设词库 */
export interface PresetTier {
  /** 稳定 id，同时是 JSON 文件名（不含扩展名） */
  id: string;
  /** 按钮上显示的名字 */
  label: string;
  /** 入库时创建的来源名称 */
  sourceName: string;
  /** 来源优先级（数字越大越优先，与设置页方向一致） */
  priority: number;
  /** 词条数（生成时写入，用于按钮上显示「预计导入 N 词」） */
  count: number;
  /** 相对 `public/presets/` 的文件名 */
  file: string;
}

/** 全部档位，按从低到高排列 */
export const PRESET_TIERS: PresetTier[] = [
  {
    id: 'junior',
    label: '初中',
    sourceName: '初中词汇',
    priority: 1,
    count: 1987,
    file: 'junior.json',
  },
  {
    id: 'cet4',
    label: '四级',
    sourceName: '四级词汇',
    priority: 2,
    count: 3104,
    file: 'cet4.json',
  },
  {
    id: 'cet6',
    label: '六级',
    sourceName: '六级词汇',
    priority: 3,
    count: 2060,
    file: 'cet6.json',
  },
  {
    id: 'kaoyan',
    label: '考研',
    sourceName: '考研词汇',
    priority: 4,
    count: 295,
    file: 'kaoyan.json',
  },
  {
    id: 'ielts',
    label: '雅思',
    sourceName: '雅思词汇',
    priority: 5,
    count: 904,
    file: 'ielts.json',
  },
];

/**
 * 按 id 取档位。
 * @param id 档位 id
 */
export function findTier(id: string): PresetTier | null {
  return PRESET_TIERS.find((t) => t.id === id) ?? null;
}
