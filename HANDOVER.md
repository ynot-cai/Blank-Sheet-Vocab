# 项目交接文档（单词白纸 / wordpaper）

> 面向接替开发的人。**读完这份 + `README.md` 就能上手改代码。**
> 最后更新：云同步阶段全部完成并已在线上验证通过。

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
| 自动化自检 | ✅ 353 项本地 + 20 项线上冒烟 + 29 项线上端到端，全绿 |
| 线上可用性 | ✅ 已实测（真机手感、iOS 语音、添加到主屏幕**尚未**人工确认，见 §10） |

---

## 2. 架构总览

```
┌─ 浏览器（手机 / 平板 / 电脑）────────────────────────────────┐
│  Vite 构建的静态站（Vercel 托管）                             │
│                                                             │
│  ┌─ IndexedDB（库名 wordpaper，v2）★主存储，断网可用        │
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

库名 `wordpaper`，版本 **2**（v1→v2 迁移补了 `sources.updatedAt` 等云同步字段）。

| 表 | keyPath | 说明 |
|---|---|---|
| `words` | `id` | 词条，含 `updatedAt`（同步游标）、`deleted?`（墓碑） |
| `sources` | `id` | 词库来源，含 `updatedAt?`、`deleted?` |
| `settings` | `key` | 设置整体存一行（`key = 'main'`）；本地文件夹句柄等用 `putRaw` |
| `sessions` | `id` | 背诵/复习会话（断点续跑） |

### 4.3 删除语义（容易搞混，重点看）

| 场景 | 行为 |
|---|---|
| 用户在背诵页/列表页「斩」词 | **软删**：`status = 'chopped'` |
| 用户「删除」词（列表页） | **硬删**（本地直接移除） |
| 删除来源 | **软删**：写一条 `deleted=1` 的墓碑（否则别的设备会复活它） |
| 云端下发 `deleted=1` | **本地真的删掉那一行**（墓碑只在传输中用，落地就清） |

- 墓碑的意义：不留墓碑，「A 设备删了、B 设备还留着」会在下次同步被 B 复活。
- `dao/words.listAlive()` 过滤掉 `deleted=1`；`getAll()` **故意不过滤**（同步要读墓碑）。
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
│  ├─ syncHelper.ts         sha256 / getSpaceKey / apiUrl / normalizeApiBase / relativeTime
│  └─ version.ts            构建时间戳（vite define 注入）
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
│  └─ syncScheduler.ts      防抖调度 + 状态订阅（phase/failStreak）+ 失败重试
│
├─ services/
│  ├─ ai.ts                 ★AI 调用：直连 ⇄ 代理自动切换；getLastAiRoute() 供设置页显示
│  ├─ parsePipeline.ts       分批解析 + 断点续传
│  ├─ importJob.ts           导入任务状态
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
│     ├─ import/            InputPanel / JobPanel
│     ├─ list/              ListTable(桌面表格) / ListCards(手机卡片流) / ListFilters
│     │                      / BatchBar / RawSourcesModal(低优先级来源手动采纳)
│     ├─ merge/             MergeCard / drafts
│     └─ settings/          A~G 七个分区（StarParams / Ai / Display / Practice / Priority
│                            / Cloud / Data）+ ctx.ts（currentSettings / patchSettings）
│
├─ state/store.ts           极简发布订阅 + emitDataChanged/onDataChanged
├─ dev/selftest.ts          浏览器控制台自测（window.__selftest）
└─ styles/global.css paper.css
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
npm test          # 类型检查 + 构建 + 353 项本地自检（不需要任何云端账号）
npm run test:live # 打线上真实 URL 的接口冒烟（20 项）
npm run test:e2e  # 用前端真实代码路径跑完整用户流程（29 项，打线上）
```

### 本地自检分组（`npm test` 跑这些）

| 命令 | 项数 | 验什么 |
|---|---|---|
| `test:build` | 45 | 相对导入可解析 / 无孤儿模块 / **类型检查配置护栏** / **产物模拟** / **路由表⇄api文件对应** |
| `test:api` | 58 | 后端：401 / 空间隔离 / 软删除 / 500 上限 / 分批 / 老库主键升级 |
| `test:sync` | 43 | 前端同步：多设备 / 增量 / 墓碑 / 断网不阻断 / 1100 条自动分批 |
| `test:ai` | 53 | AI 代理：来源白名单 / 上游白名单 / SSE 透传 / **日志里搜不到密钥** |
| `test:mobile` | 48 | 断点 / 右下角避让 / 字号热区 / 义项序号规则 |
| `test:pwa` | 49 | 真跑一遍 SW 的 install/activate/fetch（离线回落、不缓存 API） |
| `test:about` | 57 | 数据说明页文案与代码事实一致 / 错误边界 / footer |
| `verify:api` | — | 模拟 Vercel 剥类型生成 `.tmp/api-emit/`，校验每个 import 能解析且能加载 |

### 两条「本地测不出来」的教训（★ 这是本项目最重要的经验）

**本地自检全部是「直接调用处理函数」的**，不经过 URL 匹配，也不经过 Vercel 的部署映射。
所以下面这类问题**一条本地测试都发现不了**，只有打线上才暴露：

1. `api/**` 相对导入写 `.ts` 后缀 → 线上 500（已修，有产物模拟器守着）
2. 前端请求 `/api/sync/pull` 而真实路由是 `/api/sync-pull` → 线上 404（已修，有护栏 + 冒烟测试）

所以：**任何改动涉及路由路径、模块导入、部署行为，都要跑 `test:live` / `test:e2e`。**

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
- `wordpaper-proxy/`（阶段 08 的 Cloudflare Worker 转发脚本）与新的 `/api/ai-proxy`
  **功能重叠**，目前两套并存；建议后续合并
- Worker 限流是单实例内存计数，多实例部署会失效（仅指那个可选 Worker）

### 环境相关

- 本机开着**系统代理 `127.0.0.1:7897`**：PowerShell/curl 会走，但 **Node 的 fetch 默认忽略代理**。
  表现为「浏览器能开、curl 能通、Node 超时」。`scripts/run-live.mjs` / `run-e2e.mjs`
  会自动识别系统代理并加 `--use-env-proxy`。自己写脚本打线上时注意这点。
- 到 GitHub / Vercel 的网络**间歇性不稳定**，push 失败重试一两次通常就好。

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

1. **合并两套 AI 转发**：`wordpaper-proxy/`（Cloudflare Worker）与 `/api/ai-proxy` 功能重叠，留一个即可
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
| `run-live.mjs` / `run-e2e.mjs` | 自动识别系统代理后启动线上测试 | 打线上时跑 |
| `fix-api-extensions.mjs` | **一次性迁移**：把 api 的 `.ts` 后缀改成 `.js` | 历史脚本，已完成，可删 |
| `fix-api-paths.mjs` | **一次性迁移**：把 `/api/sync/pull` 改成 `/api/sync-pull` | 历史脚本，已完成，可删 |

> 两个 `fix-*.mjs` 是修线上故障时写的一次性迁移脚本，留着是为了留痕。
> 新代码不要模仿它们的写法（它们直接改文件，不经检查）。

代码里凡是有坑的地方都留了 `★` 或 `⚠️` 注释，**改之前请先读那段注释**——那些注释都是踩过坑才写下的。
