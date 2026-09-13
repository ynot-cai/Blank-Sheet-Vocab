/**
 * 一次性调试脚本（R2-b）：复现「点按钮 → 没有确认框」。
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findBrowser, launch, openSession, serveStatic } from '../../scripts/cdp.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = 4195;
const CDP_PORT = 9347;
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

  // 写 AI 设置（正确的 key: main）
  await s.evaluate(`(() => new Promise((resolve) => {
    const req = indexedDB.open('blank-sheet-vocab');
    req.onsuccess = () => {
      const tx = req.result.transaction('settings', 'readwrite');
      const store = tx.objectStore('settings');
      const get = store.get('main');
      get.onsuccess = () => {
        const row = get.result || { key: 'main', value: {} };
        const value = row.value || {};
        value.ai = Object.assign({}, value.ai, { baseUrl: 'http://127.0.0.1:${PORT}/v1', model: 'stub', key: 'stub', proxyUrl: '', forceProxy: false });
        store.put({ key: 'main', value: value });
      };
      tx.oncomplete = () => resolve(true);
    };
  }))()`);

  // 种一个词
  await s.evaluate(`(() => new Promise((resolve) => {
    const req = indexedDB.open('blank-sheet-vocab');
    req.onsuccess = () => {
      const tx = req.result.transaction(['words', 'sources'], 'readwrite');
      tx.objectStore('sources').put({ id: 'src', name: '调试来源', priority: 3, createdAt: 1, updatedAt: 1, deleted: 0 });
      tx.objectStore('words').put({
        id: 'w-delighted', en: 'delighted', phonetic: '', example: '',
        senses: [{ id: 's1', text: '高兴', aliases: [], enabled: true }],
        sourceId: 'src', rawSources: [],
        attrs: { needSpell: false, failCount: 0, failCountTotal: 0, reviewCount: 0, lastReviewAt: null, learnedAt: null, reviewPriority: 0 },
        status: 'unlearned', priority: 3, learnOrder: null, createdAt: 1, updatedAt: 1, deleted: 0,
      });
      tx.oncomplete = () => resolve(true);
    };
  }))()`);

  await s.goto(`${ORIGIN}/#/import`, 2000);
  console.log('scope options:', JSON.stringify(await s.evaluate(`[...(document.querySelector('.card select')?.options ?? [])].map((o) => o.text)`)));

  const step1 = await s.evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '用 AI 重新整理义项');
    b.click();
    return { modals: document.querySelectorAll('.modal').length, title: document.querySelector('.modal-title')?.textContent ?? null };
  })()`);
  console.log('immediately after click:', JSON.stringify(step1));
  await new Promise((r) => setTimeout(r, 800));
  console.log('after 800ms:', JSON.stringify(await s.evaluate(`({
    modals: document.querySelectorAll('.modal').length,
    title: document.querySelector('.modal-title')?.textContent ?? null,
    body: document.querySelector('.modal-body')?.textContent?.slice(0, 100) ?? null,
    toasts: [...document.querySelectorAll('.toast')].map((t) => t.textContent),
    scope: document.querySelector('.card select')?.value ?? null,
  })`)));
  await new Promise((r) => setTimeout(r, 2500));
  console.log('after 3.3s:', JSON.stringify(await s.evaluate(`({
    modals: document.querySelectorAll('.modal').length,
    title: document.querySelector('.modal-title')?.textContent ?? null,
    toasts: [...document.querySelectorAll('.toast')].map((t) => t.textContent),
  })`)));
  await s.close();
} catch (err) {
  console.error('debug 出错：', err);
} finally {
  chrome?.proc?.kill();
  server.kill();
}
