/**
 * 全局错误边界（阶段 07）：**不白屏**。
 *
 * 抓两类错误：
 * 1. `window.onerror`：同步异常（渲染、事件回调里抛的）；
 * 2. `unhandledrejection`：没 catch 的 Promise（异步 DAO、同步任务里最容易漏）。
 *
 * 兜底页只给三个动作：返回首页 / 重新加载 / 导出数据（导出走 Blob 下载，
 * 不依赖任何应用状态，就算应用已经坏了也能把数据拿去）。
 *
 * ★ T1：兜底页改成**可清除**的（{@link clearFatal}）。
 *   以前这里是「一旦显示就永久占屏、且不再响应任何后续错误」（`shown` 一置位就 return）。
 *   T1 的「应用后自动回滚」需要它可清除：观察期内抓到异常时，回滚流程会立刻把设置
 *   修回可用值，如果兜底页还压在屏幕上，用户依然被卡住、非刷新不可 ——
 *   那就等于没有兜底。回滚成功后调 `clearFatal()` 撤掉遮罩，应用当场恢复可用。
 */
import { escapeHtml } from '../dom';

/** 当前显示中的错误页（null = 没显示） */
let fatalEl: HTMLElement | null = null;

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
 * 撤掉兜底错误页（如果正显示着）。
 *
 * 调用时机：应用已经恢复到可用状态之后（T1 的回滚成功、用户手动点关闭）。
 * 为什么要专门导出：`window.location.reload()` 之外，没有任何其它办法能从
 * 兜底页回到应用 —— 而「自动回滚已经修好了设置，却还要用户手动刷新」是不能接受的。
 */
export function clearFatal(): void {
  if (fatalEl) {
    fatalEl.remove();
    fatalEl = null;
  }
}

/**
 * 显示兜底错误页。
 * @param message 给用户看的简短说明
 * @param detail 原始错误（只打到控制台，页面上不展示堆栈）
 */
export function showFatal(message: string, detail?: unknown): void {
  console.error('[fatal] 未捕获的错误：', detail ?? message);
  // 已经显示过就先撤掉旧的：连环报错时展示**最新**那条（旧消息往往是引发新错误的原因，更有误导性）
  clearFatal();

  const page = document.createElement('div');
  page.className = 'fatal-page';
  page.dataset.role = 'fatal-page';
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
      clearFatal();
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
  fatalEl = page;
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
      const req = indexedDB.open('blank-sheet-vocab');
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
    a.download = `blank-sheet-vocab-rescue-${new Date().toISOString().slice(0, 10)}.json`;
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
