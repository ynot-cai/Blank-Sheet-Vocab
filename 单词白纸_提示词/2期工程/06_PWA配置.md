# 阶段 06：PWA（添加到主屏幕 + 离线可用）

> 前置：阶段 05 移动端适配已完成。
> 目标：手机上"添加到主屏幕"后像个 App，且**断网能打开**（只读本地缓存）。

## 任务

### 1. 图标生成

需要一套 PNG 图标（放在 `public/icons/`）：
- `192x192.png`（Android）
- `512x512.png`（Android / 启动画面）
- `180x180.png`（iOS `apple-touch-icon`）
- `favicon.ico` / `favicon.png`

生成方式（二选一，注释说明）：
- 用工具 `pwa-asset-generator` 从一张源图生成
- 或者用纯色背景 + 文字"词"生成简单图标（写个脚本用 sharp 或 canvas 生成）

**注意**：图标必须是真 PNG 文件，不能是 SVG 占位（iOS 不支持 SVG 的 apple-touch-icon）。

### 2. `public/manifest.webmanifest`

```json
{
  "name": "单词白纸",
  "short_name": "单词白纸",
  "description": "白纸空间记忆，离线可用的背单词工具",
  "start_url": "/",
  "display": "standalone",
  "background_color": "#ffffff",
  "theme_color": "#ffffff",
  "orientation": "portrait",
  "icons": [...]
}
```

- `display: standalone`（隐藏浏览器地址栏，像 App）
- `orientation: portrait`（背单词主要竖屏）
- 主题色跟应用风格一致（白纸 → 白色/浅色）

### 3. `index.html` 补充 meta

```html
<link rel="manifest" href="/manifest.webmanifest">
<meta name="theme-color" content="#ffffff">
<!-- iOS 专属 -->
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="apple-mobile-web-app-title" content="单词白纸">
<link rel="apple-touch-icon" href="/icons/180x180.png">
```

### 4. Service Worker（`src/sw.ts` 或用 Vite 插件）

**推荐用 `vite-plugin-pwa`**（最省事，自动处理注册和更新）；若不想加依赖，手写 `public/sw.js` 也可以（注释说明两种方式的取舍）。

缓存策略：
- **静态资源**（HTML/JS/CSS/图标）：**Cache First**（优先缓存，后台更新）
  - 构建产物带 hash，用 hash 做缓存键，更新时自动失效
- **`index.html`**：**Network First**（优先网络，失败回落缓存），保证能拿到新版本
- **API 请求**（`/api/*`）：**不缓存**（Network Only），因为数据要实时同步
- **AI 请求**：绝对不缓存

**离线能力**：
- 断网时：应用能打开（从缓存加载静态资源）
- 断网时：能读本地 IndexedDB 的词库，**能背单词、能看列表**（只读）
- 断网时：同步功能提示失败（已有逻辑），但不影响使用
- 联网后：自动同步

### 5. 更新提示

Service Worker 检测到新版本时：
- 显示一条提示条："有新版本可用，点击刷新"
- 用户点击后：`skipWaiting` + `location.reload()`
- **不要自动刷新**（会打断用户背单词）

### 6. 添加到主屏幕引导（可选但推荐）

- 首次在手机浏览器打开时，显示一次性引导：
  - Android：提示"点击浏览器菜单 → 添加到主屏幕"
  - iOS：提示"点击分享按钮 → 添加到主屏幕"
- 用 `localStorage` 记标记，只提示一次
- 检测到已经以 standalone 模式打开（`window.matchMedia('(display-mode: standalone)')`）时不再提示

### 7. 启动画面（可选）

Android 会自动用 manifest 的 `background_color` + 图标生成启动画面，无需额外配置。iOS 需要 `<link rel="apple-touch-startup-image">`，可跳过（注释说明）。

## 验收标准

1. `npm run build` 通过，构建产物里能找到 `manifest.webmanifest` 和 `sw.js`
2. **Chrome DevTools → Application → Manifest**：无错误，图标能加载
3. **Service Worker 面板**：显示已激活（activated）
4. **离线测试（最重要）**：
   - DevTools → Network → 勾选 Offline
   - 刷新页面 → **应用能打开**（不是浏览器错误页）
   - 能进入背诵页、能看单词列表（读本地数据）
   - 顶部提示"云同步失败"（预期行为）
   - 取消 Offline → 自动恢复同步
5. **真机测试**：
   - Android Chrome：能"添加到主屏幕"，桌面出现图标，点开是 standalone（无地址栏）
   - iPhone Safari：能"添加到主屏幕"，图标正确，点开全屏
6. 更新提示：改一行代码重新构建部署 → 打开旧版本页面 → 出现"有新版本"提示条，点击后刷新成新版

## 完成后

一句话汇报：生成了哪些文件、离线测试结果、**真机添加到主屏幕是否成功**。等我发阶段 07。
