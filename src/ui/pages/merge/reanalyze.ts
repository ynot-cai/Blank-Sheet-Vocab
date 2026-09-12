/**
 * 「AI 重新分析」：把已解析出来的草稿词交回给 AI，按《资料整理规范》重排义项。
 *
 * 为什么需要这个按钮——**预设词库导进来的词，义项是没有整理过的**：
 *   预设 JSON 是从原始词表直接生成的，每条只有 1 个义项、里面是一整串原文，例如
 *     access → ["v. 获取 n. 接近，入口"]
 *   既没有把「获取」和「接近/入口」拆成两个义项，也没有把「接近」和「入口」拆成近义词。
 *   有些原始词表本身还有残缺（例如 yield 的原文少一个右括号〕）。
 *
 *   ★ 刻意**不在构建期用规则去拆**：那是自然语言活儿——
 *     「n. 管理；〔某一时期的〕政府」该拆成 2 个义项，
 *     「v. 谈判，协商，交涉」该是 1 个义项 + 2 个近义词，
 *     规则分不清这两种逗号，硬拆只会把同义词拆成独立义项，越弄越乱。
 *     所以交给 AI 按规范整理，而且给用户一个**自己决定什么时候花这个钱**的按钮。
 *
 * 这个文件只做「把 AI 结果盖回草稿」这一步（纯函数，好测）；
 * 发请求、显示进度留在 MergePage 里。
 */
import { createSense, normalizeEn } from '../../../core/model';
import type { ParsedWord } from '../../../services/ai';
import type { DraftWord } from './drafts';

/** 一批最多送多少词给 AI */
export const REANALYZE_BATCH_SIZE = 25;

/**
 * 配对人用的 key。
 *
 * ★ 必须用 `normalizeEn`（项目自己的归一化），不能只 `trim().toLowerCase()`：
 *   AI 经常把 `etc.` 写成 `etc`、把多个空格压成一个、给缩写去掉尾点。
 *   只用小写比较的话这些词会被判成「AI 没返回」，于是**永远更新不到**，
 *   而且失败得很安静——用户只会觉得"有些词点了没反应"。
 *
 * @param en 英文条目
 */
function matchKey(en: string): string {
  return normalizeEn(en).toLowerCase();
}

/**
 * 把 AI 结果盖回草稿的统计。
 */
export interface ApplyResult {
  /** 真的被重排过的词数 */
  updated: number;
  /** AI 没返回、保持原样的词数 */
  skipped: number;
  /** 被 AI 返回了但义项为空的词（保持原样，计入 skipped） */
  empty: number;
}

/**
 * 把草稿词转成送给 AI 的「原文行」。
 *
 * 格式就是标准的「英文 + 原文义项」，和用户手粘贴文本时完全一样——
 * 这样 AI 侧走的还是同一条解析路径，不必为重新分析单独维护一套提示词。
 *
 * @param drafts 待分析的草稿（调用方负责分批）
 */
export function draftsToSourceLines(drafts: DraftWord[]): string {
  return drafts
    .map((d) => {
      const text = d.senses
        .filter((s) => s.enabled && s.text.trim() !== '')
        .map((s) => s.text.trim())
        .join(' ');
      // 没有义项的词也要出现在原文里，否则 AI 不会返回它，那一行就永久漏掉了
      return `${d.en}\t${text || '（无义项，请补一个）'}`;
    })
    .join('\n');
}

/**
 * 用 AI 的分析结果替换草稿的义项。
 *
 * 匹配规则：按 `en` 归一化（trim + 小写）配对。AI 可能改大小写或去掉末尾的句点，
 * 所以**配不上时就跳过并保持原样**，绝不新建草稿——
 * 新建的话合并页会突然多出用户没见过的词，那比不更新更糟。
 *
 * ★ 会**覆盖**用户在这个词上已经做过的编辑（改代表词、划掉义项、加近义词）。
 *   所以调用方必须在动手前先跟用户确认。这里不去试图合并两边的编辑——
 *   没有任何可靠办法判断「哪边是用户的意思」，猜错反而更糟。
 *
 * @param drafts 原草稿（不被修改）
 * @param results AI 返回的词条
 */
export function applyReanalysis(drafts: DraftWord[], results: ParsedWord[]): { drafts: DraftWord[]; stat: ApplyResult } {
  const byEn = new Map<string, ParsedWord>();
  for (const item of results) {
    const key = matchKey(item.en);
    if (key !== '' && !byEn.has(key)) byEn.set(key, item);
  }

  const stat: ApplyResult = { updated: 0, skipped: 0, empty: 0 };
  const next = drafts.map((draft) => {
    const hit = byEn.get(matchKey(draft.en));
    if (!hit) {
      stat.skipped += 1;
      return draft;
    }
    const senses = hit.senses
      .map((s) => s.text.trim())
      .filter((t) => t !== '');
    if (senses.length === 0) {
      stat.empty += 1;
      stat.skipped += 1;
      return draft;
    }
    stat.updated += 1;
    return {
      ...draft,
      phonetic: hit.phonetic.trim() || draft.phonetic,
      example: hit.example.trim() || draft.example,
      // createSense 会再过一遍 normalizeAliases，把 AI 偶尔打包的近义词拆开
      senses: hit.senses.map((s) => createSense(s.text, s.aliases)),
      // AI 重排后旧的合并建议已经对不上了，清掉免得出现指向不存在义项的建议
      hints: [],
    };
  });

  return { drafts: next, stat };
}
