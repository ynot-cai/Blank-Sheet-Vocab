import './styles/global.css';
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
 * 启动顺序：装错误边界 → 打开 DB → 载入设置 → 挂载 App。
 *
 * ★ 版本 0.0.1「删除与归档行动」删掉了四段启动编排：
 *   1. `import './styles/paper.css'` 与 `import './styles/kc.css'`——
 *      白纸流程与二期（知识点）已归档删除，这两份样式表随之删除（见 已归档 02 / 01）。
 *   2. 二期同步的注入（`dao.kcScheduler.registerKcSyncRunner`）与二期单调时钟的
 *      读水位注入（`setKcClockFloorLoader`）——二期的两个调度器都没了。
 *   3. 开发模式下的三份自测挂载（`__selftest` / `__kcselftest` / `__t2BackfillExamCount`）
 *      与布局测量入口 `attachLayoutProbe()`——这些自检对象的目标模块已归档，
 *      见 已归档/13。
 *   4. `isDevLayoutRoute()` 那段「布局调试页不打开数据库」的短路——
 *      调试页已归档（见 已归档/10）。
 *
 * 保留的编排一律**没有动**：错误边界、默认设置预填缓存、本地文件夹自动备份、
 * 云同步调度（一期唯一的同步通道）、以及数据变动时同时触发备份与同步的那条线。
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

  // 本地文件夹自动备份：数据一变就防抖写一次 json
  await localfile.init();
  onDataChanged(() => {
    const latest = appStore.get().settings;
    setBackupSettingsSnapshot(latest.backup);
    localfile.onDataChanged();
    // 云同步：数据一变就防抖同步（未开启云同步时 scheduleSync 会直接返回，零开销）
    dao.syncScheduler.scheduleSync();
  });

  renderApp(root);
  console.info('[main] 已挂载主界面');

  // 启动时如果开着云同步，先悄悄同步一次（失败不影响使用）
  dao.syncScheduler.scheduleSync();

  // 启动时的贴心提示（原来的文案是「先去『录入』页加几个词」——
  // 录入页已归档，改成指向设置页）
  const stats = await dao.words.stats();
  if (stats.total === 0) {
    showToast('词库还是空的，可以在「设置 → 同步」里拉取云端已有数据', 'info', 4000);
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
