import * as dao from '../../../dao';
import { exportBackup, importBackup } from '../../../services/backup';
import * as localfile from '../../../services/localfile';
import { button, checkbox, h } from '../../dom';
import { confirmModal, promptModal } from '../../components/Modal';
import { toastError, toastOk, toastWarn } from '../../components/Toast';
import { navigate } from '../../router';
import { currentSettings, patchSettings } from './ctx';

/** 时间戳 → 本地时间字符串 */
function fmtTime(ts: number | null): string {
  if (ts === null) return '—';
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return '—';
  }
}

/**
 * F 区：数据（统计 / 导出 / 导入 / 清空 + 本地文件夹自动备份）。
 */
export function renderDataSection(): HTMLElement {
  const wrap = h('div', { class: 'stack' });
  const statsBox = h('div', { class: 'stats-line' });
  const folderBox = h('div', { class: 'stack' });

  /** 统计行 */
  const refreshStats = async (): Promise<void> => {
    const s = await dao.words.stats();
    statsBox.replaceChildren(
      h('span', { class: 'stat', text: `总词数 ${s.total}` }),
      h('span', { class: 'stat', text: `未背 ${s.unlearned}` }),
      h('span', { class: 'stat', text: `学习中 ${s.learning}` }),
      h('span', { class: 'stat', text: `已背 ${s.learned}` }),
      h('span', { class: 'stat', text: `已斩 ${s.chopped}` }),
    );
  };

  /** 本地文件夹区域 */
  const refreshFolder = (): void => {
    const parts: HTMLElement[] = [h('div', { class: 'divider' })];
    parts.push(h('h4', { class: 'sub-title', text: '本地文件夹自动备份' }));

    if (!localfile.isSupported()) {
      parts.push(
        h('p', { class: 'note warn' }, '当前浏览器不支持自动备份，请定期手动导出 json。'),
        h('p', { class: 'field-hint' }, '（本地文件夹自动备份需要 Chrome / Edge 这类较新的浏览器，且必须在 https 或 localhost 下打开）'),
      );
      folderBox.replaceChildren(...parts);
      return;
    }

    if (!localfile.isLinked()) {
      parts.push(
        h('p', { class: 'note' }, '选一个文件夹，之后每次改动会自动往里面写一个数据文件，清浏览器缓存也不怕。'),
        button(
          '连接本地文件夹（自动备份）',
          () => {
            void localfile
              .linkFolder()
              .then((ok) => {
                if (ok) toastOk('已连接，并已写入一份备份');
                refreshFolder();
              })
              .catch((err: unknown) => toastError(err instanceof Error ? err.message : String(err)));
          },
          { variant: 'primary' },
        ),
      );
      folderBox.replaceChildren(...parts);
      return;
    }

    parts.push(
      h('p', { class: 'note ok' }, `已连接文件夹：${localfile.getFolderName() ?? '（未命名）'}`),
      h('p', { class: 'field-hint', text: `上次同步：${fmtTime(localfile.getLastSyncAt())}` }),
    );

    if (localfile.needsPermission()) {
      parts.push(
        h('p', { class: 'note warn' }, '浏览器重启后需要重新授权才能读写这个文件夹。'),
        button(
          '点击恢复与本地文件夹的连接',
          () => {
            void localfile.requestPermission().then((ok) => {
              if (ok) {
                toastOk('已恢复连接');
                void localfile.syncNow().catch(() => undefined);
              } else toastWarn('未获得授权，可稍后再试');
              refreshFolder();
            });
          },
          { variant: 'primary' },
        ),
      );
    }

    parts.push(
      h(
        'div',
        { class: 'row' },
        button('立即备份一次', () => {
          void localfile
            .syncNow()
            .then(() => {
              toastOk('已写入 blank-sheet-vocab-data.json');
              refreshFolder();
            })
            .catch((err: unknown) => toastError(err instanceof Error ? err.message : String(err)));
        }),
        button('从文件恢复', () => {
          void (async () => {
            const ok = await confirmModal(
              '从文件恢复',
              '会用文件夹里的 blank-sheet-vocab-data.json 覆盖当前浏览器里的全部数据，确定吗？',
              '覆盖恢复',
              true,
            );
            if (!ok) return;
            try {
              await localfile.restoreFromFile();
              toastOk('已从文件恢复');
              await refreshStats();
              refreshFolder();
            } catch (err) {
              toastError(err instanceof Error ? err.message : String(err));
            }
          })();
        }),
        button(
          '断开连接',
          () => {
            void localfile.unlink().then(() => {
              toastOk('已断开（文件夹里的文件不会被删除）');
              refreshFolder();
            });
          },
          { variant: 'ghost' },
        ),
      ),
    );

    folderBox.replaceChildren(...parts);
  };

  // —— 统计 ——
  wrap.appendChild(h('h4', { class: 'sub-title', text: '当前数据' }));
  wrap.appendChild(statsBox);

  // —— 导出 / 导入 / 清空 ——
  const jsonPicker = h('input', { type: 'file', accept: '.json,application/json', class: 'hidden' });
  jsonPicker.addEventListener('change', () => {
    const file = jsonPicker.files?.[0];
    jsonPicker.value = '';
    if (!file) return;
    void (async () => {
      const mode = pendingMode;
      if (mode === 'replace') {
        const ok = await confirmModal(
          '导入备份（覆盖）',
          '这会先清空当前所有单词和来源，再写入备份里的内容。确定吗？',
          '覆盖导入',
          true,
        );
        if (!ok) return;
      }
      try {
        const res = await importBackup(file, mode);
        toastOk(`导入完成：${res.words} 个词、${res.sources} 个来源`);
        await refreshStats();
      } catch (err) {
        toastError(err instanceof Error ? err.message : String(err));
      }
    })();
  });

  let pendingMode: 'merge' | 'replace' = 'merge';
  const pickFile = (mode: 'merge' | 'replace'): void => {
    pendingMode = mode;
    jsonPicker.click();
  };

  wrap.appendChild(h('div', { class: 'divider' }));
  wrap.appendChild(h('h4', { class: 'sub-title', text: '导出 / 导入' }));
  wrap.appendChild(
    h(
      'div',
      { class: 'row' },
      button(
        '导出备份',
        () => {
          void exportBackup().then(() => toastOk('已导出 json 文件'));
        },
        { variant: 'primary' },
      ),
      button('导入备份（合并）', () => pickFile('merge')),
      button('导入备份（覆盖，需二次确认）', () => pickFile('replace'), { variant: 'danger' }),
      jsonPicker,
    ),
  );
  wrap.appendChild(
    h('p', { class: 'field-hint' }, '合并 = 按「英文 + 来源」判重，已存在的词跳过不动；覆盖 = 先清空再全量写入。'),
  );

  wrap.appendChild(
    h(
      'div',
      { class: 'row' },
      button(
        '清空所有数据',
        () => {
          void (async () => {
            const typed = await promptModal('清空所有数据', '这是不可撤销的操作。请输入「删除」两个字以确认：');
            if (typed === null) return;
            if (typed.trim() !== '删除') {
              toastWarn('输入不正确，已取消');
              return;
            }
            await dao.words.clearAll();
            await dao.sources.clearAll();
            toastOk('已清空');
            await refreshStats();
          })();
        },
        { variant: 'danger' },
      ),
    ),
  );

  // —— 数据说明入口（阶段 07）——
  wrap.appendChild(h('div', { class: 'divider' }));
  wrap.appendChild(h('h4', { class: 'sub-title', text: '数据说明' }));
  wrap.appendChild(
    h(
      'p',
      { class: 'note' },
      '想知道「数据到底存在哪、服务器存什么、怎么删」，看「关于数据」那一页（首页底部也有入口）。',
    ),
  );
  wrap.appendChild(
    h('div', { class: 'row' }, button('打开「关于数据」', () => navigate('/about'), { variant: 'ghost' })),
  );

  // —— 关闭页面前提醒导出 ——
  wrap.appendChild(h('div', { class: 'divider' }));
  wrap.appendChild(
    checkbox(
      currentSettings().backup.remindOnClose,
      '关闭页面前提醒我导出备份（距上次导出超过 7 天时提醒）',
      (v) => void patchSettings({ backup: { ...currentSettings().backup, remindOnClose: v } }),
    ),
  );
  wrap.appendChild(
    h('p', { class: 'field-hint', text: `上次手动导出：${fmtTime(currentSettings().backup.lastManualExportAt)}` }),
  );

  // —— 组装 + 订阅 ——
  wrap.appendChild(folderBox);
  refreshFolder();
  // 订阅本地文件夹状态变化；页面已经不在文档里就自动退订，避免泄漏
  const unsubscribe = localfile.subscribe(() => {
    if (!wrap.isConnected) {
      unsubscribe();
      return;
    }
    refreshFolder();
  });

  void refreshStats();
  return wrap;
}
