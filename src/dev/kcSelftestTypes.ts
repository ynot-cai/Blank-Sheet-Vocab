/**
 * 二期自测的公共部分：结果类型、等待工具、控制台打印。
 *
 * 单独一个文件的原因：自测拆成了三个文件（公式 / 渲染 / 数据层），
 * 它们都要用到这几样东西，放任何一个里面都会变成「兄弟互相 import」。
 */
/** 一条验收结果 */
export interface KcSelfTestResult {
  name: string;
  ok: boolean;
  detail: string;
}

/** 等一小会（IndexedDB 事务提交用） */
export const tick = (ms = 30): Promise<void> => new Promise((r) => window.setTimeout(r, ms));
/**
 * 把浮点数格式化成便于阅读的字符串（保留 3 位）。
 * @param v 数字
 */
export function fmt(v: number): string {
  return v.toFixed(3);
}
/**
 * 把结果打到控制台表格里。
 * @param results 结果数组
 */
export function print(results: KcSelfTestResult[]): void {
  const passed = results.filter((r) => r.ok).length;
  console.table(results.map((r) => ({ 通过: r.ok ? '✓' : '✗', 项目: r.name, 详情: r.detail })));
  console.info(`[kcselftest] 通过 ${passed}/${results.length}`);
}
