# 阶段 04：Vercel 部署配置

> 前置：阶段 01~03 已完成。`api/` 下的函数在本地能跑。
> 本阶段**只生成配置文件和说明**，实际部署由用户点几下完成（见配套教程）。

---

## 任务

### 1. `vercel.json`（完整版）

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "buildCommand": "npm run build",
  "outputDirectory": "dist",
  "framework": "vite",
  "functions": {
    "api/ai-proxy.ts": { "maxDuration": 120 },
    "api/**/*.ts": { "maxDuration": 60 }
  },
  "headers": [
    {
      "source": "/assets/(.*)",
      "headers": [
        { "key": "Cache-Control", "value": "public, max-age=31536000, immutable" }
      ]
    }
  ],
  "rewrites": [
    { "source": "/((?!api/).*)", "destination": "/index.html" }
  ]
}
```

要点：
- `framework: vite`：让 Vercel 自动识别 Vite 构建流程
- `outputDirectory: dist`：Vite 默认产物目录
- `rewrites`：SPA 路由回退（**必须排除 `/api/`**，否则 API 请求会被重写到 index.html）
- 静态资源长缓存（Vite 产物带 hash，可安全长缓存）
- **注释说明**：`rewrites` 的正则要小心，若写错会导致 API 404

### 2. 区域选择（降低国内延迟）

Vercel 函数默认部署在美东。为了离中国更近，在 `vercel.json` 里指定区域：

```json
{
  "regions": ["hkg1"]
}
```

- `hkg1` = 香港（离深圳最近，推荐）
- 备选 `sin1`（新加坡）、`nrt1`（东京）
- **注释说明**：Hobby 计划可指定单个区域；区域要在 Vercel 项目设置里确认已启用

### 3. `.env.example` 完善

```
# Turso 数据库（在 Vercel 项目 Settings → Environment Variables 里填真实值）
TURSO_DATABASE_URL=libsql://your-database.turso.io
TURSO_AUTH_TOKEN=your-auth-token

# 允许访问 API 的前端来源（生产填你的 Vercel 域名，如 https://wordpaper.vercel.app）
ALLOWED_ORIGIN=http://localhost:5173
```

**注释**：`.env.local` 用于本地开发；生产环境的真实值**必须**在 Vercel 控制台填，不要提交到 Git。

### 4. `.gitignore` 补充

确认包含：
```
.env
.env.local
.vercel
dist
node_modules
```

### 5. `README-DEPLOY.md`（部署说明，给用户看）

写一份**具体、可照抄**的部署步骤：

**方式 A：命令行部署（推荐，最快）**
```bash
# 1. 安装 Vercel CLI
npm i -g vercel

# 2. 登录（会打开浏览器）
vercel login

# 3. 在项目根目录部署
vercel

# 4. 生产部署
vercel --prod
```

**方式 B：Git 推送自动部署（推荐长期用）**
1. 把代码推到 GitHub / GitLab
2. 在 Vercel 控制台 "Import Project" 导入仓库
3. Vercel 自动识别 Vite 框架，**之后每次 `git push` 自动重新部署**

**部署后必做**：
1. Vercel 项目 → Settings → Environment Variables，填入：
   - `TURSO_DATABASE_URL`
   - `TURSO_AUTH_TOKEN`
   - `ALLOWED_ORIGIN`（填你的 Vercel 域名，如 `https://wordpaper.vercel.app`）
2. 填完环境变量后**必须重新部署**才会生效（Vercel 控制台点 Redeploy，或 `vercel --prod`）
3. 访问 `https://你的项目.vercel.app/api/health` → 应返回 `{ ok: true, db: "connected" }`

**常见问题排查**：
- `/api/health` 返回 500 → 检查环境变量是否填对、是否重新部署
- API 返回 401 → 前端填的同步码有问题，或请求头没带 `X-Space-Key`
- 页面 404 → `vercel.json` 的 `rewrites` 正则写错了
- 国内打不开 → 见教程里的"国内访问说明"（换自定义域名等）

### 6. 前端构建产物处理

确认 `package.json` 有：
```json
{
  "scripts": {
    "build": "tsc && vite build",
    "preview": "vite preview"
  }
}
```

Vercel 会自动执行 `npm run build`，无需手动构建上传。

---

## 验收标准

1. `vercel.json` 语法正确（`npx vercel build` 能本地模拟构建）
2. **本地模拟验证**：`npx vercel dev` 启动后：
   - 访问 `http://localhost:3000` 能看到前端页面
   - 访问 `http://localhost:3000/api/health` 返回健康
   - 前端能正常调用 `/api/sync/*`（走 Vite proxy 或直连，注释说明本地怎么配）
3. **真实部署验证**（需要用户先完成教程里的账号注册）：
   - `vercel --prod` 部署成功，拿到 `.vercel.app` 域名
   - 浏览器打开域名能进首页
   - 打开 `/api/health` 返回 `{ ok: true, db: "connected" }`
   - 在设置页填 Vercel 域名 + 同步码 → 测试连接成功 → 能同步
4. `README-DEPLOY.md` 步骤清晰，用户照着能走通

---

## 完成后

一句话汇报：`vercel.json` 配置、本地模拟结果、**是否已真实部署成功**（若已部署，给出访问地址）。等我发阶段 05。
