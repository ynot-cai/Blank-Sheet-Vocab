# 单词白纸（wordpaper）

**本地优先**的背单词 Web 应用：单词随机散落在满屏白纸上，靠 **位置 + 语音** 建立记忆，
配默写自测和可自定义的间隔复习优先度。

两种用法，同一份代码：

| 模式 | 说明 | 需要什么 |
|---|---|---|
| **纯本地**（默认） | 数据只存在浏览器里，断网照常用 | 什么都不用配，`npm run dev` 就能用 |
| **云同步**（可选） | 手机 / 平板 / 电脑共用一份数据 | 一个免费的 Turso 数据库 + Vercel 免费部署 |

密钥永远只存在你自己的浏览器里（**方案 B**），服务器不接触 AI 密钥，也不知道你的明文同步码。

> 当前进度：**同步版阶段 01~07 全部完成**。本地功能（录入 / 背诵 / 记忆 / 复习 / 列表 / 备份）
> 一行都没删，云同步是**增量加上去**的：不开启就是纯本地。

---

## 怎么跑起来

```bash
npm install
npm run dev
```

打开终端里输出的地址（默认 <http://127.0.0.1:5173/#/home>）。

想同时用上「云同步 / AI 代理」这些后端能力，再开一个窗口：

```bash
npm run api        # 本地后端，零依赖、不用登录 Vercel
```

前端已经把 `/api` 代理到 `127.0.0.1:3000`，所以本地也不会遇到跨域问题。
（也可以用官方的 `npx vercel dev`，效果一样。）

### 常用命令

| 命令 | 作用 |
|---|---|
| `npm run dev` | 启动前端开发服务器 |
| `npm run api` | 启动本地后端（api/ 里的 Serverless Functions） |
| `npm run preflight` | 构建前置检查（Node 版本 / esbuild 二进制 / vite 是否可用） |
| `npm run build` | 先 preflight，再 `tsc --noEmit && vite build`，产物在 `dist/` |
| `npm run preview` | 预览构建产物 |
| `npm run typecheck` | 权威类型检查（`tsc -b`，按 references 分别查 src 与 api） |
| `npm run typecheck:app` | 只查 `src/`（DOM + vite/client 类型） |
| `npm run typecheck:api` | 只查 `api/`（Node 类型，看不到 window/document） |
| `npm test` | **全套自检 339 项**（见下；先构建再逐项跑） |
| `npm run icons` | 重新生成 PWA 图标 |

### 自检脚本（不需要任何云端账号）

后端与同步逻辑全部可以在本地跑通，不需要 Turso、不需要 Vercel、不需要密钥：

| 命令 | 验什么 |
|---|---|
| `npm run test:api` | 后端：健康检查 / 401 / 空间隔离 / 软删除 / 500 条批量上限 / 分批推送 / 老库主键升级 |
| `npm run test:sync` | 前端同步：多设备拉取、增量、墓碑、断网不阻断、1100 条自动分批 |
| `npm run test:ai` | AI 代理：来源白名单、上游白名单、流式透传、**日志里搜不到密钥** |
| `npm run test:mobile` | 移动端：断点、右下角按钮避让、字号与热区、义项序号规则 |
| `npm run test:pwa` | PWA：真跑一遍 Service Worker 的 install/activate/fetch，验证离线回落与「不缓存 API」 |
| `npm run test:about` | 数据说明页文案与代码事实是否一致、错误边界、footer |
| `npm run test:build` | 构建完整性：393 个相对导入可解析、无孤儿模块、**类型检查配置防回归** |

`npm test` 会把上面全部跑一遍并做类型检查。**改完代码先跑它。**

### 遇到构建 / 类型检查报错时

**先跑 `npm run preflight`**，它能把「环境有问题」和「代码有问题」区分开：

```
=== 构建前置检查 ===
  ✓ Node 版本 ≥ 20.6 —— 当前 v24.21.0
  ✓ typescript 可用 —— v5.9.3
  ✓ esbuild 能用（二进制已就位） —— v0.25.12，transform 调用成功
  ✓ vite 可用
```

| 症状 | 原因与修复 |
|---|---|
| `npm warn install-scripts esbuild@0.25.12 (postinstall: node install.js)` | npm 11 默认不跑依赖的安装脚本。**这个警告本身无害**：esbuild 的二进制来自平台包 `@esbuild/win32-x64`，`npm install` 时就已经装好了（已实测：全新安装后 `esbuild.transformSync` 正常工作）。想彻底消掉它：`npm install-scripts approve esbuild` —— 放行记录会写进 `package.json` 的 `allowScripts`，其他人克隆后也不再看到。 |
| 构建报 esbuild 相关错误 | `npm rebuild esbuild`；仍不行就删掉 `node_modules` 重新 `npm install` |
| 线上 `/api/*` 返回 500，日志里是 `ERR_MODULE_NOT_FOUND: Cannot find module '/var/task/api/_lib/db.ts'` | **这是本项目踩过的大坑**：Vercel 用 Node 的类型擦除把 `.ts` 剥成 `.js`，但**不重写 import 路径**。源码写 `from './_lib/db.ts'` → 线上产物仍去找 `db.ts`，而磁盘上只有 `db.js`。**修法：`api/*.ts` 与 `api/_lib/*.ts` 里的相对导入一律写 `.js` 后缀**（TypeScript ESM 的标准写法）。跑 `npm run verify:api` 可以在本地复现并检出这类问题。 |
| 一堆 `TS5097: An import path can only end with a '.ts' extension when 'allowImportingTsExtensions' is enabled` | 说明有人把 import 后缀改回 `.ts` 了。改成 `.js` 即可（见上一条）。**不要靠开 `allowImportingTsExtensions` 让 `.ts` 后缀通过检查** —— 那样类型检查会过，但线上必崩。 |
| `npx tsc --noEmit` 什么都没查就通过 | 以前根 `tsconfig.json` 是 `{"files": [], "references": [...]}` 这种「solution 风格」配置，**零文件**，所以它静默通过、什么也没检查。现在已改成真正 `include: ["src", "api", "vite.config.ts"]`，可以直接用。 |
| 想确认 `api/` 真的被检查了 | 跑 `npm run typecheck:api`（只查 api，纯 Node 类型）。故意在 `api/` 里写 `const x: number = 'a'` 应该立刻报错。 |
| 想在上线前确认部署不会崩 | 跑 `npm run verify:api` —— 它剥一遍类型生成 `.tmp/api-emit/`（等价于 `/var/task` 的样子），检查每个 import 能否解析，并真的把产物加载一次。`npm test` 里已包含这一步。 |

---

## 两种模式怎么切换

设置 → **F. 云同步**：

1. 打开「启用云同步」（会先弹一个说明，读完点「知道了」）；
2. 「后端地址」填你的域名，例如 `https://wordpaper.vercel.app`，**不要带 `/api`**；
   本地开发就填 `http://localhost:3000`；
3. 「同步码」自己编一个（至少 8 位、要含字母和数字），**所有设备填同一个**；
4. 「测试连接」→ 绿字 → 「立即同步」。

关掉开关就回到纯本地模式：数据不会上传，本地功能完全不受影响。
**判断标准**：关掉云同步后，断网打开应用，一切照常 → 说明本地优先是真的。

> ⚠️ 同步码与词库都在浏览器里，**清缓存 / 换手机 / 忘记同步码 = 数据没了**。
> 起好同步码后立刻导出一次备份（设置 → G 区），存进网盘或密码管理器。

---

## 功能清单（六个入口全可用）

| 入口 | 做什么 |
|---|---|
| 录入 | 粘贴/上传 `.txt/.csv/.md`，AI 智能解析（分批 + 断点续传）或规则解析（离线），再进合并确认页。AI 会主动拆义项（「量纲、维度」拆成两个）、为每个义项找近义词放进 aliases |
| 背诵 | 不设数量上限，直接开白纸随机布点；点单词切换词下中文意思（`词性.①义项1②义项2`，只显示代表义项）；点中文意思开卡编辑/「拼」/斩；每背几个词按钮自动变「记忆」；「保存并退出」记住位置与每词记忆次数 |
| 记忆 | 只抽已出现在纸上的词，光标自动落到第一个输入框；每个义项一个输入框，未通过封顶（failCountCap）；答案卡沿用单词卡，**点任意处 / Enter / 空格**继续；一轮走完自动接拼写环节 |
| 复习 | 按优先度推荐数量 → 分组（每组 ≤ reviewGroupSize）→ 每组完整走一遍背诵 + 记忆 + 拼写 |
| 单词列表 | 统计条 / 搜索 / 筛选 / 批量操作 / 斩词复活 / 重算优先度 / 导出导入（手机上自动换成卡片流） |
| 设置 | A 星号参数 / B AI 接口 / C 画面与纸张 / D 记忆与练习 / E 复习优先度 / **F 云同步** / **G 数据（备份恢复清空）** |

首页底部有「关于数据」入口（`#/about`）：讲清数据存在哪、服务器存什么、怎么删。

## 快捷键

| 键 | 作用 |
|---|---|
| `Enter` | 背诵页「再背一个」（每 N 个后变成「记忆」）/ 提交答案 / 推进答案卡 |
| `空格` | 答案卡打开时推进（继续下一个） |
| 点击页面任意处 | 答案卡打开时推进（继续下一个） |
| `Esc` | 关闭单词卡 / 弹窗 |

## 星号参数（设置 → A 区，默认值）

| key | 默认 | 含义 |
|---|---|---|
| `memorizeMaxPick` | 10 | 一次「记忆」最多抽几个（只抽已出现在纸上的词） |
| `memorizeTargetCount` | 1 | 每词至少记忆几次，「背完了」按钮才出现 |
| `memorizeEvery` | 3 | 每背几个新词，「再背一个」按钮自动变成「记忆」 |
| `failCountCap` | 2 | 属性② 未通过次数上限 |
| `reviewGroupSize` | 30 | 复习每组上限 |

---

## AI 解析怎么接

设置 → B 区自己填：**接口地址**、**模型名**（默认 `deepseek-chat`）、**密钥**。

调用有**两条路径，自动切换**：

1. **直连**：浏览器直接请求你填的接口地址（首选）；
2. **代理**：被 CORS 拦下时，自动改走 `{后端地址}/api/ai-proxy` 转发一次。
   也可以手动勾「走无状态代理」，直接走代理不试直连。

那个代理是**无状态**的：不存密钥、不写数据库、不写日志、不缓存——
密钥随每次请求发出去，用完即弃。代码里有测试专门验证「日志里搜不到密钥」。

**密钥只存在这台设备的浏览器里**，每台设备各填各的，不上传不同步，清缓存会丢。
不填密钥就是纯离线，规则解析兜底，功能一样能跑。

---

## 数据存在哪（三层）

1. **浏览器本地（主）**：IndexedDB，库名 `wordpaper`。断网可用，秒开。
2. **云端（可选）**：Turso 数据库，只存单词数据 + **同步码的 SHA-256 哈希**。
3. **本地备份文件（可选）**：Chrome / Edge 连接本地文件夹后，每次改动自动写
   `wordpaper-data.json`（防抖 2 秒）；浏览器重启后顶部黄条点一下恢复授权。

手动导出：设置页或列表页「导出备份」→ 得到 json；「导入备份（合并/覆盖）」可恢复。
**导出不包含 AI 密钥**（密钥从设计上就不进备份、不进云端）。

---

## 数据层自测（浏览器控制台）

`npm run dev` 打开页面后按 F12：

```js
await __selftest.run()   // 全部：接口地址 / 规则解析 / 判分 / 优先度 / 抽词 / 布点 / 短语缩写 / 数据层
__selftest.pick()        // 记忆环节必抽规则 + 复习分组 + 推荐值
__selftest.layout()      // jitteredGrid：seed 可复现 / 不重叠
__selftest.phrase()      // 短语 / 缩写合法性
await __selftest.data()  // IndexedDB 读写
```

---

## 目录说明

```
api/                       后端（Vercel Serverless Functions，和前端共用 package.json）
├─ _lib/                   db（Turso 单例 + 建表）/ spaceAuth / cors / http / limits / validate
├─ health.ts               GET  /api/health
├─ sync-pull.ts            GET  /api/sync-pull?since=<ts>
├─ sync-push.ts            POST /api/sync-push（单批 ≤ 500 条）
├─ sync-purge.ts           POST /api/sync-purge（清空当前数据空间）
├─ ai-proxy.ts             POST /api/ai-proxy（无状态转发，不连数据库）
└─ _dev/                   本地直调与自检脚本（不会被部署）

⚠️ 路由名 = 文件名（连字符，**不是** /api/sync/pull）：
   Vercel 把 api/ 下的文件名直接映射成路由，写错斜杠会 404。
   路径只在 src/dao/syncServer.ts 的 API_ROUTES 里定义一处，
   由 npm run test:build 的护栏校验「路由表 ⇄ api/ 真实文件」一一对应，
   再用 npm run test:live 打线上真实 URL 验证。
src/
├─ main.ts / App.ts        启动、顶栏路由、footer、错误边界装配
├─ core/                   types / config / db / model / parser / merge / priority / layout / pick
│  └─ syncHelper.ts        sha256、地址拼接、相对时间
├─ dao/                    页面只能走这里，全 async
│  ├─ words / sources / settings / session     本地数据
│  ├─ syncData.ts          含墓碑的读法 / 原样写回（云同步专用）
│  ├─ syncMap.ts           本地对象 ⇄ 服务器行 的字段映射
│  ├─ syncServer.ts        HTTP 客户端（超时 15s + 一次重试 + 自动分批）
│  ├─ cloudSync.ts         同步编排：先拉后推、last-write-wins
│  └─ syncScheduler.ts     防抖调度 + 状态订阅
├─ services/               ai / parsePipeline / importJob / backup / localfile / tts / pwa
├─ state/store.ts          极简发布订阅 + 数据变动事件
├─ ui/
│  ├─ router.ts dom.ts device.ts
│  ├─ components/          WordCard / SenseEditor / Modal / Toast / Pagination / SyncBanner
│  │                       / SpeechGate（iOS 语音解锁）/ ErrorBoundary / Footer
│  └─ pages/               Home / Import / Merge / List / Settings / About
│     ├─ LearnPage MemorizePage ReviewPage
│     ├─ paper/            PaperStage / AnswerCard / rounds / finish / flow（白纸引擎，三页共用）
│     ├─ list/             ListTable（桌面表格）+ ListCards（手机卡片流）
│     └─ settings/         A~G 七个分区
├─ dev/selftest.ts         控制台自测
└─ styles/                 global.css / paper.css
public/                    manifest.webmanifest / sw.js / icons/（由 npm run icons 生成）
scripts/make-icons.mjs     零依赖生成真 PNG 图标
wordpaper-proxy/           可选：Cloudflare Worker 自建转发（阶段 08，独立小项目）
```

---

## 部署

见 **[README-DEPLOY.md](./README-DEPLOY.md)**（Turso 建库 → Vercel 部署 → 环境变量 → 自查），
上线前照着 **[CHECKLIST.md](./CHECKLIST.md)** 勾一遍。

关键环境变量（**填在 Vercel 控制台，不要提交到 Git**）：

| 名称 | 说明 |
|---|---|
| `TURSO_DATABASE_URL` | Turso 数据库地址（`libsql://...`） |
| `TURSO_AUTH_TOKEN` | Turso 令牌 |
| `ALLOWED_ORIGIN` | 你的域名，**不要写 `*`** |
| `AI_ALLOWED_HOSTS` | AI 代理允许转发的上游域名，例如 `api.deepseek.com` |

---

## 已知限制（提前知道，别当成 bug）

- AI 密钥存在浏览器 localStorage，清缓存会丢；导出备份也不包含它
- 本地文件夹自动备份只有 Chrome / Edge 支持；Safari 降级成手动导出
- 音标例句第一版靠 AI 补，规则解析模式下这两项为空
- 词量上万时列表筛选是内存过滤，会有卡顿（代码里已注明改造方向）
- 删除用软删除墓碑（保证多设备一致），墓碑会一直留着，不占多少空间但不会自动清
- 同步冲突策略是「后写覆盖」：两台设备离线各改同一个词，后同步的会覆盖前面的
- Vercel 的 `*.vercel.app` 域名在国内可能访问慢——但本地优先，慢不影响背单词
- Worker 限流是单实例内存计数，多实例部署会失效（仅 `wordpaper-proxy/` 那个可选脚本）

---

## 硬约束（写代码时守住）

1. 页面文件里不出现 `indexedDB` / `localStorage` / `fetch(`；页面只走 `dao/` + `services/` + `core/`。
2. `dao/` 全部返回 `Promise`，即使底层是同步的。
3. 所有可调数字集中在 `src/core/config.ts`（`DEFAULTS` / `SYNC` / `DEVICE`）。
4. TypeScript strict，不用 `any`、不用 `@ts-ignore`。
5. 单文件超过 300 行就拆分。
6. AI 只留一个通用接口位，不写任何厂商判断分支；**密钥只存在本机浏览器**。
7. **服务器永不接触 AI 密钥**；同步码只以 SHA-256 哈希落库；所有 SQL 都带 `WHERE space_key = ?`。
8. **同步失败绝不阻断使用**（本地优先是基石）。
