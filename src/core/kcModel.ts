/**
 * 二期卡片模型的**统一出口**（门面）。
 *
 * 这个文件本身不放实现，只把四个单一职责的模块转出去，这样调用方
 * （DAO / 同步层 / 录入页）永远只需记住一个路径，而实现可以按主题拆开：
 *
 * | 模块 | 管什么 |
 * |---|---|
 * | `kcText` | id 生成、文本清洗、分数归一化、钳制与取整 |
 * | `kcBlock` | 块的创建 / 校验 / 脏数据归一化 |
 * | `kcCard` | 卡片的创建 / 校验 / 脏数据归一化 |
 * | `kcMastery` | 掌握度公式（含完整对照表与推导注释） |
 * | `kcExamTypes` | 考核方式标签的小工具 |
 *
 * ⚠️ 为什么不放在一个文件里：项目硬约束是**单文件不超过 300 行**。
 * 五件事（文本工具 / 块 / 卡片 / 掌握度公式 / 题型）塞在一起是 570 行，
 * 而且掌握度那段注释比代码还长——拆开以后每个文件都能一眼读完。
 *
 * 用哪个入口：**业务代码请统一从这里 import**（`import { calcMastery } from './kcModel'`），
 * 这样将来再拆一次也不用改调用方；只有需要看清某个函数归属时才直接引具体模块。
 */
export { newId, sanitizeText, normalizeScore, clamp01, roundTo } from './kcText';
export { createBlock, validateBlock, coerceBlock } from './kcBlock';
export {
  createEmptyCard,
  createEmptyAttrs,
  createEmptyExamLoad,
  validateCard,
  coerceCard,
} from './kcCard';
export { calcMastery, calcMasteryWith } from './kcMastery';
export { KNOWN_EXAM_TYPE_IDS, filterExamTags } from './kcExamTypes';
