/**
 * 语境词管理：AI 生成 / 手工编辑 / 确认生效（阶段 05）。
 *
 * 从首页里拆出来是因为它有「生成 → 编辑 → 确认」一整套流程 + 两个弹窗；
 * 首页只负责把 `renderKcContextBar` 摆上去并接回调。
 *
 * ★ 用户明确要求的机制（三条都在这里落实）：
 * 1. **AI 生成后要用户确认或修改才生效**（`confirmed` 标记）；
 * 2. 生成时检索近 30 天历史避免重复（`recentWords`）；
 * 3. 自然日更新（`localDate()`，过零点自动换新一组）。
 */
import { EXAM_TYPES, type DailyContextWords } from '../../core/kcTypes';
import * as dao from '../../dao';
import { aiConfigFromSettings } from '../../services/ai';
import { generateContextWords } from '../../services/kcExamAi';
import { openModal } from '../components/Modal';
import { toastError, toastOk, toastWarn } from '../components/Toast';
import { button, h } from '../dom';

/** 管理器的对外接口 */
export interface KcContextManager {
  /** 生成（调 AI 并落库，等用户确认） */
  generate: () => Promise<void>;
  /** 打开编辑弹窗（改词 + 确认） */
  edit: () => Promise<void>;
  /** 确认今天的词生效 */
  confirm: () => Promise<void>;
  /** 正在请求 AI */
  isLoading: () => boolean;
}

/**
 * 建一个语境词管理器。
 * @param onChanged 数据变化后通知界面重画
 */
export function createKcContextManager(onChanged: () => void): KcContextManager {
  let loading = false;

  /** 把一组词存成今天的记录（覆盖旧的当天记录） */
  const saveToday = async (words: string[], source: 'ai' | 'manual', confirmed: boolean): Promise<DailyContextWords> => {
    const today = dao.contextWords.localDate();
    // 同一天只留一条：先把当天已有的清掉（避免「一天多条」导致取哪条不确定）
    const existing = await dao.contextWords.getForDate(today);
    if (existing !== null) await dao.contextWords.removeById(existing.id);
    return dao.contextWords.save(words, source, today, confirmed);
  };

  return {
    isLoading: () => loading,

    async generate(): Promise<void> {
      if (loading) return;
      loading = true;
      onChanged();
      try {
        const settings = await dao.settings.get();
        const cfg = aiConfigFromSettings(settings);
        if (cfg.key.trim() === '' || cfg.endpoint.trim() === '') {
          toastError('还没配置 AI 接口（设置 → B 区）');
          return;
        }
        // 生成时检索近 N 天（默认 30 天）历史，避免重复
        const recent = await dao.contextWords.recentWords();
        const today = dao.contextWords.localDate();
        const res = await generateContextWords(recent, today, cfg);
        if (res.words.length === 0) {
          toastError(res.error ?? '生成失败');
          return;
        }
        // ★ 落库但 **confirmed=false**：等用户看一眼、改完再确认
        await saveToday(res.words, 'ai', false);
        toastOk(`生成了 ${res.words.length} 个语境词，确认后才会用于出题`);
        if (res.error !== undefined) toastWarn(res.error);
      } catch (err) {
        console.error('[contextWords] 生成失败', err);
        toastError('生成失败，可以重试或手工填');
      } finally {
        loading = false;
        onChanged();
      }
    },

    async edit(): Promise<void> {
      const today = await dao.contextWords.getForDate();
      const count = (await dao.settings.get()).kc.contextWordCount;
      const current = today?.words ?? [];
      /** 编辑中的词（不足 count 个就补空行，方便直接填） */
      const draft: string[] = [...current];
      while (draft.length < count) draft.push('');

      const box = h('div', { class: 'kc-ctx-edit' });
      const inputs: HTMLInputElement[] = [];
      for (let i = 0; i < count; i += 1) {
        const input = h('input', { class: 'input kc-ctx-input', type: 'text', value: draft[i] ?? '', placeholder: `第 ${i + 1} 个词` });
        inputs.push(input);
        box.appendChild(input);
      }
      box.appendChild(
        h('p', {
          class: 'kc-hint-dim',
          text: '这 5 个词要互不相关（防止出题时凑成一个主题）；留空的会被丢掉。',
        }),
      );

      openModal({
        title: '编辑今日语境词',
        width: '520px',
        body: box,
        actions: [
          { text: '取消', variant: 'ghost', onClick: (close) => close() },
          {
            text: '保存并确认',
            variant: 'primary',
            onClick: (close) => {
              void (async () => {
                const words = inputs.map((el) => el.value.trim()).filter((w) => w !== '');
                if (words.length === 0) {
                  toastWarn('至少要留一个词');
                  return;
                }
                await saveToday(words, 'manual', true);
                toastOk('已保存并确认，出题时会用这些词');
                close();
                onChanged();
              })();
            },
          },
        ],
      });
    },

    async confirm(): Promise<void> {
      const today = await dao.contextWords.getForDate();
      if (today === null) {
        toastWarn('还没有今天的语境词，先点「重新生成」');
        return;
      }
      await dao.contextWords.confirm(today.id);
      toastOk('已确认，出题时会从这几个词里挑一个');
      onChanged();
    },
  };
}

/**
 * 「添加题库」弹窗（首页与题库页共用）。
 *
 * 阶段 05 只做**存储**（用户明确要求）；批量粘贴的 AI 自动分类在阶段 07。
 * @param onAdded 添加完成后的回调
 */
export function openBankAddDialog(onAdded: () => void): void {
  const typeSelect = h('select', { class: 'input' });
  for (const t of EXAM_TYPE_OPTIONS()) typeSelect.appendChild(h('option', { value: t.value, text: t.label }));
  const content = h('textarea', { class: 'input kc-bank-content', rows: '6', placeholder: '粘贴题目原文（含答案）…' });
  const source = h('input', { class: 'input', type: 'text', placeholder: '来源标注，如「2023全国甲卷」' });

  openModal({
    title: '添加题库样题',
    width: '560px',
    body: [
      h('label', { class: 'field' }, h('span', { class: 'kc-field-label', text: '题型' }), typeSelect),
      h('label', { class: 'field' }, h('span', { class: 'kc-field-label', text: '题目内容（含答案）' }), content),
      h('label', { class: 'field' }, h('span', { class: 'kc-field-label', text: '来源' }), source),
      h('p', {
        class: 'kc-hint-dim',
        text: '题库只作为 AI 出题的风格参考，不会被原样出题。注意版权：仅供个人学习使用。',
      }),
    ],
    actions: [
      { text: '取消', variant: 'ghost', onClick: (close) => close() },
      {
        text: '添加',
        variant: 'primary',
        onClick: (close) => {
          void (async () => {
            const text = content.value.trim();
            if (text === '') {
              toastWarn('题目内容不能为空');
              return;
            }
            await dao.examBank.addBankQuestion(typeSelect.value, text, source.value.trim());
            toastOk('已加入题库');
            close();
            onAdded();
          })();
        },
      },
    ],
  });
}

/** 题型选项（从 `EXAM_TYPES` 生成，不写死四种） */
function EXAM_TYPE_OPTIONS(): { value: string; label: string }[] {
  return EXAM_TYPES.map((t) => ({ value: t.id, label: t.name }));
}

/** 让调用方能拿到按钮（首页与题库页复用同一个入口） */
export function bankAddButton(onAdded: () => void): HTMLButtonElement {
  return button('＋ 添加题库', () => openBankAddDialog(onAdded), { variant: 'ghost', class: 'kc-bank-add' });
}
