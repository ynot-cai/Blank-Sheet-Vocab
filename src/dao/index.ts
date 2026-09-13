/** DAO 统一出口：页面只从这里取数据，不许直接用 indexedDB / localStorage。 */
export * as words from './words';
export * as sources from './sources';
export * as settings from './settings';
export * as session from './session';
export * as syncData from './syncData';
export * as cloudSync from './cloudSync';
export * as syncScheduler from './syncScheduler';
// ── 二期（知识点精学）：与一期完全独立的表与 DAO，只共用同步通道 ──
export * as kc from './kc';
export * as kcBatch from './kcBatch';
export * as kcSession from './kcSession';
export * as kcCloud from './kcCloud';
export * as kcSmallCloud from './kcSmallCloud';
export * as kcScheduler from './kcScheduler';
export * as contextWords from './contextWords';
export * as examBank from './examBank';
