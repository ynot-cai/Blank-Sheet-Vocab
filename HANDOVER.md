# 项目交接文档（白纸单词 / blank-sheet-vocab）

> 面向接替开发的人。**读完这份 + `README.md` 就能上手改代码。**
> 最后更新：改名 + 预设词库完成。

---

## 0. 最近一次改动（接手先看这里）

### 0.1 改名：wordpaper → blank-sheet-vocab

因为 `wordpaper` 这个域名被人占了，所以整项目改了名。**改名是一件很容易漏的事情**，
漏掉的地方往往不报错，只是悄悄不对，所以列清楚改了哪些：

| 类别 | 旧值 | 新值 | 漏了会怎样 |
|---|---|---|---|
| 包名 | `wordpaper` | `blank-sheet-vocab` | 只影响 npm 脚本标题，无实际风险 |
| IndexedDB 库名 | `wordpaper` | `blank-sheet-vocab` | ⚠️ **旧数据读不到了**（见下） |
| 设置镜像键 | `wordpaper.settings` | `blank-sheet-vocab.settings` | 设置缓存丢失，重进设置页会重建 |
| 导入任务存档键 | `wordpaper.importJob` | `blank-sheet-vocab.importJob` | 断点续传丢失 |
| iOS 语音解锁标记 | `wordpaper.speechUnlocked` | `blank-sheet-vocab.speechUnlocked` | 语音解锁状态丢失 |
| 安装提示标记 | `wordpaper.installHintShown` | `blank-sheet-vocab.installHintShown` | 会再弹一次安装引导 |
| 本地文件夹备份文件名 | `wordpaper-data.json` | `blank-sheet-vocab-data.json` | 旧备份文件不再被自动读写 |
| 救火导出文件名 | `wordpaper-rescue-*.json` | `blank-sheet-vocab-rescue-*.json` | 无 |
| 手动导出文件名 | `单词白纸备份_*.json` | `白纸单词备份_*.json` | 无 |
| SW 缓存前缀 | `wordpaper-v1` | `blank-sheet-vocab-v1` | 缓存不会清，孤儿缓存堆积 |
| PWA / 页面标题 | 单词白纸 | 白纸单词 | 主屏幕图标名不对 |
| 界面品牌名 | 单词白纸 | 白纸单词 | 顶栏/footer/首页还挂旧名 |
| 可选转发脚本目录 | `wordpaper-proxy/` | `blank-sheet-vocab-proxy/` | 只是个独立小项目 |

> ★ **IndexedDB 库名一改，用户已录入的词就读不到了**（数据其实还在浏览器里，只是程序不再去读）。
> 这次是**明确选择不迁移**（用户确认过：直接改名，不要旧数据）。
> 如果哪天需要迁移，做法是：启动时先 `indexedDB.open('wordpaper')` 把 4 张表读出来
> 写进新库，再 `indexedDB.deleteDatabase('wordpaper')`。`ErrorBoundary.ts` 里已经有一段
> 「直接开库读原始记录」的代码（救火导出用），可以照着写。

**改名这件事有护栏**：`npm run test:rename`（已进 `npm test`）会检查
「旧名在代码里绝迹」「新名出现在 17 个关键位置」「自检脚本没把旧名写死」。
★ 其中最后一条是防一种很阴的修法：改名后 `api/_dev/` 里的断言红了，
顺手把断言改回旧值来「修好」测试——那等于把 bug 焊死。

### 0.2 新增：预设词库（一键导入）

录入页顶部多了「**0. 预设词库**」区块，五个按钮对应五套内置词表，
点一下整档导入，不用粘贴文本、也不用 AI 解析。

- 数据：`一期预设词库/*.txt`（原始素材）→ `scripts/build-presets.mjs` → `public/presets/*.json` + `src/core/presets.ts`
- 逻辑：`scripts/preset-lib.mjs`（纯函数，能被构建脚本和自检同时复用）
- 前端：`src/services/presetVocab.ts`（加载）+ `src/ui/pages/import/PresetPanel.ts`（按钮）
- 自检：`npm run test:presets`（61 项）、`npm run test:presets-ui`（21 项，需本机有 Chrome/Edge）

**★ 剔除规则是递归的**，每一档减掉所有更低档：

| 档位 | 原表 | 剔除 | 保留 |
|---|---|---|---|
| 初中 | 1987 | 0 | **1987** |
| 四级 | 4543 | 初中 1439 | **3104** |
| 六级 | 3991 | 初中 339 / 四级 1592 | **2060** |
| 考研 | 5047 | 初中 1233 / 四级 2550 / 六级 969 | **295** |
| 雅思 | 3592 | 初中 320 / 四级 1612 / 六级 696 / 考研 60 | **904** |

> ⚠️ **考研只剩 295 词看着很怪，但这是实测的真实数据**：
> 考研原表 5047 词里有 4752 个（94.2%）本来就在初中/四级/六级表里。
> 用户明确选择了「保持递归」——换来的是**任意两档没有重复词**。
> 要背完整考研词，得把初中/四级/六级也导入。
> 想改成「只减相邻下一档」（考研能到 2497 词，但会残留 2202 个初中词），
> 改 `scripts/preset-lib.mjs` 的 `TIERS[].excludes` 再跑 `npm run presets`。

**★ 改词表的工作流**：改 `一期预设词库/` 下的 txt → `npm run presets` → `git diff` 复核产物。
产物（JSON + `presets.ts`）**要提交进仓库**，它是「可复核的数据」而不是构建中间物：
这样 `git diff` 能看出哪个词被加进来/剔出去了，而且 `test:presets` 能拿原始词表**独立复算一遍**验证没算错。

**★ 预设导入走的是既有路径**：词表直接填进 `ImportJob.results`，跳过「解析」，
往后还是「合并确认页 → 逐词确认 → 入库」，和粘贴文本完全同一条下游。
所以没有「只在预设模式才跑」的分支。渲染几千张卡片实测 39ms（3104 词），不需要分页。

**★ 点预设先弹确认框**（`src/ui/pages/import/PresetConfirm.ts`），不是直接导入：
- 让用户在**导入前**能改优先度。优先级决定「同一个词在别的来源里已存在时，谁的义项被保留」，
  而它**只在导入那一刻**起作用——事后再去设置页改来源优先级，**不会**补做合并。
  所以必须给一个导入前改的机会。
- 如果该来源已存在，确认框会显示当前优先级并作为输入框默认值。

### 0.3 列表页：批量编辑不设数量上限

★ 原来的坑：表头「全选」只选**当前页**（≤200 条），而且 `load()` 里有一句
「清掉不在当前页上的选中项」——**翻一页选中就没了**。
结果是批量操作实际能作用的上限就是 200 条，「把 3000 个词一次性设为未背」根本做不到。

改法：
- `dao/words.queryIds()`：只查符合条件的 id、不分页。和 `query()` **共用** `matchesQuery()`，
  避免两处筛选逻辑分叉导致「页面显示 3000 条、一键全选只选中 2800 条」这种难查的错。
- 表头全选框 = 全选/取消**整个筛选结果**（跨页），并支持半选（indeterminate）显示。
- 批量条多一个「全选筛选结果（N 个）」按钮，只在还能选更多时出现。
- `load()` 里那句清选中删掉了；现在只摘掉**库里已不存在**的 id（词被删了），
  不会因为换个筛选条件就把之前选的悄悄清掉。

### 0.4 资料整理规范（AI 录入的规则，★ 规则全文在 src/core/senseRules.ts）

**改规则只改 `src/core/senseRules.ts`。** 这是全项目唯一的权威定义，
`services/ai.ts` 的 `PARSE_SYSTEM_PROMPT` 拼的是它导出的 `SENSE_RULES_FOR_AI`——
**不重抄一份**。抄两份的话，改了提示词忘了代码兜底（或反过来），AI 的行为就和文档互相矛盾了。

四步：分类成义项 → 挑代表 → 近义词逐个分隔 → 多词性判断同源。

| 规则 | 理由 |
|---|---|
| 一个义项 = 一个独立核心含义 | 打包的话代表词是一长串，用户答对一半也算错 |
| 每个义项挑一个**代表词** | 界面上「点单词显示中文」只显示代表词（`formatSensesBrief` 只读 `s.text`），近义词全铺出来会糊成一片 |
| 近义词**一个说法一项** | `aliases:["跑步，奔跑"]` 归一化后是 `"跑步奔跑"`，用户答「跑步」或「奔跑」**都判错**（实测过） |
| 多词性先判断同源 | 同源（run 的「跑/跑步/短途跑步」）→ 合并成一个义项；不同源（bear 的「熊/忍受」）→ 拆开 |

**两个执行点（不只是靠提示词请求，代码会强制）**：
- `normalizeAliases()` —— 拆包 + 去空 + 去重。在 `createSense()`（所有非 AI 写入路径的入口：
  合并页 / 卡片编辑 / 预设导入）和 `coerceParsedWord()`（AI 输出的不可信边界）各调一次。
- `formatSensesBrief()` —— 只读代表词。

**★ 顺手修掉的两个真 bug**（都是这次定规则时暴露出来的）：
1. **打包的近义词会让判分永远失败**。`createSense` 原来只是 `trim()` 一下，
   `["跑步，奔跑"]` 会原样存进去；判分时归一化成 `"跑步奔跑"`，用户答「跑步」判错、答「奔跑」也判错。
   界面上完全看不出来，是最难查的一类问题。
2. **没有词性前缀的义项显示不出来编号**。`formatSensesBrief` 原来要求
   「每个义项都带同一个非空词性前缀」才用 `①义项②义项` 格式；但按规范第 4 步，
   同源跨词性合并起来的义项**本来就不该加前缀**（run 的「跑」），
   于是这种最常见的形态反而退化成了 `跑；经验；一段时间`。现在「都没有前缀」也算统一。

自检：`npm run test:sense-rules`（81 项，直接 import 真实源码，不是把逻辑抄一遍）。

> ⚠️ 已知遗留：**存量数据**里如果有打包的近义词（改这条规则之前录入的），
> 不会被自动修——新规则只作用于之后写入的数据。
> 要清理存量的话得单独写一个迁移（读全部词 → `normalizeAliases` → 写回）。

---

### 0.5 合并页「AI 重新分析义项」按钮（预设词库的义项整理）

**背景：预设词库导进来的词，义项是没整理过的。** 预设 JSON 是从原始词表直接生成的，
每条只有 **1 个义项、里面塞着整串原文**：

```
access → ["v. 获取 n. 接近，入口"]
```

既没分类成义项（「获取」和「接近/入口」该是两条），也没把近义词分开（「接近」和「入口」）。
有些原始词表本身还残缺（`yield` 那条少一个右括号〕）。

**★ 刻意不在构建期用规则去拆。** 那是自然语言活儿：
- `n. 管理；〔某一时期的〕政府` → 该拆成 2 个义项
- `v. 谈判，协商，交涉` → 该是 1 个义项 + 2 个近义词

规则分不清这两种逗号，硬拆只会把同义词拆成独立义项，**越弄越乱**。
所以交给 AI 按《资料整理规范》整理，并给用户一个「自己决定什么时候花这个钱」的按钮。

实现：
| 文件 | 职责 |
|---|---|
| `src/ui/pages/merge/reanalyze.ts` | 纯函数：`draftsToSourceLines()` 拼原文、`applyReanalysis()` 把 AI 结果盖回草稿 |
| `src/ui/pages/MergePage.ts` | 按钮 + 确认框 + 分批请求 + 进度显示 |

关键取舍（都有测试钉着）：
- **分批 25 个词一批**。整档 3104 个词一次发过去，模型会漏返回、还容易超时。
- **失败/漏返回的词保持原样**，绝不新建、绝不清空——AI 少返回一个词就少一个词，
  比把用户的词弄丢好得多。
- **按 `normalizeEn` 配对**（不是简单小写比较）：AI 常把 `etc.` 写成 `etc`，
  只比小写的话这些词会**永远更新不到**，而且失败得很安静。
- **动手前必须确认**：会覆盖用户已做的手动编辑（改代表词/划掉义项/加近义词）。
  不去试图「合并两边的编辑」——没有任何可靠办法判断哪边是用户的意思。
- 重排后**清掉旧的合并建议**（`hints`），否则那些建议会指向已经不存在的义项。
- 合并页在所有词都只有 1 个义项时显示一条提示条，否则用户不知道有这个功能。

自检：`test:sense-rules` 的 [9] 组（25 项）覆盖上面每一条。
另有一次性端到端脚本（用 CORS 正确的假 AI 上游）验过完整链路：预设形态 → 点按钮 →
确认 → AI 请求 → 义项被重排 → 入库后库里是拆开的。

> ★ 假上游必须应答 **CORS 预检（OPTIONS）**。第一次写的时候没应答，
> 表现是「浏览器发了 OPTIONS，但一个请求都没进 handler」——
> 直连失败后应用回退去打 `/api/ai-proxy`，而 `vite preview` 没有 API 路由，于是全军覆没。
> 排查手法：给 `scripts/cdp.mjs` 的 `openSession` 加了 `Network.enable` 抓页面真实请求
> （`session.requests()`），一眼就看出打到哪去了。

---

### 0.6 列表页：「清空全部单词」按钮

把词库恢复成空白。两个刻意的设计：

1. **要求手动输入「删除」才执行**——不可撤销的操作，和设置页「清空所有数据」用同一套确认方式。
2. **来源（词库）保留不动**。预设导入后来源带着用户特意设的优先级，
   清词时一起清掉等于白设一遍；来源不占地方，留着下次导入直接复用。

要连来源一起清，用设置页 → G 区 →「清空所有数据」。

---

### 0.7 二期阶段 01：知识点数据层 + 安全块渲染（★ 当前最新改动）

一期是**泛背**（单词量大、浅层），二期是**精学**（知识点少、深层）。
二期阶段 01 只打地基（类型 / 数据库 / DAO / 同步 / 渲染），**没有任何界面**，
所以一期界面完全没动。新增文件：

| 文件 | 作用 |
|---|---|
| `src/core/kcTypes.ts` | 二期类型：`Block` / `KnowledgeCard` / `EXAM_TYPES` / `DailyContextWords` / `ExamRecord` / `BankQuestion` |
| `src/core/kcModel.ts` | **统一出口**（32 行门面），实现拆在下面 5 个文件里 |
| `src/core/kcText.ts` | id 生成、文本清洗、分数归一化、钳制取整、`unknown` 安全取值器 |
| `src/core/kcBlock.ts` | 块的创建 / 校验 / 脏数据归一化 |
| `src/core/kcCard.ts` | 卡片的创建 / 校验 / 脏数据归一化 |
| `src/core/kcMastery.ts` | **掌握度公式**（含 16 格完整对照表与「为什么加方向系数」的推导） |
| `src/core/kcExamTypes.ts` | 考核方式标签的小工具 |
| `src/core/kcClock.ts` | **单调写入时钟**（防设备时钟倒退导致静默漏推） |
| `src/core/kcPriority.ts` | 复习优先度、掌握度重算、`isBlindSpot`（识别盲目自信） |
| `src/core/blockRender.ts` | **安全块渲染**（只走 textContent，绝不拼 HTML） |
| `src/styles/kc.css` | 块样式（class 与 blockRender 一一对应） |
| `src/dao/kc.ts` | 卡片本地 DAO（读写） |
| `src/dao/kcQuery.ts` | 卡片查询：过滤 / 排序 / 分页（**纯函数，可单测**） |
| `src/dao/kcCloud.ts` | 云同步**编排**：先拉后推、游标、墓碑 |
| `src/dao/kcCloudHttp.ts` | 云同步**传输**：请求 / 超时 / 重试 / 字段映射 |
| `src/dao/kcScheduler.ts` | 二期同步调度（实现由 main.ts 注入，避开循环依赖） |
| `src/dao/contextWords.ts` / `examBank.ts` | 语境词、题目历史、题库 DAO（界面在阶段 05/07） |
| `api/_lib/kcSchema.ts` / `kcInventory.ts` / `kcValidate.ts` | 二期建表 / SQL DAO / 请求体校验 |
| `api/kc-list.ts` / `api/kc-push.ts` | 二期同步接口 |
| `src/dev/kcSelftest.ts` / `kcXssSelftest.ts` / `kcSelftestTypes.ts` | 浏览器自测：`__kcselftest.run()`（**不自动执行**） |
| `api/_dev/test-kc.mjs` / `test-kc-ui.mjs` | 二期验收：`npm run test:kc`（106 项）/ `npm run test:kc-ui`（真 Chrome，15 项） |
| `二期阶段01_验收单.md` | **验收单**：逐条自查命令、3 个待你拍板的决定、5 条与提示词的差异 |

**改动的既有文件（都在为二期腾位置，一期行为不变）**：

| 文件 | 改动 | 风险 |
|---|---|---|
| `src/core/db.ts` | 库版本 v2 → **v3**，新增 4 张表 | IndexedDB 升级是**加法**（`contains()` 判断），一期 4 张表原样保留 |
| `src/core/config.ts` | 加 `DEFAULT_SETTINGS.kc` + `KC` 常量表 | `deepMergeSettings` 会自动给老设置补 `kc`（缺字段补默认），老备份照样能导 |
| `src/core/types.ts` | `Settings` 加 `kc` 字段 | 同上 |
| `src/dao/syncScheduler.ts` | 逻辑抽到 `syncSchedulerFactory`，本文件变成薄封装 | **对外 API 一字未改**，一期的 SyncBanner / CloudSection / App / main 全不用动 |
| `src/dao/syncServer.ts` | `API_ROUTES` 加 `kcList` / `kcPush` | `test:build` 有护栏校验路由表与 `api/` 文件一一对应 |
| `src/dao/index.ts` | 导出二期 5 个 DAO 模块 | — |
| `src/main.ts` | 注入二期同步实现 + 挂 `__kcselftest` + 引入 kc.css | 启动顺序不变 |
| `api/_dev/harness.mjs` | 本地路由分发表加两条 | — |

**★ 三个必须知道的设计决定**（都在代码注释里有完整推导）：

1. **掌握度公式加了方向系数**。主提示词给的公式 `penalty * |selfNorm - examNorm|` 是**对称**的，
   但在 `w1=0.6 > w2=0.4` 的权重下会算出「盲目自信(3/1)=0.2 **高于** 低估自己(1/3)=0.067」，
   与主提示词自己的表述（盲目自信最危险）和阶段 01 验收项 3（要求明显低于）**正好相反**。
   所以惩罚项加了 `asymmetry`（默认 2）：高估时惩罚 ×2、低估时 ÷2。
   `w1/w2/penalty` 三个用户指定的数字一个没改，`asymmetry=1` 就退回原公式。
   完整对照表在 `kcModel.calcMastery` 的注释里（16 个格子全部实算过）。
2. **二期同步用独立的调度器实例与游标**（`settings.kc.cloud`）。同一个库、同一套 spaceKey、
   同样的分批 ≤500，但失败计数与游标独立——二期后端抽风不会让一期也进「连续失败 3 次」常驻提示。
3. **`kc.ts` ⇄ `kcCloud.ts` 是真循环依赖**，靠「import 写在文件末尾」解决不了（ESM 会提升）。
   做法是调度器不 import 同步实现，改由 `main.ts` 注入（`registerKcSyncRunner`）。
   没注入时（Node 测试里直接调 DAO）`scheduleKcSync()` 静默什么都不做，本地功能不受影响。

**二期表的主键是 `(space_key, id)` 复合主键**，不是主提示词里写的 `id TEXT PRIMARY KEY`——
理由与一期完全相同：主键只有 id 时，`ON CONFLICT(id) DO UPDATE` 会把 `space_key` 一起改掉，
**跨空间覆盖**（隔离直接失效）。`test-kc.mjs` 第 8 组有护栏检查四张表都是复合主键。

**验收结果**：`npm run test:kc` 106 项全过；`npm run test:kc-ui` 15 项全过（真 Chrome）；`npm test` 全量回归通过（一期功能未损坏）。

---

### 0.8 二期阶段 02：聊天式录入（★ 当前最新改动）

`#/kc/import`：用户说一句「我在定语从句这块不行」，AI 拆成若干张结构化知识点卡片，
逐张**预览 / 采纳 / 编辑 / 丢弃**，最后「确认入库」一次性写库。

| 文件 | 作用 |
|---|---|
| `src/services/kcPrompts.ts` | **三套提示词的集中管理处**（改 AI 行为只改这里）。录入提示词完整；出题/评分留 `TODO`（阶段 05） |
| `src/services/kcImportParse.ts` | **解析层**：JSON 抽取 + 三级降级、逐块校验清洗、题型白名单、`estMinutes` 钳到 3~5 |
| `src/services/kcAi.ts` | **调用层**：`analyzeWeakPoint()`，复用一期 `chatComplete`（继承直连⇄代理切换、JSON 模式降级） |
| `src/ui/components/KcChatPanel.ts` | 聊天面板：会话状态机 + 渲染 |
| `src/ui/components/KcCardPreview.ts` | 卡片预览（8 种块的安全渲染 + 操作按钮） |
| `src/ui/components/KcMetaEditor.ts` | 改标题/摘要/考法标签的弹窗 |
| `src/ui/pages/KcImportPage.ts` | 录入页：布局 + 发起请求 + 入库 + 手动新建兜底 |
| `src/ui/pages/KcHomePage.ts` | 二期首页（6 个入口；本期只有「录入」可用，其余点了给阶段提示） |
| `api/_dev/kcImportFixture.mjs` | 假 AI 返回（Node 与浏览器测试共用） |
| `api/_dev/test-kc-import.mjs`（58 项）/ `test-kc-import-ui.mjs`（36 项，真 Chrome + 本地假 AI 服务） | 阶段 02 验收 |

**改动**：`src/App.ts`（加 `/kc`、`/kc/import` 两条路由 + 顶栏「知识点」入口，该入口在 `/kc/*` 全部子路由下都点亮）、
`src/styles/kc.css`（二期页面样式）、`src/core/config.ts` + `kcTypes.ts`（`examLoadMin/MaxMinutes`、`ParsedKcCard`）、
`api/_dev/test-build.mjs`（**新增 BOM 护栏**，见下）、`package.json`。

**★ 本阶段排掉的一个高危事故（值得记住）**

用 PowerShell 的 `Set-Content -Encoding UTF8` 改文件会**写入 UTF-8 BOM**。
后果极其阴险：`node` 与 `tsc` 都容忍 BOM，所以 `npm test`、`npm run build` **全绿**；
但 **Vite dev 的 PostCSS 配置加载器用严格 `JSON.parse` 读 `package.json`**，
遇 BOM 直接抛错 → **所有 CSS 请求 500** → `main.ts` 的 `import './styles/global.css'` 挂掉 →
`boot()` 根本不执行 → **整页白屏**（控制台只有几条看不清的 CSS 500）。

已修：剥掉 5 个自己造成的 + 2 个仓库里本来就带的（`CloudSection.ts` / `DataSection.ts`），
并在 `test:build` 加了 `[9] UTF-8 BOM 护栏`（扫 src/api/配置文件 + 要求 package.json 能被严格 JSON.parse）。
**用 PowerShell 改文件请用 `-Encoding utf8NoBOM`。**

**验收结果**：`npm run test:kc-import` 58 项、`npm run test:kc-import-ui` 36 项全过；`npm test` 全量回归通过。
⚠️ 验收标准 2/8（真实模型产出的质量与去重）**需要你在浏览器里真跑一次**，见 `二期阶段02_验收单.md` §3。

---

### 0.9 二期阶段 03~05：卡片编辑/列表、学习流程、出题与评分（★ 当前最新改动）

按用户的「一口气做完」要求连续推进了三段，**每段都有独立验收脚本**且全部通过。

#### 阶段 03：块编辑器 + 卡片列表

| 文件 | 作用 |
|---|---|
| `src/ui/components/BlockEditor.ts` | 块编辑器（8 种块的新建/编辑/上下移/复制/删除 + 预览切换） |
| `src/ui/components/KcBlockFields.ts` | 按块类型的编辑控件（列表项增删、表格增删行列） |
| `src/ui/components/kcBlockTypes.ts` | 块类型中文名与「新增块」工具条（**名字只写一份**） |
| `src/ui/pages/KcCardEditPage.ts` | 卡片编辑页（防抖 1 秒自动保存 + 显式保存） |
| `src/ui/pages/KcCardListPage.ts` + `kcList/` | 列表页（统计条/筛选/搜索/排序/分页/批量/斩复活） |
| `src/ui/pages/KcCardViewPage.ts` | 卡片详情（只读，带属性面板） |
| `src/dao/kcQuery.ts` | 查询纯函数（过滤/排序/分页，**已单测**） |
| `src/dao/kcBatch.ts` | 删除语义与批量操作（斩/复活/永久删除/批量版） |

#### 阶段 04：学习流程

| 文件 | 作用 |
|---|---|
| `src/dao/kcSession.ts` | 会话 DAO（**IndexedDB 升到 v4**，新增 `kcSessions` 表） |
| `src/ui/pages/KcStudyPage.ts` | 学习流程（选数量 → 逐张自评 → 保存退出 → 续跑） |
| `src/ui/components/KcStudyCardView.ts` | 学习态卡片（进度/标签/三档自评/斩） |
| `src/ui/components/KcCountPicker.ts` / `KcFinishPanel.ts` / `kcStudyDialogs.ts` | 学与复习共用的小组件 |

**会话不上云**：`kcSessions` 是「这台设备进行到哪儿了」的临时状态，推到别的设备只会造成困惑。

#### 阶段 05：出题与评分

| 文件 | 作用 |
|---|---|
| `src/services/kcExamPrompts.ts` | 三套提示词：每日语境词 / 出题 / rubric 评分 |
| `src/services/kcExamParse.ts` | 解析层（不可信输入的清洗，**可离线测**） |
| `src/services/kcExamAi.ts` | 调用层（语境词生成 / 出题 / 评分） |
| `src/ui/components/ExamTaker.ts` | 答题组件（四种题型各自作答 + 评分卡 + **改分**） |
| `src/ui/components/KcContextBar.ts` / `KcContextManager.ts` | 每日语境词（生成 → 编辑 → 确认） |
| `src/ui/pages/KcExamPage.ts` + `kcExam/` | 做题流程（状态机 / 出题材料 / 续跑） |
| `src/ui/pages/KcBankPage.ts` | 题库页（增删查、按题型筛） |
| `src/dao/kcSmallCloud.ts` | 三张小表的云同步 |
| `api/context-words.ts` / `exam-history.ts` / `bank-questions.ts` + `_lib/kcSmall*.ts` | 三个新接口 + SQL/校验层 |

**阶段 05 的一个必要改动**：`daily_context_words` / `exam_records` / `bank_questions`
在阶段 01 建表时**没有 `updated_at` 与 `deleted`**（主提示词的建表语句里就没有），
而云同步必须靠它们做后写覆盖与墓碑。`api/_lib/kcSchema.ts` 现在**幂等补列**
（先 `PRAGMA table_info` 查，缺了才 `ALTER TABLE ADD COLUMN`），老库自动升级、数据不动。

**三个新接口的路由**已登记在 `src/dao/syncServer.ts` 的 `API_ROUTES` 与
`api/_dev/harness.mjs`（`test:build` 有护栏盯着两边一致）。

**验收结果**：

| 套件 | 项数 | 内容 |
|---|---|---|
| `test:kc-edit` | 66 | 8 种块渲染、表格增删行列、搜索命中块内容、斩复活、批量、XSS |
| `test:kc-edit-ui` | 39 | 真 Chrome：打字改标题、加块、上移、删块、预览 XSS、重新打开改动都在 |
| `test:kc-session` | 38 | 会话结构、抽卡顺序、自评落库、保存恢复、斩的清理 |
| `test:kc-session-ui` | 40 | 真 Chrome：逐张展示、点/键盘自评、斩、退出重进、移动端热区 |
| `test:kc-exam` | 95 | 三套提示词、三种解析、出题量/防重复/题库、mastery 重算、改分、语境词、三个接口 |
| `npm test` | — | 全量回归通过 |

**★ 三个真 bug（都是测试抓出来的，值得记住）**
1. **表格/列表的「加行加列」页面不动**：块编辑器重画整棵 DOM 后，内层控件的 `repaint()`
   还在往**已脱离文档**的旧节点里画。修法：每次从当前 DOM 重新取宿主节点
   （见 `KcBlockFields.ts` 的 `host()`）。
2. **`createBlock('example')` 造出的块不合法**：`validateBlock` 原来要求例句块「内容非空」，
   但**空块是合法的**（编辑器刚造出来就是空的）。已改为只校验结构。
3. **没配题型的卡片一道题都出不了**：`questionTypesFor` 原来返回空数组，已加兜底 `['fill']`。

**★ 两个测试脚手架的坑**
1. 无头 Chrome 默认窗口**不到 768px**，响应式页面会走手机布局（列表不渲染表格）。
   要验桌面布局必须给 `launch()` 传 `windowSize`（已加到 `scripts/cdp.mjs`）。
2. `test:build` 的「坏导入」扫描器会把**注释里**提到的路径当成真导入。
   已改为先剥注释再扫（同一次改动里还补了「目录导入 → index.ts」的解析，
   否则用 node 直接跑源码测试会 `ERR_UNSUPPORTED_DIR_IMPORT`）。

---

### 0.10 二期阶段 06~07：复习流程与桥接、设置页与题库管理（★ 二期全部完成）

#### 阶段 06：复习流程 + 一期背单词桥接

`#/kc/review`：选数量 → 看卡片（自评）→ **【桥接】一期背 5 个单词** → 做题 → 收尾。

| 文件 | 作用 |
|---|---|
| `src/ui/pages/KcReviewPage.ts` | 复习流程（四个 stage 由 `KcSession.stage` 串起来） |
| `src/ui/pages/kcReview/kcReviewFlow.ts` | 抽卡规则（优先度降序 + 同分看 lastReviewAt）、推荐数量、桥接词源、收尾更新 |
| `src/ui/pages/kcReview/kcReviewPicker.ts` | 复习的「选数量」界面（带推荐数字说明） |
| `src/ui/pages/KcWordBridge.ts` | **一二期唯一桥接点**：复用一期 `createPaperFlow` 背 5 个词 |

**桥接的三条纪律**（都在代码注释里）：复用一期页面（不复制）、不改一期核心逻辑（只在外层调用）、
用**一期自己的 `sessions` 表**存桥接会话（与二期 `kcSessions` 分开，互不覆盖）。

#### 阶段 07：设置页 + 题库管理

| 文件 | 作用 |
|---|---|
| `src/core/kcPriorityExpr.ts` | **二期自己的优先度表达式引擎**（白名单校验 + 试算，与一期同机制不同变量表） |
| `src/ui/pages/KcSettingsPage.ts` | 设置页（掌握度 / 优先度 / 参数 / 数据说明四区） |
| `src/ui/pages/kcSettings/KcMasterySection.ts` | 掌握度公式（4 参数 + 3 预设 + 试算最近 5 条） |
| `src/ui/pages/kcSettings/KcPrioritySection.ts` | 优先度（3 预设 + 自定义表达式 + 变量 chip + 实时校验 + 重算） |
| `src/ui/pages/kcSettings/kcSettingsCtx.ts` | 写设置 + **重算全部卡片**（改公式后列表页立刻跟着变） |
| `src/ui/pages/kcBank/kcBankImport.ts` | 题库批量导入（规则分类 + 三种切分方式）/ 导出 |

**优先度从「固定权重」升级成「表达式」**：阶段 01 的固定加权公式仍保留为兜底
（表达式为空或非法时用它），两条路都留着，切换是显式的。

**★ 「重算全部」的必要性**：用户改了公式参数后，库里存的 `attrs.mastery` 还是旧公式算的，
列表页的掌握度与排序会停在旧值上。所以 `patchKcSettings` 每次写完设置都会
**逐张重算并写回**（只写数值真变了的，避免无意义的 `updatedAt` 刷新与同步推送）。

**验收结果**：

| 套件 | 项数 | 内容 |
|---|---|---|
| `test:kc-review` | 49 | 抽卡规则、桥接词源（新→旧→空库）、四阶段流转、收尾属性、桥接不改一期 |
| `test:kc-review-ui` | 33 | 真 Chrome：三环节走通、words 阶段退出重进仍在背单词、词源退化、完成属性更新 |
| `test:kc-settings` | 58 | 表达式白名单/求值、改参数→掌握度变、预设→排序变、非法表达式被拦、题库分类与导入导出 |
| `test:kc-e2e` | 30 | **完整冒烟**：录入→列表→学习→编辑→复习(含桥接)→设置改参数→题库（真 Chrome + 假 AI） |
| `npm test` | — | 全量回归通过 |

**测试抓出来的 1 个真 bug**：题库的「选择题」判定原来只认「一行一个选项」，
一行内联写法（`A. who B. which`）会被判成填空 —— 真题排版里很常见，已补强规则。

**★ 一个测试脚手架的坑（第二次踩）**：`location.hash = 相同的值` **不会触发 hashchange**，
页面不会重渲染。测试里「造完数据再回同一页」必须**先绕到别的路由再切回去**
（见 `test-kc-review-ui.mjs` 的 `goto()`）。

---

### 0.11 修复：IndexedDB「object stores was not found」（★ 用户实测报错，两轮才查透）

**用户报错**（先是这一句，修完第一轮后变成第二句）：
```
Failed to execute 'transaction' on 'IDBDatabase': One of the specified object stores was not found.
数据库连接里没有表「kcSessions」（可能是版本升级还没完成或被其他标签页占用）
```

**根因（两轮探针查出来的）**

第一轮确认：**数据从来没坏，坏的是「连接」**。页面可能持有旧版本的连接
（`DB_VERSION` 升到 4 时，老标签页/热更新前的老页面手里还是 v3，里边没有 `kcSessions`）。

第二轮发现**更关键的一层**（这才是那句错误反复出现的真正原因）：

> **页面自己的旧连接会阻塞自己的升级。**
> IndexedDB 的规则是「只要还有连接开着且版本更旧，更高版本的 `open` 就进不去」。
> 旧代码在 `onversionchange` 里只做了 `close()`，**没清 `dbPromise` 缓存** ——
> 于是本页后面拿到的还是那个已经关掉的旧连接，用它开事务就报「表不存在」。
> 更糟的是，被阻塞的 `open` 请求**不会被取消也永远不会返回**（探针因此 10 分钟超时），
> 表现是「点了没反应」。

还有两个放大器：`db.transaction()` 抛在 `new Promise` 构造器里 → **不会被 reject 接住**；
`main.ts` 启动时**没有 await `openDB()`** → 「数据库打不开」根本不显示给用户。

**修复（`src/core/db.ts` / `config.ts` / `main.ts`）**

| 改动 | 作用 |
|---|---|
| **`DB_VERSION` 4 → 5**（**不是新功能，是修复**） | 库版本号已经是 4 但缺表的库，版本相同就**永远不再触发 `onupgradeneeded`**，那张表永远补不上。抬到 5 给所有这类库一次重跑建表的机会（对正常库是空操作） |
| `tx()` / `txRun()` 走 `withStore()`，三级处理 | ① 缺表 → 丢掉本页连接重开；② 重开仍缺 → **`repairUpgrade()` 抬版本号重跑建表**（只补缺的表，数据一条不动）；③ 还不行 → 抛 `StaleDbError`（说人话） |
| 记住本页连接 + `releaseConnections()` | 修复前先放开自己的连接，否则会被自己挡住 |
| `onversionchange` 里同时清 `dbPromise` | 别人升级时主动让位，且不再把已关闭的旧连接发给后续调用（**这是原来最致命的一处**） |
| `DB.openTimeoutMs`（8 秒） | 被占用时不再无限挂起 |
| 打开失败/超时**不缓存** `dbPromise` | 关掉老标签页后**本页不用刷新就自愈** |
| `main.ts` 启动阶段渲染「数据库打不开 + 重试」 | 不再白屏 |

**验证（Node + 真浏览器，全过）**

| 场景 | 结果 |
|---|---|
| 全新库 | ✓ v5、9 张表 |
| 老库 v3 → 新代码 | ✓ 升级成功、一期数据保住、会话 DAO 全流程可用 |
| **库已是 v5 但缺 kcSessions**（最难修） | ✓ 自动抬到 v6 补表、**数据一条不丢**、DAO 立刻可用 |
| 老连接占着（升级 blocked） | ✓ 不再抛 IndexedDB 原文，给的是「关掉其它标签页后点重试」 |
| 关掉老连接后 | ✓ **不刷新就自愈**（v5、kcSessions 就位），卡片增删改查/斩/已斩全部照常 |
| `npm test` + 7 套二期专项 + 4 套真浏览器冒烟 | ✓ 全过 |

**给用户的建议**：关掉所有打开着这个应用的标签页，再刷新一次。
以后再遇到「点了没反应」或这类 IndexedDB 报错，先看这一条。

---

### 0.12 用户实测反馈后的六项改动（★ 当前最新改动）

用户报了一条 bug + 提了五条要求，逐条落地。**这一节的东西都是用户亲口要的，改回去会直接挨骂。**

**① 二期的设置界面渲染失败（bug）**

三层原因，全修了：

| 层 | 问题 | 修法 |
|---|---|---|
| 连接 | 陈旧连接去开事务时报「表不存在」，而 `db.transaction()` 抛在 `new Promise` 构造器里**不会被 reject 接住** → 变成未捕获异常 | `tx()` / `txRun()` 里把 `db.transaction()` / `objectStore()` 包进 `try`，转成正常 reject（`src/core/db.ts`） |
| 调用方 | 设置页有 ~10 处 `void (async () => {…})()` 的「fire and forget」，任何异步失败都会变成未捕获拒绝 → 错误边界把**整页**换成「页面渲染失败」 | 全部改走 `runSafely(label, fn)`：catch 一切、区分 `StaleDbError`、只弹 toast 不抛（`kcSettings/kcSettingsCtx.ts`） |
| 渲染 | 三个分区在 `renderKcSettingsPage` 里顺序构造，任一抛异常整页就白 | `section(name, build)` 逐块 try/catch，坏掉的那块自己显示原因，其它分区照常可用（`KcSettingsPage.ts`） |

**顺带做的结构整理（为了 ≤300 行 + 职责单一）**：`db.ts` 504 行拆成四个文件——
`dbSchema.ts`（库名/版本/表名/建表迁移）、`dbOpen.ts`（打开、让位、抬版本号修复）、
`dbStale.ts`（`StaleDbError` + `withStore` + `withDbRetry`）、`db.ts`（只发事务，106 行）。
`db.ts` 仍然**再导出** `STORE` / `openDB` / `StaleDbError` 等，几十个 DAO 的 import 一行没动。

**② 出题改成「一口气出完」**（用户原话：「把所有 AI 出题时间放在开始第一题之前」）

- 新模块 `ui/pages/kcExam/kcExamPrepare.ts`：`buildSlots()` 先把「卡片 × 题型」的槽位表铺好，
  `prepareQuestions()` 用**并发 3**（`KC.examGenConcurrency`）一次出完，逐题报告进度。
- 控制器新增 `preparing` 阶段 + `start()`：先出完所有题再显示第一题；
  `load()` **不再调用 AI**（只从内存槽位取题），所以「评分完 → 下一题」是瞬时的。
- 出题失败**只影响那一道**（进 error 槽位，单独「重试」），不会让整轮停住。
- 续跑时只补出「还没答过的题」（`pendingIndices()`），省时间也省 token。
- 界面：`renderPreparing()` 显示「正在一口气出完这一轮的题 已出好 3/7 道」+ 进度条
  （不谈进度用户会以为卡死）。

**③ 录入输出更简洁 + 表格不带表头**（用户原话：「抓住记忆的痛点…表格就不要写表头了」）

- `services/kcPrompts.ts`：删掉「内容完整 / 讲透」导向，改成**一张卡 2~4 个块、每块一句话**，
  要求用「有 the 时…／无 the 时…」这种**二分对照**抓痛点，明确禁止复述常识与废话；
  schema 示例也换成了无表头的对照表（**示例比规则管用**，示例带表头规则会被无视）。
- `core/blockRender.ts`：表格**所有行都按数据行渲染**，不再把 `rows[0]` 当 `<thead>`。
  ⚠️ 渲染端**不假设**数据里没有表头行——库里早就有旧格式的卡，猜错一行等于悄悄吃掉用户数据。
- 配套测试断言：`test:kc-session-ui` 改成「2 行 → 4 个 td、0 个 th」。

**④ 录入模块 AI 有上下文记忆**（用户原话：「录入模块中，AI 应该具有上下文记忆」）

- `services/kcAi.ts`：新增 `buildKcMessages()`（纯函数，可直接单测）+ `ChatTurn`，
  `analyzeWeakPoint(userMessage, existingTitles, cfg, history)` 多了一个可选参数。
  历史**按真实角色逐条发**（system 在最前、本轮 user 在最后），不塞进一条 user 消息里——
  否则模型会把「历史里自己写的卡片」当成要重新生成的内容。
- 截断**双上限**（都在 `config.ts` 里，不许写死）：条数 `KC.maxChatHistoryMessages`、
  字符预算 `KC.maxChatHistoryChars`，从最旧的一端丢，最近一轮永远保留。
  没有上限的后果是实打实的：assistant 那条是整段卡片 JSON，第 10 轮要付 10 倍输入费，
  超上下文还会**整个请求 400**。
- 被丢掉的轮数会回传到界面（`ImportResult.omittedTurns` → 聊天区一行灰字），
  **不能悄悄丢**：用户以为自己说的前文 AI 还记得，界面却毫无线索。
- assistant 那侧优先用上一轮的**原始 JSON 返回**（`entry.raw`），取不到才退化成 `cardsBrief()`。

**⑤ 删掉独立「做题」入口，学习自动续到那道题**

- `KcHomePage.ts`：入口从 7 个减到 6 个（录入/卡片列表/学习/复习/题库/设置），
  `exam` 那条**故意不存在**（注释里写明了原因）。
- `KcStudyPage.ts` 启动逻辑：取到 `loadLatestOpen('study')` 后，若 `stage === 'exam'`
  就**直接** `navigate('/kc/exam?resume=1')`，不再弹「继续上次 / 重新开始」——
  用户原话是「在点学习就自然而然跳转进做到的那道题」。

**⑥ Enter 键全程可用**（用户原话：「不要一会可以用一会又不行」）

以前 Enter 是散在各处的：填空题输入框自己监听、选择题按钮不认、评分页「继续」也不认。
现在**只有一个出口**（`ui/components/examKeys.ts`，纯函数 `resolveEnterAction()` 可单测）：

| 阶段 | Enter |
|---|---|
| 出题中 / 评分中 | 不响应（评分中**故意**不响应：重复提交会重复落库、重复扣分，控制器里也有 `phase === 'grading'` 守卫） |
| 作答中 · 填空/造句 | 提交（造句题 Shift+Enter 换行） |
| 作答中 · 选择/判断 | 提交**高亮那一项**（↑↓←→ 或数字键换项，默认高亮第一项，鼠标移上去也跟着高亮） |
| 已评分 | 下一题（最后一题 = 收尾） |
| 出错 | 重试当前题 |
| 做完了 | 回二期首页 |

两条容易漏的细节：**焦点在按钮上时让给浏览器原生**（否则选择题会「原生点击 + 我们提交」
各一次、落两条记录）；监听挂在 `page` **和** `window` 两处（答题卡整块重画会把焦点丢到 body，
只挂一处就会出现「时灵时不灵」）。

**验证（全过）**

| 套件 | 结果 |
|---|---|
| `npm run test:kc-exam-ui`（**新增**，真浏览器 + 假 AI 请求日志） | ✓ 26 项 |
| `test:kc-exam`（新增第 8 节：槽位表/题号换算/Enter 规则表） | ✓ 123 项 |
| `test:kc-import`（新增历史截断 + `entriesToHistory`） | ✓ 95 项 |
| `test:kc-ui`（新增设置页渲染 + 单分区失败隔离） | ✓ 23 项 |
| `test:kc` / `test:kc-edit` / `test:kc-session` / `test:kc-review` / `test:kc-settings` | ✓ 106 / 69 / 38 / 49 / 58 |
| `test:kc-import-ui` / `test:kc-edit-ui` / `test:kc-session-ui` / `test:kc-review-ui` / `test:kc-e2e` | ✓ 48 / 42 / 40 / 33 / 30 |
| `npm test`（含 build + 一期全部回归） | ✓ 全过 |

`test:kc-exam-ui` 值得单独说：它的假 AI 会**记录每一次请求**，
所以「答题过程中零出题请求」（= 用户要的「一口气出完」）是**数出来的**，不是感觉出来的。

**顺带修掉的两条过期护栏**（改了结构就得跟着改，否则测试会假红）：
`test-rename.mjs` 与 `test-about.mjs` 里查 `DB_NAME` 的位置从 `src/core/db.ts`
改到 `src/core/dbSchema.ts`；`test-kc-import-ui.mjs` 里「未实现的入口标了待做」
是阶段 02 的占位断言（入口后来全做完了），改成反过来断言「没有待做占位 + 没有独立做题入口」。

**另外三个文件为了守住 ≤300 行做了纯搬运**（逻辑一行没变）：
`kcExamState.ts`（状态机类型）、`kcChatHistory.ts`（消息 → 请求上下文）、
`dbSchema/dbOpen/dbStale`（见上）。

---

### 0.13 二期上线（2026-09-13）

**仓库**：https://github.com/ynot-cai/Blank-Sheet-Vocab （public）
**线上**：https://blank-sheet-vocab.vercel.app （Vercel，region `hkg1`）

提交 `0fa0acd`（二期全部 + 本轮六项改动，133 个文件、约 2.4 万行）推送后，
**Vercel 自动构建并上线**（GitHub App 集成：push 到 `main` → Production 部署；
可用 `gh api repos/ynot-cai/Blank-Sheet-Vocab/deployments` 看每次部署挂在哪个 commit 上）。
线上 `index-*.js` 的 hash 变了 = 新构建真的生效了，这是最快的判断方式。

**上线后验证（全过）**

| 检查 | 结果 |
|---|---|
| `npm run test:live`（真实 URL 打 9 条路由 + 一期同步协议） | ✓ 25 项 |
| `npm run test:live-ui`（**新增**：真浏览器打线上构建） | ✓ 14 项 |
| `/api/kc-list`、`/api/context-words`、`/api/exam-history`、`/api/bank-questions` | ✓ 都活着（不带 spaceKey 返回 401，符合预期） |
| `/api/kc-push` | ✓ GET 返回 405（只收 POST） |
| `/api/health` | ✓ `db: connected`（Turso 环境变量在，二期建表走 `initKcSchema()` 首次请求自建） |

`test:live` 只打接口、本地那十几套只打 dev 源码，**两者都替代不了「线上构建能不能打开」**——
所以补了 `test:live-ui`：用真 Chrome 打开线上地址，断言挂载、顶栏「知识点」、
二期六个入口、**设置页**（用户报过渲染失败的那一页）、一期首页没崩。

**★ 一个容易卡住人的坑：`git push` 的代理**

本仓库的 git 配了 `http.proxy = http://127.0.0.1:7897`（系统代理软件）。
代理**没开**的时候 push 会直接失败：

```
fatal: unable to access 'https://github.com/...': Failed to connect to github.com:443
 over proxy 127.0.0.1 after 2114 ms: Could not connect to server
```

处理：确认代理端口在不在（`Test-NetConnection 127.0.0.1 -Port 7897`）。
- 代理开着 → 直接 `git push origin main`；
- 代理没开 → 一次性绕开：`git -c http.proxy= -c https.proxy= push origin main`
  （想长期直连就 `git config --unset http.proxy; git config --unset https.proxy`，
  但网络不稳时直连 GitHub 会间歇性超时，重试一两次即可）。

注意 `gh` CLI 和浏览器（`test:live-ui` 用的 Chrome）走的是各自的路径，
**它们能通不代表 `git push` 能通**，反之亦然。

---

### 0.14 阶段 R4：规则固化 + 三项改造

用户的原话是「之前口头提过『不要时间限制』，但换个对话就忘了」。
所以本阶段的核心不是「改三处代码」，而是**让规则住进文件，而不是住在对话记忆里**。

#### ① 规则固化（治「AI 失忆」的机制）

| 文件 | 作用 |
|---|---|
| `AI_RULES.md`（仓库根） | **项目铁律**（最高优先级）。R1 无强制时间限制 / R2 义项系统 / R3 斩可撤销 / R4 安全底线 + 第 4 节「运行时 AI 提示词必含片段」 |
| `scripts/checkRules.mjs` | 机器检查：注释标记、提示词必含片段、可疑答题计时、安全底线 |
| `npm run rules:check` | 跑上面那个脚本（**已挂进 `npm test` 的第一环**） |
| 代码里的 `// RULES-R1:` `// RULES-R3:` 注释 | 让规则在代码里「看得见」 |

⚠️ **`AI_RULES.md` 与 `scripts/checkRules.mjs` 都是用户给的原文，逐字放进来**（首次落地时做过
SHA-256 校验）。改它们等于改铁律，**需要用户明确同意**。
★ 「改松自检让它变绿」是被明令禁止的修法（和 §0.1 里那条「把断言改回旧值」是同一类错误）。

**第 4 节的必含片段存了一份在代码里**：`src/services/promptRules.ts`
（`MANDATORY_IMPORT_RULES` / `MANDATORY_EXAM_RULES`），由 `AI_RULES.md` 决定内容，
三个提示词模板（一期 `ai.ts` 的 `PARSE_SYSTEM_PROMPT`、二期 `kcPrompts.ts` 的
`KC_IMPORT_SYSTEM_PROMPT`、`kcExamPrompts.ts` 的 `KC_EXAM_SYSTEM_PROMPT`）都引用它。
- 为什么不各抄一份：抄三份就会「改一处忘两处」，AI 的行为和铁律互相矛盾（§0.4 踩过）。
- 为什么文件名叫 `promptRules.ts`：自检脚本 R2 是在「文件名像提示词模板」的文件里找指纹的，
  放 `core/` 下会变成「规则写了但自检看不见」。
- `npm run test:r4` 会**逐字**比对这份副本与 `AI_RULES.md` 第 4 节，不一致就红。

#### ② 斩：不弹确认 + ≥8 秒撤销（一 / 二期全部斩点）

`components/Toast.ts` 新增 `showUndoToast(message, onUndo)`，窗口常量 `UNDO_WINDOW_MS = 8000`。
文案就是用户要的「已斩 XXX 〔撤销〕」。七个斩点全部改完：

| 位置 | 撤销时恢复什么 |
|---|---|
| `paper/flow.ts`（一期白纸单词卡） | 状态 + 词单位置 + 是否已上纸 + **画布上的落点**（重新画回去） |
| `ListPage.ts` 单行 | 状态。**批量斩**额外走 `dao.words.restoreStatuses()` 逐词还原 |
| `KcStudyPage.ts` / `KcReviewPage.ts` | 共用 `ui/pages/kcChopUndo.ts`（两处行为必须一致） |
| `KcCardListPage.ts` / `KcCardEditPage.ts` | 状态 + 墓碑；编辑页斩完会跳走，所以撤销**不依赖本页状态** |
| `kcList/KcListBatch.ts` | `dao.kcBatch.bulkRestoreChopState()` 一次事务批量还原 |

★ **撤销的语义是「完全恢复」，不是「复活」**，这是本次最容易做错的一处：
- `dao.words.revive()` 按 `learnedAt` 猜状态、`dao.kc.revive()` 一律写 `unlearned`，
  用它们做撤销会把 `learned/learning` 的卡掉回未学 —— 所以新增了
  `words.restoreStatuses()` / `kcBatch.restoreChopState()` / `bulkRestoreChopState()`，
  都是**按快照还原原值**。
- 二期还要还原**本轮学习/复习队列里的位置**：插回 `max(原下标, 当前下标)`
  （立刻撤销 → 它重新变成当前这张；先评了几张再撤销 → 它接着就会被看到。
  硬插回原下标会落在「已经翻过去」的位置，用户会以为撤销没生效）。完整推导在 `kcChopUndo.ts` 头注释。
- 复习页的 `onWordChopped` 现在**返回一个「撤销这次移除」的函数**（分组里的下标也要还原）。

#### ③ 清除强制时间限制（★ 抓到一个脚本扫不到的真 bug）

`paper/rounds.ts` 的 `waitUntil()` 原来是 `for (let i = 0; i < 400; i += 1)` × 25ms
= **等 10 秒就 `return cond()`（false）**，而两个调用点都不看返回值、直接往下判分。
后果：用户盯着默写题思考超过 10 秒，界面会**自己把没作答的框当提交判掉**
（空答案 → 记一次未通过 → 弹答案卡）—— 这就是铁律禁止的「超时自动提交」。

- 已改成 `for (;;)`：一直等到用户真的提交或主动退出，**不给任何时限**。
- ⚠️ `scripts/checkRules.mjs` 的 R1 是按变量名（timeLimit / countdown / deadline）扫的，
  **这种「按次数封顶的等待循环」它扫不到** —— 所以本项是靠人工排查发现的，
  `npm run test:r4` 里加了一条「等待循环不许有次数上限」的断言钉住它。
- 另外把 `kcExamPrompts.ts` 语境词 schema 示例里的 `deadline` 换成了 `umbrella`：
  它只是个示例单词，但会触发 R1 的 WARN，看着像违规。
- 逐条确认过 14 处 `setTimeout` 全是合法用途（网络/数据库超时、防抖、重试退避、
  焦点转移、Toast/banner 自动隐藏、自测 tick），都在原处加了 `RULES-R1:` 说明。
- 21 个「考察相关」文件（自检按文件名捞的）+ 一期真正作答的 4 个文件都加了 `RULES-R1` 标记。

#### ④ 义项系统：评判结论 = **合格**（6 条自查全过）

录入 → 数据结构 → 输入框 → 判分，全链路本来就是对的，本次**没有改判定逻辑**，
只补了验收脚本把它钉住（`test:r4-ui` 第 [1] 组就是这 6 条）：

| §3.2 | 结果 | 实测现象 |
|---|---|---|
| ① `bank` 是 2 个义项 | ✅ | `coerceParsedWord` 出来 2 条（银行 / 河岸），没被合并 |
| ② 高兴/快乐/愉快 = 1 义项 + 2 近义词 | ✅ | 1 个义项、`aliases` 被 `normalizeAliases` 拆成 2 项 |
| ③ 考 `bank` 出现 2 个输入框 | ✅ | `.mem-input` 实测 2 个（`rounds.ts` 是 `senses.forEach` 生成） |
| ④ 填「银行」+「河岸」→ 通过 | ✅ | 答案卡两条都 ✓ |
| ⑤ 改填「岸边」（近义词）→ 仍通过 | ✅ | `senseMatch` 命中 aliases，两条都 ✓ |
| ⑥ 只对第一个 → 未通过 | ✅ | `results.every(Boolean)`，第二条 ✗ |

#### ⑤ 验收与自检

| 套件 | 项数 | 内容 |
|---|---|---|
| `npm run rules:check` | 9 | **全绿（9 通过 / 0 警告 / 0 错误）** |
| `npm run test:r4` | 55 | 规则文件机制、必含片段逐字比对、R1 无时限、义项数据形态、撤销窗口 ≥8s、安全底线 |
| `npm run test:r4-ui` | 33 | 真 Chrome：§3.2 的 ③④⑤⑥、停 12 秒不被自动提交、一/二期斩无确认+可撤销 |
| `npm test` | — | 全量回归通过 |

★ `test:r4` 的两条**设计取向**，改的时候别拆掉：
1. 它会 `execFileSync` **真的跑一次 `scripts/checkRules.mjs`** 并断言退出码 0 —— 
   不是「把它抄一遍」，否则脚本坏了测试还是绿的。
2. 扫「禁止出现的计时代码」时**先剥注释**（同 `test-build.mjs` 的做法）：
   注释里提到 timeLimit 往往正是在讲这条规则，不剥的话**解释规则的话反而被判违规**。
   （`checkRules.mjs` 本身的 R4 有一处同类误报：`blockRender.ts` 的注释里
   `el.innerHTML = block.content` 会被当成真的 innerHTML 赋值。**没有改脚本**，
   而是把注释改写成不触发该模式的说法「把 `block.content` 当作元素的 `innerHTML` 赋进去」，
   既保住了说明，又不放松检查。）

---

### 0.15 用户实测第二轮：背诵流程六项修正

用户这一轮是**口述需求**（原话在下面各条里），并且明确交代：

> 「以上，我说的很多或许和可能你在文件夹里看到的『提示词』md 文件冲突，
>   **请你以我说的为主**，并且在和我说的话冲突的提示部分**做标记**。」
> 「另外我上一轮删的很多就是提示词，如果你在 git 仓库看到还有备份，就一并删了吧。」

#### ① 文档收敛：那批 md 从 git 里删掉了

用户上一轮删掉、这一轮要求连 git 备份一起删的 38 个文件（`单词白纸_提示词/` 全套 31 份 +
`CHECKLIST.md` / `README.md` / `README-DEPLOY.md` + 3 份二期验收单）**已提交为删除**。
规则与文档现在只有两处：**`AI_RULES.md`（铁律）** 与 **`HANDOVER.md`（交接）**。
`api/_dev/test-about.mjs` 的第 [7] 组原来断言 `CHECKLIST.md` 存在（会让 `npm test` 永远红），
已改成断言「留下来的两份在、且铁律原文没丢」。

> ⚠️ **删掉的是「文档」，不是「规则」**。用户口述与旧文档冲突的地方**一律以用户为准**，
> 冲突点都在代码里就地标了记号（记号里都带「用户口径」三个字，`grep -rn "用户口径" src/` 一次列全）：

| 冲突点 | 旧文档/旧注释的说法 | 现在的（用户）口径 | 标记位置 |
|---|---|---|---|
| 记忆抽取 | 未通过词**排最前**、顶掉补位词；同级无随机 | 遍数最少优先、**同级随机**、未通过词作**额外项**（可超上限） | `core/pick.ts` 的 `pickForMemorize` 头注释 |
| 「未通过」的口径 | 本次会话内**所有**历史未通过 | 只看**上一轮** | `core/types.ts` 的 `lastRoundFailedIds` |
| 记忆答案卡 | 只读（「不显示拼/斩」） | **就是普通那张卡**：可查看/可改义项/可拼/可斩 | `ui/components/WordCard.ts`、`paper/AnswerCard.ts` |
| 拼写环节词源 | 容易被读成「另外抽一批」 | **当次记忆选到的词**里标了拼的 | `paper/flow.ts` 的 `runRound` |
| 「保存并退出」 | 注释写「中途退出**丢**进度」 | **保留**位置/进度/每词遍数，且下次点击**直接续跑** | `paper/finish.ts`、`ui/pages/LearnPage.ts` |
| 首页询问框文案 | 「继续上次（进度从零开始、落点重新布）」 | 与代码事实相反 → 已删掉该框 | `ui/pages/HomePage.ts` |
| 布点最小距离 | 只按「字号 × 2.4」 | 还要加上**最宽的那个词**，且按钮避让区按半个词外扩 | `core/layout.ts` 的 `spacingBudget` |

> 📌 **代码里还有大量「（提示词 X 节）」「（阶段 03 提示词）」「（主提示词 4.3）」这类历史引用**——
> 那些 md 已经删了。它们现在只是**历史出处**，不再是权威：
> **权威顺序 = 用户口述（代码里带「用户口径」的标记）> `AI_RULES.md` > 本文件 > 其它注释。**
> 看到这类引用时不要去找那份文件（找不到），按上面这个顺序判断。
> 本次**逐条核过**：这些引用里没有一条与用户新口径冲突（冲突的 7 处已在上表处理）；
> 其余（如「记忆环节依赖已出现的词」「优先级绝对优先」）今天依然成立。

#### ② 义项输入框：Enter 跳到下一格，最后一格才提交

用户原话：「填写完一个点击 enter 切换到另一个（切换到最后（最右）的那个再按，就提交）」。

原来**任意**一格按 Enter 都直接提交 —— 多义项的词几乎必然被半途交上去判错。
现在 `rounds.ts` 里 Enter = 聚焦下一格并 `select()`（省得先删），最后一格才提交；
多义项时下面多一行提示。`stopPropagation` 保留（`flow.ts` 的 window 级 Enter 会重复触发）。

#### ③ 答案卡 = 普通界面那张卡（考察中也能改、能拼、能斩）

用户原话：「在记忆时查看答案使用和在普通界面相同的单词卡。我的意思是，即使是在考察中，
我也可以随时查看，随时修改，随时『斩』随时修改义项，随时『点击拼写』」。

`showAnswerCard` 现在传 `editable: true` + `onChange/onSpell/onChop`，回调由
`flow.ts` 的 **`cardActionsFor(word)`** 提供 —— 和点中文意思打开的那张卡**共用同一份回调**
（两份的话会出现「普通卡改了生效、答案卡改了不生效」这种很难查的不一致）。配套两处**缺一不可**：

| 改动 | 不改会怎样 |
|---|---|
| `AnswerCard` 的 `isInteractive()`：点 `input/textarea/select/label/.sense-panel` **不推进**卡片 | 点一下输入框想改义项，卡就关了 |
| `flow.ts` 的全局 Enter 在 `INPUT/TEXTAREA/SELECT/BUTTON` 上**让位** | 在卡里打字按 Enter 被当成「看完了」 |
| 词在答题途中被斩 → `recordShown` 直接 return | 斩掉的词被重新塞回 `shownIds`，重新参与抽词与统计 |

#### ④ 拼写环节的词源：**当次记忆选到的词**

用户原话：「不是单独抽的，而是当次『记忆』选到了，就拼写」。
代码本来就是这么写的（`spellIds = picked.filter(needSpell)`），本次只把它**钉进断言**
（`test-paper` + `test-paper-ui`），并就地补了注释说明这条例外关系。

#### ⑤ 「保存并退出」保留全部进度 + 下次点击直接开始

用户原话：「请连同单词位置，背诵进度，乃至每个单词进行了多少遍记忆，都保持，下次点击直接开始」。

**存的本来就是全的**（`exitMidway` 就是整份 `saveSession`），真正坏的是两处：

1. **入口**：只有带 `?resume=1` 才续跑，而顶栏「背诵」是不带的 → 保存的进度**永远回不来**。
   现在 `LearnPage` 启动时**总是**先看有没有未完成会话，有就直接续跑，**不问、不弹框**。
   `HomePage` 那个询问框（正文还写着「进度从零开始、落点重新布」，与代码事实正好相反）已删掉。
2. **落库时机**：每词记忆遍数原来只在「保存并退出」时写。现在**每轮记忆结束也存一次**，
   直接关页面也不丢。

配套：续跑自动化之后必须留一个「把这一轮丢掉」的出口 → 背诵页右下角新增**「重新开始」**
（破坏性操作，保留二次确认；RULES-R3 的「不弹确认」只管「斩」）。

#### ⑥ 布点：词与词、词与按钮的**最低距离**（由字号决定，且不许重合）

用户原话：「确保单词与单词之间，单词与按钮之间有一个『最低距离』（有字号决定），不能重合」。

原来的间距是 `字号 × 2.4`，而落点是单词**中心**（`.paper-word-zone` 有 `translate(-50%,-50%)`）——
两个各宽 170px 的长词（photosynthesis 这种）中心只隔 58px 时**必然叠在一起**；按钮避让区
也只在「中心落进矩形」时才丢点，中心贴着矩形外沿时词的一半仍压着按钮。两处都修了：

- 新增纯函数 `core/layout.ts` 的 **`spacingBudget()`**：最小中心距 = **最宽的那个词的渲染宽度 + 字号 × 系数**
  （前一项保证任何一对词都不叠，后一项保证还留着由字号决定的空隙）；
  `PaperStage` 用 canvas `measureText`（字体/字号与白纸完全一致）量出最宽词。
- 按钮避让矩形**按半个词向外扩**（`padX = 最宽词/2`、`padY = 词行高/2`）。
- 代价是容量下降（更早出现「纸上放不下了」）—— 这是用户要的取舍：**不许重合**优先于密度。

#### ⑦ 记忆抽取机制（用户重申，与旧实现不同）

用户原话：「假设设置里填『最大 10 个』。若目前只出现了 3 个，那就只进行 3 次。
如果有超过 10 个，优先按『已经抽到的次数最低』排序，在优先级相同时**随机**抽。
如果上一轮出现了有单词未通过，而又没被前面的机制抽到，则作为**额外项**加入（也就是最终超过 10 个）」。

| 步骤 | 旧实现 | 现在（用户口径） |
|---|---|---|
| 已出现 < 上限 | 有几个抽几个 ✅ | 不变 |
| 超过上限 | 按遍数升序 | 不变，但**同级随机**（先打乱再稳定排序；旧写法同级其实是 `wordIds` 的固定顺序） |
| 上一轮未通过 | 排在**最前**、并顶掉补位词 | **额外项追加**，总数可以超过上限 |
| 「未通过」的口径 | 本次会话内**所有**历史未通过（一个很早错过的词会被永远强制抽到） | **只看上一轮**（会话新增 `lastRoundFailedIds`，每轮记忆结束刷新） |

#### ⑧ 验收

| 套件 | 项数 | 内容 |
|---|---|---|
| `npm run test:paper` | 见输出 | 抽取机制（含同级随机、额外项）、间距预算与「任意两词不重合」、源码级接线断言 |
| `npm run test:paper-ui` | 见输出 | 真 Chrome：Enter 逐格切换、最后一格提交、答案卡可改可斩、停 12 秒不自动提交、保存→重进续跑 |
| `npm test` | — | 全量回归（`test:about` 的文档断言已按①改掉） |

---

### 0.16 用户实测第三轮：三条 bug（★ 当前最新改动）

用户报的三条都是**真 bug**，而且第①条会造成数据状态错误。三条都用「先写一个能复现的探针、
看它真的红、改完再变绿」的方式修的（探针已固化成 `test-paper` 的第 [8] 组 + `test-paper-ui`
的第 [3][4][5] 组）。

#### ① 「背完了」把整个词库都标成了已背（严重）

> 用户原话：「每一次点击背诵，要背几个，是不用预先设置的，点下一个就 +1 个，
> 然而我自己测试随便点 4 个，记忆点背完了，结果显示全部都已经背完。」

**根因**：`finishLearn` 遍历的是 `session.wordIds`。而 `wordIds` 是「开始背诵时把**全部未背词**
塞进去的待背队列」（可能几百个），不是「这一轮真的背了的词」。
**复现**：6 个词只点 3 个上纸 → 记忆 → 点「背完了」→ 6 个全变 `learned`（探针实测）。

**修法**：归档只认 `session.shownIds`（上过纸的词）。队列里没轮到的一个都不动。
顺手修了同一处的**显示 bug**：进度条「每词已记忆 N/M」原来拿整个队列算最小值，
队列里没上纸的词都是 0 遍，于是刚背完一轮也显示 `0/1`，看着像记忆没生效 —— 现在只统计纸上的词。
归档提示也会说清「队列里还有 N 个没上纸，仍是『未背』」，不再让用户以为全背完了。

#### ② 「保存并退出」后重进是一面白纸

> 用户原话：「你确实保存了每个单词记忆了多少次，但是问题是当我退出重进，又是一面白纸。
>  我不要白纸，退出时出现了多少单词，每个单词有多少记忆次数全部不变。」

**根因**（两处，都要修）：`flow.ts` 挂载时判断「能不能恢复」的条件是
`words.every((w) => session.placements[w.id] !== undefined)` —— 要求**队列里每一个词**都有落点。
而落点是「点一个算一个」的：队列 100 个词、只点了 4 个上纸时条件永远不成立 →
走重算分支 → **一个词都不画回白纸**（记忆次数其实还在，只是看不见）。

**修法**：`needNewPlacements` 改成「队列里还有词缺落点就重算」，并且**两条分支都要把
`shownIds` 里的词按落点画回白纸**。一句话原则写进注释了：
**`shownIds` 里有几个词，重进就必须看到几个词 —— 绝不允许白纸。**
另外落点补算过就立刻 `saveSession`，免得下次又算一遍（位置会跳）。

> ⚠️ 这条在上一轮（§0.15 ⑤）只修了「入口不带 `?resume=1`」那一半；
> **入口修好了、恢复算法本身还是坏的**，所以用户仍然看到白纸。
> 教训：改「续跑」要拿「队列比上纸词多」的局面测，而不是拿「词库里只有 2 个词」测 ——
> 上一轮的测试就是后者，所以漏了。

#### ③ 卡片编辑「名存实亡」

> 用户原话：「在背诵过程中修改单词卡的行为名存实亡，所有的修改根本不会保存，
>  我要保存，直接保存到单词库中。」

**根因**（两层）：
1. `persistEdit` 是**一个共享的 `debounce`**（只记住最后一次调用的参数）。
   连续改**两个不同的词**（相隔 < 600ms）时，前一个词的改动被直接丢掉：
   界面改了、内存改了、**库里永远是旧的**，一刷新就「改了个寂寞」。
2. 写库是 `void dao.words.put(w)`：失败（例如 §0.11 那类陈旧连接）被**静默吞掉**，
   用户完全看不到。

**修法**：换成按词 id 排队的 `pendingEdits: Map` + `flushEdits()`：
- 同一词只留最新值、**不同词各写各的**，一个都不丢；
- 落盘时**与库里的最新行合并**，只覆盖内容字段（音标 / 例句 / 义项），
  `status` / `attrs` / `priority` / `learnOrder` / 墓碑一律以库为准 ——
  否则一次迟到的写入会把刚做的「斩」「归档」悄悄覆盖回去
  （实测：改完卡片 600ms 内点斩，词会自己复活成未背）；
- 失败**弹提示**，不再静默；
- 在「背完了 / 保存并退出 / 重新开始 / 路由切走」之前都 `flushEdits()`。

验收：连改两个词 → 两个都在库里；改完立刻「保存并退出」→ 改动在；改完立刻斩 → 编辑在、
而且词**仍然是 chopped**（没被复活）。

---

### 0.17 阶段 M1 + M2：手机端一屏从 5~6 个词提到 15~16 个（★ 当前最新改动）

用户报的问题（原话）：「手机上（iPhone 14，390×844）一屏只能显示 10~12 个单词，
想提到 15~18 个；单词排成一竖列；底部 4 个按钮太大占约 1/4 屏幕；
按钮在右下角导致单词无法出现在按钮左侧。」

#### M1（只测不改）：先建测量设施，再出诊断报告

**为什么先测**：之前出现过「AI 说完成了但实际没生效」。所以 M1 阶段一行业务代码都没改，
只加了测量设施，用**机器数字**定位瓶颈。

新增三个东西：

| 文件 | 作用 |
|---|---|
| `probeLayout.mjs`（仓库根） | 无头浏览器打开 `#/dev/layout?probe=1`，从 `<pre id="probe-result">` 抓测量 JSON，跑断言并判 PASS/FAIL |
| `src/dev/layoutProbe.ts` | `window.__layoutProbe()`：遍历 `[data-word-box]` 的**真实** `getBoundingClientRect()`，算词数 / 行列 / 重叠对 / 越界 / 最小间距 / 与避让区相交 |
| `src/ui/pages/DevLayoutPage.ts` | 调试页 `#/dev/layout`：真实 PaperStage + 包围盒可视化 + 红色避让区 + 六个参数滑块（可写进设置） |

**★ 测量环境踩的两个坑（都会让数字假得看不出来）**：

1. **Windows 无头 Chromium 的最小窗宽是 504px**。`--window-size=390,844` 实际得到 `504×749`，
   真机列数**根本量不到**。→ 调试页支持 `dvw/dvh` 注入「模拟真机视口」，
   `PaperStage` 用注入尺寸算纸张/字号/避让区；`test:m2-ui` 则直接用 CDP 的
   `Emulation.setDeviceMetricsOverride` 精确设成 390×844。
2. **真实视口高度 = 窗口高度 − 95px**。窗口不够高会把纸面下沿裁掉，
   凭空多出一个「越界 1 个」的假失败。→ `probeLayout.mjs` 加了 `--window-height`。

**M1 诊断结论（390×844、字号 28、全部实测）**：

```
wordCount=5   columns(算法网格)=1   rows=6   gridCapacity=6   capacity=5
widestWordPx=129.2   avgWordPx=100   gapX=196.4(最小中心距)   paperW×paperH=390×844
```

瓶颈**不是**「单元格按最长词算 160px」这种固定值，而是：

```
最宽词 129.2px → 最小中心距 196.4px(= 129.2 + 28×2.4)
minGapW = 196.4 / 390 = 0.5036
cols = min( round(√(16×0.462))=3 , floor(0.88/0.5036)=1 ) = 1      ← core/layout.ts 第 83 行
```

**一个词就能把整屏列数压死**：把词表换成含 `photosynthesis` 的长词表（其他参数不动），
容量从 5 掉到 4。利用率 = 5 / 理论 35 ≈ **14%**。

另外两处附带发现：
- `jitteredGrid` 的抖动幅度公式把间距减了两次（`(cellW − gapX)/2` 应为 `(cellW − gapX/2)/2`），
  实测同列词中心只相距 150.4px 而「最小中心距」是 196.4px —— 横向空间白白浪费；
  M2 换了算法，这条自然消失（旧函数仍保留给桌面）。
- 避让区被 `padX` 放大 2.4 倍（140×220 → 269×273），而且「压住按钮」的判定把
  「只是进了外扩矩形」也算违规（实测假阳性：`orange` 离按钮还有 36px）。

#### M2：换算法 + 圆形按钮 + 避让带

**① 新布点算法（只用于手机，桌面一行没动）**——`core/layout.ts` 新增三个函数：

| 函数 | 作用 |
|---|---|
| `computeGrid()` | 列数按**平均词宽**定：`格宽 = 平均词宽×1.15 + minGapPx`；行数按可用高度定；容量不够就加列 |
| `layoutWords()` | 每个词按**自己的宽度**在格子里找位置，落点做**真实矩形碰撞检测**；撞了就**推开**（不是换格子） |
| `controlBandHeight()` | 底部按钮带高度 = `直径×3 + 小字 + 12 + 安全区`，与 CSS 变量同源 |

**② 底部圆形按钮横排（只在手机）**——`flow.ts` 新增 `buildRoundControls()`：
4~5 个等大圆（直径/间距/小字字号全部来自 `settings.layout.mobile.button`，注入 CSS 变量），
横排居中；圆里短文案、圆下方小字；点击转交给原按钮（**流程逻辑仍然只有一份**，
圆按钮只是显示层，`syncRoundControls()` 把 disabled/hidden/文案同步过来）。
桌面/平板保持原来的右下角竖排。

**③ 避让区从「右下角方块」变「底部横带」**——`device.ts` 的 `controlsAvoidRect()`：
手机返回 `{x:0, y:vh−带高, width:vw, height:带高}`。横带以上的左侧/中间/右侧全部可布点，
**「单词无法出现在按钮左侧」自动解决**（验收里专门有一条断言）。

**④ 参数化 + 设置页可调**——`settings.layout.{mobile,tablet,desktop}` 三档，
每档 6 个参数（边距/间距/字号/目标数/按钮直径/按钮间距）；
设置页新增 **C2. 布局参数** 一节（`LayoutSection.ts`），调试页也能改并一键写库。

#### 最终参数（`settings.layout.mobile`，每个数都由实测算出来）

```json
{ "edgeMarginPx": 8, "minGapPx": 8, "fontSizePx": 16, "targetCount": 16,
  "button": { "diameterPx": 50, "gapPx": 16, "labelFontPx": 12 } }
```

推算过程（写进 `core/config.ts` 的注释里了）：
可用宽 `390−16=374`，2 列 → 格宽 187；平均词宽（字号 16 实测）65.1 →
需要 `65.1×1.15+8 = 82.9 ≤ 187` ✓；按钮带高 `50×3+12+12 = 174` →
可用高 `844−8−174 = 662`；一行词实高 `41.6`（★ 见下面的坑）→ 格高 `49.6` → 12 行 → 容量 24 ≥ 16 ✓。

#### ★★ M2 踩的最大的坑：CSS 实际行高是 1.6，而代码里写的是 1.45

`WORD_LINE_HEIGHT_RATIO` 原来写 `1.45`（想要的 44px 热区），但 `.paper-word` 自己没写
`line-height`，继承的是 `global.css` 里 `body { line-height: 1.6 }`。
于是算法以为一行词高 39.2px，**实际渲染 41.6px** —— 每行少算 2.4px。
后果：屏幕上配置 8px 的空隙只剩 **5.6px**（probe 直接量出来），而且怎么调算法都对不上。

**教训**：布点算法里任何「推算 CSS 渲染尺寸」的常量都必须**用调试页量一次**
（`window.__layoutProbe().wordMetrics` 会给出 `lineHeight` / `padding` / 实际矩形），
不能凭「应该是 1.45」写下来。这条已写进 `WORD_LINE_HEIGHT_RATIO` 的注释。

同类的还有一条：`canvas.measureText()` 量的是**文字**宽度，而占位置的是带
padding 的 `.paper-word` 元素（手机上 `padding: 8px 4px`）——不算进去，
实测间隙同样会小 8px。修法：`wordBoxPx()` 把 padding 加进碰撞矩形。

#### 修改前 vs 修改后（390×844，全部真实 DOM 测量）

| 指标 | M1（改前） | M2（改后） | 验收要求 |
|---|---|---|---|
| `wordCount` | **5** | **16** | 15~18 ✓ |
| 算法网格 | 1 列 × 6 行 | 2 列 × 8 行 | 列数 ≥3（DOM 聚类）✓ |
| `minGap` | 64.09 | 8.00 | ≥ 8 ✓ |
| `overlapPairs` | 0 | 0 | 0 ✓ |
| `outOfBounds` | 0 | 0 | 0 ✓ |
| `buttonOverlaps` | 1（假阳性） | **0** | 0 ✓ |
| 按钮形态 | 右下角 4 个竖排（140×220 避让方块） | 底部横排 5 个圆（直径 50，避让带 390×174） | 用户要求 ✓ |
| 单词能否出现在按钮左侧 | 不能 | **能**（实测有词落在按钮左边） | ✓ |
| 长词表（含 photosynthesis） | 容量 4 | 容量 16 | 不被长词拖垮 ✓ |

三个尺寸（均为**真机视口 + 真实 DOM 测量**）：

| 尺寸 | wordCount | 列/行 | minGap | 重叠 | 越界 | 压按钮 |
|---|---|---|---|---|---|---|
| 390×844 | 16 | 6/11 | 8.00 | 0 | 0 | 0 |
| 360×800 | 15 | 7/10 | 8.02 | 0 | 0 | 0 |
| 430×932 | 15 | 6/15 | 8.01 | 0 | 0 | 0 |

> `probeLayout.mjs` 的 `viewport` 那一条在这三个尺寸上仍是 ✗（实际 504×N），
> 那是**无头浏览器最小窗宽 504px** 的限制，不是布局问题；
> 真机视口的几何验收由 `npm run test:m2-ui`（CDP 精确设视口）覆盖，39 项全过。

#### ★ M2 之后用户实测报的回归：记忆时「题干卡片看不见了」

用户原话：「这样确实放下了很多单词，但是记忆时弹出的卡片就看不到了，
把弹出在原位置的卡片（题干）修改成弹出在居中偏上（两种模式可切换），并且注意尺寸。」

**先说一个必须澄清的事实**：`settings.memorize.position`（`'origin' | 'centerTop'`）
**在类型与默认值里早就有（默认就是 `centerTop`）、设置页 D 区也早就有这个下拉框**，
但 `PaperStage.showOverlay()` **从来没读过它** —— 有落点就永远弹在原落点。
所以这个开关一直是「形同虚设」，用户切了也没用。这次把它接通了。

**两个真 bug（都是量出来的，不是猜的）**：

1. **横向跑出屏幕**（主因）。遮罩是「以中心点定位 + `translate(-50%)`」，
   宽度 327px；M2 之后手机上是 **2 列**，左列词的中心 x ≈ 65px →
   遮罩左边缘落在 **-30.6px**，最靠下那行的词甚至到 **-77.3px**，
   大半个卡片在屏幕外 —— 这就是用户看到的「卡片看不见」。
   修法：`clampOverlayLeft()` 按「整块卡片都在视口内」夹（两侧各留 8px）。
2. **纵向可能被底部按钮带压住**。按钮带 z-index 45，遮罩原来是 35。
   修法：遮罩 `z-index: 50`（高于按钮带），并用 `clampOverlayTop()` 夹纵向
   （上留 8px、下不碰底），公式是 `min = 8 + h/2`、`max = vh − 8 − h/2`。

**踩到的第三个坑（不量就发现不了）**：夹位置需要知道遮罩宽高，但
`showOverlay()` 里刚 `replaceChildren()` 完，那一刻盒子是**空的（宽 0）**，
拿它去夹等于没夹（第一次改完实测还是 `-30.6px`）。
所以拆成两步：`showOverlay()` 只记住「弹在哪」，调用方**填完内容**再调
`repositionOverlay()` 真正定位；尺寸用「上一次量到的」缓存（首次按 92vw/30vh 保守估）。
`rounds.ts` 的记忆与拼写两处都按这个顺序调。

**尺寸（用户特意提醒的那点）**：
- `.paper-overlay` 从 `position: absolute`（挂在 `.paper-stage` 这个
  `overflow:auto` 的滚动容器里，会被容器尺寸/滚动影响）改成 **`fixed`**（永远相对视口）；
  加 `max-width: min(560px, 92vw)` / `max-height: 86vh` / `overflow: auto`；
- `.memorize-word` 加 `max-width: 92vw; overflow-wrap: anywhere`（长单词不横向溢出）；
- `.memorize-box` 加 `max-width: 100%`。

**没有动答案卡**（用户明确说答案卡已经适配过了）：`.answer-card` 的 CSS
与 `AnswerCard.ts` 一行未改，有断言守着。

实测（390×844 真机视口，`window.__devOverlay(mode)` 量的是真实 DOM）：

| 模式 | x | right | y | bottom | 结论 |
|---|---|---|---|---|---|
| 居中偏上 | 31.2 | 358.8 | 134.2 | 372.2 | 居中（centerX=195.0），在上半屏 30% |
| 原落点（第一个词） | **8.0** | 335.6 | 145.8 | 383.8 | 被夹回屏内（原来 -30.6） |
| 原落点（最靠下的词） | **8.0** | 335.6 | **8.0** | 246.0 | 被夹回屏内（原来 -77.3） |

底部按钮带顶边 = 670，三种模式的遮罩下沿都 ≤ 384，都不与按钮带相交。

答案卡改成弹出在「居中偏上」这件事**没有做**：用户原话是「把弹出在**原位置**的卡片
（题干）修改成弹出在居中偏上」——要改的是题干遮罩，答案卡保持原样。

#### 新增/调整的测试

| 命令 | 覆盖 |
|---|---|
| `npm run test:mobile`（59 项） | 避让带几何、按钮一行放得下、`computeGrid` 容量/格高、长词表不被拖垮、列数对照实验 |
| `npm run test:m2-ui`（39 项） | **CDP 精确视口 390×844**：词数/重叠/越界、圆按钮数量/直径/一行/居中、避让带=底部横带、按钮全部落在避让带内、**有词落在按钮左侧**、**题干遮罩三种模式都整块在屏内且不压按钮带、z-index 高于按钮、fixed 定位**、桌面仍是旧算法+右下角方块 |

---

## 1. 一句话说清这是什么

一个**个人自用、本地优先**的背单词 Web 应用。核心玩法是「白纸空间记忆」：
单词随机散落在满屏白纸上，靠**位置 + 语音**建立记忆，配默写自测和可自定义的间隔复习优先度。

- **本地优先是基石**：所有数据主存在浏览器 IndexedDB，打开即用、断网可用；
  云同步只是后台悄悄进行的可选增强，**同步失败绝不阻断任何功能**。
- **不对外开放注册**，没有多用户体系。多设备共用数据靠一个自编的「同步码」。
- **零成本零运维**：Vercel 免费版 + Turso 免费版，不需要服务器 / Docker / Nginx。

| 项 | 值 |
|---|---|
| 线上地址 | <https://blank-sheet-vocab.vercel.app> |
| 代码仓库 | <https://github.com/ynot-cai/Blank-Sheet-Vocab>（Public） |
| 本地路径 | `D:\Project：Blank Sheet Vocab`（注意：路径里是全角冒号「：」，能用但偶尔让老工具出错） |
| 技术栈 | Vite 6 + TypeScript 5.9（strict）+ 原生 DOM（**无前端框架**）+ Vercel Serverless Functions + Turso(libSQL) |
| Node | ≥ 20.6（本地用 24.21；api 测试靠 Node 内置类型擦除直接跑 TS 源码） |

### 当前状态

| 模块 | 状态 |
|---|---|
| 本地版功能（阶段 01~08：脚手架/数据层/设置/录入合并/列表/背诵/记忆/复习/本地备份） | ✅ 完成 |
| 同步版功能（阶段 01~07：后端API/前端同步/AI代理/Vercel配置/移动端/PWA/数据说明页） | ✅ 完成 |
| 自动化自检 | ✅ 本地全绿（含 `test:mobile` 59 项 + `test:m2-ui` 20 项真机视口验收）+ 20 项线上冒烟 + 29 项线上端到端 |
| 线上可用性 | ✅ 已实测（真机手感、iOS 语音、添加到主屏幕**尚未**人工确认，见 §10） |

---

## 2. 架构总览

```
┌─ 浏览器（手机 / 平板 / 电脑）────────────────────────────────┐
│  Vite 构建的静态站（Vercel 托管）                             │
│                                                             │
│  ┌─ IndexedDB（库名 blank-sheet-vocab，v2）★主存储，断网可用        │
│  │    words / sources / settings / sessions                │
│  ├─ localStorage 镜像（设置快照、语音解锁标记、安装提示标记）│
│  └─ Service Worker（离线缓存：静态资源 Cache First）         │
└───────────┬─────────────────────────────────┬───────────────┘
            │ 后台静默同步（防抖 5s）          │ AI 调用
            │ 请求头 X-Space-Key = sha256(码)  │ ① 直连（首选）
            ▼                                 │ ② 被 CORS 拦 → 走代理
┌─ Vercel Serverless Functions（api/，Node 运行时）────────────┐
│  无状态。只做校验 + 转发 + SQL                               │
│  /api/sync-pull  /api/sync-push  /api/sync-purge            │
│  /api/health     /api/ai-proxy（★不连数据库、不存密钥）      │
└───────────┬─────────────────────────────────┬───────────────┘
            │ @libsql/client                  │ 原样转发（用完即弃）
            ▼                                 ▼
     Turso（libSQL/SQLite）              用户的 AI 服务
     words / sources 两张表              （DeepSeek 等，用户自填）
     按 space_key 隔离
```

### 三个核心设计（改动前务必理解）

**① 本地优先（Local-first）**
所有操作先写 IndexedDB（立刻生效），再由 `dao/syncScheduler.ts` 防抖 5 秒后后台同步。
同步失败只在顶部显示一条轻提示（连续失败 3 次转常驻），**不弹窗、不阻断、不白屏**。

**② 同步码替代账号**
用户自己编一个码（≥8 位、含字母数字）→ 前端 `sha256(码)` = `spaceKey`（64 位十六进制）
→ 所有请求带 `X-Space-Key` → 服务器用它隔离数据。
**服务器只存哈希，永远不知道明文同步码**；明文只存在这台设备的浏览器里。

**③ 方案 B：服务器永不接触 AI 密钥**
密钥只存浏览器。调 AI 时浏览器直连（首选）；被 CORS 拦时改走 `/api/ai-proxy` 转发一次。
那个代理**不写数据库、不写日志、不缓存、不回显请求头**，密钥随请求来、用完即弃。
`api/ai-proxy.ts` 里**没有** import `_lib/db`——这条有测试守着。

---

## 3. 接口清单（★ = 踩过坑的地方）

所有路由的**唯一权威定义**在 `src/dao/syncServer.ts` 的 `API_ROUTES`。
前端不许在别处硬编码路径；`npm run test:build` 有护栏校验「路由表 ⇄ api/ 真实文件」一一对应。

> ★ **路由名 = 文件名（连字符），不是目录结构。**
> `api/sync-pull.ts` 对应 `/api/sync-pull`。写成 `/api/sync/pull` 会 404——
> 线上就是这么炸过一次，表现是「同步不了」，后端其实完全正常。

| 路由 | 方法 | 作用 | 鉴权 |
|---|---|---|---|
| `/api/health` | GET | 健康检查（`db: connected/error`） | 不需要 |
| `/api/sync-pull` | GET | 增量拉取 `?since=<ts>` | `X-Space-Key` |
| `/api/sync-push` | POST | 批量推送（单批 ≤ 500 条） | `X-Space-Key` |
| `/api/sync-purge` | POST | 清空当前数据空间 | `X-Space-Key` + `{confirm:"DELETE"}` |
| `/api/ai-proxy` | POST | 无状态 AI 转发 | 来源白名单 + 客户端自带 `Authorization` |
| `/api/kc-list` | GET | **二期**：知识点卡片增量拉取 `?since=<ts>` | `X-Space-Key` |
| `/api/kc-push` | POST | **二期**：知识点卡片批量推送（单批 ≤ 500 张） | `X-Space-Key` |

### 3.1 `GET /api/health`

```json
{ "ok": true, "time": 1789212289281, "db": "connected" }
```
不需要 spaceKey。数据库不通时返回 500 + `"db":"error"`。**不泄露任何连接串**。

### 3.2 `GET /api/sync-pull?since=<ts>`

- 请求头：`X-Space-Key: <64位十六进制>`（非法 → 401）
- `since` 空/非法一律当 0（= 全量）
- 返回：

```json
{
  "words":   [ { "id","en","phonetic","example","senses","source_id","raw_sources","attrs",
                 "status","learn_order","created_at","updated_at","deleted" } ],
  "sources": [ { "id","name","priority","created_at","updated_at","deleted" } ],
  "serverTime": 1789212312303,
  "hasMore": false
}
```

- ★ **包含软删除记录**（`deleted=1`），否则别的设备永远删不掉那条
- `senses`/`raw_sources`/`attrs` 是 **JSON 字符串**，前端自己 parse
- 单次上限 `MAX_PULL_ROWS = 2000`（`api/_lib/limits.ts`），超出靠 `hasMore` 提示
- 按 `updated_at` 升序

### 3.3 `POST /api/sync-push`

- 请求体：`{ words?: [...], sources?: [...] }`（两者合计 ≤ 500，超了 400）
- 返回 `{ applied, conflicts, skipped, serverTime }`
  - `applied`：真正 upsert 的行数（**重复推同样内容也算 applied**）
  - `conflicts`：客户端版本比云端旧、被挡下的行数（**不覆盖**，避免旧设备把新数据打回去）
  - `skipped`：结构不合法被跳过的行数（脏数据**不整批失败**，只跳过并计数）
- 冲突策略：**后写覆盖**（`incoming.updatedAt >= server.updatedAt` 才写）
- 日志只打条数 + spaceKey 前 8 位，**不打词条内容**

### 3.4 `POST /api/sync-purge`

- 请求体必须带 `{ "confirm": "DELETE" }`（防误触），否则 400
- 真 DELETE（不是软删），**只删当前 space_key 的行**（`WHERE space_key = ?` 由 DAO 层强制）

### 3.5 `POST /api/ai-proxy`
- 请求头：`X-Target-Url`（目标 AI 完整地址，**必须 https**）、`Authorization`（用户密钥）、`Content-Type`
- body：标准 OpenAI 兼容请求体，原样转发
- 处理：来源白名单校验（403）→ 目标校验（400/403）→ 剥离 `origin/host/referer/cookie/x-forwarded-*` → 转发
- **流式（SSE）透传**，不缓冲成一次性返回；响应带 `Cache-Control: no-store`
- 上游超时 60 秒（`AI_PROXY_TIMEOUT_MS`），对应 `vercel.json` 里 `maxDuration: 120`
- ★ 允许转发的主机由环境变量 `AI_ALLOWED_HOSTS` 控制（防 SSRF）；
  白名单里的主机允许 http（**只是为了本地开发和自动化测试对着 127.0.0.1 起假上游**）

---

### 3.6 `GET /api/kc-list?since=<ts>`（二期）

与 `sync-pull` 完全同一套口径，只是拉的是知识点卡片：

```json
{
  "cards": [ { "id","title","summary","blocks","exam_tags","exam_load","source","attrs",
               "status","created_at","updated_at","deleted" } ],
  "serverTime": 1789212312303,
  "hasMore": false
}
```

- **包含软删除**（`deleted=1`）：二期「斩」是留墓碑的，墓碑必须能传到别的设备
- ★ 二期「斩」与一期**不同**：一期墓碑落地时本地**真删**；二期本地**保留墓碑**
  （因为二期有「复活」功能，且「已斩」列表要能看到它）
- `blocks` / `exam_tags` / `exam_load` / `source` / `attrs` 都是 JSON 字符串
- 建表在 `api/_lib/kcSchema.ts`（`initKcSchema()`，与一期 `initSchema()` 分开）

### 3.7 `POST /api/kc-push`（二期）

- 请求体：`{ cards: [...] }`（单批 ≤ 500，超了 400）
- 返回与 `sync-push` 同形：`{ applied, conflicts, skipped, serverTime }`
- 冲突策略同样是**后写覆盖**（`incoming.updatedAt >= server.updatedAt` 才写）
- 归一化在 `api/_lib/kcValidate.ts`：**坏行只跳过不整批失败**，
  且 `blocks` 之类字段若是坏 JSON 会被换成兜底值（否则前端 `JSON.parse` 会抛异常）

---

## 4. 数据模型

### 4.1 云端（Turso，建表在 `api/_lib/db.ts`）

```sql
CREATE TABLE words (
  id TEXT NOT NULL, space_key TEXT NOT NULL,
  en TEXT NOT NULL, phonetic TEXT, example TEXT,
  senses TEXT NOT NULL,            -- JSON 字符串
  source_id TEXT, raw_sources TEXT, attrs TEXT NOT NULL,
  status TEXT NOT NULL, learn_order INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  deleted INTEGER DEFAULT 0,
  PRIMARY KEY (space_key, id)      -- ★ 复合主键，不是单独的 id
);
CREATE TABLE sources ( … 同上，PRIMARY KEY (space_key, id) );

CREATE INDEX idx_words_space    ON words(space_key);
CREATE INDEX idx_words_updated  ON words(space_key, updated_at);
CREATE INDEX idx_sources_space  ON sources(space_key, updated_at);
```

- ★ **主键必须是 `(space_key, id)`**：同步是客户端生成 uuid 上传，两台设备/两个空间可能撞同一个 id。
  只按 `id` 做 `ON CONFLICT` 会连 `space_key` 一起改掉 → **跨空间数据互相覆盖**，隔离直接失效。
  `initSchema()` 里有**老库自动升级**（检测到旧主键就重建表搬数据，幂等）。
- **没有 users 表，没有任何存密钥的表**——这是安全性的来源。
- 表结构改字段时记得同步 `api/_lib/inventory.ts` 的 SQL 与 `src/dao/syncMap.ts` 的映射。

### 4.2 本地（IndexedDB，`src/core/db.ts`）

库名 `blank-sheet-vocab`，版本 **3**：
- v1→v2 迁移补了 `sources.updatedAt` 等云同步字段；
- v2→v3 新增二期四张表（**纯加法，一期数据一条不动**）。

| 表 | keyPath | 说明 |
|---|---|---|
| `words` | `id` | 词条，含 `updatedAt`（同步游标）、`deleted?`（墓碑） |
| `sources` | `id` | 词库来源，含 `updatedAt?`、`deleted?` |
| `settings` | `key` | 设置整体存一行（`key = 'main'`）；本地文件夹句柄等用 `putRaw` |
| `sessions` | `id` | 背诵/复习会话（断点续跑） |
| `knowledgeCards` | `id` | **二期**：知识点卡片（`core/kcTypes.ts` 的 `KnowledgeCard`） |
| `dailyContextWords` | `id` | **二期**：每日语境词（防 AI 出题重复） |
| `examRecords` | `id` | **二期**：已出过的题（防重复 + 复盘） |
| `bankQuestions` | `id` | **二期**：用户存的参考样题 |

### 4.3 删除语义（容易搞混，重点看）

| 场景 | 行为 |
|---|---|
| 用户在背诵页/列表页「斩」词 | **软删**：`status = 'chopped'` |
| 用户「删除」词（列表页） | **硬删**（本地直接移除） |
| 删除来源 | **软删**：写一条 `deleted=1` 的墓碑（否则别的设备会复活它） |
| 云端下发 `deleted=1` | **本地真的删掉那一行**（墓碑只在传输中用，落地就清） |
| **二期**「斩」卡片 | **软删**：`deleted=1` + `status='chopped'`（本地保留墓碑） |
| **二期**云端下发 `deleted=1` | **本地落成墓碑**（不真删），这样「已斩」列表能看到并能**复活** |

- 墓碑的意义：不留墓碑，「A 设备删了、B 设备还留着」会在下次同步被 B 复活。
- `dao/words.listAlive()` 过滤掉 `deleted=1`；`getAll()` **故意不过滤**（同步要读墓碑）。
- 二期同理：`dao/kc.query()` 默认不含墓碑，要看已斩就传 `status: ['chopped']`。
- 已知限制：墓碑**不会自动清理**，一直留着（占空间很小）。

---

## 5. 同步协议（`src/dao/cloudSync.ts`）

一次 `syncOnce()` 固定「**先拉后推**」：

```
1. pull(since = lastSyncAt)          ← 拿云端增量（含墓碑）
     ├─ 云端 updatedAt > 本地 → 用云端覆盖本地（后写覆盖）
     ├─ 云端是墓碑           → 本地删掉那一行
     └─ 本地更新或本地独有    → 留着，等第 2 步推上去
2. push(本地所有 updatedAt > lastPushAt 的行)
     └─ 服务端按后写覆盖处理，每批 ≤ 500 条自动分批
3. 更新两个游标
     ├─ lastSyncAt = serverTime（界面显示用）
     └─ lastPushAt = 本次真正推到的最大 updatedAt（下次推送起点）
```

**为什么要先拉后推**：不先拉就推，会把本机较旧的版本推上去覆盖别的设备刚改好的内容。

### ★ 分批推送里两个必须懂的坑（`pushAll()` 注释里有完整说明）

1. **同毫秒批量写入**：导入/粘贴/批量改属性会给几百条记录**完全相同的 `updatedAt`**。
   - 游标停在 `max(updatedAt)` → 下一轮 `> 游标` 把同批剩下的**全漏掉**（实测 1100 条只推上去 500 条）
   - 游标 +1 → 又把同批剩下的**全跳过**
   - **正确做法**：`listDirty*(since)` 用 **`>=`** 返回候选集，再用 `pushedIds` 集合排除本次已推的；
     游标只推进到「本页待推数据的真实最大 updatedAt」
2. **`hasMore` 时不要推进 `lastPushAt` 到 `serverTime`**，否则本地没拉到的行会被误判成已在服务端。

### 触发方式

- 数据变动 → `emitDataChanged()` → `main.ts` 里接的 `scheduleSync()`（防抖 5 秒）
- 启动时也会调一次
- 设置页有「立即同步」（`syncNow()`，无视 `autoSync` 开关）
- ★ 注意：`scheduleSync()` 读的是 `core/config` 的**内存缓存**，所以
  `dao/settings.get()/set()` 必须刷新缓存（`setSettingsCache`）——不刷新会出现
  「界面显示已开启、后台按旧的判断跑」

---

## 6. 后端代码结构（`api/`）

```
api/
├─ _lib/
│  ├─ db.ts          Turso 客户端（★模块级单例）+ initSchema（含老库主键升级）+ pingDB
│  ├─ inventory.ts   ★DAO 层：所有 SQL 都在这里，每条都带 WHERE space_key = ?
│  ├─ spaceAuth.ts   X-Space-Key 读取与校验（64 位十六进制）+ spaceKeyHint（日志只留前 8 位）
│  ├─ cors.ts        CORS + OPTIONS 预检；来源白名单
│  ├─ http.ts        sendJson / sendError / readJsonBody / readHeader
│  ├─ limits.ts      所有硬上限：MAX_PUSH_BATCH=500、MAX_PULL_ROWS=2000、AI_PROXY_TIMEOUT_MS
│  ├─ validate.ts    请求体结构校验与归一化（脏数据跳过计数，不整批失败）
│  └─ types.ts       最小 ApiRequest/ApiResponse（不引 @vercel/node，方便本地直调测试）
├─ health.ts / sync-pull.ts / sync-push.ts / sync-purge.ts / ai-proxy.ts
└─ _dev/             ★本地开发与测试工具（Vercel 不会部署这个目录）
```

**★ 纪律：所有 SQL 必须带 `WHERE space_key = ?`，且只能出现在 `inventory.ts`。**
处理函数只负责取参数、拼响应——这样没法绕过空间隔离。

### ★ 部署的代码只能用 `.js` 后缀的相对导入

```ts
import { getDB } from './_lib/db.js';   // ✅ 必须这样写
import { getDB } from './_lib/db.ts';   // ❌ 线上必崩（ERR_MODULE_NOT_FOUND）
```

原因：Vercel 用 Node 的类型擦除把 `.ts` 剥成 `.js`，**但不重写 import 路径**。
所以源码写 `.ts`，产物里还是去找 `db.ts`，而磁盘上只有 `db.js` → 函数加载失败 → 500。
本地由 `api/_dev/loader-hooks.mjs` 把 `.js` 映射回同名 `.ts`，所以测试照样能跑。

只有 `api/_dev/`（不部署）才允许写 `.ts` 后缀。

---

## 7. 前端代码结构（`src/`）

```
src/
├─ main.ts                  启动：错误边界 → 打开DB → 载入设置 → 本地文件夹 → 挂 App
│                           并在这里把 emitDataChanged 接到「本地备份 + 云同步」上
├─ App.ts                   顶栏路由、banner（同步提示/安装引导）、footer、beforeunload 提醒
├─ env.d.ts                 __APP_VERSION__ 全局声明
│
├─ core/                    ★纯逻辑，不碰 DOM / 不碰 dao
│  ├─ types.ts              所有类型（不许 import 任何东西）
│  ├─ config.ts             ★所有可调数字：DEFAULTS / SYNC / DEVICE；getSettings() 缓存
│  ├─ db.ts                 IndexedDB 封装（openDB / tx / txRun / clearStore）
│  ├─ model.ts              归一化、义项拆分、判分、格式化
│  ├─ parser.ts             规则解析（离线兜底）
│  ├─ merge.ts              义项合并
│  ├─ priority.ts           优先度表达式求值
│  ├─ layout.ts             jitteredGrid 布点（含右下角避让 avoidPx）+ resolvePaperSize
│  ├─ pick.ts               记忆环节抽词规则
│  ├─ presets.ts            ★预设档位清单（**自动生成**，不要手改）
│  ├─ syncHelper.ts         sha256 / getSpaceKey / apiUrl / normalizeApiBase / relativeTime
│  ├─ version.ts            构建时间戳（vite define 注入）
│  ├─ kcTypes.ts            ★二期类型（Block / KnowledgeCard / EXAM_TYPES / 语境词 / 题目 / 题库）
│  ├─ kcModel.ts            ★二期卡片构造与校验 + **calcMastery 掌握度公式**（含完整对照表注释）
│  ├─ kcPriority.ts         二期复习优先度 + 掌握度重算 + isBlindSpot（识别盲目自信）
│  └─ blockRender.ts        ★★二期安全渲染：Block → DOM，**只走 textContent，绝不拼 HTML**
│
├─ dao/                     ★页面只能通过这里取数据，全部返回 Promise
│  ├─ index.ts              统一出口
│  ├─ words.ts              词条 CRUD（put/bulkUpsert/updateAttrs/chop/revive/query/stats…）
│  ├─ sources.ts            来源（remove 是软删墓碑）
│  ├─ settings.ts           设置（★get/set 都会刷新 config 内存缓存）
│  ├─ session.ts            会话断点续跑
│  ├─ syncData.ts           云同步专用：含墓碑的读法 / 原样写回（不改 updatedAt）
│  ├─ syncMap.ts            本地对象 ⇄ 服务器行 的字段映射（含 JSON 打包/拆包）
│  ├─ syncServer.ts         ★HTTP 客户端 + **API_ROUTES 路由表（路径唯一权威定义）**
│  ├─ cloudSync.ts          ★同步编排：syncOnce / overwrite / clearCloud / getStatus
│  ├─ syncScheduler.ts      防抖调度 + 状态订阅（phase/failStreak）+ 失败重试
│  ├─ syncSchedulerFactory.ts ★调度器工厂（一期/二期各建一个实例，互不干扰）
│  ├─ kc.ts                 ★二期卡片本地 DAO（query / chop / revive / listDirty…）
│  ├─ kcCloud.ts            ★二期云同步：kcPull / kcPush / kcSyncOnce（游标在 settings.kc.cloud）
│  ├─ kcScheduler.ts        二期同步调度（同步实现由 main.ts 注入，避开循环依赖）
│  ├─ contextWords.ts       二期：每日语境词（自然日 / 去重 / 确认后才生效）
│  └─ examBank.ts           二期：题目历史（防重复 + 复盘）+ 题库
│
├─ services/
│  ├─ ai.ts                 ★AI 调用：直连 ⇄ 代理自动切换；getLastAiRoute() 供设置页显示
│  ├─ parsePipeline.ts       分批解析 + 断点续传
│  ├─ importJob.ts           导入任务状态
│  ├─ presetVocab.ts         ★预设词库加载（fetch public/presets/*.json → ParsedWord）
│  ├─ backup.ts              导出/导入 json
│  ├─ localfile.ts           本地文件夹自动备份（File System Access API）
│  ├─ tts.ts                 语音朗读
│  └─ pwa.ts                 SW 注册 / 新版本提示 / 添加主屏幕引导
│
├─ ui/
│  ├─ router.ts             hash 路由（带页面清理回调）
│  ├─ dom.ts                h / button / field / textInput / details / debounce
│  ├─ device.ts             手机/平板/桌面判断 + ★controlsAvoidRect() 按钮避让区
│  ├─ components/           WordCard / SenseEditor / Modal / Toast / Pagination
│  │                        / SyncBanner / SpeechGate(iOS语音解锁) / ErrorBoundary / Footer
│  └─ pages/
│     ├─ HomePage / ImportPage / MergePage / ListPage / SettingsPage / AboutPage
│     ├─ LearnPage / MemorizePage / ReviewPage
│     ├─ paper/             ★白纸引擎：PaperStage / rounds / AnswerCard / finish / flow
│     ├─ import/            InputPanel / JobPanel / PresetPanel(预设按钮)
│     ├─ list/              ListTable(桌面表格) / ListCards(手机卡片流) / ListFilters
│     │                      / BatchBar / RawSourcesModal(低优先级来源手动采纳)
│     ├─ merge/             MergeCard / drafts
│     └─ settings/          A~G 七个分区（StarParams / Ai / Display / Practice / Priority
│                            / Cloud / Data）+ ctx.ts（currentSettings / patchSettings）
│
├─ state/store.ts           极简发布订阅 + emitDataChanged/onDataChanged
├─ dev/selftest.ts          浏览器控制台自测（window.__selftest）
└─ styles/global.css paper.css

public/presets/             ★预设词库产物（自动生成，要提交；按需 fetch，不进 JS 包）
一期预设词库/                预设词库的**原始素材** txt（改词表改这里，再跑 npm run presets）
scripts/build-presets.mjs   ★生成 public/presets/*.json + src/core/presets.ts
scripts/preset-lib.mjs      解析 / 递归剔除的纯函数（构建脚本与自检共用同一份）
scripts/cdp.mjs             真浏览器测试用的 CDP 小工具（起预览服务 / 跑表达式 / 取 DOM）
```

### 白纸引擎（最复杂的部分，三页共用）

`paper/flow.ts` 是背诵/记忆/复习共用的引擎，`PaperStage.ts` 负责纸面渲染：

- 单词按 `jitteredGrid` 布点（seed 由 sessionId 决定，**可复现**）；右下角按钮区在布点时**主动避让**
- 右下角按钮竖排（从下往上）：`再背一个`（每 N 个变「记忆」）→ `再次记忆` → `保存并退出` → `背完了`
- 点单词切换中文意思；**点中文意思**才弹单词卡（卡片默认不展开义项编辑）
- 义项数用**浅灰小数字**主动显示（只有 1 个义项时不显示）——移动端没有 hover，不能靠悬停
- 记忆环节：逐词默写 → 判分 → 答案卡（点卡片/点白纸/空格/Enter 都能继续）

---

## 8. 自检与验证（改完必跑）

```bash
npm test                # 类型检查 + 构建 + 本地自检（不需要任何云端账号）
npm run test:live       # 打线上真实 URL 的接口冒烟（20 项）
npm run test:e2e        # 用前端真实代码路径跑完整用户流程（29 项，打线上）
npm run test:presets-ui # 预设导入的真浏览器流程（需要本机有 Chrome/Edge，不在 npm test 里）
```

### 本地自检分组（`npm test` 跑这些）

| 命令 | 项数 | 验什么 |
|---|---|---|
| `test:build` | 45 | 相对导入可解析 / 无孤儿模块 / **类型检查配置护栏** / **产物模拟** / **路由表⇄api文件对应** |
| `test:rename` | 27 | 旧名绝迹 / 新名出现在 17 个关键位置 / 自检没把旧名写死 / 旧 SW 缓存仍会被清 |
| `test:sense-rules` | 81 | 资料整理规范 + AI 重新分析：提示词真含规则 / 近义词拆包 / **打包会判错**的回归防线 / 只显示代表词 / 重排盖回草稿 |
| `test:presets` | 61 | 拿原始词表**独立复算** / **各档两两不相交** / 清单⇄产物一致 / SW 缓存了 json |
| `test:api` | 58 | 后端：401 / 空间隔离 / 软删除 / 500 上限 / 分批 / 老库主键升级 |
| `test:sync` | 43 | 前端同步：多设备 / 增量 / 墓碑 / 断网不阻断 / 1100 条自动分批 |
| `test:kc-import` | 58 | **二期阶段 02**：提示词规则齐全 / 解析三级降级（非法 JSON）/ 逐块校验清洗 / 题型白名单 / 耗时钳制 / 入库存档 |
| `test:kc-review` | 49 | **二期阶段 06**：抽卡规则 / 桥接词源（新→旧→空库）/ 四阶段流转 / 收尾属性 / 桥接不改一期 |
| `test:kc-settings` | 58 | **二期阶段 07**：表达式白名单 / 改参数→掌握度变 / 预设→排序变 / 题库分类与导入导出 |
| `test:kc` | 106 | **二期阶段 01**：mastery 公式 / **安全渲染（XSS）** / **空间隔离** / 软删除墓碑传播 / 断网可用 / 时钟倒退不漏推 / 查询纯函数 / 四张表复合主键 / 一期回归 |
| `test:ai` | 53 | AI 代理：来源白名单 / 上游白名单 / SSE 透传 / **日志里搜不到密钥** |
| `test:mobile` | 59 | 断点 / **底部按钮横带避让** / **M2 网格与碰撞布点** / 字号热区 / 义项序号规则 |
| `test:m2-ui` | 39 | **CDP 精确视口 390×844** 的真机验收：词数 / 重叠 / 越界 / 圆按钮几何 / 避让带 / 词在按钮左侧 / **题干遮罩三种模式都不出屏不压按钮** / 桌面未被误改 |
| `test:pwa` | 49 | 真跑一遍 SW 的 install/activate/fetch（离线回落、不缓存 API） |
| `test:about` | 57 | 数据说明页文案与代码事实一致 / 错误边界 / footer |
| `verify:api` | — | 模拟 Vercel 剥类型生成 `.tmp/api-emit/`，校验每个 import 能解析且能加载 |

### 两条「本地测不出来」的教训（★ 这是本项目最重要的经验）

**本地自检全部是「直接调用处理函数」的**，不经过 URL 匹配，也不经过 Vercel 的部署映射。
所以下面这类问题**一条本地测试都发现不了**，只有打线上才暴露：

1. `api/**` 相对导入写 `.ts` 后缀 → 线上 500（已修，有产物模拟器守着）
2. 前端请求 `/api/sync/pull` 而真实路由是 `/api/sync-pull` → 线上 404（已修，有护栏 + 冒烟测试）

所以：**任何改动涉及路由路径、模块导入、部署行为，都要跑 `test:live` / `test:e2e`。**

### 第三条：界面流程要真浏览器才测得出（`test:presets-ui`）

预设导入这条链路上踩过一模一样的坑，值得单独记一笔：

- 一开始用 `chrome --headless --dump-dom` 抓页面，结果抓到的 `<div id="app">` **是空的**——
  模块脚本还没跑就被 dump 了。**看着像「功能没实现」，其实是测法错了**。
  改用 CDP（`scripts/cdp.mjs`）先等 load 再 `Runtime.evaluate` 才拿到真实 DOM。
- 只验「数据文件在不在」和「按钮画出来没有」是不够的：**接线错了照样能画出来**。
  所以 `test:presets-ui` 真的去 `click()` 那个按钮，然后等跳转、数卡片、
  点「确认入库」，最后直接开 IndexedDB 数一遍**是不是真有 295 个词**。

### 本地怎么跑起来

```bash
npm install
npm run api     # 窗口 1：本地后端（零依赖、不用登录 Vercel）
npm run dev     # 窗口 2：前端（Vite 已把 /api 代理到 127.0.0.1:3000）
```

设置 → F 区填 `http://localhost:3000` + 自编同步码 → 测试连接 → 立即同步。

---

## 9. 环境变量与部署

**填在 Vercel 控制台**（本机放 `.env.local`，已被 gitignore 忽略）。填完**必须重新部署**才生效。

| 变量 | 必填 | 说明 |
|---|---|---|
| `TURSO_DATABASE_URL` | ✅ 线上必填 | `libsql://xxx.turso.io`；本地可填 `file:./.tmp/dev.db` 免注册跑通 |
| `TURSO_AUTH_TOKEN` | ✅ 线上必填 | Turso 控制台生成 |
| `ALLOWED_ORIGIN` | ✅ | 你的域名，逗号分隔可多个。**不要用 `*`** |
| `AI_ALLOWED_HOSTS` | 建议 | AI 代理允许转发的上游域名（如 `api.deepseek.com`），防 SSRF。留空 = 不限制 |

**部署配置 `vercel.json`**：`framework: vite`、`outputDirectory: dist`、
区域 `hkg1`（香港，国内延迟更低）、`functions` 超时（ai-proxy 120s / 其余 60s）、
静态资源长缓存、`/api/*` no-store、SPA 回退 `rewrites`（**必须排除 `/api/`**）。

---

## 10. 已知限制与未验证项（诚实清单）

### 尚未人工验证（代码写了、自动化测不到）

- **真机手感**：右下角按钮是否好按、避让是否够（自动化只验证了「撒 180 个词，按钮区里 0 个」）
- **iOS 语音**：`SpeechGate` 的静音朗读解锁逻辑写了自动化检查，但**没在真机上听过声音**
- **添加到主屏幕**：PWA manifest 与 SW 都验证过，但没在真机上装过
- **真实 AI 调用**：`ai-proxy` 用假上游验证了转发/流式/白名单，**没用真实 DeepSeek 密钥端到端跑过**
- **多设备真实同步**：用「模拟设备」验证过（同一份代码 + 独立 IndexedDB），没用两台真机同时在线测

### 设计上的已知限制

- AI 密钥存浏览器 localStorage，清缓存会丢；导出备份**不包含**密钥
- 本地文件夹自动备份只有 Chrome/Edge 支持，Safari 降级成手动导出
- 音标与例句靠 AI 补，规则解析模式下这两项为空
- 词量上万时列表筛选是内存过滤，会卡（改造方向：索引游标）
- 删除用软删除墓碑保证多设备一致，但**墓碑不会自动清理**
- 同步冲突是「后写覆盖」：两台设备离线各改同一个词，后同步的会覆盖前面的
- `blank-sheet-vocab-proxy/`（阶段 08 的 Cloudflare Worker 转发脚本）与新的 `/api/ai-proxy`
  **功能重叠**，目前两套并存；建议后续合并
- Worker 限流是单实例内存计数，多实例部署会失效（仅指那个可选 Worker）

### 环境相关

- 本机开着**系统代理 `127.0.0.1:7897`**。关键点：**PowerShell / curl 会自动走系统代理，
  但 `git` 和 Node 的 `fetch` 都不会**。表现为「浏览器能打开、curl 能通，git push / Node 却超时」。
  - 已在**本仓库**配好 git 代理：`git config http.proxy http://127.0.0.1:7897`（https 同理）
  - Node 脚本用 `scripts/run-live.mjs` / `run-e2e.mjs`（自动识别代理并加 `--use-env-proxy`）
  - 自己写脚本打线上时注意这点；代理端口变了要同步改 git 配置
- 到 GitHub / Vercel 的网络**间歇性不稳定**：配置代理前 `git push` 约有一半概率失败（`Failed to connect to github.com:443 after 21s`）。配好后明显稳定；万一仍失败，重试一两次通常就好。

---

## 11. 常见故障速查

| 症状 | 原因与处理 |
|---|---|
| 线上 `/api/*` 返回 500，日志 `ERR_MODULE_NOT_FOUND: ..._lib/db.ts` | `api/**` 的 import 写成 `.ts` 了，改 `.js`；跑 `npm run verify:api` 本地复现 |
| 线上 `/api/*` 返回 404（空 body） | 路径写错。Vercel 按文件名映射：`/api/sync-pull`（连字符）；跑 `npm run test:live` 定位 |
| 「同步不了」 | 先 `npm run test:live`：能过说明后端没问题，再查前端「后端地址」是否填成 `https://域名`（**不带 `/api`**） |
| `/api/health` 返回 `db: error` | Vercel 环境变量没填或改完没 Redeploy |
| 一堆 `TS5097` | 有人把 import 后缀改回 `.ts` 了 → 改 `.js`（**别靠开 `allowImportingTsExtensions` 绕过，那样线上必崩**） |
| 同步推送返回 400「单批不得超过 500 条」 | 正常保护；前端已自动分批，出现这个说明请求没走前端代码 |
| 推了很多条但云端数量不对 | 看 `pushAll()` 的 `>=` 游标语义（§5），别改回 `>` |
| `npm warn install-scripts esbuild@...` | 无害（二进制来自平台包）。想消掉：`npm install-scripts approve esbuild`（已写进 `package.json` 的 `allowScripts`） |

---

## 12. 下一步建议（如果要继续做）

1. **合并两套 AI 转发**：`blank-sheet-vocab-proxy/`（Cloudflare Worker）与 `/api/ai-proxy` 功能重叠，留一个即可
2. **真机跑查**：照 `CHECKLIST.md` 在三端勾一遍，尤其是 iOS 语音与添加到主屏幕
3. **墓碑清理**：加一个「清理 30 天前的墓碑」按钮（`deleted=1 AND updated_at < 阈值`）
4. **冲突提示**：现在冲突是静默后写覆盖；后端已返回 `conflicts` 计数，可以做成提示
5. **列表页性能**：上万词时给 `words` 加索引游标，避免全量 `getAll()`
6. **同步状态可视化**：`syncScheduler` 已有 `phase/failStreak` 状态，可以做成设置页的状态徽章

---

## 13. 相关文档

| 文件 | 内容 |
|---|---|
| `README.md` | 功能清单、命令、自检脚本、目录说明、硬约束 |
| `README-DEPLOY.md` | 部署教程（Turso 建库 → Vercel → 环境变量 → 自查 → 常见问题） |
| `CHECKLIST.md` | 上线自检清单（90+ 条可勾选，含真机项） |
| `.env.example` | 环境变量模板（含逐条注释） |
| `api/_dev/*.mjs` | 自检脚本；每个文件顶部注释都写了「为什么这么测」 |
| `scripts/emit-api.mjs` | ★Vercel 产物模拟器（本地复现部署后行为） |

### `scripts/` 里各脚本的用途

| 脚本 | 用途 | 是否常用 |
|---|---|---|
| `preflight.mjs` | 构建前置检查（Node / esbuild / vite） | 每次 build 自动跑 |
| `emit-api.mjs` + `verify-api-emit.mjs` | ★模拟 Vercel 剥类型后的产物并校验 import 可解析 | `npm run verify:api`，测试自动跑 |
| `make-icons.mjs` | 零依赖生成 PWA 真 PNG 图标 | 改图标时跑 |
| `build-presets.mjs` | ★从原始词表生成预设词库产物（`--check` 只校验不写） | 改词表时跑 |
| `preset-lib.mjs` | 预设词表的解析 / 递归剔除纯函数（不是可执行脚本，被上面那个和自检 import） | — |
| `cdp.mjs` | 真浏览器测试工具：起预览服务 + CDP 连无头浏览器跑表达式、**精确设视口**（`setViewport`） | 被 `test:presets-ui` / `test:m2-ui` 用 |
| `run-live.mjs` / `run-e2e.mjs` | 自动识别系统代理后启动线上测试 | 打线上时跑 |
| `fix-api-extensions.mjs` | **一次性迁移**：把 api 的 `.ts` 后缀改成 `.js` | 历史脚本，已完成，可删 |
| `fix-api-paths.mjs` | **一次性迁移**：把 `/api/sync/pull` 改成 `/api/sync-pull` | 历史脚本，已完成，可删 |

> 两个 `fix-*.mjs` 是修线上故障时写的一次性迁移脚本，留着是为了留痕。
> 新代码不要模仿它们的写法（它们直接改文件，不经检查）。
>
> 同理，`.tmp/rename.mjs` 是改名时用的一次性脚本（也直接改文件），
> 留档是为了说明「当时到底替换了哪些字符串」。

代码里凡是有坑的地方都留了 `★` 或 `⚠️` 注释，**改之前请先读那段注释**——那些注释都是踩过坑才写下的。
