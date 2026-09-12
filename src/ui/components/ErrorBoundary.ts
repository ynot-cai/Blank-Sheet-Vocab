/**
 * 全局错误边界（阶段 07）：**不白屏**。
 *
 * 抓两类错误：
 * 1. `window.onerror`：同步异常（渲染、事件回调里抛的）；
 * 2. `unhandledrejection`：没 catch 的 Promise（异步 DAO、同步任务里最容易漏）。
 *
 * 兜底页只给三个动作：返回首页 / 重新加载 / 导出数据（导出走 Blob 下载，
 * 不依赖任何应用状态，就算应用已经坏了也能把数据拿去）。
 */
import { escapeHtml } from '../dom';

/** 是否已经显示过错误页（避免连环报错把页面刷爆） */
let shown = false;

/**
 * 挂载错误边界（在应用启动时调用一次即可）。
 */
export function mountErrorBoundary(): void {
  window.addEventListener('error', (ev) => {
    // 资源加载失败（img/script）不算应用崩溃，忽略
    if (ev.target instanceof HTMLElement && ev.target !== document.body) return;
    showFatal(ev.message || '未知错误', ev.error);
  });

  window.addEventListener('unhandledrejection', (ev) => {
    const reason = ev.reason;
    showFatal(reason instanceof Error ? reason.message : String(reason), reason);
  });
}

/**
 * 显示兜底错误页。
 * @param message 给用户看的简短说明
 * @param detail 原始错误（只打到控制台，页面上不展示堆栈）
 */
export function showFatal(message: string, detail?: unknown): void {
  if (shown) return;
  shown = true;
  console.error('[fatal] 未捕获的错误：', detail ?? message);

  const page = document.createElement('div');
  page.className = 'fatal-page';
  page.innerHTML = `
    <h2 class="fatal-title">出问题了，但你的数据还在</h2>
    <p class="fatal-msg">${escapeHtml(message)}</p>
    <p class="fatal-hint">单词数据存在浏览器本地，这次崩溃不会删掉它。可以先「返回首页」继续用；
      如果一直出错，先「导出数据」存一份，再清空浏览器数据重新开始。</p>
    <div class="fatal-actions">
      <button type="button" class="btn btn-primary" data-act="home">返回首页</button>
      <button type="button" class="btn" data-act="reload">重新加载</button>
      <button type="button" class="btn" data-act="export">导出数据</button>
    </div>
  `;

  const onClick = (ev: MouseEvent): void => {
    const target = ev.target;
    if (!(target instanceof HTMLElement)) return;
    const act = target.dataset.act;
    if (act === 'home') {
      shown = false;
      page.remove();
      window.location.hash = '#/home';
      window.location.reload();
    } else if (act === 'reload') {
      window.location.reload();
    } else if (act === 'export') {
      void exportRaw();
    }
  };
  page.addEventListener('click', onClick);
  document.body.appendChild(page);
}

/**
 * 兜底导出：直接读 IndexedDB 把两张表 dump 成 json 下载。
 *
 * 为什么不复用 services/backup.ts：那条路依赖应用自身的模块与设置，
 * 而这个函数要在「应用可能已经半死不活」的时候也能跑，所以只依赖原生 API。
 */
async function exportRaw(): Promise<void> {
  const note = document.querySelector<HTMLElement>('.fatal-msg');
  try {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('wordpaper');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('打不开本地数据库'));
    });
    const readAll = (store: string): Promise<unknown[]> =>
      new Promise((resolve, reject) => {
        if (!db.objectStoreNames.contains(store)) {
          resolve([]);
          return;
        }
        const tx = db.transaction(store, 'readonly');
        const req = tx.objectStore(store).getAll();
        req.onsuccess = () => resolve(req.result as unknown[]);
        req.onerror = () => reject(req.error ?? new Error(`读 ${store} 失败`));
      });

    const [words, sources] = await Promise.all([readAll('words'), readAll('sources')]);
    db.close();

    const payload = JSON.stringify(
      { version: 1, exportedAt: Date.now(), note: '来自崩溃兜底页的导出', words, sources },
      null,
      2,
    );
    const blob = new Blob([payload], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `wordpaper-rescue-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    if (note) note.textContent = `已导出 ${words.length} 个词，请保存好这个文件。`;
  } catch (err) {
    console.error('[fatal] 兜底导出失败', err);
    if (note) note.textContent = '导出失败：本地数据库读不出来，请改用浏览器开发者工具导出。';
  }
}
