import { DEFAULT_SETTINGS, deepMergeSettings, sanitizeLayoutSettings, setSettingsCache } from '../core/config';
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
 * 同时把结果写进 localStorage 镜像，便于启动时同步读取与排查。
 *
 * ★ T1：返回值额外过一道 `sanitizeLayoutSettings`。
 *   为什么在**读**的时候就要净化：T1 诊断已经实测到，旧版本一次「改手机档边距」
 *   就会把 `layout.mobile` 写成 `{ edgeMarginPx: 18 }`（`button` 子树丢失）并落库，
 *   之后**每次**进设置页都白屏，用户只能清数据自救。
 *   `deepMergeSettings(DEFAULT_SETTINGS, …)` 只在**整个 tier 缺失**时补默认值，
 *   补不了「tier 在、但里面缺字段」这种半残状态 —— 所以需要这一层按字段净化。
 *   净化是**幂等**的（跑两次结果一样），合法数据经过它不会有任何变化。
 */
export async function get(): Promise<Settings> {
  const row = await tx<SettingsRow | undefined>(
    STORE.settings,
    'readonly',
    (s) => s.get(MAIN_KEY) as IDBRequest<SettingsRow | undefined>,
  );
  const merged = sanitizeSettings(deepMergeSettings(DEFAULT_SETTINGS, row?.value ?? {}));
  writeMirror(merged);
  // 同步刷新 core 层的内存缓存：core 的同步函数（priorities、同步调度器）都读它，
  // 不刷新的话「改了设置但缓存还是旧的」，会出现「界面显示已开启、后台却按旧的判断跑」。
  setSettingsCache(merged);
  return merged;
}

/**
 * 把设置里所有「可能来自脏数据」的字段收敛到合法形状。
 *
 * 目前只有布局参数需要（它是唯一有嵌套数值、且直接进布点算法的部分）。
 * 以后新增这类字段时**加在这里**，不要在业务代码里各自兜底。
 * @param s 深合并后的设置
 */
function sanitizeSettings(s: Settings): Settings {
  return { ...s, layout: sanitizeLayoutSettings(s.layout) };
}

/**
 * 同步读镜像（可能为 null，只用于启动时先渲染一版）。
 */
export function readMirror(): Settings | null {
  try {
    const raw = localStorage.getItem(MIRROR_KEY);
    if (!raw) return null;
    return sanitizeSettings(deepMergeSettings(DEFAULT_SETTINGS, JSON.parse(raw) as unknown));
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
