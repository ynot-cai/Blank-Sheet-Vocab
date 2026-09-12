# 部署说明（照着做就行）

这份文档讲**怎么把这个项目放到网上，让手机、平板、电脑共用一份单词数据**。

全程零成本：Vercel 免费版 + Turso 免费版，都不需要信用卡。

---

## 0. 部署前先在本地跑一遍

```bash
npm install
npm run test      # 类型检查 + 154 项自检（后端 / 同步 / AI 代理）
npm run build     # 确认能构建
```

要体验完整效果（本地也有后端）：

```bash
# 窗口 1：本地 API（零依赖，不用登录 Vercel）
npm run api

# 窗口 2：前端
npm run dev
```

打开 <http://127.0.0.1:5173>，设置 → F 区「云同步」→ 后端地址填 `http://localhost:3000`，
自己编一个同步码（至少 8 位、含字母和数字），点「测试连接」。

---

## 1. 建一个 Turso 数据库（放单词数据）

1. 打开 <https://turso.tech>，用 GitHub 账号登录（免费版够用）。
2. 控制台里 **Create Database**：
   - 名字随意，例如 `wordpaper`；
   - 区域选**离你最近**的，国内用户建议 `Hong Kong (hkg)` 或 `Singapore (sin)`。
3. 建好后点进数据库，记下两样东西：
   - **URL**：形如 `libsql://wordpaper-你的名字.turso.io`
   - **Token**：点 *Create Token* 生成一个（**只显示一次**，先复制好）

> 这两样就是环境变量 `TURSO_DATABASE_URL` 和 `TURSO_AUTH_TOKEN`。
> 它们**只配在 Vercel 上**，不会进代码、不会进 Git。

---

## 2. 部署到 Vercel

### 方式 A：命令行（最快）

```bash
npm i -g vercel
vercel login          # 会打开浏览器让你登录
vercel                # 首次会问几个问题，一路回车（框架会自动识别成 Vite）
vercel --prod         # 正式发布，结束后会给你一个 https://xxx.vercel.app 地址
```

### 方式 B：推到 GitHub 自动部署（长期推荐）

1. 把代码推到 GitHub / GitLab；
2. Vercel 控制台 **Add New → Project → Import** 选这个仓库；
3. Vercel 自动识别 Vite，点 Deploy；
4. 之后每次 `git push`，Vercel 自动重新部署。

> 仓库里**不含任何密钥**：`.env.local` 已被 `.gitignore` 忽略，Turso 的地址与令牌只存在 Vercel 的环境变量里。

---

## 3. 填环境变量（**必做，否则同步接口会 500**）

Vercel 项目 → **Settings → Environment Variables**，加这三条（Production 环境）：

| 名称 | 填什么 | 说明 |
|---|---|---|
| `TURSO_DATABASE_URL` | `libsql://wordpaper-xxx.turso.io` | 第 1 步拿到的 URL |
| `TURSO_AUTH_TOKEN` | 第 1 步生成的 Token | **不要**提交到 Git |
| `ALLOWED_ORIGIN` | `https://你的项目.vercel.app` | 你的真实域名，**不要写 `*`** |
| `AI_ALLOWED_HOSTS` | `api.deepseek.com`（可留空） | AI 代理允许转发的上游域名，填上更安全 |

> 有自定义域名就填自定义域名；想两个都能用就写成一列，逗号分隔：
> `https://wordpaper.vercel.app,https://words.example.com`

**填完必须重新部署一次才会生效**：控制台 Development… → 右侧 **Redeploy**，或再跑一次 `vercel --prod`。

---

## 4. 部署后自查

打开浏览器访问：

| 地址 | 期望结果 |
|---|---|
| `https://你的域名/` | 能进首页（6 个入口都在） |
| `https://你的域名/api/health` | `{"ok":true,"time":...,"db":"connected"}` |

`db` 不是 `connected` 的话：
- `{"ok":false,...,"db":"error"}` → 环境变量填错了，或改完没重新部署；
- 页面 404 → `vercel.json` 里的 `rewrites` 被改坏了（它必须排除 `/api/`）。

---

## 5. 在手机上用起来

1. 手机浏览器打开 `https://你的域名/`；
2. 设置 → F 区「云同步」：
   - 打开开关（会弹一个说明，读完点「知道了」）；
   - 后端地址填 `https://你的域名`（**不要带 `/api`**，代码会自己拼）；
   - 同步码填和电脑上**完全一样**的那个码；
   - 点「测试连接」→ 绿字成功 → 点「立即同步」。
3. 手机浏览器菜单里「添加到主屏幕」，之后就当一个 App 用（阶段 06 已配好 PWA）。

> 第一次同步会把本机词库整个推上去；几千条词会自动分成每批 500 条发送，不用管。

---

## 6. AI 解析怎么填

设置 → B 区：接口地址（`https://api.deepseek.com`）、模型名（`deepseek-chat`）、密钥。

- 密钥**只存这台设备的浏览器**，服务器全程不接触；
- 浏览器直连被跨域拦时，程序会**自动**改走 `https://你的域名/api/ai-proxy` 转发一次；
- 也可以手动勾「走无状态代理」，直接走代理不试直连；
- 那个代理是无状态的：不存密钥、不写库、不写日志、不缓存。

---

## 7. 关于国内访问速度

Vercel 的 `*.vercel.app` 域名在国内有时会被墙或很慢。三种应对：

1. **本项目已经做了「本地优先」**：单词数据主存在浏览器里，打开就能背，
   同步只是后台悄悄进行，Vercel 打不开也**不影响使用**；
2. 换一个能正常访问的**自定义域名**（Vercel 支持绑定自己的域名，自动签 HTTPS）；
3. 把 `vercel.json` 里的 `regions` 改成 `sin1`（新加坡）或 `nrt1`（东京）再试。

---

## 8. 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| `/api/health` 返回 500 | 环境变量没填或没重新部署 |
| 同步接口返回 401 | 前端同步码填错，或没带 `X-Space-Key`（同步码要 ≥8 位且含字母数字） |
| 页面刷新后 404 | `vercel.json` 的 `rewrites` 写错了，注意要排除 `/api/` |
| 同步推送返回 400「单批不得超过 500 条」 | 正常保护；前端已自动分批，出现这个说明请求没走前端代码 |
| AI 一直失败 | 见第 6 节；先点「测试连接」，看是密钥问题还是跨域问题 |
| 换设备看不到数据 | 两端同步码必须**完全一致**（大小写敏感）；同步码不同 = 不同数据空间 |
| 手机上加不到主屏幕 | 必须用 **https** 打开（PWA 的要求），`http://` 不行 |

---

## 9. 备份（**最重要的一条**）

同步码和词库都在浏览器里。**清除浏览器数据 / 换手机 / 忘记同步码 = 数据没了**。

- 设置 → G 区「导出备份」→ 得到一个 json，丢进网盘；
- Chrome / Edge 还可以「连接本地文件夹」，之后每次改动自动写 `wordpaper-data.json`；
- 云端那份在 Turso 里，但你得**记得同步码**才能取回来。

建议：起好同步码之后，立刻在手机备忘录里存一份，并导出一次备份。
