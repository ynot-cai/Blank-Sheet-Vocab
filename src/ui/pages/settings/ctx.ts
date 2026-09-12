import { getSettings, mergeSettingsPatch, setSettingsCache } from '../../../core/config';
import type { DeepPartial, Settings } from '../../../core/types';
import * as dao from '../../../dao';
import { appStore, emitDataChanged } from '../../../state/store';

/**
 * 取当前设置（同步读 store，页面渲染用）。
 */
export function currentSettings(): Settings {
  return getSettings();
}

/**
 * 保存设置补丁：先同步更新缓存与 store（界面立刻生效），再落库。
 * @param patch 设置补丁（支持 { cloud: { enabled: true } } 这类嵌套局部更新）
 */
export async function patchSettings(patch: DeepPartial<Settings>): Promise<void> {
  const merged = mergeSettingsPatch(patch);
  setSettingsCache(merged);
  appStore.set({ settings: merged });
  emitDataChanged();
  await dao.settings.set(patch);
}
