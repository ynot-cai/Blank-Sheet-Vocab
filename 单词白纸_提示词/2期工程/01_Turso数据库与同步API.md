# 阶段 01：Turso 数据库 + Vercel 同步 API

> 前置：已贴 `00_同步版主提示词_每次必贴.md`。本阶段写 `api/` 目录下的 Serverless Functions，不碰前端页面。

---

## 任务

### 1. 装依赖

在项目根目录（前端项目）执行：

```bash
npm install @libsql/client
```

**说明**：Vercel 部署时，`api/` 目录的函数和前端共用同一个 `package.json`，所以这个依赖装在根依赖里即可。

### 2. `api/_lib/db.ts` —— Turso 客户端

```ts
import { createClient, type Client } from '@libsql/client';

let client: Client | null = null;

export function getDB(): Client {
  if (client) return client;               // 模块级单例，Serverless 复用连接
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url) throw new Error('TURSO_DATABASE_URL is not set');
  client = createClient({ url, authToken });
  return client;
}

export async function initSchema(): Promise<void>;   // 幂等建表 + 建索引
```

要点：
- **必须模块级单例**（`let client` 缓存），否则每次请求新建连接会严重拖慢 Serverless 冷启动
- `initSchema()` 执行主提示词第 7 节的建表 SQL（`CREATE TABLE IF NOT EXISTS`），幂等
- 在每个需要数据库的 Function 开头调用一次 `initSchema()`（幂等，可安全重复调用）
- 环境变量缺失时抛出**明确错误**（方便在 Vercel 日志里排查）

### 3. `api/_lib/spaceAuth.ts`

```ts
export function getSpaceKey(req: { headers: Record<string, string | string[] | undefined> }): string;
export function requireSpaceKey(req): string;   // 缺失/非法则抛错
```

- 从请求头 `X-Space-Key` 读取（注意 Vercel 会把头名规范化，建议同时兼容 `x-space-key`）
- 校验：必须是 **64 位十六进制字符串**（`/^[0-9a-f]{64}$/i`），否则抛 401
- **注释写明**：这里拿到的是哈希，服务器永远不知道明文同步码

### 4. `api/_lib/cors.ts`

统一处理跨域 + 预检：

```ts
export function applyCors(res, origin?: string): void;   // 设 Access-Control-* 头
export function handleOptions(req, res): boolean;        // OPTIONS 预检直接返回 204
```

- `Access-Control-Allow-Headers`：必须包含 `Content-Type, X-Space-Key`
- `Access-Control-Allow-Methods`：`GET, POST, OPTIONS`
- `Access-Control-Allow-Origin`：从环境变量 `ALLOWED_ORIGIN` 读（开发时 `http://localhost:5173`，生产是你的 Vercel 域名）。**不要用 `*`**（虽然自用，但保持好习惯）
- **注释说明**：Vercel Function 要自己处理 OPTIONS，否则浏览器预检会失败

### 5. `api/health.ts`

```ts
export default async function handler(req, res) {
  // 返回 { ok: true, time, db: 'connected' | 'error' }
}
```

- **不需要** spaceKey
- 尝试 `SELECT 1` 验证 Turso 连通性，把结果放进响应（**只放"是否连通"，不要泄露任何连接串**）
- 用途：前端「测试连接」按钮、Vercel 部署后自查

### 6. `api/sync-pull.ts`

```ts
GET /api/sync/pull?since=<timestamp>
```

- 从 `X-Space-Key` 取 spaceKey（非法 → 401）
- 查询 `updated_at > since` 的 words 和 sources（**必须带 `WHERE space_key = ?`**）
- 返回：
  ```json
  { "words": [...], "sources": [...], "serverTime": 1730000000000 }
  ```
- **包含软删除记录**（`deleted=1` 也要返回），让客户端能同步删除
- 默认按 `updated_at` 升序
- `senses` / `raw_sources` / `attrs` 字段是 JSON 字符串，直接返回（前端自己 parse）
- **限制单次返回条数**（如 ≤ 2000），超出的用分页或提示前端分次拉（注释说明）

### 7. `api/sync-push.ts`

```ts
POST /api/sync/push
body: { words?: WordInput[], sources?: SourceInput[] }
```

- 校验 spaceKey（非法 → 401）
- **校验批量大小：单批 ≤ 500 条**，超过返回 400 并提示前端分批（Vercel 请求体上限 4.5MB）
- 逐条 upsert：按 `id` 判断，存在则更新（更新 `updated_at`），不存在则插入
- 用**批量事务**（`client.batch()` 或手动事务）提升性能
- 返回：`{ applied: number, conflicts: number, serverTime: number }`
- 冲突策略：**后写覆盖**（客户端 `updated_at` 更新就覆盖）。`conflicts` 字段先返回 0，注释说明将来可升级为冲突提示
- 全程 try/catch，异常返回 500 + 脱敏错误信息

**安全要求**：日志里**只打条目数量**，不打印 spaceKey 完整值（最多前 8 位），不打印任何单词内容（避免日志膨胀和隐私泄露）。

### 8. `vercel.json`（本阶段先写最小版）

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "functions": {
    "api/**/*.ts": {
      "maxDuration": 60
    }
  }
}
```

- 所有 API 函数超时 60 秒（同步操作够用；AI 代理后续单独配）
- 注释说明：`maxDuration` 最大值 Hobby 计划是 300 秒

### 9. `.env.example`

```
TURSO_DATABASE_URL=libsql://your-database.turso.io
TURSO_AUTH_TOKEN=your-auth-token
ALLOWED_ORIGIN=http://localhost:5173
```

**注释**：真实值填在 Vercel 项目设置的环境变量里，不要提交到 Git。

---

## 验收标准

1. `npx tsc --noEmit` 零报错（若 `api/` 未被 tsconfig 覆盖，单独配一个检查或将 `api` 纳入 include）
2. **本地能启动 Vercel 开发服务器**：
   ```bash
   npx vercel dev
   ```
   （首次会要求登录 Vercel，按提示操作；本地需要能连 Turso）
3. 用 curl 自测（把结果贴给我）：
   - `GET /api/health` → 200，`db: connected`
   - `GET /api/sync/pull` **不带** `X-Space-Key` → 401
   - 带非法 spaceKey（如 `abc`）→ 401
   - 带合法 64 位十六进制 spaceKey → 200，返回空数组（首次）
4. `POST /api/sync/push` 推 2 条词 → `GET /api/sync/pull?since=0` 能取回这 2 条，JSON 字段能被正确解析
5. **隔离验证（最重要）**：用 spaceKey A 推数据，用 spaceKey B 拉取 → 拉不到 A 的数据
6. **批量限制验证**：一次推 600 条 → 返回 400 并提示"单批不得超过 500 条"
7. 软删除验证：推一条 `deleted=1` 的记录 → pull 能返回它（不是消失）
8. 代码全局搜索确认：**没有任何地方写明文同步码**、**没有任何 AI 密钥相关代码**、`space_key` 在所有 SQL 里都出现

---

## 完成后

用一句话汇报：新增了哪些文件、Vercel dev 是否跑起来、curl 的隔离验证结果。然后停下等我发阶段 02。
