import { DEFAULT_SETTINGS, deepMergeSettings, setSettingsCache } from '../core/config';
import { STORE, tx } from '../core/db';
import type { DeepPartial, Settings } from '../core/types';

/** 设置在主存储里的固定 key */
const MAIN_KEY = 'main';
/** localStorage 镜像的键名（只存一份，供启动时同步读取与排查） */
const MIRROR_KEY = 'blank-sheet-vocab.settings';

/** 设置表里的一行 */
interface SettingsRow {
  key: string;
  value: Settings;
}

/**
 * 读设置：与 DEFAULT_SETTINGS 深合并，缺字段用默认值补。
 * 同时把结果写进 localStorage 镜像，便于排查与快速启动。
 */
export async function get(): Promise<Settings> {
  const row = await tx<SettingsRow | undefined>(
    STORE.settings,
    'readonly',
    (s) => s.get(MAIN_KEY) as IDBRequest<SettingsRow | undefined>,
  );
  const merged = deepMergeSettings(DEFAULT_SETTINGS, row?.value ?? {});
  writeMirror(merged);
  // 同步刷新 core 层的内存缓存：core 的同步函数（priorities、同步调度器）都读它，
  // 不刷新的话「改了设置但缓存还是旧的」，会出现「界面显示已开启、后台却按旧的判断跑」。
  setSettingsCache(merged);
  return merged;
}

/**
 * 同步读镜像（可能为 null，只用于启动时先渲染一版）。
 */
export function readMirror(): Settings | null {
  try {
    const raw = localStorage.getItem(MIRROR_KEY);
    if (!raw) return null;
    return deepMergeSettings(DEFAULT_SETTINGS, JSON.parse(raw) as unknown);
  } catch (err) {
    console.warn('[dao/settings] 读取本地镜像失败', err);
    return null;
  }
}

/**
 * 把设置写进 localStorage 镜像。
 * 说明：AI 密钥只存在这台设备的浏览器里（localStorage / IndexedDB），不上传也不同步。
 * @param settings 设置
 */
function writeMirror(settings: Settings): void {
  try {
    localStorage.setItem(MIRROR_KEY, JSON.stringify(settings));
  } catch (err) {
    console.warn('[dao/settings] 写入本地镜像失败', err);
  }
}

/**
 * 局部更新设置（深合并后整体写回）。
 * @param patch 设置补丁
 */
export async function set(patch: DeepPartial<Settings>): Promise<void> {
  const current = await get();
  const merged = deepMergeSettings(current, patch);
  await tx(STORE.settings, 'readwrite', (s) => s.put({ key: MAIN_KEY, value: merged } satisfies SettingsRow));
  writeMirror(merged);
  // 与 get() 同理：设置一变，内存缓存马上跟上
  setSettingsCache(merged);
}

/**
 * 重置为默认设置。
 */
export async function reset(): Promise<void> {
  await tx(STORE.settings, 'readwrite', (s) => s.put({ key: MAIN_KEY, value: DEFAULT_SETTINGS } satisfies SettingsRow));
  writeMirror(DEFAULT_SETTINGS);
  setSettingsCache(DEFAULT_SETTINGS);
}

/**
 * 写一条原始键值（本地文件夹句柄这类不能进 JSON 的东西放这里）。
 * @param key 键
 * @param value 任意可结构化克隆的值
 */
export async function putRaw(key: string, value: unknown): Promise<void> {
  await tx(STORE.settings, 'readwrite', (s) => s.put({ key, value }));
}

/**
 * 读一条原始键值。
 * @param key 键
 */
export async function getRaw<T>(key: string): Promise<T | null> {
  const row = await tx<{ key: string; value: T } | undefined>(
    STORE.settings,
    'readonly',
    (s) => s.get(key) as IDBRequest<{ key: string; value: T } | undefined>,
  );
  return row?.value ?? null;
}

/**
 * 删除一条原始键值。
 * @param key 键
 */
export async function deleteRaw(key: string): Promise<void> {
  await tx(STORE.settings, 'readwrite', (s) => s.delete(key));
}
