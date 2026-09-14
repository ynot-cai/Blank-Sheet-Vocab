/**
 * 卡片编辑页（`#/kc/edit?id=<cardId>`）。
 *
 * 路由用 **query 参数**而不是 `/kc/edit/:id`：一期路由是精确匹配的 Map，没有动态段
 * （`/learn`、`/review` 也都走 query）。这一点在《接口对齐清单》里说过。
 *
 * 保存策略：**改动防抖 1 秒自动保存**（阶段 03 提示词建议的做法）。
 * 理由：块编辑器会连续产生很多次改动，逐次写库既浪费又会让 `updatedAt` 乱跳；
 * 但只靠「点保存」也不安全（用户忘了点就丢）。折中就是防抖自动存 + 显式保存按钮（立即存）。
 */
import { getSettings, KC } from '../../core/config';
import { sanitizeText } from '../../core/kcModel';
import { EXAM_TYPES, type Block, type ExamLoad, type KcStatus, type KnowledgeCard } from '../../core/kcTypes';
import * as dao from '../../dao';
import { renderBlockEditor } from '../components/BlockEditor';
import { openModal } from '../components/Modal';
import { showUndoToast, toastError, toastOk } from '../components/Toast';
import { button, debounce, h, numberInput, textInput } from '../dom';
import { navigate, registerCleanup, type RouteContext } from '../router';

/** 自动保存的防抖时长（毫秒） */
const AUTOSAVE_DEBOUNCE_MS = 1000;

/**
 * 渲染卡片编辑页。
 * @param ctx 路由上下文（`?id=<cardId>`）
 */
export function renderKcCardEditPage(ctx: RouteContext): HTMLElement {
  const page = h('div', { class: 'page kc-edit-page' });
  const id = (ctx.query.get('id') ?? '').trim();

  /** 加载中的占位 */
  page.appendChild(h('p', { class: 'kc-hint-dim', text: '正在读取卡片…' }));

  void (async () => {
    const card = id === '' ? null : await dao.kc.getById(id);
    if (card === null) {
      page.replaceChildren(
        h('div', { class: 'kc-empty' }, [
          h('p', { class: 'kc-empty-title', text: '找不到这张卡片' }),
          h('p', { class: 'kc-hint-dim', text: id === '' ? '链接里缺少 id 参数。' : `id=${id}` }),
          button('回卡片列表', () => navigate('/kc/list'), { variant: 'primary' }),
        ]),
      );
      return;
    }
    page.replaceChildren(renderEditor(card));
  })();

  return page;
}

/**
 * 渲染编辑器主体（卡片已读出来）。
 * @param card 卡片
 */
function renderEditor(card: KnowledgeCard): HTMLElement {
  const box = h('div', { class: 'kc-edit-body' });
  /** 本地工作副本：所有改动先落这里，防抖后整体写库 */
  const draft = {
    title: card.title,
    summary: card.summary,
    examTags: [...card.examTags],
    estMinutes: card.examLoad.estMinutes,
    types: [...card.examLoad.types],
    blocks: card.blocks.map((b) => ({ ...b })),
    status: card.status as KcStatus,
  };
  let dirty = false;

  /** 真的写库 */
  const save = async (silent: boolean): Promise<void> => {
    if (!dirty) {
      if (!silent) toastOk('没有改动');
      return;
    }
    const title = sanitizeText(draft.title, KC.maxTitleLength).trim();
    if (title === '') {
      toastError('标题不能为空');
      return;
    }
    const examLoad: ExamLoad = {
      types: draft.types,
      estMinutes: Number(draft.estMinutes) || (getSettings().kc?.examLoadDefaultMinutes ?? 4),
    };
    const ok = await dao.kc.updateMeta(card.id, {
      title,
      summary: sanitizeText(draft.summary, KC.maxSummaryLength),
      examTags: draft.examTags,
      examLoad,
      status: draft.status,
    });
    const blocksOk = await dao.kc.updateBlocks(card.id, draft.blocks);
    dirty = false;
    if (!ok || !blocksOk) {
      toastError('保存失败：卡片可能已被删除');
      return;
    }
    if (!silent) toastOk('已保存');
  };

  const autoSave = debounce(() => void save(true), AUTOSAVE_DEBOUNCE_MS);
  /** 保存状态提示（每改一次就更新文案） */
  const statusEl = h('span', { class: 'kc-edit-status', text: `上次更新：${formatTime(card.updatedAt)}` });
  /** 标记有改动并安排自动保存 */
  const touch = (): void => {
    dirty = true;
    statusEl.textContent = '有未保存的改动…';
    autoSave();
  };

  // ── 顶部：标题 / 摘要 ──
  const titleInput = textInput(draft.title, (v) => {
    draft.title = v;
    touch();
  }, { placeholder: '知识点标题', class: 'kc-title-input' });
  const summaryInput = textInput(draft.summary, (v) => {
    draft.summary = v;
    touch();
  }, { placeholder: '一句话摘要（列表页会显示）', class: 'kc-summary-input' });

  box.appendChild(h('div', { class: 'kc-edit-head' }, titleInput, summaryInput));

  // ── 考法标签（多选，每个带 ×） ──
  const tagRow = h('div', { class: 'kc-chip-edit' });
  const paintTags = (): void => {
    tagRow.replaceChildren();
    for (const tag of draft.examTags) {
      const chip = h('span', { class: 'kc-chip kc-chip--editable' });
      chip.appendChild(h('span', { text: examName(tag) }));
      chip.appendChild(
        button('×', () => {
          draft.examTags = draft.examTags.filter((t) => t !== tag);
          paintTags();
          touch();
        }, { variant: 'ghost', class: 'kc-chip-x', title: '去掉这个考法' }),
      );
      tagRow.appendChild(chip);
    }
    for (const t of EXAM_TYPES) {
      if (draft.examTags.includes(t.id)) continue;
      tagRow.appendChild(
        button(`＋${t.name}`, () => {
          draft.examTags = [...draft.examTags, t.id];
          // 出题量跟着补上这个题型（两者本来就是一件事的两种表述）
          if (!draft.types.includes(t.id)) draft.types = [...draft.types, t.id];
          paintTags();
          paintLoad();
          touch();
        }, { variant: 'ghost', class: 'kc-chip-add' }),
      );
    }
  };

  // ── 出题量：题型组合 + 预计耗时 ──
  // 耗时区间从设置读（`examLoadMin/MaxMinutes`），不要在这里写死 3/5
  const loadCfg = getSettings().kc;
  const loadMin = loadCfg?.examLoadMinMinutes ?? 3;
  const loadMax = loadCfg?.examLoadMaxMinutes ?? 5;
  const loadBox = h('div', { class: 'kc-load-box' });
  const paintLoad = (): void => {
    loadBox.replaceChildren(
      h('span', { class: 'kc-field-label', text: '出题量：' }),
      h('span', { class: 'kc-hint-dim', text: draft.types.length > 0 ? draft.types.map(examName).join(' + ') : '（未指定题型）' }),
    );
    const minutes = numberInput(draft.estMinutes, (v) => {
      // 钳到设置里的区间：AI/用户都可能填出 12 分钟，出题量必须是 3~5
      draft.estMinutes = Math.min(loadMax, Math.max(loadMin, Math.round(v)));
      minutes.value = String(draft.estMinutes);
      touch();
    }, { min: loadMin, max: loadMax, step: 1, class: 'kc-minutes-input' });
    loadBox.appendChild(minutes);
    loadBox.appendChild(h('span', { class: 'kc-hint-dim', text: `分钟（${loadMin}~${loadMax}）` }));
  };

  const metaSection = h('div', { class: 'kc-edit-meta' });
  metaSection.appendChild(h('div', { class: 'kc-field' }, h('span', { class: 'kc-field-label', text: '考核标签（可多选）' }), tagRow));
  metaSection.appendChild(loadBox);
  box.appendChild(metaSection);
  paintTags();
  paintLoad();

  // ── 块编辑器 ──
  box.appendChild(h('h3', { class: 'kc-edit-subtitle', text: '卡片内容' }));
  const editorBox = h('div', { class: 'kc-edit-blocks' });
  /** 重画块编辑器（换块数/顺序时由它自己 repaint，这里只在外部需要时重建） */
  const paintEditor = (): void => {
    editorBox.replaceChildren(
      renderBlockEditor(draft.blocks, (next: Block[]) => {
        draft.blocks = next;
        touch();
      }),
    );
  };
  paintEditor();
  box.appendChild(editorBox);

  // ── 底部：状态 + 操作 ──
  const foot = h('div', { class: 'kc-edit-foot' });
  foot.appendChild(statusEl);
  foot.appendChild(button('保存', () => void save(false), { variant: 'primary' }));
  foot.appendChild(
    button('取消', () => {
      if (dirty && !window.confirm('有未保存的改动，确定放弃？')) return;
      autoSave.cancel();
      navigate('/kc/list');
    }, { variant: 'ghost' }),
  );
  foot.appendChild(
    button('斩', () => {
      void (async () => {
        // RULES-R3: 斩不弹确认，但必须提供 ≥8 秒的撤销 Toast。
        // 注意这里斩完就跳走了，撤销必须**不依赖本页状态**——
        // toast 挂在 document.body 上、撤销只调 DAO，所以跳页之后照样能撤销。
        const prev = { deleted: card.deleted ?? 0, status: card.status } as const;
        autoSave.cancel();
        await dao.kc.chop(card.id);
        showUndoToast(`已斩 ${card.title}`, async () => {
          await dao.kc.restoreChopState(card.id, { deleted: prev.deleted, status: prev.status });
        });
        navigate('/kc/list');
      })();
    }, { variant: 'danger' }),
  );
  foot.appendChild(
    button('删除卡片', () => {
      openModal({
        title: '永久删除这张卡片？',
        body: h('p', { class: 'modal-text', text: '删除是**永久**的（连墓碑一起清掉），无法在「已斩」里找回。普通场景请用「斩」。' }),
        actions: [
          { text: '取消', variant: 'ghost', onClick: (close) => close() },
          {
            text: '永久删除',
            variant: 'danger',
            onClick: (close) => {
              void (async () => {
                autoSave.cancel();
                await dao.kc.removePermanently(card.id);
                toastOk('已永久删除');
                close();
                navigate('/kc/list');
              })();
            },
          },
        ],
      });
    }, { variant: 'ghost' }),
  );
  box.appendChild(foot);

  // 离开页面前把未保存的改动落库（防抖还没到点就被切走的情况）
  const page = h('div', { class: 'kc-edit-wrap' }, box);
  registerCleanup(page, () => {
    autoSave.cancel();
    if (dirty) void save(true);
  });
  return page;
}

/** 题型 id → 中文名（未知 id 原样返回） */
function examName(id: string): string {
  return EXAM_TYPES.find((t) => t.id === id)?.name ?? id;
}

/**
 * 把时间戳格式化成「几分钟前 / 几小时前 / 日期」。
 * @param ts 时间戳
 */
function formatTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return new Date(ts).toLocaleDateString();
}
