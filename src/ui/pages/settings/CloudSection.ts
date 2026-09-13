/**
 * 设置页 · 云同步分区（阶段 02）。
 *
 * 三件必须讲清楚的事（界面文案里都写了）：
 * 1. 同步码只存在这台设备的浏览器里，服务器只存它的 SHA-256 哈希；
 * 2. 换设备时填同一个同步码就能同步；忘记 / 清缓存会丢，请定期导出备份；
 * 3. 同步失败不影响任何本地功能（本地优先）。
 */
import { SYNC } from '../../../core/config';
import { isSyncCodeValid, relativeTime } from '../../../core/syncHelper';
import { button, checkbox, field, h, textInput } from '../../dom';
import { confirmModal, openModal } from '../../components/Modal';
import { toastError, toastOk, toastWarn } from '../../components/Toast';
import { cancelScheduled, syncNow } from '../../../dao/syncScheduler';
import * as cloudSync from '../../../dao/cloudSync';
import { currentSettings, patchSettings } from './ctx';

/** 刷新整页（同步完成后统计、状态都要重画） */
function refreshSection(host: HTMLElement): void {
  host.replaceChildren(renderCloudSection());
}

/**
 * 渲染云同步分区。
 */
export function renderCloudSection(): HTMLElement {
  const host = h('div', { class: 'cloud-section' });
  const settings = currentSettings();
  const cloud = settings.cloud;

  host.appendChild(
    h(
      'p',
      { class: 'note' },
      '本地优先：所有数据先存本机浏览器，断网也能照常背单词；开启云同步后会把数据悄悄同步到你自己部署的后端，多设备填同一个同步码即可共用一份数据。',
    ),
  );

  // ── 开关 ──
  host.appendChild(
    checkbox(cloud.enabled, '启用云同步', (on) => {
      void (async () => {
        if (on && !cloud.introShown) {
          showIntro(() => refreshSection(host));
          await patchSettings({ cloud: { enabled: true } });
          return;
        }
        await patchSettings({ cloud: { enabled: on } });
        if (!on) cancelScheduled();
        toastOk(on ? '已开启云同步（数据变动后会自动同步）' : '已关闭云同步，本地功能不受影响');
        refreshSection(host);
      })();
    }),
  );

  // ── 后端地址 ──
  host.appendChild(
    field(
      '后端地址',
      textInput(cloud.apiBase, (v) => {
        void patchSettings({ cloud: { apiBase: v } });
      }, { placeholder: 'https://blank-sheet-vocab.vercel.app' }),
      '填你的 Vercel 域名，不要带 /api（代码会自动拼）。本地开发可以填 http://localhost:3000',
    ),
  );

  // ── 同步码 ──
  const codeInput = textInput(
    cloud.syncCode,
    (v) => {
      void patchSettings({ cloud: { syncCode: v } });
      updateCodeHint(v);
    },
    { type: 'password', placeholder: '自己编一个，例如 my-word-2026' },
  );
  const codeHint = h('span', { class: 'field-hint' }, '');
  const updateCodeHint = (v: string): void => {
    codeHint.textContent =
      v.trim() === ''
        ? `至少 ${SYNC.minCodeLength} 位，且要同时包含字母和数字`
        : isSyncCodeValid(v, SYNC.minCodeLength)
          ? '格式没问题。所有设备填同一个码就能同步。'
          : `太简单了：至少 ${SYNC.minCodeLength} 位，并且要同时包含字母和数字`;
    codeHint.classList.toggle('field-hint-warn', v.trim() !== '' && !isSyncCodeValid(v, SYNC.minCodeLength));
  };
  updateCodeHint(cloud.syncCode);
  host.appendChild(h('label', { class: 'field' }, h('span', { class: 'field-label', text: '同步码' }), codeInput, codeHint));
  host.appendChild(
    h(
      'p',
      { class: 'note note-strong' },
      '同步码只保存在这台设备的浏览器里，我们的服务器只存它的哈希值，不知道你的明文同步码。换设备时在新设备填同一个同步码即可同步。清缓存或忘记同步码将无法恢复数据，请定期导出备份。',
    ),
  );

  // ── 自动同步开关 ──
  host.appendChild(
    checkbox(cloud.autoSync, '自动同步（数据变动后防抖几秒同步一次）', (on) => {
      void patchSettings({ cloud: { autoSync: on } }).then(() => {
        if (!on) cancelScheduled();
      });
    }),
  );

  // ── 状态行 ──
  const statusLine = h('p', { class: 'cloud-status', text: '状态读取中…' });
  host.appendChild(statusLine);
  void cloudSync.getStatus().then((status) => {
    const parts = [`上次同步：${relativeTime(status.lastSyncAt)}`];
    parts.push(status.pending > 0 ? `待同步 ${status.pending} 条` : '本地已是最新');
    if (status.lastError !== '') parts.push(`上次失败：${status.lastError}`);
    statusLine.textContent = parts.join(' · ');
    statusLine.classList.toggle('cloud-status-error', status.lastError !== '');
  });

  // ── 按钮 ──
  const actions = h('div', { class: 'row-actions' });
  actions.appendChild(
    button(
      '测试连接',
      () => {
        void (async () => {
          actions.querySelectorAll('button').forEach((b) => (b.disabled = true));
          const res = await cloudSync.testConnection(currentSettings().cloud.apiBase);
          actions.querySelectorAll('button').forEach((b) => (b.disabled = false));
          if (res.ok) toastOk(res.message);
          else toastError(res.message);
        })();
      },
      { variant: 'ghost' },
    ),
  );
  actions.appendChild(
    button(
      '立即同步',
      () => {
        void (async () => {
          const before = statusLine.textContent;
          statusLine.textContent = '正在同步…';
          const res = await syncNow();
          if (!res) {
            statusLine.textContent = before ?? '';
            toastWarn('同步没跑起来：先打开开关、填好后端地址和同步码');
            return;
          }
          if (res.error) {
            toastError(`同步失败：${res.error}`);
          } else {
            toastOk(`同步完成：拉取 ${res.pulled} 条 / 推送 ${res.pushed} 条`);
          }
          refreshSection(host);
        })();
      },
      { variant: 'primary' },
    ),
  );
  host.appendChild(actions);

  // ── 强制覆盖 ──
  host.appendChild(h('h4', { class: 'sub-title', text: '强制覆盖（危险）' }));
  host.appendChild(
    h('p', { class: 'note' }, '正常同步不会丢数据。只有在两边实在对不上、想彻底以某一端为准时才用下面两个按钮。'),
  );
  const dangerActions = h('div', { class: 'row-actions' });
  dangerActions.appendChild(
    button(
      '用本机数据覆盖云端',
      () => {
        void (async () => {
          const yes = await confirmModal(
            '用本机数据覆盖云端',
            '会把本机全部词条推到云端，云端同名 id 的记录会被本机版本覆盖。云端独有的词条不会被删除。确定继续？',
            '确定覆盖',
            true,
          );
          if (!yes) return;
          const res = await cloudSync.overwrite('local-to-cloud');
          if (res.error) toastError(`覆盖失败：${res.error}`);
          else toastOk(`已推送 ${res.pushed} 条到云端`);
          refreshSection(host);
        })();
      },
      { variant: 'ghost' },
    ),
  );
  dangerActions.appendChild(
    button(
      '用云端数据覆盖本机',
      () => {
        void (async () => {
          const yes = await confirmModal(
            '用云端数据覆盖本机',
            '会先清空本机的全部词条，再把云端数据全量拉回来。**本机还没同步上去的改动会丢失**，建议先「导出备份」。确定继续？',
            '确定覆盖',
            true,
          );
          if (!yes) return;
          const res = await cloudSync.overwrite('cloud-to-local');
          if (res.error) toastError(`覆盖失败：${res.error}`);
          else toastOk(`已从云端拉回 ${res.pulled} 条`);
          refreshSection(host);
        })();
      },
      { variant: 'ghost' },
    ),
  );
  host.appendChild(dangerActions);

  // ── 清空云端 ──
  host.appendChild(
    button(
      '清空云端数据',
      () => {
        void (async () => {
          const yes = await confirmModal(
            '清空云端数据',
            '会删除云端这个同步码下的全部词条与来源（本机数据不动）。此操作不可撤销。确定继续？',
            '确定清空',
            true,
          );
          if (!yes) return;
          const res = await cloudSync.clearCloud();
          if (!res.ok) toastError(`清空失败：${res.error ?? '未知原因'}`);
          else toastOk(`已清空云端 ${res.removed} 条`);
          refreshSection(host);
        })();
      },
      { variant: 'danger' },
    ),
  );

  return host;
}

/**
 * 首次开启时的说明框：讲清同步码、多设备、以及「先导出一份备份」。
 * @param onClose 关闭后的回调
 */
function showIntro(onClose: () => void): void {
  openModal({
    title: '第一次用云同步，先看三件事',
    width: '560px',
    body: [
      h('p', { class: 'modal-text' }, '1. 同步码是什么：你自己编的一串字符（例如 my-word-2026），它相当于你的私人空间门牌号。'),
      h('p', { class: 'modal-text' }, '2. 所有设备填同一个码：手机、平板、电脑都填这个码，就共用同一份数据。'),
      h('p', { class: 'modal-text' }, '3. 一定要先导出一次备份：同步码和词库都在浏览器里，清缓存会丢。设置 → F 区「导出备份」存一份到网盘。'),
      h(
        'p',
        { class: 'note' },
        '补充：服务器只保存同步码的哈希值（SHA-256），不知道你的明文同步码；你的 AI 密钥只存在本机，服务器全程不接触。',
      ),
    ],
    actions: [
      {
        text: '知道了，开始用',
        variant: 'primary',
        onClick: (close) => {
          void patchSettings({ cloud: { introShown: true } }).then(() => {
            close();
            onClose();
          });
        },
      },
    ],
  });
}
