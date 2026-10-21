/** DAO 统一出口：页面只从这里取数据，不许直接用 indexedDB / localStorage。 */
export * as words from './words';
export * as sources from './sources';
export * as settings from './settings';
export * as session from './session';
export * as syncData from './syncData';
export * as cloudSync from './cloudSync';
export * as syncScheduler from './syncScheduler';
export * as papers from './papers';
/** ★ 0.0.22：卡片收藏（收藏对象从「单词」改为「卡片」） */
export * as cardFavorites from './cardFavorites';
/** ★ 0.0.25：拼写强化的历史得分 / 出现次数（不新增词表字段） */
export * as spellRecords from './spellRecords';
