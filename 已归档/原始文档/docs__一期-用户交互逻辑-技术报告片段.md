# 白纸单词 · 一期（单词背诵）用户交互逻辑技术报告片段

> 只读分析，未修改任何既有代码/配置。所有结论均给出 `文件路径:行号` 证据；无法确认的以「未确认」标注。
> 关键常量来源：`src/core/config.ts` 的 `DEFAULTS` / `DEFAULT_LAYOUT` / `DEVICE`。

---

## 1. 完整用户旅程与状态流转

**启动与路由骨架**：`src/main.ts:34`（`boot()`）先挂错误边界（`main.ts:39`）、开 IndexedDB（`main.ts:51`，8s 超时，见 `core/config.ts:288` `DB.openTimeoutMs`），再载设置进缓存（`main.ts:82-85`）、初始化本地文件夹备份（`main.ts:98`）、最后 `renderApp()`（`main.ts:133`）。词库为空时弹「词库还是空的，先去「录入」页加几个词吧」（`main.ts:142`）。

**路由**：`src/ui/router.ts:40` `parseHash()` 精确匹配（无动态段，参数走 query）；`router.ts:67` `renderCurrent()` 渲染前先执行上一页的 `registerCleanup`（`router.ts:105`）——白纸流程的全局 keydown 就靠它摘除（`router.ts:71-82` 注释）。路由表在 `src/App.ts:50-78`，兜底 `/home`（`App.ts:77`）。顶栏 `NAV` 只有 6 项：录入 / 背诵 / 单词列表 / 复习 / 知识点 / 设置（`App.ts:39-47`）——`/memorize` 路由保留但不再有入口（`App.ts:33-38`、`HomePage.ts:20-26`）。

**首页**：`src/ui/pages/HomePage.ts:28`。五个入口卡（`HomePage.ts:8-14`），`/learn` 直接跳、`/review` 若有未完成复习会话先弹确认框（`HomePage.ts:52-76`，确认文案在 `HomePage.ts:62-66`）。统计条文案见 `HomePage.ts:95`，未完成会话角标 `HomePage.ts:98-102`。

```
首页 ──录入──▶ 录入页 ──开始解析──▶ (解析) ──完成──▶ 合并确认页 ──确认入库──▶ 单词列表
  │                                                                              │
  ├─背诵─▶ 背诵页(白纸 browse) ──再背一个×memorizeEvery──▶ 记忆环节 ──需拼写──▶ 拼写环节 ──答案卡──▶ 回白纸
  │                              └─背完了(全部达标)──▶ finishLearn(归档+清会话) ──▶ 首页
  └─复习─▶ 复习页(白纸,首屏 30 词) ──再复习一个──▶ 同一套记忆/拼写 ──背完了──▶ finishReview ──▶ 首页
```

**导入（录入页）**：`src/ui/pages/ImportPage.ts:20`。第零区预设词库（`import/PresetPanel.ts:26`，点一下只把词表填进编辑框并切页签，`ImportPage.ts:74-103`）；第一区来源+**唯一的**优先级（`import/InputPanel.ts:91-119`，控件 `components/PrioritySelect.ts:43`，`WORD_PRIORITY_DEFAULT = 3` 见 `core/types.ts:50`）；第二区粘贴/上传（`InputPanel.ts:146-355`，支持 .txt/.csv/.md/.docx/.pdf，单文件上限 `MAX_FILE_BYTES = 5MB` 见 `InputPanel.ts:51`，串行解析 `InputPanel.ts:228`）；第三区解析设置（分隔符/解析方式/每批 20~100，`InputPanel.ts:357-424`）。`开始解析` → 校验（空内容 / 空来源名，`ImportPage.ts:149-156`）→ 无密钥时可改走规则解析（`ImportPage.ts:161-172`）→ 建 `ImportJob` 并 `saveJob`（`ImportPage.ts:179-193`）→ 分批跑（`ImportPage.ts:201`）；全部完成时 `dedupeResults` 去重并 `navigate('/merge')`（`ImportPage.ts:224-230`）。

**规则解析**：`src/core/parser.ts:88` `parseText`。字段分隔符探测优先级 Tab > 连续 2+ 空格 > 逗号 > 单空格（`parser.ts:46-53`）；义项分隔符默认 `；;／/|`（`parser.ts:36`）；行首序号被剥离（`parser.ts:27`、`parser.ts:99`）；义项再经 `splitPackedSenses` 拆「顿号打包项」（`parser.ts:117`，实现 `core/model.ts:200`）。校验失败的行进 `errors`（`parser.ts:105-109`、`parser.ts:118-121`）。

**合并确认页**：`src/ui/pages/MergePage.ts:106`。工具条：搜索（200ms 防抖，`MergePage.ts:142-149`）、仅看多义词（`MergePage.ts:151`）、全部展开/折叠（`MergePage.ts:156-160`）、`AI 重新分析义项`（`MergePage.ts:163`）、`智能再合并`（`MergePage.ts:162`，每批 `MERGE_BATCH_SIZE = 100` 见 `MergePage.ts:25`）。单卡（`merge/MergeCard.ts:19`）可改英文/音标/例句、编辑义项、对 AI 建议点「接受/忽略」（`MergeCard.ts:71-104`）、`斩掉此词（不入库）`、`删除这张卡`（`MergeCard.ts:120-134`）。草稿统计在 `MergePage.ts:231-237`。`确认入库`（`MergePage.ts:394`）：`validateWord` 过滤非法词（`MergePage.ts:411-420`，规则 `core/model.ts:133`）→ 只对「已存在且优先级不同」弹优先级冲突框（`MergePage.ts:38-66`、`MergePage.ts:426-434`）→ `planImport`（`core/merge.ts:95`）→ `bulkUpsert` + `sources.upsert` → `navigate('/list')`（`MergePage.ts:444-452`）。冲突三分支：`insert` / `replace`（旧义项进 `rawSources`）/ `keepBoth`（`core/merge.ts:46-86`）。

**列表 → 背诵 → 复习**：列表页见第 5、6 节；背诵页 `src/ui/pages/LearnPage.ts:24`（**总是**先续跑未完成 `learn` 会话，`LearnPage.ts:110-122`；否则取全部未背词建会话，`LearnPage.ts:54-97`）；复习页 `src/ui/pages/ReviewPage.ts:41`（`REVIEW_CHUNK = 30`，`ReviewPage.ts:51`；自动续跑 `ReviewPage.ts:210-224`；`advanceChunk()` 追加下一批并**清空 placements 重挂流程**，`ReviewPage.ts:109-125`）；`/memorize` 直入记忆用 `startInMemorize`（`MemorizePage.ts:25`、`flow.ts:886`）。

---

## 2. 「白纸」的交互隐喻

**舞台**：纸 = `.paper-stage`（`position:fixed; inset:0;` 居中）+ `.paper-sheet`（白底、`position:relative`、`overflow:hidden`），见 `src/styles/paper.css:13-28`。单词是绝对定位的 `.paper-word-zone`，`transform: translate(-50%,-50%)`，坐标是**归一化百分比**（`paper.css:32-38`；`PaperStage.ts:314-319` 写入 `left/top%`）——所以换尺寸后相对位置不变。

**落点(placements)怎么算**（`src/core/layout.ts`）：
1. `computeGrid()`（`layout.ts:278`）：自然格宽 `meanWidthPx * 1.15 + minGapPx`（`layout.ts:299`），自然格高 `rowHeightPx + minGapPx`（`layout.ts:301`）；`maxCols = floor(availableW/naturalCellW)`、`maxRows = floor(availableH/naturalCellH)`（`layout.ts:302-303`）；自动列数 `autoCols = round(sqrt(target * availableW/availableH))`（`layout.ts:310`），列数 = `clamp(autoCols, minCols, maxCols)`（自动时，`layout.ts:316`）或**手动覆盖优先、但受宽度夹住**（`layout.ts:312-314`，`colsClamped` 报告）；行数 `ceil(target/cols)` 且不超 `maxRows`（`layout.ts:317`）；格子**撑满**可用区域（`layout.ts:324-325`）。
2. `layoutWords()`（`layout.ts:400`）：格子顺序 seeded 打乱（`layout.ts:410`）→ 每词按**自己的**宽高在格内抖动（`layout.ts:428-438`）→ ①夹回 `area`（`layout.ts:441-442`）②与 `avoidPx` 真实矩形判交则换格（`layout.ts:445-447`）③`resolveOverlaps()` 把候选矩形**向下/向上推开**（最多 8 轮，`layout.ts:452`、`layout.ts:487-508`）→ 返回归一化中心点（`layout.ts:455-458`）。放不下的词从末尾丢弃，返回值长度即容量（`layout.ts:396-397`）。
3. 可用区与避让（`PaperStage.ts:332-397`）：手机下边界 = 底部按钮横带顶边（`PaperStage.ts:357-359`），平板/桌面 = 整张纸扣四周边距、只按右下角方块判交（`PaperStage.ts:354-356`）；避让矩形来自 `ui/device.ts:86` `controlsAvoidRect()`——手机是整条横带（`device.ts:95-98`），平板/桌面是右下角方块（`device.ts:99-107`）。
4. 每词的占位矩形 = canvas `measureText` 宽 + 点击热区 padding（`PaperStage.ts:270-284`、`layout.ts:604`）；行高 = `fontSize × WORD_LINE_HEIGHT_RATIO(1.6) + WORD_ROW_PADDING_PX(12)`，且与一个同款探测元素的实测值取较大者（`PaperStage.ts:253-268`、`layout.ts:577`、`layout.ts:580`）。
5. `jitteredGrid()` / `spacingBudget()` 是**旧算法，S3 起真实布点不用**（`layout.ts:67-88`、`layout.ts:523-563`），只留给自检与诊断对照。

**纸上怎么显示单词**（`PaperStage.ts:467-522`）：每个落点一个 zone = 「单词 +（浅灰）义项数徽章」一行 + 其下的中文意思。点单词 → `toggleMeaning()` 切换中文（`PaperStage.ts:556-561`，回调挂在 `PaperStage.ts:488-491`）；点中文 → 打开可编辑单词卡（`PaperStage.ts:513-516`，回调 `flow.ts:534`）。义项数徽章**只在义项 > 1** 时出现，字号 = 单词字号 × `DEVICE.senseBadgeScale(0.5)` 且不低于 12px，颜色 `#bbb`（`PaperStage.ts:494-505`、`config.ts:216-221`）。中文只显示**代表义项**、不显示 aliases（`core/model.ts:234` `formatSensesBrief`，统一词性时输出 `词性.①义项1②义项2`，不统一则 `义项；义项`；`model.ts:242-249`）。

**字体 / 动画**：字体 = `settings.display.fontFamily`，字号 = 手机档 `layout.mobile.fontSizePx`（默认 16）、其它档 `display.fontSize`（默认 24）（`PaperStage.ts:183-187`、`config.ts:460-466`）；颜色 `display.wordColor`、背景 `display.bgColor`（`PaperStage.ts:148-151`）。入场动画 `paper-in 0.45s ease`（scale 0.7→1 + opacity，`paper.css:60-73`）；总开关 `display.animation`，关闭时给 stage 加 `no-anim`（`PaperStage.ts:149`、`paper.css:76-78`）。记忆/拼写时整批词隐藏：`.hidden-words`（`paper.css:81-83`，`PaperStage.ts:562-563`）。

**两列布局与层数 / 移动端一屏几个词**：层数（cols/rows）由 `computeGrid` 推导，`capacity = cols × rows`（`layout.ts:321`）。设备分档：手机 ≤767px、平板 768~1024、桌面 >1024（`config.ts:185-187`、`device.ts:23-27`）。列数硬下限 手机 3 / 平板 4 / 桌面 4（`config.ts:197-199`，`device.ts:49-53`）。三档默认参数（`config.ts:38-60`）：
- 手机：`edgeMarginPx 8 / minGapPx 8 / fontSizePx 16 / targetCount 16 / button 50·16·12`
- 平板：`14 / 16 / 22 / 24 / 56·18·13`
- 桌面：`24 / 20 / 24 / 40 / 44·12·12`

`targetCount` 只决定**行数与容量**，不是硬上限；实际能上纸几个由 `layoutWords` 返回值决定（`PaperStage.ts:370-399`）。**手机默认落成「2 列 × 8 行 = 16 个词」**，这一数字由 `config.ts:27-36` 的实测推导写死为注释、并被 `api/_dev/test-mobile.mjs:173` 断言（`capacity ≥ targetCount`）——注意 `capacity` 由纸面真实几何决定，`DEFAULT_LAYOUT.mobile.targetCount = 16` 只是目标值。手动列数兜底：⊞ 按钮 + 选择条（`flow.ts:234-291`），可选值 `LAYOUT_COLS_OPTIONS = ['auto',3,4,5,6,8,10]`（`config.ts:231`，解析 `config.ts:253-257`），改完立刻 `stage.relayout()` 就地移动（`flow.ts:269-282`、`PaperStage.ts:546-550`）。布局种子 = `seedFromString(session.id + '#' + groupIndex)`（`flow.ts:222`），所以同会话同组位置稳定、续跑不跳。

---

## 3. 背诵抽词算法（`src/core/pick.ts`）

**(a) `pickForMemorize(session, allWords, cfg)`（`pick.ts:56-81`）** —— 记忆环节抽词，规则由用户口头定稿（`pick.ts:28-54` 注释是权威口径）：
1. 候选池 = `session.wordIds` 中**已经在纸上出现过**（`shownIds`）且 `status !== 'chopped'` 的词（`pick.ts:63-67`）——没上纸的词不进记忆。
2. `cap = max(0, floor(cfg.maxPick))`（`pick.ts:69`）；候选 ≤ cap 时**全部抽走**（有几个抽几个）。
3. 候选 > cap：先 `shuffle()`（`pick.ts:14`，Fisher–Yates 真随机）再 **稳定** `.sort()` 按 `memorizeCount` **升序**（`pick.ts:73`）——稳定排序保留同级间的随机顺序，即「遍数相同时随机抽」。取前 `cap` 个为基础项（`pick.ts:74`）。
4. **额外项** = `session.lastRoundFailedIds` 中仍在候选池且未被基础项抽到的词（`pick.ts:78`），追加后总数**可以超过** maxPick（`pick.ts:80` 整体再 shuffle 一次）。
- `memorizeMaxPick`（默认 **10**，`config.ts:5`）= 单次「记忆」最多抽几个；`memorizeTargetCount`（默认 **1**，`config.ts:6`）= 每词至少记忆几次（**抽词本身不使用**，`pick.ts:61` 显式 `void`，结束条件在页面层）；`memorizeEvery`（默认 **3**，`config.ts:7`）= 每点几次「再背一个」按钮自动变成「记忆」（`flow.ts:322` `batchReady()`、`flow.ts:419-422`）。

**(b) `pickForReview(words, count, settings, now)`（`pick.ts:117-128`）**：候选 = `status !== 'chopped' && status !== 'unlearned'`（`pick.ts:118`）；按 `computePriority()` 降序，同分时 `attrs.lastReviewAt ?? 0` **升序**（越久没复习越前，`pick.ts:119-126`）；取前 `count` 个。（`count < 0` 被 `Math.max(0,count)` 兜住。）
> ⚠️ 事实校正：一期复习页**当前不调** `pickForReview`，改调 `sortReviewCandidates()`（`pick.ts:146-162`）——两者排序比较逻辑**逐字一致**，差别只是后者额外排除「已在本次词单里的 id」（`pick.ts:153`），返回全部候选（调用方取 `slice(0, REVIEW_CHUNK)`，`ReviewPage.ts:117/180`）。`pickForReview` 目前只被 `src/dev/selftest.ts` 引用。同理 `recommendReviewCount()`（`pick.ts:93-107`：候选取优先度第 75 百分位为 threshold、count clamp 到 `[1, reviewGroupSize*3]`）已**不再有界面入口**，只被自检使用（`ReviewPage.ts:18-25` 注释说明 T2 删掉了「问复习多少个」）。

**(c) 背诵抽词 `sortForLearn()`（`pick.ts:207-232`）+ `pickNextForLearn()`（`pick.ts:246-261`）**：`priority` **降序是第一关键字、绝对优先不掺概率**（`pick.ts:221`、`pick.ts:228`）；同级内按设置 `learnPick.samePriorityOrder`（默认 `'createdAt'`，先录入的先背，`config.ts:479`）或 `'random'`（用 `mulberry32(seedFromString(sessionId + '#' + word.id))` 的**确定性**权重，同会话稳定，`pick.ts:212-226`）。`pickNextForLearn` 候选池 = `deleted !== 1 && status !== 'chopped' && (status === 'unlearned' || status === 'learning') && 不在 appearedIds`（`pick.ts:251-257`）。`LearnPage` 取全部未背词时用同一个 `sortForLearn`（`LearnPage.ts:54-58`），所以「词单顺序」与「逐个上纸顺序」一致。

**(d) 分组 `groupWords(ids, size)`（`pick.ts:173-181`）**：顺序切分（不是蛇形），65 个 + size 30 → 30/30/5（`pick.ts:257-262` 自检）。

---

## 4. 一次背诵会话的状态机

状态变量：`flowMode: 'browse' | 'memorize' | 'spell'`、`roundBusy`、`pendingSave`、`sinceBatch`、`aborted`（`flow.ts:175-183`）。

**浏览阶段**：`nextAction()`（`flow.ts:417-435`）——按 `words` 数组顺序（= `wordIds` 顺序，已由 `sortForLearn` 排好，见 `flow.ts:408-416` 注释）一个个放上纸；取 `stage.placementOf()`，`stage.addWord(word, placement, { showMeaning: true })`（新词自动显示中文，旧的自动收起，`PaperStage.ts:530-538`），把 id 推入 `shownIds`，`autoSpeak` 开启时朗读（`flow.ts:432`），`sinceBatch += 1`（`flow.ts:433`）。`batchReady()` 为真时按钮文案变 `记忆（新词 N 个）`（`flow.ts:398-404`）。进度条文案：`已出现 N/cap（纸面已满）· 每词已记忆 minMem/target`（`flow.ts:381-385`）。

**记忆环节**：`startMemorize()`（`flow.ts:615-626`）→ `pickForMemorize` → 空则提示「纸上还没有词，先点「再背一个」」→ `runRound(picked)`（`flow.ts:629`）。`runRound` 里 `flowMode='memorize'`、`stage.hideWords()`、`hideOverlay()`，建 `RoundHost`（`flow.ts:649-672`）——**注意它不是一个显式状态对象，而是三个变量 + host 闭包**。

`runMemorizeRound()`（`rounds.ts:81-191`）逐个词串行：
1. `stage.showOverlay(placementOf(id))` + `.memorize-mode`（`rounds.ts:88-89`）；`autoSpeak` 时朗读（`rounds.ts:90`）。
2. **"点词显示释义？"——不是。** 记忆环节直接显示**题干英文单词**（`.memorize-word`）并给每个生效义项一个**独立输入框**（placeholder `义项 N`），要求用户填中文（`rounds.ts:93-101`）。释义不在这一环节出现，改为**提交后由答案卡给出**。
3. 提交按钮 `#mem-submit`（`rounds.ts:102-106`）；输入框 Enter = **填完一格跳下一格、最后一格才提交**（`rounds.ts:118-131`，`stopPropagation` 防止与全局 Enter 重复触发）；多义项时给提示文案（`rounds.ts:134-138`）；「🔊 朗诵一遍」提示按钮（`rounds.ts:147`）；填完内容后 `repositionOverlay()` 夹进视口（`rounds.ts:152`，算法 `PaperStage.ts:60-90`、`PaperStage.ts:581-606`）；光标自动落第一个输入框（`rounds.ts:156`）。
4. **无任何超时**：`waitUntil(() => submitted, host.isAborted)` 死等（`rounds.ts:67-73`、`rounds.ts:160`；注释 `rounds.ts:52-66` 说明删掉了 400×25ms=10 秒的隐性超时自动提交）。
5. **判分**（`rounds.ts:166-171`）：第 i 个框的值必须命中某个生效义项才为真——`senses.some(s => senseMatch(value, s))`，`answerCorrect = results.every(Boolean)`，**空值直接算错**（`rounds.ts:168`）。`senseMatch()`（`core/model.ts:259-267`）候选 = `sense.text`、`stripPosPrefix(sense.text)`、**全部 aliases**，比较前 `normalizeForCompare` 去掉空白与常见标点并小写（`model.ts:154-162`）——即「代表义项 + aliases 匹配」，顺序无关。
6. `passed = resolvePass(answerCorrect, hint.used(), settings.practice.hintFails)`（`rounds.ts:178`；实现 `components/HintButton.ts:164-167`：开关为真且用过提示时**答对也判未通过**）；`hintUsed` 只存在内存、不落库（`HintButton.ts:88-110`、`rounds.ts:172-177` 注释）。
7. **`recordExam(id, passed)`（`flow.ts:657-661`）**：`examDeltas[id] += 1`（**每次判分都加**，对错都算，分母）；`passed === false` 时再 `recordFail(id)`（`flow.ts:644-647`：`failDeltas[id] += 1` 并加入 `failedIds`，分子）。`examCount/failCount` 的**累计时机就是这里**，两个环节（默写、拼写）共用同一口子，避免只加分子不加分母（`rounds.ts:20-36` 注释）。
8. 答案卡：`showAnswerCard(word, comparison, resolve, cardActionsFor(word))`（`rounds.ts:187`）；`comparison` 每项 `{input, ok}`。答案卡 = **与普通界面同一张可编辑单词卡**（`AnswerCard.ts:104-115` 传 `editable: true` + `onChange/onSpell/onChop`），输入对照对绿 `✓` / 错红 `✗` 且空值显示「（未填）」，有错时追加「正确答案：」chips（`WordCard.ts:122-142`）。推进方式：点卡片外部任意处 / `Enter` / `空格`（`AnswerCard.ts:86-97`、`AnswerCard.ts:116`），卡片内输入控件与 `.paper-controls` 的点击**不推进**（`AnswerCard.ts:86-87`、`AnswerCard.ts:94`）。全局单例 `currentCard`（`AnswerCard.ts:26`）。
9. 推进后 `host.recordShown(id)`（`rounds.ts:188`）→ `flow.ts:662-668`：`memorizeCount[id] += 1`、`shownIds` 去重加入；**若该词已被斩出词单则直接 return，不计数**（`flow.ts:665`）。

**本轮收尾与失败传递**（`flow.ts:674-723`）：进入前记 `failBefore`（`flow.ts:675`）；`runMemorizeRound` 结束后刷新 `session.lastRoundFailedIds = 本轮 failDeltas 变大过的词`（`flow.ts:682`，**只记上一轮，不累积**——`pick.ts:45-50` 说明这是用户口径）；未被中断时，从 `picked` 中挑 `attrs.needSpell && status !== 'chopped'` 的词进**拼写环节**（`flow.ts:687-695`，注释明确「拼写不是另外抽的，就是当次记忆选到的词里标了拼的那些」）。

**拼写环节** `runSpellRound()`（`rounds.ts:218-285`）：遮罩 `.spell-mode`；题干 = 全部生效义项的 `text + aliases` 用「，」连接（`rounds.ts:227`）；输入 `#spell-input`，Enter 或 `#spell-submit` 提交（`rounds.ts:236-248`）；判分 `value.toLowerCase() === word.en.trim().toLowerCase()`——**忽略大小写与首尾空格，必须完全相等**（`rounds.ts:264-265`）；同样 `resolvePass` → `recordExam(id, passed)`（`rounds.ts:274-276`）；答案卡的对错标记用**最终判定** `passed`（提示算挂时答对也显示红，`rounds.ts:280-282`）。拼写环节**不调 `recordShown`**（不增加 memorizeCount）。

**round 结束后**（`flow.ts:698-723`）：`hideOverlay` → `showWords` → `flowMode='browse'`、`roundBusy=false`、`aborted=false`、`sinceBatch=0`，立即 `dao.session.saveSession(session)`（`flow.ts:708`，保证直接关页也不丢）；若 `pendingSave` 则转 `saveAndExit()`（`flow.ts:710-714`）；`mode==='review'` 且本批全部达标则 `opts.onGroupDone?.()`（`flow.ts:715-722`）。

**「保存并退出」的持久化与续跑**：`saveAndExit()`（`flow.ts:742-758`）——若正处在环节中（`roundBusy && flowMode !== 'browse'`）则置 `pendingSave = true` 并 `aborted = true`，等本轮收尾后再存（`flow.ts:744-747`）；否则 `cancelSpeak()` → `flushEdits()`（`flow.ts:457-485`，把 600ms 防抖的卡片编辑全部落盘，且**与库中最新行做字段级合并**，避免迟到写入覆盖 status/attrs）→ `exitMidway(session)`（`finish.ts:16-19`：`finished = false` + 整份 `saveSession`）→ toast → `navigate('/home')`。落库字段见 `dao/session.ts:8-25`（含 `wordIds / placements / shownIds / memorizeCount / failedIds / failDeltas / examDeltas / lastRoundFailedIds / groupId`；**只有 `groups` 不落库**，`session.ts:32`）。续跑：`initFlow()`（`flow.ts:854-887`）过滤掉被斩词 → `shownIds` 与词单求交 → 只要「上过纸的词」有落点就恢复、否则整体重算（`flow.ts:865-873`）→ **无论哪条分支都把已出现词画回白纸**（`flow.ts:876-879`，注释记录「保存并退出后重进又是一面白纸」这个已修 bug）→ `browseIndex = shownWords.length`（`flow.ts:881`）。`flow.ready` 暴露该初始化 Promise 供调用方 await（`flow.ts:60-68`、`flow.ts:901`）。

**正常收尾 `finishReview()`（`finish.ts:96-122`）**：只处理 `shownIds` 里真正上过纸、未斩的词（`finish.ts:104-106`）——`lastReviewAt = now`、`reviewCount += 1`、`examCount += examDeltas[id]`、**然后**才 `reviewPriority = computePriority(next, settings, now)`（`finish.ts:109-116`，顺序不能反，否则用的是旧失败率）、`updatedAt = now`；`bulkUpsert` 后 `clearSession()`；返回条数。复习页 `completeAll()`（`ReviewPage.ts:133-144`）：0 个词时不写任何记录并提示。对照：背诵的 `finishLearn()`（`finish.ts:42-76`）只归档 `shownIds` 里的词——`failCount = min(failCount+delta, failCap)`、`failCountTotal += delta`、`examCount += examDelta`、`learnedAt = now`、`status='learned'`、`learnOrder` 从当前最大值递增（`finish.ts:56-71`），然后清会话。出口判定：`allQualified()`（`flow.ts:339-343`，每个上纸词 `memorizeCount >= memorizeTargetCount`）与 `reviewQualified()`（`flow.ts:332-336`，只看纸上的词）。`背完了` 按钮默认 `hidden`（`flow.ts:197`），达标才显示（`flow.ts:389-394`）；复习模式走 `opts.onRequestFinish`（`flow.ts:771-781`）。

**其他按钮**：`再次记忆` → `startMemorize()`（`flow.ts:199`）；`重新开始`（破坏性，二次确认 `confirmModal`）→ `clearSession()` + `navigate('/learn')`（`flow.ts:214`、`flow.ts:732-739`）。

---

## 5. 「斩」、撤销 Toast 与「已斩」区复活

**斩的数据语义**：`dao.words.chop(id)` = 整词写回 `status='chopped'`（`dao/words.ts:257-261`）。斩掉的词在背诵抽词、复习抽词、统计里全部不再出现（`pick.ts:66`、`pick.ts:118`、`pick.ts:153`、`pick.ts:253`）。**不弹确认框**是规则（`flow.ts:525-531` 注释：RULES-R3）。

**背诵/复习页里的斩**（`flow.ts:565-604` `chopWord()`）：先快照 `prevStatus / prevIndex(words 下标) / prevWordIdIndex(wordIds 下标) / wasShown / placement`（`flow.ts:566-570`）→ `dao.words.chop` → `stage.removeWord`（`PaperStage.ts:564-571`）→ 从 `words`、`wordMap`、`session.wordIds`、`session.shownIds` 移除 → 复习模式下 `opts.onWordChopped?.(id)` 并要求页面返回**撤销函数**（`flow.ts:579`；复习页实现见 `ReviewPage.ts:79-89`，把 id 插回 `wordIds` 原位置）→ `browseIndex` 重算 → `saveSession` → `showUndoToast('已斩 '+en, undo)`（`flow.ts:585-603`）。撤销回调**完全恢复**：`setStatus(prevStatus)` + `words.splice(prevIndex)` 插回原位 + `wordIds` 插回原下标 + `shownIds` 补回 + `placements` 写回 + `wasShown` 时 `stage.addWord(restored, placement, { animate: false })` 重新画回白纸 + `undoGroups?.()` + 重算 `browseIndex` + 存会话（`flow.ts:586-602`）。从卡片斩会顺手关弹窗（`flow.ts:545-549`）。

**撤销 Toast（≥8 秒）**：`components/Toast.ts:100` `showUndoToast()`，窗口常量 `UNDO_WINDOW_MS = 8000`（`Toast.ts:13`，注释「只许调大不许调小」，由 `npm run test:r4` 断言 ≥8000，`Toast.ts:9-12`）；`settled` 标志防止「点撤销」与「超时移除」两条路径都执行（`Toast.ts:105-106`、`Toast.ts:112-113`、`Toast.ts:127-131`）；点击后 toast 立即移除并执行 `onUndo`，失败兜底文案「撤销失败，请到列表页的「已斩」里复活」（`Toast.ts:116-123`）。按钮文案 `撤销`，标题「撤销这次斩」（`Toast.ts:111`）。

**列表页的「已斩」区与复活**：统计条第 5 项「已斩」按钮把筛选切到 `statuses = ['chopped']`（`ListPage.ts:21-27`、`ListPage.ts:167-175`）；默认视图**不含已斩**（`ListFilters.ts:46-50`：没勾状态时默认查 `unlearned/learning/learned`；「含已斩」勾选框 `ListFilters.ts:119-127`）。行内操作随状态切换：`chopped` 显示「复活」，否则显示「斩」（`ListTable.ts:229-233`）；手机卡片流同样（`ListCards.ts:118-122`）。`onRevive` → `dao.words.revive(id)`（`ListPage.ts:344-349`），复活状态 = `attrs.learnedAt !== null ? 'learned' : 'unlearned'`（`dao/words.ts:267-272`）。列表页的单个斩也带撤销：先存 `prevStatus`，撤销时 `setStatus(prevStatus)`（`ListPage.ts:332-343`）。**批量斩**先对选中词逐个快照原状态，撤销走 `dao.words.restoreStatuses(entries)` 逐条还原（`ListPage.ts:382-405`、`dao/words.ts:355-368`）——注释说明不能用「一律设 unlearned」代替（`dao/words.ts:346-354`）。批量复活 = `setStatusMany(ids, status)`（`ListPage.ts:239`、`dao/words.ts:330-343`，`status === null` 时按 `learnedAt` 推断）。

---

## 6. 复习分组与复习优先度公式

**分组**：`reviewGroupSize` 默认 **30**（`config.ts:9`，设置项 A 区 `settings/StarParamsSection.ts:25`，`Settings` 字段 `types.ts:394`）。`groupWords(ids, size)` 顺序切分（`pick.ts:173-181`）。会话字段 `groupId`（当前组，0-based）与 `groups`（**仅内存**，不落库，`types.ts:186-187`、`dao/session.ts:32`、`session.ts:81`）。复习页当前把 `groupCount` 报成 1、`groups` 传空数组，用户**看不见分组**；`groupId` 退化为内部计数器（`ReviewPage.ts:34-37`、`ReviewPage.ts:72-78`、`flow.ts:315-319`）。实际分批由 `REVIEW_CHUNK = 30` 控制（`ReviewPage.ts:51`、`ReviewPage.ts:117`、`ReviewPage.ts:180`）——**注意 `reviewGroupSize` 现在主要靠这个 30 常量在界面上生效**，改设置项不会改变首屏批量。`runRound` 里复习组的完成信号被复用为「又复习完一批」（`flow.ts:715-722` → `ReviewPage.ts:92` → `advanceChunk()`），追加下一批时**清空 `placements` 并重挂流程**（`ReviewPage.ts:118-123`）。

**优先度公式**（`src/core/priority.ts`）：`computePriority(w, settings, now)`（`priority.ts:251-253`）= `evalPriority(activeExpr(settings), w, now)` 四舍五入到 2 位小数。`activeExpr()`（`priority.ts:239-243`）：`customExpr.trim() !== ''` 时优先，否则用预设。四种预设（`priority.ts:46-67`）：
| preset | 名称 | 表达式 |
|---|---|---|
| `forgetting` | 遗忘曲线型 | `daysSinceReview / (reviewCount + 1) + failRate * 20` |
| `failFirst` | 失败率优先型 | `failRate * 60 + daysSinceReview` |
| `balanced` | 均衡型（默认） | `daysSinceReview * 0.5 + failRate * 30 + (needSpell ? 2 : 0) + reviewCount * -0.2` |
| `failRateBalanced` | 失败率均衡型 | `failRate * 50 + daysSinceReview * 0.5` |
默认 `balanced`（`config.ts:477`）。变量作用域 `exprScope()`（`priority.ts:167-183`）：`needSpell(0/1)`、`failRate`、`examCount`、`failCount`、`failCountTotal`、`reviewCount`、`daysSinceReview`、`daysSinceLearned`；无记录时天数取 `NO_RECORD_DAYS = 999`（`priority.ts:153`、`priority.ts:169-172`），一天 = 86 400 000 ms（`priority.ts:151`）。`failRate = failCountTotal / examCount`，`examCount` 缺失或 ≤0 时**不做除法**、直接返回 `DEFAULT_FAIL_RATE = 0.5`（`priority.ts:12`、`priority.ts:27-32`）。`customExpr` 校验 `validateExpr()`（`priority.ts:103-119`）：字符集白名单 `ALLOWED_CHARS_RE`（`priority.ts:89`）+ 标识符必须在 `ALLOWED_VARS`（`priority.ts:75-86`）+ **真试算一次**（`tryEvaluate`，`priority.ts:193-205`，区分「语法错/除零」与「算出来是 0」）；`evalPriority` 对非法表达式打 warn 并返回 0（`priority.ts:213-233`）。二期表达式在 `core/kcPriorityExpr.ts`（变量是 `mastery/reviewCount/daysSince*/selfScore/examScore`，`kcPriorityExpr.ts:35-44`），与一期**白名单完全独立**（`kcPriorityExpr.ts:1-11` 注释），且二期 `activeKcExpr` 会在自定义表达式非法时**回退到预设**（`kcPriorityExpr.ts:179-183`）——一期 `activeExpr` **没有**这道回退（非法 customExpr 会让全库优先度变 0，只有设置页校验拦着）。

**列表页怎么用**：排序下拉含「词优先级（高→低）/ 背诵顺序 / 复习优先度 / 创建时间 / 字母序」（`list/ListFilters.ts:182-190`）+ 升降序（`ListFilters.ts:193-201`）；排序实现 `dao/words.ts:426-442`（`learnOrder` 为 null 永远排最后，`words.ts:430-436`；词级优先级走 `wordPriorityOf` 兜底防 `NaN`，`words.ts:440`）。筛选项：关键词（同时匹配 en / 义项 text / aliases，`ListFilters.ts:79`、`dao/words.ts:390-396`）、状态多选、来源、只看需拼写、含已斩、`未通过 ≥`、`优先度 ≥`（**复习优先度**）、`词优先级` P1~P5 精确筛选（`ListFilters.ts:153-171`、`dao/words.ts:389`）、重置（`ListFilters.ts:205`）。分页 50/100/200（`components/Pagination.ts:21-27`）。**批量编辑**：选中 ≥1 条底部滑出 `BatchBar`（`ListPage.ts:232-252`、`list/BatchBar.ts:31`）——批量斩 / 复活 / 设优先级（下拉选中即执行，`BatchBar.ts:51-61`）/ 标记需拼写 / 取消需拼写 / 设为未背 / 删除 / 取消选择；「全选筛选结果」跨页不设上限（`BatchBar.ts:39-46`、`ListPage.ts:259-263`，表头勾选框支持 `indeterminate` 半选 `ListTable.ts:93-98`）。写库函数：`setStatusMany` / `updateAttrsMany` / `setWordPriorityMany` / `removeMany` / `restoreStatuses`（`ListPage.ts:382-443`）。另有 `重算优先度`（对全库调 `computePriority` 后 `applyPriorities`，`ListPage.ts:446-457`）与 `清空全部单词`（要求手动输入「删除」两字，来源保留，`ListPage.ts:469-489`）。

---

## 7. 键盘、错题与失败提示、TTS 位置

**键盘/快捷键**：白纸流程只有一个 window 级 `keydown`（`flow.ts:800-819`，注册 `flow.ts:819`，销毁时移除 `flow.ts:826`）。规则：焦点在 `INPUT/TEXTAREA/SELECT/BUTTON` 上时**完全让给浏览器原生**（`flow.ts:806`）→ 答案卡打开时 `Enter` 或 `空格` = 推进答案卡（`flow.ts:807-813`，`preventDefault`）→ 否则只认 `Enter`，存在 `.modal-mask` 时不抢键（`flow.ts:815`）；浏览态 `Enter` = 再背一个/再复习一个（`flow.ts:816`），作答态 `Enter` = 点 `#mem-submit` / `#spell-submit`（`flow.ts:817`）。记忆环节输入框自己的 Enter 处理会 `stopPropagation` 防止重复提交（`rounds.ts:119-131`）；拼写输入框同理（`rounds.ts:242-248`）。弹窗 `Esc` 关闭（`Modal.ts:41-43`）。桌面按钮文案直接写 `再背一个 (Enter)`（`flow.ts:209`）。手机圆形按钮带另有一层映射：`ROUND_LABELS` / `ROUND_SUB_LABELS`（`flow.ts:75-92`）把长文案压成「完 / 存 / 忆 / 背 / 复 / 重」，圆按钮点击转交给原按钮 `btn.click()`，状态以原按钮为唯一来源（`flow.ts:143-157`、`flow.ts:353-364`）。

**错题与失败提示**：
- 记忆判分逐框标绿/红，错框显示用户输入（空则「（未填）」），任一项错时追加「正确答案：」列出全部生效义项（`WordCard.ts:122-142`）。
- 拼写环节答案卡只用**最终判定** `ok: passed`，避免「绿勾 + 却记了一次未通过」的自相矛盾（`rounds.ts:278-282`）。
- 上一轮未通过的词下一轮作为**额外项**强制加入记忆（`pick.ts:77-80`、`flow.ts:682`）。
- 按钮层面的失败提示：`纸上还没有词，先点「再背一个」`（`flow.ts:622`）；`先复习到词，「背完了」才会出现`（`flow.ts:775`）/ `每个词都记忆达标后，「背完了」才会出现`（`flow.ts:783`）；进度条追加 `可以点「背完了」` / `可以点「背完了」结束复习`（`flow.ts:384-385`）；`纸面已满`（`flow.ts:383`）、按钮变 `纸上放不下了` / `已全部出现`（`flow.ts:398-404`）。
- 卡片编辑写库失败会**显式提示**而不是静默吞掉：`单词改动没能存进本地库…`（`flow.ts:481-484`）。
- 复习结束若一个词都没复习到：`这一轮还没有复习到任何词，未写回复习记录`（`ReviewPage.ts:136-141`）。
- Toast 类型与时长：info 2600ms / ok 2600ms / warn 3600ms / error 5000ms（`Toast.ts:46`、`Toast.ts:56-74`）。

**TTS 朗读在流程里的位置**：
1. 单词上纸时自动朗读（仅当 `practice.autoSpeak`，默认 **true**，`config.ts:489`）：`flow.ts:432` → `stage.speakWord()`（`PaperStage.ts:217-222`）→ `speak(word.en, { rate: speech.rate, lang: speech.accent })`，默认 `rate 0.9 / en-US`（`config.ts:448-455`）；`speak()` 内部走「缓存 → 第三方 → 浏览器语音」三级降级（`services/tts.ts:1-18`、`services/tts/index.ts`）。
2. 记忆环节每个词开头再读一遍（同一 `autoSpeak` 条件，`rounds.ts:90`）。
3. 考核中的按需朗读 = 「🔊 朗诵一遍」提示按钮（`components/HintButton.ts:67`，文案 `HINT_LABEL = '🔊 朗诵一遍'`，`HintButton.ts:36`）：念**单词英文**（`rounds.ts:147`、`rounds.ts:232`），可重复点击无次数上限（`HintButton.ts:10-16`）；只有**真的发出声音**才置 `used`（设备不支持 / 文本为空时只显示小字「当前设备不支持朗读」且不计入提示，`HintButton.ts:95-105`、`HintButton.ts:39`）；旧的「首字母 + 长度」字母掩码提示已**删除**（`rounds.ts:194-202` 明确说明删掉而非停用）。提示是否判挂由设置 `practice.hintFails`（默认 false）经 `resolvePass()` 决定（`HintButton.ts:146-167`、`config.ts:487-488`、设置界面 `settings/PracticeSection.ts:100-131`）。
4. 单词卡上的 `🔊` 按钮（`WordCard.ts:96-103`）。
5. iOS 首次朗读必须在用户手势里解锁：`mountSpeechGate(root, ...)`（`flow.ts:297`）挂「点击屏幕开始」引导层，点击时**同步**发一次 `volume=0 / rate=2` 的静音朗读（`SpeechGate.ts:70-83`、`SpeechGate.ts:90-113`）；非 iOS 自动跳过（`SpeechGate.ts:41-46`）；解锁标记存 localStorage `blank-sheet-vocab.speechUnlocked`（`SpeechGate.ts:16`）。语速/音色/口音/有道密钥的入口集中在设置页 H 区（`SettingsPage.ts:151-160`、`settings/PracticeSection.ts:74-88`）。

---

## 8. 一期交互中的专业名词

| 名词 | 一句话解释 |
|---|---|
| 白纸 / PaperStage | 满屏白色画布，单词按归一化坐标撒在纸上，靠**空间位置**辅助记忆（`PaperStage.ts:146`）。 |
| 落点（placement） | 单词在纸上的归一化中心坐标 `{x,y}`（0~1），换屏幕尺寸后相对位置不变（`layout.ts:4-7`）。 |
| 自然列数网格（natural-grid） | S3 起的布点算法：列数由**平均词宽**自然推导、行数由目标词数反推、N 个词随机落格再做真实矩形碰撞检测（`layout.ts:278`、`layout.ts:427`）。 |
| 抖动（jitter） | 词在格子内的小幅随机偏移，避免排成呆板行列（`layout.ts:363`、`layout.ts:431-432`）。 |
| 避让带 / 避让区（controlsAvoidRect） | 底部/右下角按钮占据的矩形，布点必须避开；手机是整条横带，桌面是右下角方块（`device.ts:86`）。 |
| capacity（纸面容量） | 受几何约束实际能放上纸的词数，= `layoutWords` 返回的落点数（`PaperStage.ts:399`、`layout.ts:396`）。 |
| targetCount | 每档设备「期望一屏放几个词」的目标值（手机 16 / 平板 24 / 桌面 40），决定行数推导（`config.ts:38-60`）。 |
| 词级优先级（`word.priority` P1~P5） | **唯一**的优先级，1~5、5 最高，决定背诵抽词**绝对优先**顺序，默认 3（`types.ts:37-62`、`model.ts:108`）。 |
| 复习优先度（属性⑥ / `reviewPriority`） | 由表达式算出的 0~n 实数，决定**复习**抽谁，越大越该复习（`priority.ts:251`、`types.ts:80`）。 |
| failRate / failCountTotal / examCount | 失败率 = 真实累计失败次数 ÷ 总考核次数；examCount 是每次判分 +1 的分母，缺失/0 时不除、取默认 0.5（`priority.ts:27-32`）。 |
| memorizeMaxPick / memorizeTargetCount / memorizeEvery | 单次「记忆」最多抽几个（10）/ 每词至少记忆几遍才算达标（1）/ 每背几个新词按钮变成「记忆」（3）（`config.ts:5-7`）。 |
| lastRoundFailedIds | **上一轮**记忆未通过的词 id，只用于「额外项」补抽，不累积（`pick.ts:77-80`、`flow.ts:682`）。 |
| 额外项（extras） | 上一轮未通过又没被「遍数最少」抽到的词，追加进本轮，故总数可超 memorizeMaxPick（`pick.ts:77-80`）。 |
| 答案卡（AnswerCard） | 提交后弹出的**可编辑**单词卡 + 输入对照 + 正确答案，点外部/Enter/空格继续（`AnswerCard.ts:63`）。 |
| 统一作答闭环 | 「提交 → 弹答案卡 → 手动推进 → 下一个词」的固定节奏，不自动跳过（`rounds.ts:76-80`、`AnswerCard.ts:45-48`）。 |
| 记忆环节 / 默写 | 显示英文、逐义项填中文输入框的考察环节（`rounds.ts:81`）。 |
| 拼写环节 | 显示全部义项文本、要求拼出英文，忽略大小写但必须完全相等的环节（`rounds.ts:218`、`rounds.ts:264-265`）。 |
| 提示「朗诵一遍」 | 唯一提示形式，念单词英文、可重复；是否判挂由 `practice.hintFails` 决定（`HintButton.ts:36`、`HintButton.ts:164`）。 |
| 斩（chop） | 把词标 `status='chopped'`，从此不参与抽词/统计；不弹确认但必须给 ≥8 秒撤销（`dao/words.ts:257`、`flow.ts:565`）。 |
| 撤销窗口 UNDO_WINDOW_MS | 8000ms 的撤销 Toast 存活时长，只许调大（`Toast.ts:13`）。 |
| 复活（revive） | 把已斩词恢复成 `learnedAt` 决定的状态（learned / unlearned）（`dao/words.ts:267`）。 |
| 保存并退出 / 续跑 | 整份会话（词单、落点、每词记忆遍数…）落库，下次进来自动恢复并接着背（`finish.ts:16`、`flow.ts:854`）。 |
| 背完了 / finishLearn / finishReview | 两种**正常收尾**：背诵归档 status+属性，复习写回 lastReviewAt/reviewCount/优先度（`finish.ts:42`、`finish.ts:96`）。 |
| reviewGroupSize | 复习每组上限（默认 30），构成分组模型；当前复习页改用常量 `REVIEW_CHUNK = 30` 分批（`config.ts:9`、`ReviewPage.ts:51`）。 |
| groupId / groups | 会话里的「当前第几组」（0-based）与「全部分组」；`groups` 仅内存不落库，用户界面已不展示分组（`types.ts:186-187`、`session.ts:32`）。 |
| 来源（Source） | 「这批词从哪来」的分组标签，**没有优先级**，仅供筛选与 rawSources 留档（`types.ts:137-153`、`dao/sources.ts:76`）。 |
| rawSources | 重复录入时被保留下来、可供列表页手动采纳的「其他来源义项」（`types.ts:100-104`、`model.ts:300`）。 |
| 代表义项 / aliases | 白纸与答案卡只显示义项的代表词 `text`；aliases 是判分时视为等价的近义写法，不显示（`model.ts:234`、`model.ts:259`）。 |
| 斩掉此词（合并页的 dropped） | 合并确认页的「不入库」标记，只影响本次导入，与「斩」的状态语义不同（`merge/MergeCard.ts:125`）。 |
| 主/平板/桌面档（LayoutTier） | 三档布局参数集合（边距、最小空隙、字号、目标词数、按钮尺寸），断点 767 / 1024（`types.ts:348`、`config.ts:183-187`）。 |
| 手动列数覆盖（layoutColsOverride） | `'auto'` 或 3/4/5/6/8/10，强制列数（自动推导与 minCols 让路，但受宽度夹住），是布局的**永久人工兜底**（`config.ts:231`、`layout.ts:306-316`）。 |
| 铁律 RULES-R1 / R3 | 项目内的两条硬约束注释标记：R1 = 禁止任何强制时间限制（无倒计时/超时提交）；R3 = 斩不弹确认但必须给 ≥8 秒撤销（`rounds.ts:1`、`flow.ts:526`）。 |

---

## 未确认 / 需要复核的点

1. **手机默认一屏词数**：`DEFAULT_LAYOUT.mobile.targetCount = 16` 是**目标值**（`config.ts:43`），默认 390×844 + 字号 16 下 `computeGrid` 的 `capacity` 被注释推为「2 列 × 8 行 = 16」（`config.ts:36`），但**当前仓库里跑出的真实值未在本轮实测验证**（需跑 `probeLayout.mjs` 或 `api/_dev/test-mobile.mjs`）。`api/_dev/test-mobile.mjs:173` 只断言 `capacity ≥ targetCount`。
2. **`pickForReview` / `recommendReviewCount`** 是否属于「对外 API 有意保留」还是「重构遗留」，需产品确认；本轮只能确认它们**不再有界面调用点**（除 `src/dev/selftest.ts`）。
3. **一期 `activeExpr` 对非法 `customExpr` 无回退**（`priority.ts:239-243`），与二期 `activeKcExpr`（`kcPriorityExpr.ts:179-183`）的行为不一致。是否有意为之未确认。
4. **设置项 `reviewGroupSize` 的实际影响面**：文件里仍是 A 区设置项与分组函数参数，但复习页分批已改用 `REVIEW_CHUNK = 30`，两者是否应统一未确认。
5. `layout.ts` 文件顶部注释提到的 AI_RULES.md 铁律原文（R1/R3 的完整条款）本轮未逐条核对，只按代码内注释转述。
