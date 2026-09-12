/**
 * 本地文件夹自动备份（File System Access API）。
 *
 * 目的：解决「清浏览器缓存导致数据全丢」。数据本身就在本地，这个功能是给它再加一份
 * 你看得见摸得着的副本——由用户主动选一个文件夹，之后每次改动自动往里写一份 json。
 *
 * 注意：浏览器不允许网站未经允许写任意路径，所以必须由用户主动选一次文件夹，
 * 这是浏览器的安全机制，不是缺陷。
 * Safari / 旧浏览器不支持，会降级为「请定期手动导出 json」。
 */
import * as dao from '../dao';
import { applyBackup, parseBackupText, serializeBackup } from './backup';

/** 句柄在 IndexedDB settings 表里的 key */
const HANDLE_KEY = 'fsHandle';
/** 备份文件名 */
const FILE_NAME = 'wordpaper-data.json';
/** 自动同步防抖时间 */
const DEBOUNCE_MS = 2000;

/** 权限状态（结构与浏览器一致） */
export type FsPermission = 'granted' | 'denied' | 'prompt';

/** 带权限接口的句柄（这些接口不在标准 lib.dom 里，用结构化类型描述） */
interface FsHandleWithPermission {
  name: string;
  queryPermission?: (desc: { mode: 'read' | 'readwrite' }) => Promise<FsPermission>;
  requestPermission?: (desc: { mode: 'read' | 'readwrite' }) => Promise<FsPermission>;
}

/** 可写流 */
interface WritableLike {
  write: (data: string) => Promise<void>;
  close: () => Promise<void>;
}

/** 文件句柄 */
interface FileHandleLike {
  createWritable: () => Promise<WritableLike>;
  getFile: () => Promise<File>;
}

/** 目录句柄 */
interface DirHandleLike extends FsHandleWithPermission {
  getFileHandle: (name: string, opts?: { create?: boolean }) => Promise<FileHandleLike>;
}

/** window 上可能存在的选择器 */
interface PickerWindow {
  showDirectoryPicker?: (opts?: { mode?: 'read' | 'readwrite'; id?: string }) => Promise<unknown>;
}

let cachedHandle: DirHandleLike | null = null;
let permissionNeeded = false;
let lastSyncAt: number | null = null;
let debounceTimer: number | null = null;
let initialized = false;

const listeners = new Set<() => void>();

/**
 * 订阅状态变化（连接 / 断开 / 权限需要恢复 / 同步完成），供页面刷新 UI。
 * @param fn 回调
 */
export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** 通知所有订阅者 */
function notify(): void {
  for (const fn of listeners) {
    try {
      fn();
    } catch (err) {
      console.warn('[localfile] 监听器出错', err);
    }
  }
}

/**
 * 当前浏览器是否支持本地文件夹自动备份。
 */
export function isSupported(): boolean {
  if (typeof window === 'undefined') return false;
  const w = window as unknown as PickerWindow;
  return typeof w.showDirectoryPicker === 'function' && window.isSecureContext;
}

/**
 * 是否已经连接过文件夹（句柄已记住）。
 */
export function isLinked(): boolean {
  return cachedHandle !== null;
}

/**
 * 是否需要在用户手势里重新授权（浏览器重启后首次访问会出现这种情况）。
 */
export function needsPermission(): boolean {
  return permissionNeeded;
}

/**
 * 已连接文件夹的名字。
 */
export function getFolderName(): string | null {
  return cachedHandle?.name ?? null;
}

/**
 * 上次同步时间。
 */
export function getLastSyncAt(): number | null {
  return lastSyncAt;
}

/**
 * 启动时调用：从 IndexedDB 取回上次记住的文件夹句柄，并检查权限。
 */
export async function init(): Promise<void> {
  if (initialized) return;
  initialized = true;
  if (!isSupported()) return;
  try {
    const handle = await dao.settings.getRaw<unknown>(HANDLE_KEY);
    if (!handle) return;
    cachedHandle = handle as DirHandleLike;
    const state = await queryPermission();
    permissionNeeded = state !== 'granted';
  } catch (err) {
    console.warn('[localfile] 恢复文件夹句柄失败', err);
  }
  notify();
}

/**
 * 查询当前权限。
 */
async function queryPermission(): Promise<FsPermission> {
  if (!cachedHandle) return 'prompt';
  if (typeof cachedHandle.queryPermission !== 'function') return 'granted';
  try {
    return await cachedHandle.queryPermission({ mode: 'readwrite' });
  } catch {
    return 'prompt';
  }
}

/**
 * 在用户手势中请求权限。
 */
export async function requestPermission(): Promise<boolean> {
  if (!cachedHandle) return false;
  if (typeof cachedHandle.requestPermission !== 'function') return true;
  try {
    const state = await cachedHandle.requestPermission({ mode: 'readwrite' });
    permissionNeeded = state !== 'granted';
    notify();
    return state === 'granted';
  } catch (err) {
    console.warn('[localfile] 请求权限失败', err);
    return false;
  }
}

/**
 * 让用户选一个文件夹并连接（必须在用户手势中调用）。
 * @returns 是否连接成功
 */
export async function linkFolder(): Promise<boolean> {
  if (!isSupported()) return false;
  try {
    const w = window as unknown as PickerWindow;
    const picked = await w.showDirectoryPicker?.({ mode: 'readwrite', id: 'wordpaper-backup' });
    if (!picked) return false;
    cachedHandle = picked as DirHandleLike;
    permissionNeeded = false;
    await dao.settings.putRaw(HANDLE_KEY, picked);
    notify();
    await syncNow();
    return true;
  } catch (err) {
    // 用户取消选择不算错误
    if (err instanceof DOMException && err.name === 'AbortError') return false;
    console.warn('[localfile] 连接文件夹失败', err);
    throw err instanceof Error ? err : new Error('连接文件夹失败');
  }
}

/**
 * 断开连接（只忘记句柄，不动用户文件夹里的文件）。
 */
export async function unlink(): Promise<void> {
  cachedHandle = null;
  permissionNeeded = false;
  lastSyncAt = null;
  await dao.settings.deleteRaw(HANDLE_KEY);
  notify();
}

/**
 * 立即写一次 wordpaper-data.json。
 */
export async function syncNow(): Promise<void> {
  if (!cachedHandle) throw new Error('还没有连接文件夹');
  const state = await queryPermission();
  if (state !== 'granted') {
    permissionNeeded = true;
    notify();
    throw new Error('需要重新授权文件夹访问权限');
  }
  const text = await serializeBackup();
  const fileHandle = await cachedHandle.getFileHandle(FILE_NAME, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(text);
  await writable.close();
  lastSyncAt = Date.now();
  permissionNeeded = false;
  notify();
}

/**
 * 从文件夹里的 wordpaper-data.json 恢复（覆盖当前库，调用方必须先确认）。
 * @returns 是否有文件并恢复成功
 */
export async function restoreFromFile(): Promise<boolean> {
  if (!cachedHandle) throw new Error('还没有连接文件夹');
  const state = await queryPermission();
  if (state !== 'granted') {
    permissionNeeded = true;
    notify();
    throw new Error('需要重新授权文件夹访问权限');
  }
  const fileHandle = await cachedHandle.getFileHandle(FILE_NAME, { create: false });
  const file = await fileHandle.getFile();
  const text = await file.text();
  const backup = parseBackupText(text);
  await applyBackup(backup, 'replace');
  lastSyncAt = Date.now();
  notify();
  return true;
}

/**
 * 数据变动后调用：内部防抖 2 秒合并写入。
 * 同步失败只 console.warn（外加页面轻提示），绝不阻断正常操作。
 */
export function onDataChanged(): void {
  if (!cachedHandle) return;
  if (debounceTimer !== null) window.clearTimeout(debounceTimer);
  debounceTimer = window.setTimeout(() => {
    debounceTimer = null;
    void syncNow().catch((err: unknown) => {
      console.warn('[localfile] 自动备份失败（不影响使用）', err);
      notify();
    });
  }, DEBOUNCE_MS);
}
