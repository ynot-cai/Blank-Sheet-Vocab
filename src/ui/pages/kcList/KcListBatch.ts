/**
 * 卡片列表的**批量操作栏**（逻辑部分：确认弹窗 + 调 DAO + 回调刷新）。
 *
 * 从列表页拆出来的原因：单文件 ≤ 300 行；而且「批量删除要二次确认」这类
 * 危险操作的文案集中在一处，比散在页面流程里更不容易出事。
 */
import * as dao from '../../../dao';
import { openModal } from '../../components/Modal';
import { showUndoToast, toastOk } from '../../components/Toast';
import { h } from '../../dom';
import { renderKcBatchBar } from './KcListFilters';

/**
 * 渲染批量操作栏并接上动作。
 *
 * @param ids 选中的卡片 id
 * @param after 每次批量操作完成后的回调（清空选中 + 重新查询）
 */
export function renderKcBatchActions(ids: string[], after: () => void | Promise<void>): HTMLElement {
  /** 跑一个批量操作，然后统一提示 + 刷新 */
  const run = async (label: string, fn: () => Promise<number>): Promise<void> => {
    const n = await fn();
    toastOk(`${label} ${n} 张`);
    await after();
  };

  return renderKcBatchBar(ids.length, {
    onChop: () => {
      void (async () => {
        // RULES-R3: 批量斩也是斩，同样要能撤销 —— 斩之前把每张卡的原状态快照下来
        // （不能事后用「一律设成 unlearned」代替，那会抹平掌握进度）
        const snapshot = (await dao.kc.getAll())
          .filter((c) => ids.includes(c.id))
          .map((c) => ({ id: c.id, deleted: (c.deleted ?? 0) as 0 | 1, status: c.status }));
        const n = await dao.kcBatch.bulkSetDeleted(ids, 1);
        showUndoToast(`已斩 ${n} 张`, async () => {
          await dao.kcBatch.bulkRestoreChopState(snapshot);
          await after();
        });
        await after();
      })();
    },
    onRevive: () => {
      void run('已复活', () => dao.kcBatch.bulkSetDeleted(ids, 0));
    },
    onAddTag: (tag: string) => {
      void run('已加上考法，共', () => dao.kcBatch.bulkAddExamTags(ids, [tag]));
    },
    onRemove: () => {
      openModal({
        title: `永久删除选中的 ${ids.length} 张？`,
        body: h('p', {
          class: 'modal-text',
          text: '永久删除不可恢复，也无法在「已斩」里找回。只想让它们不再出现的话，请用「批量斩」。',
        }),
        actions: [
          { text: '取消', variant: 'ghost', onClick: (close) => close() },
          {
            text: '永久删除',
            variant: 'danger',
            onClick: (close) => {
              void (async () => {
                await run('已永久删除', () => dao.kcBatch.bulkRemovePermanently(ids));
                close();
              })();
            },
          },
        ],
      });
    },
    onClear: () => {
      void after();
    },
  });
}
