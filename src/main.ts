import './styles/global.css';
import './styles/paper.css';
// 二期（知识点）的块样式：class 名与 core/blockRender.ts 一一对应
import './styles/kc.css';
import { DEFAULT_SETTINGS, setSettingsCache } from './core/config';
import { openDB } from './core/db';
import { setClockFloorLoader as setKcClockFloorLoader } from './core/kcClock';
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
    // ⚠️ 这一步**必须等到**（而不是只 fire 一个 openDB）：
    // 老版本标签页占着库时升级会被 blocked，这里如果不等，后面的 DAO 调用
    // 会先在某个具体表上报「object store was not found」，用户看到的是一句
    // 看不懂的 IndexedDB 报错，而不是「关掉其他标签页」这种能照做的提示。
    const message = err instanceof Error ? err.message : String(err);
    console.error('[main] 数据库打开失败', err);
    root.replaceChildren();
    const box = document.createElement('div');
    box.className = 'boot-error';
    const title = document.createElement('h2');
    title.textContent = '数据库打不开';
    const detail = document.createElement('p');
    detail.textContent = message;
    const hint = document.createElement('p');
    hint.textContent = '常见原因：另一个标签页还开着这个应用（旧版本占着数据库）。关掉其它标签页后点下面的按钮重试。';
    const retry = document.createElement('button');
    retry.className = 'btn btn-primary';
    retry.type = 'button';
    retry.textContent = '重试';
    retry.addEventListener('click', () => window.location.reload());
    box.appendChild(title);
    box.appendChild(detail);
    box.appendChild(hint);
    box.appendChild(retry);
    root.appendChild(box);
    return;
  }

  // 载入设置到 store（页面通过 ctx 读 store）
  const settings = await dao.settings.get();
  setSettingsCache(settings);
  appStore.set({ settings });
  setBackupSettingsSnapshot(settings.backup);

  // 二期的同步实现注入给二期调度器（避免 kc.ts ⇄ kcCloud.ts 循环依赖，见 kcScheduler 注释）
  dao.kcScheduler.registerKcSyncRunner(dao.kcCloud.kcSyncOnce);

  // 给二期的「单调时钟」注入读水位的实现（core 层不碰 dao，所以用注入；
  // 作用：设备时钟倒退时也不会让新卡片漏推，见 core/kcClock.ts）
  setKcClockFloorLoader(async () => {
    const latest = await dao.settings.get();
    return Math.max(latest.kc.cloud.lastPushAt, latest.kc.cloud.lastSyncAt);
  });

  // 本地文件夹自动备份：数据一变就防抖写一次 json
  await localfile.init();
  onDataChanged(() => {
    const latest = appStore.get().settings;
    setBackupSettingsSnapshot(latest.backup);
    localfile.onDataChanged();
    // 云同步：数据一变就防抖同步（未开启云同步时 scheduleSync 会直接返回，零开销）
    dao.syncScheduler.scheduleSync();
    // 二期同步走另一个调度器实例（游标/失败计数独立，互不拖累）。
    // 说明：二期卡片的写操作内部已经调过 scheduleKcSync 了，这里再叫一次是兜底——
    // 保证「任何数据变动」都能触发二期同步（和一期同样的口径）。
    dao.kcScheduler.scheduleKcSync();
  });

  // 开发模式下挂数据层自测（不自动执行，手动在控制台调 __selftest.run()）
  if (import.meta.env.DEV) {
    const { attachSelfTest } = await import('./dev/selftest');
    attachSelfTest();
    // 二期的验收项（mastery 公式 / XSS 渲染 / 隔离）另挂一个入口：__kcselftest.run()
    const { attachKcSelfTest } = await import('./dev/kcSelftest');
    attachKcSelfTest();
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
