/**
 * 二期的「综合掌握程度」算法（主提示词 4.3）。
 *
 * 单独成文件的原因：这个公式是二期最需要被反复讨论的地方，
 * 注释比代码长得多（含完整对照表与「为什么加了方向系数」的推导），
 * 混在卡片模型里会让人找不到重点。
 */
import { KC } from './config';
import { clamp01, normalizeScore, roundTo } from './kcText';
import type { MasteryConfig } from './kcTypes';

/** 掌握度公式参数（默认值来自设置，这里留一份兜底，避免无参调用时取不到设置） */
const DEFAULT_MASTERY = { w1: 0.6, w2: 0.4, penalty: 0.8, asymmetry: 2 };

/**
 * 缺失分数时的「中性先验」：0.5 正好对应 3 分制里的 2 分（模糊）。
 * 拿它补上缺失的一侧，公式就只需要一套（见函数头注释）。
 */
const NEUTRAL_PRIOR = 0.5;

/**
 * 综合掌握程度（主提示词 4.3 的公式）。
 *
 * ```
 * normalized = score / 3                       // 1~3 分归一化到 0~1
 * dir        = selfNorm >= examNorm ? asymmetry : 1 / asymmetry
 * mastery    = w1*selfNorm + w2*examNorm - penalty*dir*|selfNorm - examNorm|
 * ```
 *
 * **为什么自评权重（w1=0.6）比考核（w2=0.4）高**：
 * 用户明确要求。二期大量题型是主观题（造句、填空），AI 评分只能算参考，
 * 用户自己的「会不会」判断反而更可信，所以自评给更高的权重。
 *
 * **惩罚项（penalty × dir）的作用：抓「盲目自信」**。
 * 自评高（3）而考核低（1）是最危险的状态——用户以为会了、其实不会。
 *
 * ⚠️ 这里有一个**必须解释清楚的设计决定**：主提示词给的公式里惩罚项是
 * `penalty * |selfNorm - examNorm|`（对称），但它的默认权重是 w1=0.6 > w2=0.4，
 * 对称惩罚算出来是这样的：
 *
 * | 自评 | 考核 | 对称惩罚 | 方向惩罚（本实现） |
 * |---|---|---|---|
 * | 3 | 1 | 0.200 | **0**（盲目自信，必须最狠） |
 * | 1 | 3 | 0.067 | **0.333**（低估自己，不危险） |
 *
 * 也就是说：**对称惩罚会让「盲目自信」的掌握度（0.2）反而高于「低估自己」（0.067）**，
 * 与主提示词自己的表述（「盲目自信是最危险状态，必须被自动提上来复习」）
 * 以及阶段 01 验收项 3（`calcMastery(3,1)` 要明显低于 `calcMastery(1,3)`）**正好相反**。
 *
 * 所以惩罚项加了方向系数 `asymmetry`（默认 2）。**为什么是 2**：设方向系数为 a，
 * 两个关键格子是
 * ```
 * m(3,1) = 0.6*1.0   + 0.4*0.333 - 0.8*a*0.667 = 0.733 - 0.533a
 * m(1,3) = 0.6*0.333 + 0.4*1.0   - 0.8/a*0.667 = 0.600 - 0.533/a
 * ```
 * 实测（`api/_dev/test-kc.mjs` 里也是这么断言的）：
 * `a=1`（对称）时 `m(3,1)=0.2 > m(1,3)=0.067`，**验收项不成立**；
 * `a ≥ 1.3` 起成立；取 **`a=2`** 是因为这一档刚好让四个「真会 / 真不会 / 模糊 / 盲目自信」
 * 的格子落在 1 / 0.333 / 0.667 / 0 上（区分度最干净），
 * 再大（如 a=3）会把「考核 2 分」也压到接近 0，反而丢掉区分度。
 *
 * `asymmetry=1` 就退回主提示词原来那个对称公式（设置页可改，阶段 07 做界面）。
 * - 自评 ≥ 考核：`- penalty * asymmetry * gap`
 * - 自评 < 考核：`- penalty / asymmetry * gap`
 *
 * `asymmetry=1` 就退回主提示词原来那个对称公式（设置页可改，阶段 07 做界面）。
 *
 * 完整对照表（用当前默认参数实算出来的，不是推的）：
 *
 * | 自评＼考核 | 无(未考) | 1 不会 | 2 模糊 | 3 会了 |
 * |---|---|---|---|---|
 * | **无（未自评）** | 0 | 0.167 | 0.5 | 0.5 |
 * | **1 不会** | 0.333 | 0.333 | 0.333 | 0.333 |
 * | **2 模糊** | 0.333 | **0** | 0.667 | 0.667 |
 * | **3 会了** | **0** | **0** | 0.333 | **1** |
 *
 * 两个值得注意的格子（都是**故意的**，不是 bug）：
 * - `3/1 = 0`：说自己会了、一考却不会 —— 这是最危险的状态，必须最先复习，
 *   掌握度给 0 是「当作没学过、重来一遍」的意思；
 * - `2/1 = 0`：模糊 + 考砸，同理。
 * 而 `1/3 = 0.333`（低估自己但真会）不会被惩罚到底 —— 低估不危险。
 *
 * **只有一个分数时**：把缺失的那一侧当作「中性先验 0.5」（3 分制的 2 分，
 * 见 `NEUTRAL_PRIOR`），用同一个公式算 —— 这样「缺失惩罚」和「不一致惩罚」
 * 是同一套逻辑，不需要第二套规则。注意「自评 3、还没考」= **0**
 * （光自己说会了不算掌握，必须经过考核才可能拿到分），
 * 「考核 3、还没自评」= 0.5，只有 `3/3` 才 = 1.0。
 * 两个都是 `null` → 返回 0（没学过，掌握度就是 0）。
 *
 * 结果钳制到 `[0, 1]`，保留 3 位小数（避免界面显示 0.6000000000000001）。
 *
 * @param selfScore 最近一次自评（1~3，null = 没评过）
 * @param examScore 最近一次考核（1~3，null = 没考过）
 * @param cfg 公式参数（默认 0.6 / 0.4 / 0.8 / 2，来自设置页）
 */
export function calcMastery(
  selfScore: number | null,
  examScore: number | null,
  cfg?: { w1?: number; w2?: number; penalty?: number; asymmetry?: number },
): number {
  const hasSelf = selfScore !== null && Number.isFinite(selfScore);
  const hasExam = examScore !== null && Number.isFinite(examScore);
  if (!hasSelf && !hasExam) return KC.masteryInitial;

  const w1 = cfg?.w1 ?? DEFAULT_MASTERY.w1;
  const w2 = cfg?.w2 ?? DEFAULT_MASTERY.w2;
  const penalty = cfg?.penalty ?? DEFAULT_MASTERY.penalty;
  const asymmetry = cfg?.asymmetry ?? DEFAULT_MASTERY.asymmetry;

  // 缺失的一侧用「中性先验 0.5」（= 3 分制的 2 分「模糊」）补齐：
  // 既保留加权公式的形状，又让「证据缺一半」本身有代价（见函数头注释的算式）
  const selfNorm = hasSelf ? normalizeScore(selfScore) : NEUTRAL_PRIOR;
  const examNorm = hasExam ? normalizeScore(examScore) : NEUTRAL_PRIOR;

  // 方向系数：自评不低于考核（偏自信 / 相等）→ 重罚；自评低于考核（偏谦虚）→ 轻罚。
  // 相等的差距是 0，乘哪个都一样，所以用 >= 不会影响「真掌握」与「真不会」。
  const dir = selfNorm >= examNorm ? asymmetry : 1 / asymmetry;
  const raw = w1 * selfNorm + w2 * examNorm - penalty * dir * Math.abs(selfNorm - examNorm);
  return roundTo(clamp01(raw), KC.masteryDigits);
}

/** 掌握度公式参数取值的兜底（设置里被填成 NaN 时不让公式崩） */
function safeMasteryCfg(cfg: MasteryConfig): MasteryConfig {
  const pick = (v: number, fallback: number): number => (Number.isFinite(v) ? v : fallback);
  const asymmetry = pick(cfg.asymmetry, DEFAULT_MASTERY.asymmetry);
  return {
    w1: pick(cfg.w1, DEFAULT_MASTERY.w1),
    w2: pick(cfg.w2, DEFAULT_MASTERY.w2),
    penalty: pick(cfg.penalty, DEFAULT_MASTERY.penalty),
    // 方向系数必须 > 0，否则 1/asymmetry 会变成 Infinity / NaN
    asymmetry: asymmetry > 0 ? asymmetry : DEFAULT_MASTERY.asymmetry,
  };
}

/**
 * 用「当前设置里的公式参数」算掌握度（DAO / 同步层用的便捷入口）。
 * @param selfScore 自评
 * @param examScore 考核
 * @param cfg 设置里的公式参数
 */
export function calcMasteryWith(
  selfScore: number | null,
  examScore: number | null,
  cfg: MasteryConfig,
): number {
  return calcMastery(selfScore, examScore, safeMasteryCfg(cfg));
}
