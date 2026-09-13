/**
 * 二期设置页 · 复习优先度（阶段 07 §1.2）。
 *
 * 三个预设 + 自定义表达式（复用一期的表达式机制思路，变量白名单在 `core/kcPriorityExpr`）
 * + 变量 chip（点一下插到光标处）+ 实时校验 + 「重算全部」。
 */
import { getSettings } from '../../../core/config';
import { KC_ALLOWED_VARS, KC_PRIORITY_PRESETS, activeKcExpr, validateKcExpr } from '../../../core/kcPriorityExpr';
import * as dao from '../../../dao';
import { button, h } from '../../dom';
import { toastError, toastOk } from '../../components/Toast';
import { patchKcSettings, recomputeAllCards, runSafely } from './kcSettingsCtx';

/** 预设的键名类型 */
type PresetKey = keyof typeof KC_PRIORITY_PRESETS;

/**
 * 渲染复习优先度设置区。
 * @param onChanged 设置变更后的回调
 */
export function renderPrioritySection(onChanged: () => void): HTMLElement {
  const box = h('section', { class: 'kc-set-section' });
  const kc = getSettings().kc;
  box.appendChild(h('h2', { class: 'kc-set-title', text: '综合复习优先度' }));

  // ── 三个属性说明（用户给的表格） ──
  const attrTable = h('table', { class: 'kc-table kc-set-table' });
  const head = h('tr', {});
  for (const t of ['#', '属性', '变量']) head.appendChild(h('th', { class: 'kc-th', text: t }));
  attrTable.appendChild(head);
  const rows: [string, string, string][] = [
    ['1', '距学习天数', 'daysSinceLearned'],
    ['2', '距上次复习天数', 'daysSinceReview'],
    ['3', '综合掌握程度', 'mastery'],
  ];
  for (const [n, name, v] of rows) {
    const tr = h('tr', {});
    tr.appendChild(h('td', { class: 'kc-td', text: n }));
    tr.appendChild(h('td', { class: 'kc-td', text: name }));
    tr.appendChild(h('td', { class: 'kc-td' }, h('code', { class: 'kc-code', text: v })));
    attrTable.appendChild(tr);
  }
  box.appendChild(attrTable);
  box.appendChild(
    h('p', {
      class: 'kc-set-note kc-set-note--dim',
      text: '另外还能用：reviewCount（复习次数）、selfScore / examScore（最近的自评与考核，没评过是 0）。',
    }),
  );

  // ── 预设 ──
  const presetRow = h('div', { class: 'kc-set-row' });
  presetRow.appendChild(h('span', { class: 'kc-field-label', text: '预设：' }));
  for (const [key, p] of Object.entries(KC_PRIORITY_PRESETS)) {
    const btn = button(`${p.name}`, () => {
      runSafely(`套用预设「${p.name}」`, async () => {
        // 选预设时清空自定义表达式（否则自定义会一直压着预设，用户会以为没生效）
        await patchKcSettings({ priority: { preset: key as PresetKey, customExpr: '' } });
        toastOk(`已套用「${p.name}」并重算全部卡片`);
        onChanged();
      });
    }, { variant: kc.priority.preset === key && kc.priority.customExpr === '' ? 'primary' : 'ghost', class: 'kc-set-btn' });
    btn.title = `${p.expr}\n${p.desc}`;
    presetRow.appendChild(btn);
  }
  box.appendChild(presetRow);
  box.appendChild(
    h('p', {
      class: 'kc-set-note kc-set-note--dim',
      text: Object.entries(KC_PRIORITY_PRESETS)
        .map(([, p]) => `${p.name}：${p.expr}`)
        .join('　|　'),
    }),
  );

  // ── 自定义表达式 ──
  const textarea = h('textarea', {
    class: 'input kc-set-expr',
    rows: '3',
    placeholder: '例如 daysSinceReview * 0.5 + (1 - mastery) * 10',
    value: kc.priority.customExpr,
  });
  box.appendChild(h('label', { class: 'kc-set-field' }, h('span', { class: 'kc-field-label', text: '自定义表达式（填了就压过预设）' }), textarea));

  // 变量 chip：点一下插到光标处
  const chips = h('div', { class: 'kc-chips kc-set-vars' });
  for (const v of KC_ALLOWED_VARS) {
    if (v === 'true' || v === 'false') continue; // 这两个不用展示，减少干扰
    chips.appendChild(
      button(v, () => {
        const start = textarea.selectionStart ?? textarea.value.length;
        const before = textarea.value.slice(0, start);
        const after = textarea.value.slice(start);
        textarea.value = `${before}${v}${after}`;
        textarea.focus();
        textarea.selectionStart = textarea.selectionEnd = start + v.length;
        check();
      }, { variant: 'ghost', class: 'kc-chip-add', title: '插入这个变量' }),
    );
  }
  box.appendChild(chips);

  // ── 实时校验 + 保存 ──
  const status = h('p', { class: 'kc-set-status' });
  /** 校验并更新提示 */
  function check(): boolean {
    const text = textarea.value.trim();
    if (text === '') {
      status.textContent = '留空则使用上面选中的预设。';
      status.className = 'kc-set-status kc-hint-dim';
      return true;
    }
    const res = validateKcExpr(text);
    status.textContent = res.ok ? '✓ 表达式合法' : `✗ ${res.message}`;
    status.className = res.ok ? 'kc-set-status kc-set-status--ok' : 'kc-set-status kc-set-status--bad';
    return res.ok;
  }
  textarea.addEventListener('input', check);
  check();
  box.appendChild(status);

  const actions = h('div', { class: 'kc-set-row' });
  actions.appendChild(
    button('保存表达式', () => {
      runSafely('保存优先度表达式', async () => {
        const text = textarea.value.trim();
        if (!check()) {
          toastError('表达式不合法，已拦下（请按提示修改）');
          return;
        }
        await patchKcSettings({ priority: { customExpr: text } });
        toastOk(text === '' ? '已清空自定义表达式（用预设）' : '已保存并重算全部卡片');
        onChanged();
      });
    }, { variant: 'primary', class: 'kc-set-btn' }),
  );
  actions.appendChild(
    button('重算全部', () => {
      runSafely('重算全部卡片', async () => {
        const n = await recomputeAllCards();
        toastOk(`已重算 ${n} 张卡片（优先度变化的才会写库）`);
        onChanged();
      });
    }, { variant: 'ghost', class: 'kc-set-btn' }),
  );
  box.appendChild(actions);

  // 当前生效的表达式（让用户随时看到「到底在用什么」）
  const active = activeKcExpr(kc.priority.preset, kc.priority.customExpr);
  box.appendChild(h('p', { class: 'kc-set-note', text: `当前生效：${active}` }));

  // 预览：按当前表达式给前 3 张卡算一遍
  const preview = h('div', { class: 'kc-set-calc' });
  box.appendChild(preview);
  runSafely('读取排序预览', async () => {
    const all = (await dao.kc.getAll()).slice(0, 3);
    if (all.length === 0) {
      preview.appendChild(h('p', { class: 'kc-hint-dim', text: '还没有卡片，先去「录入」加几张。' }));
      return;
    }
    const list = h('ul', { class: 'kc-set-preview' });
    for (const c of all) {
      list.appendChild(
        h('li', { text: `${c.title} → 优先度 ${c.attrs.reviewPriority}（掌握度 ${c.attrs.mastery.toFixed(2)}）` }),
      );
    }
    preview.replaceChildren(h('p', { class: 'kc-field-label', text: '当前排序预览（前 3 张）：' }), list);
  });

  return box;
}
