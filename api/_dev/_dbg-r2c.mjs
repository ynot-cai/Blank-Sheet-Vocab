/**
 * 一次性调试脚本（R2-c）：把设置真正读出来看。
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findBrowser, launch, openSession, serveStatic } from '../../scripts/cdp.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = 4197;
const CDP_PORT = 9349;
const ORIGIN = `http://127.0.0.1:${PORT}`;

async function waitForServer(url) {
  for (let i = 0; i < 60; i += 1) {
    try {
      if ((await fetch(url)).ok) return true;
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

const browser = findBrowser();
const server = serveStatic({ root: ROOT, port: PORT, mode: 'preview' });
let chrome = null;
try {
  await waitForServer(`${ORIGIN}/`);
  chrome = await launch(browser, CDP_PORT, { windowSize: '1280,900' });
  const s = await openSession(CDP_PORT, `${ORIGIN}/#/home`);

  const wrote = await s.evaluate(`(() => new Promise((resolve) => {
    const req = indexedDB.open('blank-sheet-vocab');
    req.onsuccess = () => {
      const tx = req.result.transaction('settings', 'readwrite');
      const store = tx.objectStore('settings');
      const get = store.get('main');
      get.onsuccess = () => {
        const row = get.result || { key: 'main', value: {} };
        const value = row.value || {};
        value.ai = { baseUrl: 'http://127.0.0.1:${PORT}/v1', model: 'stub', key: 'stub-key-123', proxyUrl: '', forceProxy: false };
        store.put({ key: 'main', value: value });
      };
      tx.oncomplete = () => resolve('written');
      tx.onerror = () => resolve('tx-error');
      tx.onabort = () => resolve('tx-abort');
    };
    req.onerror = () => resolve('open-error');
  }))()`);
  console.log('write result:', wrote);

  // 读回来看看（不经应用）
  const raw = await s.evaluate(`(() => new Promise((resolve) => {
    const req = indexedDB.open('blank-sheet-vocab');
    req.onsuccess = () => {
      const get = req.result.transaction('settings').objectStore('settings').getAll();
      get.onsuccess = () => resolve(get.result.map((r) => ({ key: r.key, ai: r.value && r.value.ai ? r.value.ai : null })));
    };
  }))()`);
  console.log('raw rows:', JSON.stringify(raw));

  await s.goto(`${ORIGIN}/#/import`, 2500);

  // 应用读完设置后，localStorage 镜像里应该有 ai
  const mirror = await s.evaluate(`(() => {
    const raw = localStorage.getItem('blank-sheet-vocab.settings');
    if (!raw) return null;
    try { const o = JSON.parse(raw); return { hasAi: !!o.ai, ai: o.ai }; } catch (e) { return { parseError: String(e) }; }
  })()`);
  console.log('localStorage mirror ai:', JSON.stringify(mirror));

  // 设置表里**所有**的行（看是不是写进了别的 key，被别的行覆盖了）
  const allRows = await s.evaluate(`(() => new Promise((resolve) => {
    const req = indexedDB.open('blank-sheet-vocab');
    req.onsuccess = () => {
      const get = req.result.transaction('settings').objectStore('settings').getAll();
      get.onsuccess = () => resolve(get.result.map((r) => ({ key: r.key, aiKey: r.value && r.value.ai ? r.value.ai.key : '(no ai)' })));
    };
  }))()`);
  console.log('rows after app load:', JSON.stringify(allRows));

  const mirrorAfterDelay = await s.evaluate(`(() => new Promise((resolve) => {
    setTimeout(() => {
      const raw = localStorage.getItem('blank-sheet-vocab.settings');
      let o = null;
      try { o = raw ? JSON.parse(raw) : null; } catch (e) { o = { parseError: String(e) }; }
      resolve(o && o.ai ? { key: o.ai.key, baseUrl: o.ai.baseUrl } : null);
    }, 2500);
  }))()`);
  console.log('mirror after 2.5s:', JSON.stringify(mirrorAfterDelay));

  const storedAi = await s.evaluate(`(() => new Promise((resolve) => {
    const req = indexedDB.open('blank-sheet-vocab');
    req.onsuccess = () => {
      const get = req.result.transaction('settings').objectStore('settings').get('main');
      get.onsuccess = () => resolve(get.result && get.result.value && get.result.value.ai ? get.result.value.ai : null);
    };
  }))()`);
  console.log('stored ai right now:', JSON.stringify(storedAi));

  // 直接在页面里跑一遍真正的 deepMergeSettings 逻辑（复刻），看合并结果
  const mergeProbe = await s.evaluate(`(() => {
    const req = indexedDB.open('blank-sheet-vocab');
    return new Promise((resolve) => {
      req.onsuccess = () => {
        const get = req.result.transaction('settings').objectStore('settings').get('main');
        get.onsuccess = () => {
          const patch = get.result ? get.result.value : null;
          resolve({
            patchAi: patch && patch.ai ? patch.ai : null,
            patchKeys: patch ? Object.keys(patch) : null,
            aiIsPlainObject: patch && patch.ai ? (typeof patch.ai === 'object' && !Array.isArray(patch.ai)) : null,
          });
        };
      };
    });
  })()`);
  console.log('merge probe:', JSON.stringify(mergeProbe));

  const toasts = await s.evaluate(`[...document.querySelectorAll('.toast')].map((t) => t.textContent)`);
  console.log('toasts at load:', JSON.stringify(toasts));
  await s.close();
} catch (err) {
  console.error('debug 出错：', err);
} finally {
  chrome?.proc?.kill();
  server.kill();
}
