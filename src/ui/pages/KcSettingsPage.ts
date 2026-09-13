/**
 * 二期设置页（`#/kc/settings`）—— 阶段 07 §1。
 *
 * 三个分区（各自一个文件，页面只负责组装）：
 * 1. **掌握度公式**（`KcMasterySection`）：w1 / w2 / penalty / asymmetry + 预设 + 试算；
 * 2. **复习优先度**（`KcPrioritySection`）：三预设 + 自定义表达式 + 重算；
 * 3. **二期参数**（本文件里的 `renderParamsSection`）：5 个数字参数 + 桥接设置。
 *
 * 底部还有「二期数据说明」（阶段 07 §3）与「清空二期数据」入口。
 */
import { getSettings } from '../../core/config';
import type { KcSettings } from '../../core/kcTypes';
import * as dao from '../../dao';
import { openModal } from '../components/Modal';
import { toastOk } from '../components/Toast';
import { button, h, numberInput } from '../dom';
import { registerCleanup } from '../router';
import { renderMasterySection } from './kcSettings/KcMasterySection';
import { renderPrioritySection } from './kcSettings/KcPrioritySection';
import { patchKcSettings, runSafely, type KcSettingsPatch } from './kcSettings/kcSettingsCtx';

/** 二期数字参数的定义（**加参数只加一行**） */
const PARAMS: { key: keyof KcSettings; label: string; hint: string; min: number; max: number; step: number }[] = [
  { key: 'contextWordCount', label: '每日语境词数量', hint: '每天生成几个词（默认 5，要互不相关）', min: 1, max: 10, step: 1 },
  { key: 'contextGenLookbackDays', label: '生成词时检索天数', hint: '生成新词时回看多少天避免重复（默认 30）', min: 1, max: 365, step: 1 },
  { key: 'examDedupeLookbackDays', label: '出题时检索天数', hint: '出题时回看多少天的历史题目避免重复（默认 3）', min: 1, max: 60, step: 1 },
  { key: 'examLoadDefaultMinutes', label: '默认出题耗时', hint: '没给建议时按几分钟出题（默认 4）', min: 1, max: 30, step: 1 },
  { key: 'examLoadMinMinutes', label: '出题耗时下限', hint: 'AI 给的耗时会被钳到这个下限（默认 3）', min: 1, max: 30, step: 1 },
  { key: 'examLoadMaxMinutes', label: '出题耗时上限', hint: 'AI 给的耗时会被钳到这个上限（默认 5）', min: 1, max: 60, step: 1 },
  { key: 'reviewWordLimit', label: '复习时背单词上限', hint: '复习流程里跳转到一期背单词的词数上限（默认 5）', min: 1, max: 20, step: 1 },
];

/**
 * 渲染二期设置页。
 */
export function renderKcSettingsPage(): HTMLElement {
  const page = h('div', { class: 'page kc-set-page' });
  /** 重画（改设置后） */
  const paint = (): void => {
    page.replaceChildren(...build());
  };
  /** 组装全部分区 */
  const build = (): HTMLElement[] => [
    h('header', { class: 'kc-set-head' }, [
      h('h1', { class: 'kc-set-h1', text: '二期设置' }),
      h('p', { class: 'kc-hint-dim', text: '掌握度公式、复习优先度、语境词与出题参数；改完立即对全部卡片生效（自动重算）。' }),
    ]),
    section('掌握度公式', () => renderMasterySection(paint)),
    section('复习优先度', () => renderPrioritySection(paint)),
    section('二期参数', () => renderParamsSection(paint)),
    section('二期数据', () => renderDataSection()),
  ];
  page.replaceChildren(...build());
  registerCleanup(page, () => undefined);
  return page;
}

/**
 * 安全地渲染一个分区：**某个分区炸了，也不能让整页变空白**。
 *
 * 为什么需要它（真实故障）：设置页有三个分区，任何一处抛异常（最典型的是
 * 手里拿着陈旧 IndexedDB 连接去开事务）都会让 `renderKcSettingsPage` 整体抛出，
 * 错误边界于是把**整页**替换成「页面渲染失败」——
 * 用户看到的是设置页完全打不开，而不是「其中一块坏了」。
 * 隔离之后，坏掉的那块自己显示错误原因，其余分区照常可用。
 *
 * @param name 分区名（显示在错误块上）
 * @param build 分区构造函数
 */
function section(name: string, build: () => HTMLElement): HTMLElement {
  try {
    return build();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[kcSettings] 分区「${name}」渲染失败`, err);
    return h('section', { class: 'kc-set-section kc-set-section--bad' }, [
      h('h2', { class: 'kc-set-title', text: name }),
      h('p', { class: 'kc-set-status kc-set-status--bad', text: `这一块渲染失败：${message}` }),
    ]);
  }
}

/**
 * 渲染「二期参数」区。
 * @param onChanged 变更回调
 */
function renderParamsSection(onChanged: () => void): HTMLElement {
  const box = h('section', { class: 'kc-set-section' });
  box.appendChild(h('h2', { class: 'kc-set-title', text: '二期参数' }));
  const kc = getSettings().kc;

  const grid = h('div', { class: 'kc-set-grid' });
  for (const p of PARAMS) {
    const current = kc[p.key];
    const value = typeof current === 'number' ? current : 0;
    const input = numberInput(value, (v) => {
      runSafely(`修改「${p.label}」`, async () => {
        const clamped = Math.min(p.max, Math.max(p.min, Math.round(v)));
        await patchKcSettings({ [p.key]: clamped } as KcSettingsPatch);
        toastOk(`已保存：${p.label} = ${clamped}`);
        onChanged();
      });
    }, { min: p.min, max: p.max, step: p.step, class: 'kc-set-num' });
    grid.appendChild(
      h('label', { class: 'kc-set-field' }, [
        h('span', { class: 'kc-field-label', text: p.label }),
        input,
        h('span', { class: 'kc-hint-dim', text: p.hint }),
      ]),
    );
  }
  box.appendChild(grid);

  box.appendChild(
    h('p', {
      class: 'kc-set-note kc-set-note--dim',
      text: '「复习时背单词上限」就是一二期唯一的桥接点：复习流程走到中间会跳去一期的背单词界面，背完再回来做题。词来自一期词库，优先未背过的新词；一期词库为空时自动跳过这一步。',
    }),
  );
  return box;
}

/**
 * 渲染「二期数据说明 + 清空」区（阶段 07 §3）。
 */
function renderDataSection(): HTMLElement {
  const box = h('section', { class: 'kc-set-section' });
  box.appendChild(h('h2', { class: 'kc-set-title', text: '二期数据说明' }));
  const ul = h('ul', { class: 'kc-set-list' });
  for (const line of [
    '知识卡片存在浏览器本地（IndexedDB）+ 云端同步（同一个 Turso 库，独立游标）。',
    'AI 密钥只存这台设备的浏览器里，服务器全程不接触（方案 B）。',
    '题目历史会记录（用于出题防重复），可以一键清空。',
    '学习/复习的进度（会话）**不上云** —— 它是「这台设备进行到哪儿了」，推到别的设备只会造成困惑。',
    '「斩」是软删除：留墓碑，能复活、能同步到别的设备；「永久删除」不可恢复。',
  ]) {
    ul.appendChild(h('li', { text: line }));
  }
  box.appendChild(ul);

  const row = h('div', { class: 'kc-set-row' });
  row.appendChild(
    button('清空题目历史', () => {
      openModal({
        title: '清空题目历史？',
        body: h('p', { class: 'modal-text', text: '只清「出过的题」记录（用于防重复与复盘），知识卡片不受影响。' }),
        actions: [
          { text: '取消', variant: 'ghost', onClick: (close) => close() },
          {
            text: '清空',
            variant: 'danger',
            onClick: (close) => {
              runSafely('清空题目历史', async () => {
                const all = await dao.examBank.listRecords();
                await dao.examBank.clearAll();
                toastOk(`已清空 ${all.length} 条题目历史`);
                close();
              });
            },
          },
        ],
      });
    }, { variant: 'ghost', class: 'kc-set-btn kc-bank-danger' }),
  );
  row.appendChild(
    button('清空全部知识点', () => {
      openModal({
        title: '清空全部知识点？',
        body: h('p', { class: 'modal-text', text: '会删掉所有知识卡片、语境词、题目历史与题库（本地立即生效，云端会在下次同步时跟上）。不可恢复。' }),
        actions: [
          { text: '取消', variant: 'ghost', onClick: (close) => close() },
          {
            text: '全部清空',
            variant: 'danger',
            onClick: (close) => {
              runSafely('清空全部知识点', async () => {
                await dao.kc.clearAll();
                toastOk('已清空二期数据');
                close();
              });
            },
          },
        ],
      });
    }, { variant: 'ghost', class: 'kc-set-btn kc-bank-danger' }),
  );
  box.appendChild(row);
  return box;
}
