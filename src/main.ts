import './styles/global.css';
import './styles/paper.css';
import { DEFAULT_SETTINGS, setSettingsCache } from './core/config';
import { openDB } from './core/db';
import * as dao from './dao';
import { onDataChanged, appStore } from './state/store';
import * as localfile from './services/localfile';
import { emitDataChanged } from './state/store';
import { renderApp, setBackupSettingsSnapshot } from './App';
import { mountErrorBoundary } from './ui/components/ErrorBoundary';
import { showToast, toastError } from './ui/components/Toast';

/**
 * 启动顺序：装错误边界 → 初始化本地文件夹连接 → 打开 DB → 载入设置 → 挂载 App。
 */
async function boot(): Promise<void> {
  const root = document.getElementById('app');
  if (!root) throw new Error('index.html 里缺少 #app 挂载点');

  // 错误边界最先装：后面任何一步崩了都能给用户一个「不白屏」的兜底页
  mountErrorBoundary();

  // 先把默认设置填进缓存，保证任何同步调用都有值
  setSettingsCache(DEFAULT_SETTINGS);

  try {
    await openDB();
  } catch (err) {
    root.textContent = `数据库打开失败：${err instanceof Error ? err.message : String(err)}`;
    return;
  }

  // 载入设置到 store（页面通过 ctx 读 store）
  const settings = await dao.settings.get();
  setSettingsCache(settings);
  appStore.set({ settings });
  setBackupSettingsSnapshot(settings.backup);

  // 本地文件夹自动备份：数据一变就防抖写一次 json
  await localfile.init();
  onDataChanged(() => {
    const latest = appStore.get().settings;
    setBackupSettingsSnapshot(latest.backup);
    localfile.onDataChanged();
    // 云同步：数据一变就防抖同步（未开启云同步时 scheduleSync 会直接返回，零开销）
    dao.syncScheduler.scheduleSync();
  });

  // 开发模式下挂数据层自测（不自动执行，手动在控制台调 __selftest.run()）
  if (import.meta.env.DEV) {
    const { attachSelfTest } = await import('./dev/selftest');
    attachSelfTest();
  }

  renderApp(root);
  console.info('[main] 已挂载主界面');

  // 启动时如果开着云同步，先悄悄同步一次（失败不影响使用）
  dao.syncScheduler.scheduleSync();

  // 启动时的贴心提示
  const stats = await dao.words.stats();
  if (stats.total === 0) {
    showToast('词库还是空的，先去「录入」页加几个词吧', 'info', 4000);
    emitDataChanged();
  }
}

void boot().catch((err: unknown) => {
  console.error('[main] 启动失败', err);
  const root = document.getElementById('app');
  const message = `启动失败：${err instanceof Error ? err.message : String(err)}`;
  if (root) root.textContent = message;
  toastError(message);
});
