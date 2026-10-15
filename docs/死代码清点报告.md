# 死代码清点报告（只读分析 · 未修改任何代码）

> **状态更新**：清点阶段结束，**W1~W3 已执行完毕**（4 个 commit，46 个文件，净减 673 行 + 2.7 MB 临时文件）→ 见 **§7 执行记录**；
> **W4 只剩 6 项待你拍板** → 见 **§8 拍板清单**（回我 `F1=A, F2=A, F4=B, F5=留, F6=A, D1=做` 这种形式即可）。

> 生成时间：本轮会话　|　分析对象：`D:\Project：Blank Sheet Vocab`　|　分支 `main`，最新提交 `83a14ef`
> 工具：knip 6.38（临时安装 `--no-save`，配置文件放在系统临时目录，**未落盘进仓库**）
> 　　　+ 自研两层解析器（token 级引用扫描 / import 绑定级消费者解析）+ 逐条人工复核

## 0. 结论摘要

| 类别 | 条数 | 建议动作 | 需你逐条拍板 |
|---|---|---|---|
| **A1 业务代码里的死导出** | 43 | **删**（引用次数 0，knip 全部相互印证） | 否，整批确认即可 |
| A2 dev/测试/脚本内部的死导出 | 3（实为 0） | **不删**：2 条是 Node loader 钩子，1 条是解析器把模板字符串当成了函数 | — |
| **D 门面再导出（无人消费）** | 42 | **删掉那一行再导出**，底层实现保留 | 否 |
| **C2 只被自检/开发工具引用** | 41 | **待决**（多数是刻意的「测试接缝」） | **是** |
| **B 建议降为私有** | 220（98 个文件） | **去掉 export 关键字**，实现不动 | 否 |
| E 有真实消费者 | 655 | 留 | — |
| **功能块级** | 9 块（F1~F9） | **待决** | **是** |

**总估算**：A1 段约 **429 行**；功能块候选合计约 **3,900 行**（含 Cloudflare Worker 目录 1,855 行、二期小表云同步 1,049 行）。
注意：本项目的**代码注释占极高比例**，「删 43 个死导出」实际减重有限；真正能一次减掉上千行的只有功能块（F1~F3）。

## 1. 基线与方法

### 1.1 基线（清点开始前）

| 检查 | 结果 |
|---|---|
| `git status` | 干净（仅有本轮新增的两份 docs 报告，未跟踪） |
| `npm run test:build` | ✅ **通过 53 项 / 失败 0 项**（exit 0） |
| `npm run build` | ✅ exit 0，548 modules，产物正常 |
| 结论 | **基线全绿，可以放心做减法** |

> 说明：`test:build` 是单个脚本（内含 53 项断言，覆盖相对导入可解析 / 路由表⇄api 文件 / tsconfig 护栏 / UTF-8 BOM）。
> 指令里提到的「26 组自动化自检」是全量 `npm test`（26 个脚本），删除阶段建议改用 `npm test` 做全绿校验。

### 1.2 方法（三层交叉验证）

1. **knip 6.38**：`npx knip --reporter json`，`entry` 显式声明（`index.html` / `src/main.ts` / `api/*.ts` / `scripts/**/*.mjs` / `public/sw.js` / `vite.config.ts`），`api/_dev/**`、`src/dev/**` 分别跑「业务视角 / 全量视角」两遍。
2. **token 级扫描**（自研 `bkv-scan.mjs`）：从 entry 出发算 import 可达闭包 + 全库标识符出现次数，找出「文件级孤儿」和「token 级零引用」。
3. **绑定级消费者解析**（自研 `bkv-refs.mjs`）：解析 `import {}` / `import * as NS` / `const {x} = await import()` / `const NS = await import()` / **跨行链式命名空间访问**（`dao\n  .words\n  .chop()`），并**跟随再导出链**把消费者映射回真实定义模块。
4. **安全网**：凡被判「删」但 token 级在别处出现过的名字，一律降级为「待人工」——本轮结果该名单为空（0 条），说明两层结论完全一致。
5. **逐条人工复核**：对 43 条 A1 全部做了精确 grep 验证（见 §2.2 末的抽验记录）。

### 1.3 假阳性记录（**这几个如果没查，会被误删**）

| 命中 | 工具怎么说 | 真相 | 处置 |
|---|---|---|---|
| `probeLayout.mjs`（仓库根，320 行） | 不在任何 entry 的可达闭包里 → 像是孤儿 | 被 `api/_dev/test-s3-ui.mjs:74` 用 `execFileSync(process.execPath, ['probeLayout.mjs', ...])` **以字符串路径调用** | **留**（布局验收探针） |
| `public/r1-seed.html`（20 行） | 零代码引用 | `api/_dev/test-r1.mjs:795` 用 CDP 打开它当「同源但不启动应用」的种子页 | **留**（但见 F10 附注：它会被部署到线上） |
| `api/**/*.ts` 共 11 个文件 | Vercel 约定「文件名 = 路由名」，无人 import | 是线上入口 | **留** |
| `api/_dev/loader-hooks.mjs` 的 `resolve` / `load` | 无任何调用点 | 是 **Node ESM loader 钩子**，由模块系统按名调用 | **留** |
| `scripts/build-presets.mjs:129 findTier` | 声明了但没人用 | 该行在**模板字符串里**，是生成 `src/core/presets.ts` 的文本，不是真函数 | **留**（解析器误报） |
| `scripts/**/*.mjs`、`src/dev/**`、`api/_dev/**` | 大量「只被 dev 引用」 | 工程化资产（26 组自检 + CDP 工具） | **留**，需要拍板的单独列 C2 |
| `src/env.d.ts` | 不是被 import 的模块 | `tsc` 的类型声明入口（`__APP_VERSION__`） | **留** |

## 2. 对照表

### 2.1 文件级

| # | 文件 | 引用来源 | 次数 | knip 判定 | 建议 | 需拍板 | 备注 |
|---|---|---|---|---|---|---|---|
| 1 | `probeLayout.mjs`（320 行） | `api/_dev/test-s3-ui.mjs:74`（execFileSync 字符串） | 1 | 不在 project 范围 | **留** | 否 | 假阳性；S3 布局验收工具 |
| 2 | `public/r1-seed.html`（20 行） | `api/_dev/test-r1.mjs:795` | 1 | — | **留** | 否 | 假阳性；测试种子页 |
| 3 | `.git-commit-msg.txt`（41 行） | 无 | 0 | — | **删** | 是 | 被 git 跟踪的**游离文件**，内容是历史 commit message 草稿；想留可移进 `docs/` |
| 4 | `.tmp/**`（70 个文件 / 2.7 MB） | 无 | 0 | 被 .gitignore 忽略 | **删** | 是 | 一次性诊断脚本（`diag-*.mjs` / `m2-ui-check.mjs` / `add-r1-markers.mjs` …）+ JSON 转储 + `dev.db`。**不进 git，但会拖慢 AI 每次读仓库** |
| 5 | `src/env.d.ts` | tsc 隐式包含 | — | — | 留 | 否 | 类型声明入口 |
| 6 | `api/_lib/*.ts`（14 个） | 被 `api/*.ts` 可达 | — | — | 留 | 否 | 无孤儿（初版脚本因 `.js`→`.ts` 映射缺失误报过，已修） |
| 7 | `dist/**`、`tsconfig*.tsbuildinfo` | 构建产物 | — | gitignored | 留 | 否 | 已被 .gitignore 正确排除 |

> **结论**：全项目**没有零引用的源代码文件**（knip 的 `Unused files` 为空，自研可达性分析同样为空）。文件级减法只剩「游离文件 + 临时目录」两项。

### 2.2 A1 类：业务代码里的死导出（43 条，建议删）

判定口径：**没有任何文件 import / 命名空间访问它，本文件内部也不再使用，且没有任何地方再导出它**。全部 43 条同时被 knip 独立标记。

| # | 位置（文件:行） | 符号 | 引用来源 | 次数 | knip | 建议 | 需拍板 | 估算行数 |
|---|---|---|---|---|---|---|---|---|
| 1 | `api/_lib/inventory.ts:231` | `maxWordUpdatedAt` | 无（仅定义处；注释里提到不算） | 0 | unused export | **删** | 否 | ~17 |
| 2 | `api/_lib/kcSmallInventory.ts:15` | `ContextWordRow` | 无（仅定义处；注释里提到不算） | 0 | unused export | **删** | 否 | ~12 |
| 3 | `api/_lib/kcSmallInventory.ts:27` | `ExamRecordRow` | 无（仅定义处；注释里提到不算） | 0 | unused export | **删** | 否 | ~16 |
| 4 | `api/_lib/kcSmallInventory.ts:43` | `BankQuestionRow` | 无（仅定义处；注释里提到不算） | 0 | unused export | **删** | 否 | ~51 |
| 5 | `api/_lib/limits.ts:29` | `WORDS_SOFT_LIMIT` | 无（仅定义处；注释里提到不算） | 0 | unused export | **删** | 否 | ~2 |
| 6 | `src/core/blockRender.ts:256` | `MAX_BLOCK_TEXT` | 无（仅定义处；注释里提到不算） | 0 | unused export | **删** | 否 | ~2 |
| 7 | `src/core/config.ts:584` | `getSetting` | 无（仅定义处；注释里提到不算） | 0 | unused export | **删** | 否 | ~8 |
| 8 | `src/core/kcClock.ts:101` | `currentClockFloor` | 无（仅定义处；注释里提到不算） | 0 | unused export | **删** | 否 | ~4 |
| 9 | `src/core/kcTypes.ts:55` | `SelfRating` | 无（仅定义处；注释里提到不算） | 0 | unused export | **删** | 否 | ~3 |
| 10 | `src/core/kcTypes.ts:125` | `ExamTypeId` | 无（仅定义处；注释里提到不算） | 0 | unused export | **删** | 否 | ~7 |
| 11 | `src/core/layout.ts:730` | `paperLayout` | 无（仅定义处；注释里提到不算） | 0 | unused export | **删** | 否 | ~17 |
| 12 | `src/core/pick.ts:117` | `pickForReview` | 无（仅定义处；注释里提到不算） | 0 | unused export | **删** | 否 | ~29 |
| 13 | `src/core/pick.ts:246` | `pickNextForLearn` | 无（仅定义处；注释里提到不算） | 0 | unused export | **删** | 否 | ~17 |
| 14 | `src/core/presets.ts:89` | `findTier` | 无（仅定义处；注释里提到不算） | 0 | unused export | **删** | 否 | ~4 |
| 15 | `src/dao/cloudSync.ts:351` | `isConfigured` | 无（仅定义处；注释里提到不算） | 0 | unused ns-export | **删** | 否 | ~5 |
| 16 | `src/dao/contextWords.ts:198` | `clearAll` | 无（仅定义处；注释里提到不算） | 0 | unused ns-export | **删** | 否 | ~4 |
| 17 | `src/dao/examBank.ts:205` | `bulkPutBank` | 无（仅定义处；注释里提到不算） | 0 | unused ns-export | **删** | 否 | ~7 |
| 18 | `src/dao/kcScheduler.ts:82` | `kcSyncNow` | 无（仅定义处；注释里提到不算） | 0 | unused ns-export | **删** | 否 | ~7 |
| 19 | `src/dao/kcScheduler.ts:89` | `cancelKcScheduled` | 无（仅定义处；注释里提到不算） | 0 | unused ns-export | **删** | 否 | ~8 |
| 20 | `src/dao/kcScheduler.ts:97` | `subscribeKcSyncState` | 无（仅定义处；注释里提到不算） | 0 | unused ns-export | **删** | 否 | ~7 |
| 21 | `src/dao/kcScheduler.ts:104` | `getKcSyncState` | 无（仅定义处；注释里提到不算） | 0 | unused ns-export | **删** | 否 | ~8 |
| 22 | `src/dao/kcScheduler.ts:112` | `shouldShowKcPersistentHint` | 无（仅定义处；注释里提到不算） | 0 | unused ns-export | **删** | 否 | ~4 |
| 23 | `src/dao/kcSmallCloud.ts:234` | `pushAllSmall` | 无（仅定义处；注释里提到不算） | 0 | unused ns-export | **删** | 否 | ~16 |
| 24 | `src/dao/kcSmallCloud.ts:250` | `pullAllSmall` | 无（仅定义处；注释里提到不算） | 0 | unused ns-export | **删** | 否 | ~12 |
| 25 | `src/dao/words.ts:88` | `putRaw` | 无（仅定义处；注释里提到不算） | 0 | unused ns-export | **删** | 否 | ~9 |
| 26 | `src/dao/words.ts:97` | `putRawMany` | 无（仅定义处；注释里提到不算） | 0 | unused ns-export | **删** | 否 | ~12 |
| 27 | `src/dao/words.ts:109` | `updateSenses` | 无（仅定义处；注释里提到不算） | 0 | unused ns-export | **删** | 否 | ~11 |
| 28 | `src/dao/words.ts:171` | `setWordPriorityByIdMany` | 无（仅定义处；注释里提到不算） | 0 | unused ns-export | **删** | 否 | ~31 |
| 29 | `src/dao/words.ts:202` | `applySenseRewrite` | 无（仅定义处；注释里提到不算） | 0 | unused ns-export | **删** | 否 | ~25 |
| 30 | `src/dao/words.ts:483` | `maxLearnOrder` | 无（仅定义处；注释里提到不算） | 0 | unused ns-export | **删** | 否 | ~8 |
| 31 | `src/dao/words.ts:497` | `newId` | 无（仅定义处；注释里提到不算） | 0 | unused ns-export | **删** | 否 | ~4 |
| 32 | `src/services/kcAi.ts:215` | `kcAiConfig` | 无（仅定义处；注释里提到不算） | 0 | unused export | **删** | 否 | ~4 |
| 33 | `src/services/reparse.ts:50` | `ReparseBatchOutcome` | 无（仅定义处；注释里提到不算） | 0 | unused export | **删** | 否 | ~6 |
| 34 | `src/ui/components/kcBlockTypes.ts:58` | `examTypeLabel` | 无（仅定义处；注释里提到不算） | 0 | unused export | **删** | 否 | ~4 |
| 35 | `src/ui/dom.ts:99` | `qs` | 无（仅定义处；注释里提到不算） | 0 | unused export | **删** | 否 | ~7 |
| 36 | `src/ui/pages/kcSettings/kcSettingsCtx.ts:106` | `currentKcSettings` | 无（仅定义处；注释里提到不算） | 0 | unused export | **删** | 否 | ~4 |
| 37 | `src/ui/pages/KcWordBridge.ts:136` | `BRIDGE_SKIP_HINT` | 无（仅定义处；注释里提到不算） | 0 | unused export | **删** | 否 | ~2 |
| 38 | `src/ui/pages/list/ListTable.ts:261` | `attrsNumberPatch` | 无（仅定义处；注释里提到不算） | 0 | unused export | **删** | 否 | ~4 |
| 39 | `src/ui/pages/settings/layoutDraft.ts:225` | `draftPatch` | 无（仅定义处；注释里提到不算） | 0 | unused export | **删** | 否 | ~6 |
| 40 | `src/ui/pages/settings/layoutObserve.ts:102` | `ensureSnapshot` | 无（仅定义处；注释里提到不算） | 0 | unused export | **删** | 否 | ~6 |
| 41 | `src/ui/pages/settings/layoutObserve.ts:125` | `isObserving` | 无（仅定义处；注释里提到不算） | 0 | unused export | **删** | 否 | ~10 |
| 42 | `src/ui/pages/settings/LayoutSection.ts:437` | `clampLayoutValue` | 无（仅定义处；注释里提到不算） | 0 | unused export | **删** | 否 | ~5 |
| 43 | `src/ui/router.ts:127` | `refresh` | 无（仅定义处；注释里提到不算） | 0 | unused export | **删** | 否 | ~4 |
| | | | | | | | **合计** | **~429** |

**抽验记录**（我逐个 grep 过的、最容易被误删的几条）：

| 符号 | 全库命中 | 真相 |
|---|---|---|
| `pickNextForLearn`（`core/pick.ts:246`） | 4 处 | **全部是注释**：`pick.ts:189`、`flow.ts:415`、`LearnPage.ts:48` 都在文字里提到它，代码实际已改用 `sortForLearn`。**注释与代码已脱节**，删除时顺手把注释里这句描述改掉 |
| `pickForReview`（`core/pick.ts:117`） | 10 处 | 其中 6 处是**二期的同名函数**（`kcReview/kcReviewFlow.ts:32`）+ 注释；一期这个确实零调用 |
| `applySenseRewrite`（`dao/words.ts:202`） | 6 处 | 活的路径是复数版 `applySenseRewriteMany`（`reparse.ts` / `ReparsePanel.ts`），单数版只剩定义 + 一句注释引用 |
| `newId`（`dao/words.ts:497`） | 25 处 | 其他 12 个文件各自定义了**同名局部函数**（`kcText.ts`、`kcCard.ts`…），与这个导出无关 |
| `clearAll`（`dao/contextWords.ts:198`） | 54 处 | `dao.kc.clearAll` / `dao.examBank.clearAll` / `dao.words.clearAll` 都在用；**`dao.contextWords.clearAll` 无任何调用**（`getAll` 同理） |
| `qs` / `refresh`（`ui/dom.ts:99`、`ui/router.ts:127`） | 0 处 | 彻底零引用（连注释都没有） |
| `setWordPriorityByIdMany` / `updateSenses` / `maxLearnOrder` / `putRawMany` / `putRaw` | 1 处 | 只有自己的定义行 |

> ⚠️ 两条**必须连带改**的：
> 1. `src/core/presets.ts` 是**自动生成**的（文件头写着「不要手改」）。里面的 `findTier`（`:89`）来自 `scripts/build-presets.mjs` 第 129 行的**模板字符串**；只删产物不删模板，下次 `npm run presets` 会重新生成回来。
> 2. `dao/words.ts` 一次删 7 个导出（`putRaw` / `putRawMany` / `updateSenses` / `setWordPriorityByIdMany` / `applySenseRewrite` / `maxLearnOrder` / `newId`），删完建议跑 `test:sync` / `test:api`（DAO 是同步链路的根基）。

### 2.3 D 类：门面再导出、无人消费（42 条，建议删那一行）

这一类的共同点是：**实现是活的（别的地方在用），只是「挂在这个门面上的那个名字」没人消费**。
典型是 `src/core/kcModel.ts`（32 行的统一出口门面）与 `src/services/tts.ts`（46 行的兼容门面）—— 门面本身要留，删的是里面**没人用的那一行**。

| # | 位置 | 名字 | 在哪被再导出 | 处置 |
|---|---|---|---|---|
| 1 | `src/core/kcCard.ts:26` | `createEmptyAttrs` | `src/core/kcModel.ts:24` | 删掉那行再导出 |
| 2 | `src/core/kcCard.ts:39` | `createEmptyExamLoad` | `src/core/kcModel.ts:24` | 删掉那行再导出 |
| 3 | `src/core/kcExamTypes.ts:11` | `KNOWN_EXAM_TYPE_IDS` | `src/core/kcModel.ts:32` | 删掉那行再导出 |
| 4 | `src/services/tts/index.ts:208` | `pickVoice` | `src/services/tts.ts:19` | 删掉那行再导出 |
| 5 | `src/services/tts/index.ts:336` | `stop` | `src/services/tts.ts:19` | 删掉那行再导出 |
| 6 | `src/services/tts/youdao.ts:36` | `YOUDAO_TTS_ENDPOINT` | `src/services/tts/index.ts:41` | 删掉那行再导出 |
| 7 | `src/services/tts/youdao.ts:62` | `YOUDAO_ERRORS` | `src/services/tts/index.ts:41` | 删掉那行再导出 |
| 8 | `src/services/tts/youdao.ts:73` | `YoudaoTtsError` | `src/services/tts/index.ts:41`、`src/services/tts.ts:45` | 删掉那行再导出 |
| 9 | `src/services/tts/youdao.ts:94` | `makeSalt` | `src/services/tts/index.ts:41` | 删掉那行再导出 |
| 10 | `src/services/tts/youdao.ts:155` | `buildSignedForm` | `src/services/tts/index.ts:41` | 删掉那行再导出 |
| 11 | `src/services/tts/youdao.ts:192` | `readYoudaoResponse` | `src/services/tts/index.ts:41` | 删掉那行再导出 |
| 12 | `src/core/db.ts:21` | `DB_NAME` | 门面/别名再导出（export { x as y } from，knip 单独报出） | 删掉那行再导出 |
| 13 | `src/core/db.ts:21` | `DB_VERSION` | 门面/别名再导出（export { x as y } from，knip 单独报出） | 删掉那行再导出 |
| 14 | `src/core/db.ts:21` | `releaseConnections` | 门面/别名再导出（export { x as y } from，knip 单独报出） | 删掉那行再导出 |
| 15 | `src/core/db.ts:21` | `repairUpgrade` | 门面/别名再导出（export { x as y } from，knip 单独报出） | 删掉那行再导出 |
| 16 | `src/core/db.ts:22` | `withStore` | 门面/别名再导出（export { x as y } from，knip 单独报出） | 删掉那行再导出 |
| 17 | `src/core/kcModel.ts:22` | `clamp01` | 门面/别名再导出（export { x as y } from，knip 单独报出） | 删掉那行再导出 |
| 18 | `src/core/kcModel.ts:26` | `createEmptyAttrs` | 门面/别名再导出（export { x as y } from，knip 单独报出） | 删掉那行再导出 |
| 19 | `src/core/kcModel.ts:27` | `createEmptyExamLoad` | 门面/别名再导出（export { x as y } from，knip 单独报出） | 删掉那行再导出 |
| 20 | `src/core/kcModel.ts:32` | `KNOWN_EXAM_TYPE_IDS` | 门面/别名再导出（export { x as y } from，knip 单独报出） | 删掉那行再导出 |
| 21 | `src/core/kcModel.ts:32` | `filterExamTags` | 门面/别名再导出（export { x as y } from，knip 单独报出） | 删掉那行再导出 |
| 22 | `src/core/model.ts:39` | `backfillExamCount` | 门面/别名再导出（export { x as y } from，knip 单独报出） | 删掉那行再导出 |
| 23 | `src/dao/kcCloud.ts:44` | `kcCloudReady`（命名空间 `dao`） | 门面/别名再导出（export { x as y } from，knip 单独报出） | 删掉那行再导出 |
| 24 | `src/dao/kcScheduler.ts:30` | `SyncPhase`（命名空间 `dao`） | 门面/别名再导出（export { x as y } from，knip 单独报出） | 删掉那行再导出 |
| 25 | `src/dao/kcScheduler.ts:30` | `SyncState`（命名空间 `dao`） | 门面/别名再导出（export { x as y } from，knip 单独报出） | 删掉那行再导出 |
| 26 | `src/dao/syncScheduler.ts:20` | `SyncPhase`（命名空间 `dao`） | 门面/别名再导出（export { x as y } from，knip 单独报出） | 删掉那行再导出 |
| 27 | `src/services/tts.ts:25` | `isThirdPartyDisabled` | 门面/别名再导出（export { x as y } from，knip 单独报出） | 删掉那行再导出 |
| 28 | `src/services/tts.ts:27` | `normalizeForSpeech` | 门面/别名再导出（export { x as y } from，knip 单独报出） | 删掉那行再导出 |
| 29 | `src/services/tts.ts:29` | `pickVoice` | 门面/别名再导出（export { x as y } from，knip 单独报出） | 删掉那行再导出 |
| 30 | `src/services/tts.ts:30` | `resetSpeechDedupe` | 门面/别名再导出（export { x as y } from，knip 单独报出） | 删掉那行再导出 |
| 31 | `src/services/tts.ts:34` | `speakAsync` | 门面/别名再导出（export { x as y } from，knip 单独报出） | 删掉那行再导出 |
| 32 | `src/services/tts.ts:35` | `stop` | 门面/别名再导出（export { x as y } from，knip 单独报出） | 删掉那行再导出 |
| 33 | `src/services/tts.ts:38` | `LastThirdPartyResult` | 门面/别名再导出（export { x as y } from，knip 单独报出） | 删掉那行再导出 |
| 34 | `src/services/tts.ts:39` | `SpeakOptions` | 门面/别名再导出（export { x as y } from，knip 单独报出） | 删掉那行再导出 |
| 35 | `src/services/tts.ts:42` | `TtsProvider` | 门面/别名再导出（export { x as y } from，knip 单独报出） | 删掉那行再导出 |
| 36 | `src/services/tts.ts:44` | `isBrowserSpeechSupported` | 门面/别名再导出（export { x as y } from，knip 单独报出） | 删掉那行再导出 |
| 37 | `src/services/tts.ts:45` | `createYoudaoProvider` | 门面/别名再导出（export { x as y } from，knip 单独报出） | 删掉那行再导出 |
| 38 | `src/services/tts.ts:45` | `YoudaoTtsError` | 门面/别名再导出（export { x as y } from，knip 单独报出） | 删掉那行再导出 |
| 39 | `src/services/tts/index.ts:38` | `TtsProvider` | 门面/别名再导出（export { x as y } from，knip 单独报出） | 删掉那行再导出 |
| 40 | `src/services/tts/index.ts:39` | `normalizeForSpeech` | 门面/别名再导出（export { x as y } from，knip 单独报出） | 删掉那行再导出 |
| 41 | `src/services/tts/index.ts:40` | `pickBrowserVoice` | 门面/别名再导出（export { x as y } from，knip 单独报出） | 删掉那行再导出 |
| 42 | `src/services/tts/index.ts:48` | `isBrowserSpeechSupported` | 门面/别名再导出（export { x as y } from，knip 单独报出） | 删掉那行再导出 |

> 特别说明 `src/services/tts.ts`：这是「为了让 `import ... from '../services/tts'` 不歧义」而保留的兼容层（文件头注释解释了原因）。
> 实测：真正被消费的只有 `speak` / `cancelSpeak`（`paper/flow.ts`）等少数几个；其余 10 个再导出（`isThirdPartyDisabled` / `normalizeForSpeech` / `pickVoice` / `resetSpeechDedupe` / `speakAsync` / `stop` / `isBrowserSpeechSupported` / `createYoudaoProvider` / `YoudaoTtsError` / `TtsProvider`…）无人使用。
> **建议**：保留 `speak`/`cancelSpeak` 两行，其余删掉；或整体改成直接 `export { speak, cancelSpeak } from './tts/index'`。

### 2.4 C2 类：只被自检 / 开发工具引用（41 条，**待你拍板**）

这一类**不能按普通死代码处理**：本项目的自检是唯一护栏，这些导出正是**刻意的测试接缝**（为了让 Node 里的自检能直接调内部函数而导出）。
删掉它们就必须同步改写对应测试；保留则「业务代码为了测试而扩大导出面」。

| # | 位置 | 符号 | 使用者（dev/测试） | knip | 建议 | 需拍板 |
|---|---|---|---|---|---|---|
| 1 | `src/core/blockRender.ts:28` | `BLOCK_CLASS` | `src/dev/kcXssSelftest.ts:9` | — | 待决 | **是** |
| 2 | `src/core/blockRender.ts:71` | `renderBlock` | `src/dev/kcXssSelftest.ts:9` | — | 待决 | **是** |
| 3 | `src/core/dbSchema.ts:214` | `backfillExamCountRow` | `src/dev/t2Migrate.ts:15` | — | 待决 | **是** |
| 4 | `src/core/kcPriority.ts:103` | `computeKcPriority` | `src/dev/kcSelftest.ts:19`、`api/_dev/test-kc.mjs:57` | — | 待决 | **是** |
| 5 | `src/core/layout.ts:89` | `jitteredGrid` | `src/dev/selftest.ts:18`、`api/_dev/test-mobile.mjs:32`、`api/_dev/test-paper.mjs:23` | — | 待决 | **是** |
| 6 | `src/core/layout.ts:547` | `spacingBudget` | `api/_dev/test-paper.mjs:23` | — | 待决 | **是** |
| 7 | `src/core/model.ts:63` | `createWord` | `src/dev/selftest.ts:5`、`api/_dev/test-kc-e2e.mjs:132`、`api/_dev/test-kc-review-ui.mjs:104` 等 5 处 | — | 待决 | **是** |
| 8 | `src/core/model.ts:190` | `stripPosPrefix` | `src/dev/selftest.ts:5` | — | 待决 | **是** |
| 9 | `src/core/model.ts:274` | `wordMatch` | `api/_dev/test-sense-rules.mjs:25` | — | 待决 | **是** |
| 10 | `src/core/pick.ts:93` | `recommendReviewCount` | `src/dev/selftest.ts:19` | — | 待决 | **是** |
| 11 | `src/core/pick.ts:173` | `groupWords` | `src/dev/selftest.ts:19` | — | 待决 | **是** |
| 12 | `src/core/priority.ts:12` | `DEFAULT_FAIL_RATE` | `api/_dev/test-t2-ui.mjs:187`、`api/_dev/test-t2-ui.mjs:251` | unused | 待决 | **是** |
| 13 | `src/core/priority.ts:75` | `ALLOWED_VARS` | `api/_dev/test-t2-ui.mjs:187`、`api/_dev/test-t2-ui.mjs:251` | unused | 待决 | **是** |
| 14 | `src/core/senseRules.ts:68` | `ALIAS_SEPARATORS` | `api/_dev/test-sense-rules.mjs:22` | — | 待决 | **是** |
| 15 | `src/core/senseRules.ts:162` | `validateSenseShape` | `api/_dev/test-sense-rules.mjs:22` | — | 待决 | **是** |
| 16 | `src/dao/contextWords.ts:182` | `dedupe` | `api/_dev/test-kc-exam.mjs:51` | — | 待决 | **是** |
| 17 | `src/dao/examBank.ts:103` | `listByCard` | `api/_dev/test-kc-exam.mjs:51` | — | 待决 | **是** |
| 18 | `src/dao/kc.ts:141` | `updateExamTags` | `api/_dev/test-kc.mjs:53` | — | 待决 | **是** |
| 19 | `src/dao/kcCloud.ts:269` | `kcStatus` | `api/_dev/test-kc.mjs:54` | — | 待决 | **是** |
| 20 | `src/dao/kcQuery.ts:61` | `filterCards` | `api/_dev/test-kc-edit.mjs:40` | — | 待决 | **是** |
| 21 | `src/dao/kcSession.ts:113` | `load` | `api/_dev/test-kc-review.mjs:40`、`api/_dev/test-kc-session.mjs:39` | — | 待决 | **是** |
| 22 | `src/dao/kcSession.ts:149` | `clearOpen` | `api/_dev/test-kc-e2e.mjs:128`、`api/_dev/test-kc-e2e.mjs:267`、`api/_dev/test-kc-e2e.mjs:353` 等 17 处 | — | 待决 | **是** |
| 23 | `src/dao/settings.ts:96` | `reset` | `api/_dev/test-kc-settings.mjs:42` | — | 待决 | **是** |
| 24 | `src/dao/sources.ts:90` | `remove` | `src/dev/selftest.ts:22` | — | 待决 | **是** |
| 25 | `src/dao/syncScheduler.ts:52` | `getSyncState` | `api/_dev/test-sync.mjs:307` | — | 待决 | **是** |
| 26 | `src/dao/words.ts:31` | `getById` | `src/dev/selftest.ts:22`、`api/_dev/test-e2e.mjs:38`、`api/_dev/test-sync.mjs:45` | — | 待决 | **是** |
| 27 | `src/dao/words.ts:40` | `getByEn` | `src/dev/selftest.ts:22` | — | 待决 | **是** |
| 28 | `src/services/ai.ts:349` | `PARSE_SYSTEM_PROMPT` | `api/_dev/test-r4.mjs:25`、`api/_dev/test-sense-rules.mjs:26` | — | 待决 | **是** |
| 29 | `src/services/ai.ts:403` | `coerceParsedWord` | `api/_dev/test-r4.mjs:25`、`api/_dev/test-sense-rules.mjs:26` | — | 待决 | **是** |
| 30 | `src/services/kcExamAi.ts:38` | `cardBlocksText` | `api/_dev/test-kc-exam.mjs:47` | — | 待决 | **是** |
| 31 | `src/services/kcImportParse.ts:88` | `clampEstMinutes` | `api/_dev/test-kc-import.mjs:41` | — | 待决 | **是** |
| 32 | `src/services/tts/index.ts:76` | `isThirdPartyDisabled` | `api/_dev/test-t4-ui.mjs:307`、`api/_dev/test-t4-ui.mjs:313`、`api/_dev/test-t4-ui.mjs:411` 等 12 处 | unused | 待决 | **是** |
| 33 | `src/services/tts/index.ts:109` | `resetSpeechDedupe` | `api/_dev/test-t3-ui.mjs:449`、`api/_dev/test-t3-ui.mjs:460` | unused | 待决 | **是** |
| 34 | `src/services/tts/index.ts:235` | `speakAsync` | `api/_dev/test-t4-ui.mjs:307`、`api/_dev/test-t4-ui.mjs:313`、`api/_dev/test-t4-ui.mjs:411` 等 12 处 | unused | 待决 | **是** |
| 35 | `src/services/tts/youdao.ts:107` | `youdaoSignInput` | `src/dev/selftest.ts:435`、`api/_dev/test-t4-ui.mjs:624` | — | 待决 | **是** |
| 36 | `src/services/tts/youdao.ts:119` | `sha256Hex` | `src/dev/selftest.ts:435` | — | 待决 | **是** |
| 37 | `src/services/tts/youdao.ts:134` | `youdaoSign` | `src/dev/selftest.ts:435`、`src/dev/selftest.ts:525`、`api/_dev/test-t4-ui.mjs:624` | — | 待决 | **是** |
| 38 | `src/ui/components/Toast.ts:13` | `UNDO_WINDOW_MS` | `api/_dev/test-r4.mjs:28` | — | 待决 | **是** |
| 39 | `src/ui/pages/kcBank/kcBankImport.ts:38` | `guessBankType` | `api/_dev/test-kc-settings.mjs:40` | — | 待决 | **是** |
| 40 | `src/ui/pages/kcExam/kcExamFlow.ts:158` | `collectMaterials` | `api/_dev/test-kc-exam.mjs:48` | — | 待决 | **是** |
| 41 | `src/ui/pages/kcReview/kcReviewFlow.ts:19` | `reviewCandidates` | `api/_dev/test-kc-review.mjs:39` | — | 待决 | **是** |

**建议的默认处置**（供你参考，不是替你决定）：

- **倾向保留**：`backfillExamCountRow`（`dbSchema.ts:214`，`src/dev/t2Migrate.ts` 的迁移入口，HANDOVER 明确要求「真实升级与测试入口共用同一份实现」）、`renderBlock` / `BLOCK_CLASS`（`blockRender.ts`，被 XSS 自检用）、`PARSE_SYSTEM_PROMPT` / `coerceParsedWord`（`ai.ts`，被 `test:r4` 的提示词逐字比对与义项回归用）、`UNDO_WINDOW_MS`（`Toast.ts`，被 `test:r4` 断言 ≥8000）。
- **可考虑删**：`dao/kcSession.ts` 的 `load` / `clearOpen`（只在测试里用来清理会话）、`dao/settings.ts reset`、`dao/words.ts getByEn`、`ui/dom.ts` 里的相关辅助 —— 但这些都属「删了要改测试」，收益很小。
- **另一个方向**：与其删，不如把这些接缝**集中到一个 `src/dev/testSeams.ts`**（或给它们加 `/** @internal 仅供自检 */` 标记），让「业务导出面」与「测试接缝」在目录上分开。

### 2.5 B 类：建议「降为私有」（220 条 / 98 个文件）

判定：**没有任何外部消费者，但本文件内部仍在使用** → 只需去掉 `export` 关键字，**一行实现都不用删**。
这是数量最大、风险最低、但收益也最小的一类（主要是类型/接口与内部工具函数）。

| # | 文件 | 条数 | 可去 `export` 的符号（名字@行号） |
|---|---|---|---|
| 1 | `api/_dev/harness.mjs` | 2 | ROUTES@23、createMockResponse@45 |
| 2 | `api/_lib/inventory.ts` | 4 | WordRow@13、SourceRow@38、ExistingRow@78、MaxUpdated@223 |
| 3 | `api/_lib/kcInventory.ts` | 1 | KcCardRow@17 |
| 4 | `api/_lib/kcValidate.ts` | 1 | normalizeCard@83 |
| 5 | `api/_lib/spaceAuth.ts` | 1 | getSpaceKey@48 |
| 6 | `api/_lib/validate.ts` | 3 | CoercedBatch@12、coerceWord@107、coerceSource@141 |
| 7 | `scripts/build-presets.mjs` | 2 | PresetTier@105、PRESET_TIERS@121 |
| 8 | `scripts/preset-lib.mjs` | 3 | displayEn@61、parseTabbed@83、parseIelts@130 |
| 9 | `scripts/youdaoSign.mjs` | 3 | signInput@66、youdaoSign@75、signedForm@86 |
| 10 | `src/core/config.ts` | 3 | LAYOUT_LIMITS@73、LayoutNumericKey@84、NumRange@87 |
| 11 | `src/core/kcPriority.ts` | 4 | weightsOf@30、scoreGap@53、daysSinceReview@83、ScorePatch@128 |
| 12 | `src/core/kcPriorityExpr.ts` | 2 | KcExprCheck@54、kcExprScope@64 |
| 13 | `src/core/kcTypes.ts` | 1 | KcCloudCursor@218 |
| 14 | `src/core/layout.ts` | 10 | JitteredGridOptions@10、DEFAULT_GRID_MARGIN@65、WordLayoutOptions@350、SpacingBudget@512、WORD_ROW_PADDING_PX@580、WORD_H_PADDING_PHONE_PX@593、WORD_V_PADDING_PHONE_PX@594、WORD_H_PADDING_DESKTOP_PX@595、WORD_V_PADDING_DESKTOP_PX@596、shuffledIndexes@747 |
| 15 | `src/core/merge.ts` | 3 | ConflictAction@22、ImportPlan@25、resolveConflict@46 |
| 16 | `src/core/model.ts` | 2 | defaultAttrs@15、posPrefixOf@180 |
| 17 | `src/core/parser.ts` | 3 | ParsedEntry@8、ParseError@14、ParseResult@21 |
| 18 | `src/core/pick.ts` | 1 | shuffle@14 |
| 19 | `src/core/priority.ts` | 3 | ExprCheck@94、exprScope@167、evalPriority@213 |
| 20 | `src/core/senseRules.ts` | 2 | SENSE_TEXT_FORBIDDEN_SEPARATORS@71、SenseLike@119 |
| 21 | `src/core/syncHelper.ts` | 1 | sha256@14 |
| 22 | `src/core/types.ts` | 9 | PriorityDir@35、DisplaySettings@201、ParseSettings@215、PrioritySettings@229、LearnPickSettings@239、AiSettings@245、PracticeSettings@259、BackupSettings@316、CloudSettings@327 |
| 23 | `src/core/version.ts` | 1 | appVersion@9 |
| 24 | `src/dao/cloudSync.ts` | 2 | CloudStatus@44、OverwriteMode@56 |
| 25 | `src/dao/contextWords.ts` | 1 | getAll@68 |
| 26 | `src/dao/kc.ts` | 1 | KcMetaPatch@146 |
| 27 | `src/dao/kcCloud.ts` | 6 | KcSyncResult@53、KcPullResult@61、KcPushResult@71、kcPull@83、kcPush@113、applyRemote@153 |
| 28 | `src/dao/kcCloudHttp.ts` | 2 | ServerKcCard@21、KcEndpoint@52 |
| 29 | `src/dao/kcQuery.ts` | 4 | DEFAULT_SORT@26、DEFAULT_ORDER@28、sortCards@83、paginate@108 |
| 30 | `src/dao/kcSmallCloud.ts` | 3 | SmallTableKey@19、pushSmallTable@177、pullSmallTable@200 |
| 31 | `src/dao/sources.ts` | 2 | putRaw@46、create@64 |
| 32 | `src/dao/syncMap.ts` | 2 | WordPayload@44、SourcePayload@63 |
| 33 | `src/dao/syncScheduler.ts` | 1 | shouldShowPersistentHint@82 |
| 34 | `src/dao/syncSchedulerFactory.ts` | 2 | SyncPhase@26、SyncSchedulerOptions@45 |
| 35 | `src/dao/syncServer.ts` | 2 | PullData@26、PushData@34 |
| 36 | `src/dev/kcSelftest.ts` | 4 | runMasterySelfTest@35、runDataSelfTest@122、runAll@218、KcSelfTestApi@228 |
| 37 | `src/dev/layoutProbe.ts` | 3 | WordBox@26、GapPair@39、collectLayoutProbe@208 |
| 38 | `src/dev/selftest.ts` | 9 | SelfTestResult@25、runDataSelfTest@43、runParserSelfTest@100、runEndpointSelfTest@123、runCoreSelfTest@139、runPickSelfTest@172、runLayoutSelfTest@289、runPhraseSelfTest@338、YOUDAO_SIGN_SAMPLE@422 |
| 39 | `src/dev/t2Migrate.ts` | 1 | ExamCountBackfillResult@24 |
| 40 | `src/services/ai.ts` | 3 | AiRoute@40、ParseBatchResult@72、MergeSuggestionResult@502 |
| 41 | `src/services/backup.ts` | 3 | BackupFile@11、buildBackupFile@22、backupFileName@121 |
| 42 | `src/services/fileParse.ts` | 5 | ParsedFileType@20、extensionOf@72、normalizeText@105、countLines@120、decodeTextFile@151 |
| 43 | `src/services/kcExamAi.ts` | 2 | KC_EXAM_TIMEOUT_MS@27、KC_CONTEXT_TIMEOUT_MS@29 |
| 44 | `src/services/kcExamParse.ts` | 1 | parseReplyJson@21 |
| 45 | `src/services/kcImportParse.ts` | 2 | coerceImportCard@162、extractCardsArray@255 |
| 46 | `src/services/localfile.ts` | 1 | FsPermission@22 |
| 47 | `src/services/parsePipeline.ts` | 2 | PipelineProgress@12、PipelineOptions@21 |
| 48 | `src/services/presetVocab.ts` | 1 | LoadedPreset@34 |
| 49 | `src/services/pwa.ts` | 1 | isStandalone@27 |
| 50 | `src/services/reparse.ts` | 6 | REPARSE_BATCH_DELAY_MS@25、ReparseSenses@31、ReparseOptions@56、ReparseResult@68、REPARSE_SYSTEM_PROMPT@84、ReparseJobState@355 |
| 51 | `src/services/tts/browser.ts` | 1 | BrowserSpeakOptions@42 |
| 52 | `src/state/store.ts` | 2 | Store@5、createStore@15 |
| 53 | `src/ui/components/BlockEditor.ts` | 1 | BlockEditorOptions@22 |
| 54 | `src/ui/components/ErrorBoundary.ts` | 1 | showFatal@57 |
| 55 | `src/ui/components/ExamTaker.ts` | 1 | KcExamTakerHandlers@39 |
| 56 | `src/ui/components/HintButton.ts` | 2 | HINT_LABEL@36、HINT_UNSUPPORTED_TEXT@39 |
| 57 | `src/ui/components/KcBlockFields.ts` | 1 | BlockChange@16 |
| 58 | `src/ui/components/KcCardPreview.ts` | 3 | KcPreviewData@23、KcPreviewHandlers@32、KC_PREVIEW_STATE_TEXT@41 |
| 59 | `src/ui/components/KcChatPanel.ts` | 2 | ChatEntry@22、KcChatHandlers@40 |
| 60 | `src/ui/components/KcContextBar.ts` | 1 | KcContextBarHandlers@11 |
| 61 | `src/ui/components/KcContextManager.ts` | 2 | KcContextManager@21、openBankAddDialog@151 |
| 62 | `src/ui/components/KcCountPicker.ts` | 1 | KcPickerOptions@11 |
| 63 | `src/ui/components/KcFinishPanel.ts` | 1 | KcFinishAction@11 |
| 64 | `src/ui/components/KcStudyCardView.ts` | 2 | KcStudyCardHandlers@20、SELF_RATINGS@28 |
| 65 | `src/ui/components/Modal.ts` | 2 | ModalAction@4、ModalOptions@11 |
| 66 | `src/ui/components/Pagination.ts` | 1 | PaginationOptions@4 |
| 67 | `src/ui/components/PriorityConflict.ts` | 3 | ConflictResolution@29、rememberConflict@65、PriorityConflictAnswer@77 |
| 68 | `src/ui/components/PrioritySelect.ts` | 1 | clampPriority@25 |
| 69 | `src/ui/components/ReparseDiff.ts` | 1 | ReparseApplyResult@29 |
| 70 | `src/ui/components/SenseEditor.ts` | 1 | SenseEditorOptions@7 |
| 71 | `src/ui/components/SpeechGate.ts` | 2 | needsSpeechUnlock@26、unlockSpeech@70 |
| 72 | `src/ui/components/Toast.ts` | 2 | ToastType@4、UndoToastOptions@77 |
| 73 | `src/ui/components/WordCard.ts` | 1 | WordCardOptions@11 |
| 74 | `src/ui/components/examKeys.ts` | 2 | ExamEnterAction@33、ExamControls@41 |
| 75 | `src/ui/components/kcBlockTypes.ts` | 1 | BLOCK_TYPE_ORDER@26 |
| 76 | `src/ui/components/kcChatHistory.ts` | 1 | HistorySourceEntry@25 |
| 77 | `src/ui/components/kcStudyDialogs.ts` | 1 | confirmDialog@52 |
| 78 | `src/ui/device.ts` | 2 | DeviceKind@17、mobileBandHeightPx@56 |
| 79 | `src/ui/dom.ts` | 4 | DomProps@10、clear@80、replace@89、Debounced@106 |
| 80 | `src/ui/pages/KcWordBridge.ts` | 1 | KcWordBridgeHandlers@23 |
| 81 | `src/ui/pages/import/InputPanel.ts` | 2 | InputState@14、InputPanel@30 |
| 82 | `src/ui/pages/import/JobPanel.ts` | 1 | JobPanel@6 |
| 83 | `src/ui/pages/kcBank/kcBankImport.ts` | 1 | ParsedBankItem@19 |
| 84 | `src/ui/pages/kcChopUndo.ts` | 1 | ChopKcCardOptions@34 |
| 85 | `src/ui/pages/kcExam/kcExamFlow.ts` | 3 | ExamMaterials@65、RoundMaterials@77、pickType@123 |
| 86 | `src/ui/pages/kcExam/kcExamState.ts` | 1 | ExamPhase@21 |
| 87 | `src/ui/pages/kcList/KcListFilters.ts` | 1 | KcFilterHandlers@22 |
| 88 | `src/ui/pages/list/BatchBar.ts` | 1 | BatchBarOptions@5 |
| 89 | `src/ui/pages/list/ListFilters.ts` | 1 | ListFiltersOptions@53 |
| 90 | `src/ui/pages/merge/MergeCard.ts` | 1 | MergeCardOptions@8 |
| 91 | `src/ui/pages/merge/drafts.ts` | 1 | DraftStats@19 |
| 92 | `src/ui/pages/merge/reanalyze.ts` | 1 | ApplyResult@43 |
| 93 | `src/ui/pages/paper/PaperStage.ts` | 1 | PaperStageOptions@19 |
| 94 | `src/ui/pages/paper/flow.ts` | 2 | FlowOptions@24、PaperFlow@57 |
| 95 | `src/ui/pages/settings/layoutDraft.ts` | 8 | LAYOUT_TIER_KEYS@55、LAYOUT_FIELD_KEYS@58、LAYOUT_BUTTON_FIELD_KEYS@66、LayoutDraft@69、cloneLayout@87、savedLayout@99、sameLayout@124、editDraft@145 |
| 96 | `src/ui/pages/settings/layoutObserve.ts` | 6 | OBSERVE_WINDOW_MS@40、LayoutSnapshot@46、readSnapshot@59、writeSnapshot@82、ApplyLayoutOptions@108、stopObserving@135 |
| 97 | `src/ui/pages/settings/layoutPreview.ts` | 3 | PreviewViewport@41、PREVIEW_VIEWPORT@53、PreviewResult@69 |
| 98 | `src/ui/router.ts` | 1 | RouteRender@14 |

> 注意：`src/core/types.ts`、`src/core/kcTypes.ts` 里的接口很多属于「**公共类型契约**」，即使当前无人 import，也不建议去 `export`（它们是这一层数据结构的对外说明，去掉会让后来者以为不能复用）。
> 建议：**这一类只对 `core/`、`dao/`、`ui/components/` 里的**内部辅助函数与私有选项类型执行；对 `*Types.ts` 直接跳过。

### 2.6 依赖（package.json）

| # | 位置 | 项 | knip 判定 | 建议 | 需拍板 | 备注 |
|---|---|---|---|---|---|---|
| 1 | `package.json` | 全部 dependencies / devDependencies | **无未使用依赖** | 留 | 否 | `@libsql/client`(api) / `mammoth`(动态) / `pdfjs-dist`(动态) / `fake-indexeddb`(测试) / `typescript` / `vite` / `@types/node` 全部有引用 |
| 2 | `scripts/preflight.mjs:67` | `esbuild` | unlisted dependency | 二选一：显式加进 devDependencies，或在 preflight 里改成 `createRequire` 探测 | 是 | 它其实是 `vite` 的传递依赖；现在能跑但不稳 |
| 3 | `scripts/run-live.mjs` / `run-e2e.mjs` | `reg` | unlisted binary | **忽略** | 否 | 误报：`reg` 是 Windows 读系统代理的命令行工具 |
| 4 | `blank-sheet-vocab-proxy/package.json` | `typescript` + `wrangler` | — | 随 F1 一起决定 | 是 | 独立小项目，有 `typecheck`/`deploy` 脚本 |

### 2.7 路由（20 条，逐条核对入站引用）

口径：在全仓（含测试与注释）里搜该路由的字符串字面量出现次数。**没有任何一条是零引用**。

| # | 路由 | 出现次数 | 产品入口 | 建议 |
|---|---|---|---|---|
| 1 | `#/home` | 46 | 兜底 + 顶栏 + 各处导航 | 留 |
| 2 | `#/import` | 10 | 顶栏 / 首页 / 合并页 | 留 |
| 3 | `#/merge` | 11 | 录入完成后自动跳 | 留 |
| 4 | `#/list` | 15 | 顶栏 / 首页 | 留 |
| 5 | `#/settings` | 16 | 顶栏 / 首页 / 多处 | 留 |
| 6 | `#/learn` | 27 | 顶栏 / 首页 | 留 |
| 7 | `#/memorize` | 2 | **无**（2 处全在 `api/_dev/test-r3.mjs` 的「路由仍然能用」断言里） | **待决（F4）** |
| 8 | `#/review` | 6 | 顶栏 / 首页 | 留 |
| 9 | `#/about` | 5 | footer / 设置页数据区 | 留 |
| 10 | `#/kc` | 97 | 顶栏 + 二期全部子路由前缀 | 留 |
| 11 | `#/kc/import` | 8 | 二期首页 / 卡片列表 / 学习页 / 复习页 | 留 |
| 12 | `#/kc/list` | 15 | 二期首页 / 编辑页 / 详情页 | 留 |
| 13 | `#/kc/edit` | 5 | 卡片列表（带 id） | 留 |
| 14 | `#/kc/view` | 1 | **只有** `KcCardListPage.ts:113` 一处 | 留（单入口，注意别误删） |
| 15 | `#/kc/study` | 9 | 二期首页 / 复习页 / 出题页 | 留 |
| 16 | `#/kc/exam` | 11 | 学习页 / 复习页 / 复习流程 | 留 |
| 17 | `#/kc/review` | 6 | 二期首页 / 学习页 | 留 |
| 18 | `#/kc/settings` | 5 | 二期首页 | 留 |
| 19 | `#/kc/bank` | 2 | 二期首页 | 留 |
| 20 | `#/dev/layout` | 1 | `src/main.ts:28` 短路 + `probeLayout.mjs --url ...#/dev/layout?probe=1` | 留（调试页，顶栏故意无入口） |

## 3. 功能块级待决（**这一节才是能真正减重的地方，必须你拍板**）

| # | 功能块 | 现状 | 还被谁调用 | 删掉会失去什么 | 能少多少行 | 建议 |
|---|---|---|---|---|---|---|
| **F1** | Cloudflare Worker 转发脚本（`blank-sheet-vocab-proxy/` 整个目录） | 与 `/api/ai-proxy` **功能完全重叠**；主项目只在 `vite.config.ts:51` 把它排除出前端构建 | 无人调用（独立部署产物） | 一个「不用 Vercel 也能自建转发」的备选方案；HANDOVER §12 自己就列为「建议合并，留一个」 | **1855 行**（其中 package-lock 1,635 行） | **建议删**（思路可留在 README/HANDOVER 里） |
| **F2** | 二期「三张小表」云同步整块 | DAO（`src/dao/kcSmallCloud.ts`）+ 3 个 API 路由 + `_lib/kcSmall*.ts` **全部实现完毕，但前端零调用点** | 只有测试间接覆盖 | 语境词 / 题目历史 / 题库目前只在本机；但**用户感知不到**（知识卡片本身是会同步的） | **1049 行** | **二选一**：① 接线（挂到二期调度器上）；② 删掉。**不要维持现状** |
| **F3** | 一次性迁移脚本 `scripts/fix-api-extensions.mjs` / `fix-api-paths.mjs` | 当初修线上故障用的一次性脚本，HANDOVER 原话「已完成，可删」 | 无人调用（也不在 package.json scripts 里） | 无（留痕价值已在 HANDOVER 记录） | **102 行** | **建议删** |
| **F4** | `#/memorize` 路由 + `MemorizePage` | 路由与页面都保留，**产品上已无入口**（R3 把记忆改成背诵流程的内嵌环节）；记忆引擎本身是活的 | 只有 `test-r3.mjs` 的「路由仍然能用」断言 | 一个「直达纯记忆模式」的隐藏入口（当前无 UI 可达） | **32 行** + 2 行路由注册 | **待决**（删则同时删 test-r3 那两条断言） |
| **F5** | 旧布点算法 `jitteredGrid()` + `spacingBudget()` | 注释明示「S3 起真实布点不用，只留给自检与诊断对照」 | `src/dev/selftest.ts`、`api/_dev/test-mobile.mjs`、`test-paper.mjs` | 布局自检里的「旧算法对照基线」 | **~240 行**（`layout.ts:89-225` + `:512-576` + 两个相关类型） | **待决**（建议保留：它是布局回归的对照物） |
| **F6** | `src/dev/layoutProbe.ts` | 布局测量模块，**被 `main.ts:131` 静态 import**（注释说明：动态导入会让 rollup 报 chunk 错），因此**进了生产包** | `#/dev/layout` 页 + `probeLayout.mjs` | 线上无头浏览器测量能力 | **424 行**（生产 bundle 里的字节数更值得关注） | **待决**：要么接受它进生产包，要么改成 `import.meta.env.DEV` 动态导入 |
| **F7** | `src/services/tts.ts` 兼容门面里的 10 个死再导出 | 门面部分存活（`speak` / `cancelSpeak` 在用） | 无人 | 无 | ~20 行 + 认知负担 | **建议删死的那部分**（见 §2.3） |
| **F8** | `.tmp/` 70 个文件 / 2.7 MB | 一次性诊断脚本 + JSON 转储 + `dev.db`；**gitignored，不进仓库** | 无人 | 无（历史调试残留） | 70 个文件 / **2.7 MB** | **建议删**（对「AI 读仓库变慢」的体感改善最直接） |
| **F9** | `.git-commit-msg.txt` | 被 git 跟踪的游离文件（历史 commit message 草稿） | 无人 | 一点点历史记录 | 41 行 | **建议删**或移入 `docs/` |

> **F10（附注，不是死代码）**：`public/r1-seed.html` 是测试种子页，但它在 `public/` 下，**会被原样部署到线上**（任何人可访问 `https://你的域名/r1-seed.html`）。功能无害，但如果你在意「线上不该有测试文件」，可以把它移到 `api/_dev/` 并用本地文件协议打开——这会牵动 `test-r1.mjs`，属独立小任务。

## 4. 不能动清单（写进下一位 AI 的约束里）

| 位置 | 为什么 |
|---|---|
| `api/*.ts`（11 个） | Vercel 约定「文件名 = 路由名」，无人 import 是正常的 |
| `api/_dev/loader-hooks.mjs` 的 `resolve` / `load` | Node ESM loader 钩子，按名调用 |
| `api/_dev/**`、`scripts/**`、`src/dev/**` | 26 组自检 + CDP 工具 + 产物模拟器 = 工程化资产 |
| `public/sw.js`、`public/manifest.webmanifest` | Service Worker / PWA 清单，按路径加载 |
| `public/presets/*.json`、`一期预设词库/` | 运行时词库素材，非代码 |
| `docs/`、`HANDOVER.md`、`AI_RULES.md` | 喂给 AI 的上下文本体 |
| `src/core/presets.ts` | **自动生成**，改要去改 `scripts/build-presets.mjs` |
| `#/dev/layout` 路由 + `probeLayout.mjs` | 生产保留的只读测量链路 |
| `src/core/*Types.ts` 里的类型 | 公共类型契约，即便零 import 也不建议去 export |

## 5. 删除阶段的执行建议（等你拍板后再动手）

| 波次 | 内容 | 预估 | 风险 | 校验 |
|---|---|---|---|---|
| **W1** | A1 类 43 个死导出（分批 ≤20） | ~429 行 | 低（knip + 绑定级双重零引用 + 已逐条抽验） | `npm test` + `npx tsc --noEmit` + `npm run build` |
| **W2** | D 类 42 行门面再导出 + F7 的 tts 门面收窄 | ~60 行 | 低 | 同上 + `test:t4-ui`（TTS 真浏览器） |
| **W3** | 文件级：`.git-commit-msg.txt`、`.tmp/**`、F3 两个迁移脚本 | 2.7 MB + ~140 行 | 极低 | `npm test` |
| **W4** | 你拍板通过的功能块（F1/F2/F4/F6 任一） | 240~3,900 行 | 中（涉及部署与测试） | `npm test` + `npm run test:live` + `npm run verify:api` |
| **W5（可选）** | B 类 220 条「降为私有」（**排除 `*Types.ts`**） | 0 行删除（只改 `export`） | 低但要跑 tsc | `npx tsc --noEmit` + `npm test` |

**每波纪律**：一个波次一个 commit，信息写清「删了哪一类」；上一波全绿才开下一波；任何一项红了立刻 `git revert`，**不要硬修**。

## 6. 附录：方法与可复现命令

```bash
# 1) 临时装 knip（--no-save：package.json / lock 都不动）
npm install --no-save knip

# 2) 跑分析（配置文件放在系统临时目录，仓库里不留任何东西）
npx knip --config "$env:TEMP\bkv-knip\knip.A.json" --directory . --no-progress --reporter json

# 3) 自研两层扫描（脚本同样放在临时目录）
node "$env:TEMP\bkv-scan.mjs"   # token 级引用 + 可达性闭包
node "$env:TEMP\bkv-refs.mjs" . # 绑定级消费者解析（含跨行链式访问与再导出链）
```

**工具已知局限**（报告里的每条结论都据此打了折扣）：

1. **字符串引用**：`execFileSync` 调脚本、CDP 打开页面、localStorage key、CSS 类名 —— knip 与自研解析器都看不见，只能靠人工（本轮因此救回了 `probeLayout.mjs` 与 `r1-seed.html`）。
2. **模板字符串里的代码**：`scripts/build-presets.mjs` 生成 `presets.ts` 的那段文本会被当成真代码（已人工排除）。
3. **同名局部函数**：`newId`、`clearAll`、`tick`、`fmt` 这类短名会被大量同名局部定义污染 token 级统计（所以最终结论以**绑定级**为准）。
4. **动态属性访问**：`obj[name]` 形式（本仓库暂未发现）。

---

*报告结束。本轮全程只读：仓库内只**新增**本文件（`docs/死代码清点报告.md`），未修改任何 `.ts/.mjs/.json/.css` 业务文件；knip 以 `--no-save` 安装，两份 knip 配置与三个分析脚本都在系统临时目录 `%TEMP%` 下。*
---

## 7. 执行记录（W1~W3 已完成 · 2026 本轮）

| 波次 | commit | 内容 | 文件 | 新增 | 删除 | 校验结果 |
|---|---|---|---|---|---|---|
| **W1-a** | `5f08788` | 核心层 / 后端 `api/_lib` / 服务层 16 个零引用导出（含预设生成器同步） | 15 | +4 | **-191** | tsc 0 · test:build 53/0 · build ✅ |
| **W1-b** | `c296259` | DAO / 界面层 27 个零引用导出 + 连带清理 11 处未使用 import | 17 | +11 | **-291** | 同上 |
| **W2** | `e3f3b17` | 收窄 6 个门面（db / kcModel / kcExamTypes / model / tts / scheduler），移除 39 处无人消费的转发导出 | 10 | +12 | **-50** | 同上 |
| **W3** | `dc8bdf4` | 一次性迁移脚本 2 个 + 游离文件 `.git-commit-msg.txt`；另删 gitignored 的 `.tmp/` 70 个文件 / 2.7 MB | 4 | +1 | **-141** | tsc 0 · test:build 53/0 · `verify:api` ✅ · build ✅ |
| 合计 | — | — | **46** | +28 | **-673** | 全量 `npm test` 见下 |

### 7.1 执行中的三个额外发现（都已处理）

1. **删除会连带产生未使用的 import**：删掉 43 个函数后，`npx tsc --noEmit` 立刻指出 **11 处**「声明了但没用到」的 import（`KC` / `clearStore` / `txRun` / `SyncState` / `uid` / `Settings` / `aiConfigFromSettings` / `EXAM_TYPES` / `getSettings` / `Attrs` / `clampNum`）。
   已一并清理（属同一次删除的组成部分，不是额外重构）。**注意：这些行号只有 tsc 是准的** —— 本机 PowerShell 的 `Get-Content` 读同一文件时给出的行号有偏移，排查时以 tsc / 编辑器的行号为准。
2. **注释与代码已脱节**：`pickNextForLearn` 的 4 处「引用」全在注释里（代码早已改用 `sortForLearn`），`applySenseRewrite` / `backfillExamCount` 同理。已同步修正 5 处注释引用（`pick.ts` / `LearnPage.ts` / `flow.ts` / `words.ts` / `priority.ts` / `types.ts`）。
3. **生成器必须同改**：`src/core/presets.ts` 是自动生成的，`findTier` 来自 `scripts/build-presets.mjs` 的模板字符串。已先改生成器再重跑 `node scripts/build-presets.mjs`，产物 diff 只有 `findTier` 消失、5 个词库 JSON **字节级不变**。

### 7.2 W2 里两处「没按原计划删」的地方（有意保留）

| 位置 | 原计划 | 实际处理 | 原因 |
|---|---|---|---|
| `src/services/tts/index.ts:41` `export * from './youdao'` | 整行删 | 改成 `export { YOUDAO_VOICES } from './youdao'` | `YOUDAO_VOICES` 是 `SpeechSection.ts:20` 唯一的来源，整行删会直接报错；改成具名导出后，另外 6 个实现细节（`YOUDAO_TTS_ENDPOINT` / `YOUDAO_ERRORS` / `makeSalt` / `buildSignedForm` / `readYoudaoResponse` / `YoudaoTtsError`）不再泄漏到模块外 |
| `src/dao/kcCloud.ts` 的 `kcCloudReady` | 当成死代码删 | 只删了第 44 行的**再导出**，函数保留 | 它在 `kcCloud.ts:225` 被内部使用（是活代码），只是不该对外暴露 |

> 另：`.tmp/` 是 gitignored 目录，删除不进 commit；跑 `npm run verify:api` 会重建 `.tmp/api-emit/`（正常）。

## 8. W4 拍板清单（**只剩这 6 项需要你决定**）

请直接回我编号 + 选项，例如：`F1=A, F2=A, F4=B, F5=留, F6=A, D1=做`。

### F1 · Cloudflare Worker 转发脚本（`blank-sheet-vocab-proxy/`，共 1,855 行，含 1,635 行 package-lock）

- **A 删掉整个目录**（我的建议）：它与 `/api/ai-proxy` 功能完全重叠，HANDOVER §12 自己就写着「建议后续合并，只留一个」。删完顺手把 `vite.config.ts:51` 的 watch-ignore 那一行去掉。
- **B 保留**：留着「不用 Vercel 也能自建转发」这条路（代价：一份没人维护、没有测试、`name` 还是旧品牌名 `wordpaper-proxy` 的代码）。

### F2 · 二期「三张小表」的云同步（1,049 行：DAO 261 + 3 个接口 404 + `_lib` 384）

- **A 接线**（我的建议）：把 `kcSmallCloud.pushAllSmall/pullAllSmall` 挂到二期调度器上 → 语境词 / 题目历史 / 题库也能跨设备。约 20 行改动 + 补测试。
- **B 删掉**：删 DAO + 3 个 `api/*.ts` + `_lib/kcSmall*.ts` + `API_ROUTES` 里 4 条登记（`test:build` 的路由护栏会盯着，必须同步删）。
- 不建议维持现状：现在是「后端齐了、前端从不调用」，最容易被后来者当成能用的功能。

### F4 · `#/memorize` 路由 + `MemorizePage`（32 行 + 2 行注册）

- **A 删**：同时删 `api/_dev/test-r3.mjs` 里那两条「路由仍然能用」的断言（约 10 行）。
- **B 留**（我的建议）：记忆引擎本身是活的（背诵流程内嵌调用），这条路由只是「隐藏直达入口」，留着零成本，还能当调试入口。

### F5 · 旧布点算法 `jitteredGrid()` + `spacingBudget()`（约 240 行）

- **留**（我的建议）：注释写明它是「布局回归的对照基线」，`test:mobile` / `test:paper` 靠它做新旧对照。
- **A 删**：要同步改 3 个测试（`test-mobile` / `test-paper` / `selftest`），收益 240 行但对布局改动的信心下降。

### F6 · `src/dev/layoutProbe.ts`（424 行，**当前静态 import 进了生产包**）

- **A 保留能力 + 改按需加载**（我的建议）：维持 `#/dev/layout` 与 `probeLayout.mjs` 可用，但把 `main.ts:131` 的静态 import 改成 `import.meta.env.DEV` 下的动态导入（注释说当初动态导入会让 rollup 报 chunk 错，需要重试一次并验证构建）。
- **B 维持现状**：生产包里多带 424 行测量代码（gzip 后约 3~4 KB）。
- **C 删掉**：连带删 `#/dev/layout` 页与 `probeLayout.mjs`（失去线上无头测量能力）。

### D1 · 文档同步（不改代码，但需要你点头）

- 本轮删了 3 个文件后，`HANDOVER.md` §13 仍把它们列为「历史脚本」；它还引用着仓库里**根本不存在**的 `README.md` / `README-DEPLOY.md` / `CHECKLIST.md`，§4.2 说 IndexedDB 是 v3（实际 v8）。
- **A 做**：我在 `HANDOVER.md` 顶部加一节「文档与现状的差异（本轮清点结果）」，不改动你原有的正文。
- **B 不做**：保持原样（我会在本报告里留档这些差异）。

### W5（可选，不属于 W4）· B 类 220 条「降为私有」

只去 `export` 关键字、不删实现，风险低但收益也小（主要是收紧导出面）。**建议跳过**，或只做 `core/` / `dao/` / `ui/components/`，跳过所有 `*Types.ts`。

### 7.3 ★ 一处漏检与修复（必须留档）

**现象**：全量 `npm test` 首次运行 **exit 1**，`test:kc` 抛 `TypeError: ctx.clearAll is not a function`（`api/_dev/test-kc.mjs:767`）。

**根因**：这是我清点方法的一个真实盲区 ——

| 环节 | 发生了什么 |
|---|---|
| token 级扫描 | `clearAll` 全库 39 处命中，**看到了** |
| 我的判断 | 抽样看前 6 处，全是 `dao.words.clearAll` / `dao.kc.clearAll` 这类**同名不同物**，于是判为「名字撞车，不是引用」 |
| 绑定级解析 | 只认 `import` 绑定与 `NS.a.b` 链，**认不出 `const ctx = dao.contextWords` 之后再 `ctx.clearAll()`** 这种「别名再调用」 |
| tsc | 看不见（`clearAll` 的调用点在 `.mjs` 测试里，不在类型检查范围） |
| 结果 | 一个**只被自检使用**的测试接缝被当成死代码删掉了 |

**修复**：commit `be7b3d5` 恢复 `src/dao/contextWords.ts` 的 `clearAll`（含 `clearStore` import），并把它**重新归类到 C2「仅自检引用 · 待决」**。

**为堵住这个盲区**，补了一个专门的检查器（`bkv-alias-check.mjs`）：先收集全库 `const ALIAS = <ns>[.<member>]` 与 `const ALIAS = await import(...)` 的别名绑定（5,407 条），再逐个匹配「已删符号名」在别名上的调用。
对 43 个已删符号全量跑过之后，**真回归只有这 1 处**，其余命中都是同名但属于别的模块（`dao.words.clearAll` / `dao.kc.clearAll` / 二期自己的 `pickForReview` / `kcModel.newId` 等）。

**结论**：W1 的 43 条里，**业务代码路径 0 误删**；错的是「仅自检引用」这一类的归属（`clearAll` 应进 C2 而不是 A1）。这也反过来印证了报告 §2.4 的判断：**C2 那一类不能用引用计数机械处理**。

> 顺带说明：如果当初严格按 §3.5 的「每批跑 `npm test`」执行，这个问题会在 W1-b 就被拦住 —— 我第一轮只跑了 `tsc` + `test:build` + `build`，而这三项**都覆盖不到 `api/_dev` 的 .mjs 自检**。教训：本项目的测试接缝大量存在于 `.mjs` 自检里，**减法必须用 `npm test` 做关卡**。
### 7.4 最终关卡：全量 `npm test` 全绿

修复后重跑 **26 组全量自检 → `exit 0`**，关键套件：

| 套件 | 结果 | 套件 | 结果 |
|---|---|---|---|
| test:build | 53 / 0 | 二期阶段 01（test:kc） | 106 / 0 |
| test:api | 58 / 0 | 阶段 02（录入解析） | 95 / 0 |
| test:sync | 43 / 0 | 阶段 03（卡片编辑） | 69 / 0 |
| R1 验收 | 67 / 0 | 阶段 04（会话自评） | 38 / 0 |
| R2 验收 | 48 / 0 | 阶段 05（出题评分） | 123 / 0 |
| R3 验收 | 34 / 0 | 阶段 06（复习桥接） | 49 / 0 |
| test:ai | 53 / 0 | 阶段 07（设置题库） | 58 / 0 |
| test:mobile | 59 / 0 | test:pwa | 49 / 0 |
| test:about | 51 / 0 | 其余（rename/sense-rules/presets/paper） | 全通过 |

### 7.5 本轮 commit 清单（可直接 `git log --oneline -6` 复核）

| # | commit | 说明 |
|---|---|---|
| 1 | `5f08788` | W1-a 核心/后端/服务层 16 个零引用导出 |
| 2 | `c296259` | W1-b DAO/界面层 27 个零引用导出 + 未使用 import |
| 3 | `e3f3b17` | W2 收窄 6 个门面，移除 39 处转发导出 |
| 4 | `dc8bdf4` | W3 一次性迁移脚本 + 游离文件（+ gitignored `.tmp/` 70 文件） |
| 5 | `be7b3d5` | 修复误删：恢复 `contextWords.clearAll` |

**净效果**：46 个源文件改动，**-673 行**；另清掉 70 个临时文件 / 2.7 MB。基线（改动前）与本轮结束**都是全绿**。

> 回滚方式：任一波出问题都可以单独 `git revert <commit>`；四处删除彼此独立，不需要整体回退。