/**
 * 二期设置页的公共上下文：**写设置 + 重算全部卡片的优先度**。
 *
 * 为什么单独一个文件：掌握度区、优先度区、参数区都要做同一件事
 * （改设置 → 重算所有卡片 → 通知页面重画），写在三处必然分叉。
 */
import { getSettings, setSettingsCache } from '../../../core/config';
import { StaleDbError, withDbRetry } from '../../../core/db';
import { recomputeCard } from '../../../core/kcPriority';
import type { KcSettings } from '../../../core/kcTypes';
import * as dao from '../../../dao';
import { toastError } from '../../components/Toast';

/**
 * 二期设置的补丁类型。
 *
 * `mastery` / `priority` 允许**只给部分字段**（设置区就是一个个改的），
 * 其余字段给整体值。这样调用方写起来直白，也不会漏字段。
 */
export type KcSettingsPatch = Omit<Partial<KcSettings>, 'mastery' | 'priority' | 'cloud'> & {
  mastery?: Partial<KcSettings['mastery']>;
  priority?: Partial<KcSettings['priority']>;
};

/**
 * 跑一段异步操作，**任何失败都只提示、不抛**。
 *
 * 为什么必须有它（真实故障）：设置页里每个按钮/输入框都是
 * `void (async () => { ... })()` 这种「fire and forget」写法。
 * 里面一旦抛异常（比如 IndexedDB 连接陈旧），就变成**未处理的 Promise 拒绝** ——
 * 会被错误边界接住，结果是**整页变成「页面渲染失败」**，
 * 用户完全不知道刚才那一下到底做没做成。设置页有 10 处这样的调用，
 * 所以统一从这里出口。
 *
 * @param label 操作名（用于日志与提示）
 * @param fn 要做的事
 */
export function runSafely(label: string, fn: () => Promise<void>): void {
  void (async () => {
    try {
      await fn();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[kcSettings] ${label} 失败`, err);
      // StaleDbError / 打开超时 这类错误的消息本身就是说给用户听的
      toastError(
        err instanceof StaleDbError
          ? '数据库正忙（可能另一个标签页开着）：关掉其它标签页后重试'
          : `${label}失败：${message}`,
      );
    }
  })();
}

/**
 * 写二期设置（深合并到 `settings.kc`），并**重算所有卡片的 mastery 与优先度**。
 *
 * 为什么必须重算：用户改公式参数后，库里存的 `attrs.mastery` 还是按旧公式算的，
 * 列表页的掌握度与排序会停在旧值上（验收标准 2 明确要求「改参数后列表页跟着变」）。
 *
 * 说明：`dao.settings.set` 内部做的是**深合并**，所以这里给部分字段是安全的。
 *
 * @param patch 设置补丁（只写给出的字段）
 */
export async function patchKcSettings(patch: KcSettingsPatch): Promise<void> {
  await withDbRetry(async () => {
    await dao.settings.set({ kc: patch } as Parameters<typeof dao.settings.set>[0]);
    setSettingsCache(await dao.settings.get());
    await recomputeAllCards();
  });
}

/**
 * 按当前设置重算所有卡片的 `mastery` 与 `reviewPriority`。
 *
 * 实现说明：`dao.kc.updateAttrs(id, {})` 会走一次「读 → 重算 → 写」，
 * 这里直接用它（卡片规模是几十到几百张，逐张写可接受；
 * 而且**必须逐张写**才能让每张卡的 `updatedAt` 刷新、同步出去）。
 *
 * @returns 重算的卡片数
 */
export async function recomputeAllCards(): Promise<number> {
  const all = await dao.kc.getAll();
  let n = 0;
  for (const card of all) {
    const next = recomputeCard(card);
    // 只在真的变了的时候写库（避免无意义的 updatedAt 刷新与同步推送）
    if (
      Math.abs(next.attrs.mastery - card.attrs.mastery) < 1e-9 &&
      Math.abs(next.attrs.reviewPriority - card.attrs.reviewPriority) < 1e-9
    ) {
      continue;
    }
    await dao.kc.updateAttrs(card.id, {
      mastery: next.attrs.mastery,
      reviewPriority: next.attrs.reviewPriority,
    });
    n += 1;
  }
  return n;
}

/**
 * 读当前二期设置（便捷入口）。
 */
export function currentKcSettings(): KcSettings {
  return getSettings().kc;
}
