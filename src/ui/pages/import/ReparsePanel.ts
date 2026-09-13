/**
 * R2 的「已有词库整理」分区（挂在录入页上）。
 *
 * 功能：选一个范围（某个来源 / 全部未整理过的词 / 全部词）→ 用 AI 按规范重整理义项
 *      → 差异预览 → 用户勾选 → 只写 senses / phonetic / example。
 *
 * ★ 铁律：这一路**不碰** priority / sourceId / rawSources / status / attrs / id / createdAt。
 *   落实在 `dao.words.applySenseRewriteMany()` 里（它只替换那三个字段）。
 */
import * as dao from '../../../dao';
import { wordPriorityOf } from '../../../core/model';
import type { Source, Word } from '../../../core/types';
import { aiConfigFromSettings } from '../../../services/ai';
import {
  REPARSE_BATCH_SIZE,
  clearReparseJob,
  loadReparseJob,
  reparseWords,
  sameReparseScope,
  saveReparseJob,
} from '../../../services/reparse';
import { button, h, select } from '../../dom';
import { confirmModal } from '../../components/Modal';
import { openReparseDiff } from '../../components/ReparseDiff';
import { toastError, toastOk, toastWarn } from '../../components/Toast';
import { currentSettings } from '../settings/ctx';

/** 下拉里的范围值 */
const SCOPE_ALL = '__all__';
const SCOPE_UNTOUCHED = '__untouched__';

/**
 * 判断一个词是否「已经整理过」。
 *
 * 判据：**至少有一个义项带近义词**，或者义项数 > 1，或者有音标/例句。
 * 反面（= 没整理过）就是预设词库直接导入的那种形态：
 * 只有 1 个义项、里面塞着一整串中文、没有近义词、没有音标例句。
 *
 * 这个判据不完美，但足够用来给出「全部未整理过的词」这个实用范围——
 * 用户真正的意图是「把预设词表那种没弄过的整理一遍」，而那种形态非常特征化。
 * @param w 单词
 */
function isTouched(w: Word): boolean {
  if (w.phonetic.trim() !== '' || w.example.trim() !== '') return true;
  if (w.senses.length > 1) return true;
  return w.senses.some((s) => s.aliases.length > 0);
}

/**
 * 渲染「已有词库整理」分区。
 *
 * @param opts.onDone 整理并写库完成后的回调（让录入页刷新其它区块）
 */
export function renderReparsePanel(opts: { onDone?: () => void } = {}): HTMLElement {
  const box = h('div', { class: 'card' });
  box.appendChild(h('h3', { class: 'card-title', text: '4. 已有词库整理' }));
  box.appendChild(
    h('p', {
      class: 'note',
      text:
        '用 AI 把**已经入库**的词按《资料整理规范》重新整理一遍：把平铺的中文意思分类成义项、' +
        '每个义项挑一个代表词、近义词逐个分开、缺音标/例句的补上。整理结果会先给你看差异，勾选后才写库。',
    }),
  );

  const scopeRow = h('div', { class: 'row' });
  const scopeSelect = select<string>([{ value: SCOPE_ALL, label: '加载中…' }], SCOPE_ALL, () => {
    void refreshHint();
  });
  const hint = h('p', { class: 'field-hint' });
  const progress = h('p', { class: 'reparse-progress' });
  const startBtn = button('用 AI 重新整理义项', () => {
    void run().catch((err: unknown) => {
      // 不吞异常：整理链路上的错必须看得见（否则表现成「点了没反应」）
      const message = err instanceof Error ? err.message : String(err);
      console.error('[reparse] 整理失败', err);
      toastError(`整理失败：${message}`);
    });
  }, { variant: 'primary' });

  scopeRow.appendChild(h('span', { class: 'field-label', text: '整理范围' }));
  scopeRow.appendChild(scopeSelect);
  box.appendChild(scopeRow);
  box.appendChild(hint);
  box.appendChild(h('div', { class: 'row' }, startBtn));
  box.appendChild(progress);

  /** 所有词（缓存一次，选范围与整理都基于它） */
  let allWords: Word[] = [];
  let sources: Source[] = [];
  let busy = false;

  /** 加载词库与来源，重建下拉选项 */
  const loadOptions = async (): Promise<void> => {
    [allWords, sources] = await Promise.all([dao.words.listAlive(), dao.sources.list()]);
    const untouched = allWords.filter((w) => !isTouched(w)).length;
    const options: { value: string; label: string }[] = [];
    for (const s of sources) {
      const count = allWords.filter((w) => w.sourceId === s.id).length;
      options.push({ value: s.id, label: `来源：${s.name}（${count} 词）` });
    }
    options.push({ value: SCOPE_UNTOUCHED, label: `全部未整理过的词（${untouched} 词）` });
    options.push({ value: SCOPE_ALL, label: `全部词（${allWords.length} 词，谨慎）` });

    // ★ 重建选项时**必须保住用户当前选的那个**。
    //   `replaceChildren` 之后 `<select>` 会自动落到第一个选项上——
    //   而这个函数在「点开始整理」时还会再被调用一次（刷新词数），
    //   于是用户选的「全部词」会在点下去的瞬间被悄悄换成第一项，
    //   接着 pickWords() 按错的范围取词：选了 500 个词却一个都没整理，**而且不报错**。
    const previousValue = scopeSelect.value;
    const last = loadReparseJob();
    const preferred = options.some((o) => o.value === previousValue)
      ? previousValue
      : options.some((o) => o.value === last?.scope)
        ? (last?.scope as string)
        : SCOPE_UNTOUCHED;

    scopeSelect.replaceChildren();
    for (const opt of options) {
      const o = h('option', { value: opt.value, text: opt.label });
      if (opt.value === preferred) o.selected = true;
      scopeSelect.appendChild(o);
    }
    scopeSelect.value = preferred;
    void refreshHint();
  };

  /** 按当前范围算出目标词 */
  const pickWords = (): Word[] => {
    const scope = scopeSelect.value;
    if (scope === SCOPE_ALL) return allWords;
    if (scope === SCOPE_UNTOUCHED) return allWords.filter((w) => !isTouched(w));
    return allWords.filter((w) => w.sourceId === scope);
  };

  /** 刷新数量提示 */
  const refreshHint = async (): Promise<void> => {
    const words = pickWords();
    const batches = Math.max(1, Math.ceil(words.length / REPARSE_BATCH_SIZE));
    hint.textContent =
      `本次会整理 ${words.length} 个词，分 ${batches} 批（每批 ${REPARSE_BATCH_SIZE} 个）送给你填的 AI 接口。` +
      '只改义项 / 音标 / 例句，**不动优先级、来源、状态和学习记录**。';
  };

  /** 跑一次整理 */
  const run = async (): Promise<void> => {
    if (busy) return;
    const cfg = aiConfigFromSettings(currentSettings());
    if (cfg.key.trim() === '') {
      toastWarn('整理需要 AI 密钥，请先去设置页填写接口地址和密钥');
      return;
    }
    await loadOptions();
    const words = pickWords();
    if (words.length === 0) {
      toastWarn('这个范围里没有词，换个范围试试');
      return;
    }

    // 断点续传：同一批词、并且上次有没跑完的进度 → 问用户要不要接着跑
    const previous = loadReparseJob();
    const scopeKey = scopeSelect.value;
    let skipIds = new Set<string>();
    if (previous && previous.scope === scopeKey && sameReparseScope(previous, words.map((w) => w.id))) {
      const doneCount = previous.processedIds.length;
      if (doneCount > 0 && doneCount < words.length) {
        const resume = await confirmModal(
          '发现上次没整理完',
          `上次整理到 ${doneCount}/${words.length} 个词（刷新页面会丢掉那次的中间结果，除非你继续）。要跳过已经整理过的部分接着跑吗？`,
          '接着跑',
        );
        if (resume) skipIds = new Set(previous.processedIds);
      }
    }

    const ok = await confirmModal(
      '用 AI 重新整理义项',
      `会把 ${words.length} 个词的【当前义项 + 音标 + 例句】分批发给 AI，让它按整理规范重新分类义项、挑代表词、分隔近义词、补音标例句。\n\n` +
        '整理完**不会直接写库**，会先给你看差异，你勾选后才应用。\n' +
        '铁律：只改义项 / 音标 / 例句，优先级、来源、状态、复习记录一律不动。\n\n确定开始吗？',
      '开始整理',
    );
    if (!ok) return;

    busy = true;
    startBtn.disabled = true;
    const total = words.length;
    progress.textContent = `正在整理：0/${total}`;
    try {
      const result = await reparseWords({
        words,
        cfg,
        skipIds,
        onProgress: (done, t) => {
          progress.textContent = `正在整理：${done}/${t}`;
        },
      });

      const processed = Array.from(new Set([...skipIds, ...result.processedIds]));
      saveReparseJob({
        scope: scopeKey,
        wordIds: words.map((w) => w.id),
        processedIds: processed,
        appliedIds: previous?.scope === scopeKey ? (previous.appliedIds ?? []) : [],
        savedAt: Date.now(),
      });

      const changed = result.diffs.filter((d) => d.changed);
      if (result.diffs.length === 0) {
        toastWarn(
          `没有拿到任何整理结果${result.failedBatches.length > 0 ? `（${result.failedBatches.length} 个批次失败）` : ''}`,
        );
        return;
      }
      if (changed.length === 0) {
        toastOk(`AI 返回了 ${result.diffs.length} 个词，但和现有数据一致，没有需要改的地方`);
        return;
      }

      const answer = await openReparseDiff(result.diffs, {
        failedBatches: result.failedBatches,
        missingCount: result.missingCount,
      });
      if (!answer.confirmed || answer.ids.length === 0) {
        toastWarn('已取消，词库没有任何改动（差异结果已保留在本次会话里）');
        return;
      }

      // ★ 只写 senses / phonetic / example（dao 层保证）
      const entries = answer.ids
        .map((id) => result.diffs.find((d) => d.wordId === id))
        .filter((d): d is NonNullable<typeof d> => d !== undefined)
        .map((d) => ({
          id: d.wordId,
          senses: d.after.senses,
          phonetic: d.after.phonetic,
          example: d.after.example,
        }));
      const written = await dao.words.applySenseRewriteMany(entries);

      // 记下已应用的词（下一轮可以跳过它们）
      const appliedIds = Array.from(new Set([...(previous?.appliedIds ?? []), ...answer.ids]));
      saveReparseJob({
        scope: scopeKey,
        wordIds: words.map((w) => w.id),
        processedIds: processed,
        appliedIds,
        savedAt: Date.now(),
      });

      toastOk(`已应用 ${written} 个词的义项整理（优先级 / 来源 / 学习记录未改动）`);
      opts.onDone?.();
      await loadOptions();
    } catch (err) {
      toastError(err instanceof Error ? err.message : String(err));
    } finally {
      busy = false;
      startBtn.disabled = false;
      progress.textContent = '';
    }
  };

  // 「清掉进度」入口：整理失败想从头来过时用
  box.appendChild(
    h(
      'div',
      { class: 'row' },
      button(
        '清空整理进度',
        () => {
          clearReparseJob();
          toastOk('已清空本次会话的整理进度');
        },
        { variant: 'ghost' },
      ),
    ),
  );

  void loadOptions();

  // 顺手把「已整理 / 未整理」的数量显示出来，让用户对范围有概念
  void (async () => {
    const words = await dao.words.listAlive();
    if (words.length === 0) return;
    const untouched = words.filter((w) => !isTouched(w)).length;
    const withPriority = words.filter((w) => wordPriorityOf(w) === 5).length;
    box.appendChild(
      h('p', {
        class: 'field-hint',
        text: `当前词库：${words.length} 词，其中 ${untouched} 个看起来还没整理过；优先级 P5 的有 ${withPriority} 个（整理不会改变它）。`,
      }),
    );
  })();

  return box;
}
