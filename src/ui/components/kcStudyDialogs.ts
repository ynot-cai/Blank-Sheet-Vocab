/**
 * 学习/复习流程用的小组件：**二选一确认弹窗**、分数文案、**「继续上次」询问**。
 *
 * 与一期的 `confirmModal` 的区别：那个只有「确认/取消」两个固定文案，
 * 而「继续上次 / 重新开始」需要两个按钮都换文案，所以单独做一个。
 */

// RULES-R1: 此处禁止任何强制时间限制（无倒计时 / 无超时提交 / 无超时判错）
import { openModal } from '../components/Modal';
import { h } from '../dom';

/**
 * 问用户「继续上次还是重新开始」。
 *
 * 学习与复习流程都要问同一件事（只是文案里的量词/环节名不同），所以共用一份。
 *
 * @param open 未完成的会话（要知道进度才能写文案）
 * @param unit 单位（'张' = 卡片）
 * @param kind 环节中文名（'学习' / '复习'）
 * @returns true = 继续上次；false = 重新开始（调用方负责删掉旧会话）
 */
export function askResume(
  open: { currentIndex: number; cardIds: string[] },
  unit: string,
  kind: string,
): Promise<boolean> {
  const left = Math.max(0, open.cardIds.length - open.currentIndex);
  return confirmDialog(
    `继续上次的${kind}？`,
    open.currentIndex > 0
      ? `上次进行到第 ${open.currentIndex + 1} ${unit}，还剩 ${left} ${unit}。选「重新开始」会丢掉上次的进度。`
      : `上次开了个头，还剩 ${left} ${unit}。选「重新开始」会丢掉上次的进度。`,
    '继续上次',
    '重新开始',
  );
}

/** 自评分的中文（给「上次自评」提示用） */
export function scoreLabel(score: number): string {
  if (score <= 1) return '不会';
  if (score === 2) return '模糊';
  return '会了';
}

/**
 * 二选一确认弹窗（比 `confirmModal` 多一个自定义按钮文案）。
 * @param title 标题
 * @param message 正文
 * @param confirmText 主按钮文案
 * @param cancelText 次按钮文案
 */
export function confirmDialog(title: string, message: string, confirmText: string, cancelText = '取消'): Promise<boolean> {
  // 说明：这里不复用 `confirmModal`，因为它只有「确认/取消」两个固定文案，
  // 而「继续上次 / 重新开始」需要两个都改。
  return new Promise((resolve) => {
    let answered = false;
    openModal({
      title,
      width: '420px',
      body: h('p', { class: 'modal-text', text: message }),
      actions: [
        {
          text: cancelText,
          variant: 'ghost',
          onClick: (close) => {
            answered = true;
            resolve(false);
            close();
          },
        },
        {
          text: confirmText,
          variant: 'primary',
          onClick: (close) => {
            answered = true;
            resolve(true);
            close();
          },
        },
      ],
      onClose: () => {
        if (!answered) resolve(false);
      },
    });
  });
}
