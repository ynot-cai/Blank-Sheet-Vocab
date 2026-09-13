/**
 * 二期设置页 · 掌握度公式（阶段 07 §1.1）。
 *
 * 显示当前公式 + 四个参数输入 + 三个预设 + 「试算」（拿最近 5 次记录算一遍）。
 *
 * ⚠️ 参数比提示词多了一个 `asymmetry`：那是**满足阶段 01 验收项 3** 必须的方向系数
 * （对称惩罚会让「盲目自信」的掌握度反而高于「低估自己」）。所以这里把它也暴露出来，
 * 并在说明里写清「=1 就退回对称公式」，否则用户改不回原始公式。
 */
import { KC, getSettings } from '../../../core/config';
import { calcMastery } from '../../../core/kcModel';
import type { MasteryConfig } from '../../../core/kcTypes';
import * as dao from '../../../dao';
import { button, h, numberInput } from '../../dom';
import { toastOk } from '../../components/Toast';
import { patchKcSettings, runSafely } from './kcSettingsCtx';

/** 三个预设（用户明确要求） */
const PRESETS: { key: string; label: string; cfg: MasteryConfig }[] = [
  { key: 'default', label: '默认', cfg: { w1: 0.6, w2: 0.4, penalty: 0.8, asymmetry: 2 } },
  { key: 'trustAi', label: '信任 AI 评分', cfg: { w1: 0.4, w2: 0.6, penalty: 0.8, asymmetry: 2 } },
  { key: 'noPenalty', label: '不看不一致', cfg: { w1: 0.6, w2: 0.4, penalty: 0, asymmetry: 2 } },
];

/**
 * 渲染掌握度公式设置区。
 * @param onChanged 设置变更后的回调（页面重画）
 */
export function renderMasterySection(onChanged: () => void): HTMLElement {
  const box = h('section', { class: 'kc-set-section' });
  const cfg = getSettings().kc.mastery;

  box.appendChild(h('h2', { class: 'kc-set-title', text: '综合掌握度公式' }));
  box.appendChild(
    h('pre', {
      class: 'kc-pre kc-set-formula',
      text: 'mastery = w1 × 自评 + w2 × 考核 − penalty × 方向系数 × |自评 − 考核|',
    }),
  );

  // ── 参数输入 ──
  const grid = h('div', { class: 'kc-set-grid' });
  const field = (label: string, key: keyof MasteryConfig, step: number): HTMLElement => {
    const input = numberInput(cfg[key], (v) => {
      runSafely(`修改 ${key}`, async () => {
        await patchKcSettings({ mastery: { [key]: v } });
        toastOk('已保存，掌握度已按新公式重算');
        onChanged();
      });
    }, { step, class: 'kc-set-num' });
    return h('label', { class: 'kc-set-field' }, h('span', { class: 'kc-field-label', text: label }), input);
  };
  grid.appendChild(field('w1 自评权重', 'w1', 0.05));
  grid.appendChild(field('w2 考核权重', 'w2', 0.05));
  grid.appendChild(field('penalty 不一致惩罚', 'penalty', 0.1));
  grid.appendChild(field('asymmetry 方向系数', 'asymmetry', 0.5));
  box.appendChild(grid);

  // ── 解释性说明（用户要求照抄的部分 + asymmetry 的补充说明） ──
  box.appendChild(
    h('p', {
      class: 'kc-set-note',
      text: '自评权重更高（默认 0.6），因为主观题（独立写句子）的 AI 评分不一定准。「不一致惩罚」用于捕捉盲目自信：自评「会了」但考核「不会」时，掌握度会被额外拉低，让这类知识点自动被提上来复习——这是最该优先复习的状态。',
    }),
  );
  box.appendChild(
    h('p', {
      class: 'kc-set-note kc-set-note--dim',
      text: '「方向系数」控制惩罚偏向哪一边：自评高于考核（盲目自信）时乘它、低于考核（低估自己）时除以它。默认 2 是最危险状态被拉到 0 的最小整数解；填 1 就退回对称公式（`penalty × |自评 − 考核|`），但那样「盲目自信」的掌握度会反而高于「低估自己」。',
    }),
  );

  // ── 预设按钮 ──
  const presetRow = h('div', { class: 'kc-set-row' });
  presetRow.appendChild(h('span', { class: 'kc-field-label', text: '预设：' }));
  for (const p of PRESETS) {
    presetRow.appendChild(
      button(p.label, () => {
        runSafely(`套用掌握度预设「${p.label}」`, async () => {
          await patchKcSettings({ mastery: { ...p.cfg } });
          toastOk(`已套用「${p.label}」`);
          onChanged();
        });
      }, { variant: 'ghost', class: 'kc-set-btn' }),
    );
  }
  box.appendChild(presetRow);

  // ── 试算：拿最近 5 条有分数的记录算一遍 ──
  const tableBox = h('div', { class: 'kc-set-calc' });
  box.appendChild(tableBox);
  const runCalc = async (): Promise<void> => {
    tableBox.replaceChildren(h('p', { class: 'kc-hint-dim', text: '正在算…' }));
    const cards = (await dao.kc.getAll()).filter((c) => c.attrs.lastSelfScore !== null || c.attrs.lastExamScore !== null);
    const recent = cards
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 5);
    if (recent.length === 0) {
      tableBox.replaceChildren(h('p', { class: 'kc-hint-dim', text: '还没有任何自评或考核记录，先去「学习」过几张卡。' }));
      return;
    }
    const current = getSettings().kc.mastery;
    const table = h('table', { class: 'kc-table kc-set-table' });
    const head = h('tr', {});
    for (const t of ['知识点', '自评', '考核', '算出的 mastery']) head.appendChild(h('th', { class: 'kc-th', text: t }));
    table.appendChild(head);
    for (const c of recent) {
      const tr = h('tr', {});
      tr.appendChild(h('td', { class: 'kc-td', text: c.title }));
      tr.appendChild(h('td', { class: 'kc-td', text: c.attrs.lastSelfScore === null ? '—' : String(c.attrs.lastSelfScore) }));
      tr.appendChild(h('td', { class: 'kc-td', text: c.attrs.lastExamScore === null ? '—' : String(c.attrs.lastExamScore) }));
      const value = calcMastery(c.attrs.lastSelfScore, c.attrs.lastExamScore, current);
      tr.appendChild(
        h('td', { class: 'kc-td' }, [
          h('strong', { text: value.toFixed(3) }),
          h('span', { class: 'kc-hint-dim', text: `　当前存的是 ${c.attrs.mastery.toFixed(3)}` }),
        ]),
      );
      table.appendChild(tr);
    }
    tableBox.replaceChildren(table);
  };
  box.appendChild(
    h('div', { class: 'kc-set-row' }, [
      button('试算（最近 5 条）', () => runSafely('掌握度试算', () => runCalc()), { variant: 'primary', class: 'kc-set-btn' }),
      h('span', { class: 'kc-hint-dim', text: `mastery 保留 ${KC.masteryDigits} 位小数，钳制到 [0,1]` }),
    ]),
  );
  return box;
}
