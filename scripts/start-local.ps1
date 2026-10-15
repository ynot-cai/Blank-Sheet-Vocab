# 白纸单词 —— 本地启动器（真正的逻辑都在这里）
#
# ⚠️ 本文件必须保存为 **UTF-8 带 BOM**。
#    PowerShell 5.1 读 .ps1 时：有 BOM → 按 UTF-8 解码（中文正常）；
#    没有 BOM → 按系统 ANSI 代码页解码（中文变乱码，还会引发语法错误）。
#    这与「源码文件一律 UTF-8 无 BOM」的规则**不冲突**：那条规则管的是
#    src/ 与 api/ 下的 .ts 文件（`npm run test:build` 有护栏），
#    而被 cmd / PowerShell 直接执行的脚本是明确的例外。
#
# 为什么入口是 .cmd 而不是直接双击 .ps1：
#   双击 .ps1 走的是「用记事本打开」或受执行策略拦截，体验不可控；
#   由 .cmd 用 -ExecutionPolicy Bypass 调起来最稳。
#
# 用法：双击 启动白纸单词.cmd（桌面快捷方式指向它）

$ErrorActionPreference = 'Continue'
Set-Location (Split-Path -Parent $PSScriptRoot)   # scripts 的上一级 = 项目根

function Write-Head($text) { Write-Host $text -ForegroundColor Cyan }
function Write-Ok($text) { Write-Host "  $text" -ForegroundColor Green }
function Write-Bad($text) { Write-Host "  $text" -ForegroundColor Red }
function Write-Warn2($text) { Write-Host "  $text" -ForegroundColor Yellow }

Write-Host ''
Write-Head '============================================================'
Write-Head '  白纸单词  blank-sheet-vocab  —— 本地启动器'
Write-Head '============================================================'
Write-Host ''

# ── 1. 检查 Node ──
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Bad '[错误] 找不到 node 命令。'
  Write-Host '        请先安装 Node.js 20.6 或更高版本：https://nodejs.org/'
  Write-Host ''
  exit 1
}
Write-Ok "[1/3] Node.js 已就绪：$(node -v)"

# ── 2. 依赖 ──
if (-not (Test-Path 'node_modules')) {
  Write-Host '  [2/3] 首次运行：正在安装依赖，可能要几分钟...' -ForegroundColor Yellow
  & npm install
  if ($LASTEXITCODE -ne 0) {
    Write-Bad '[错误] 依赖安装失败。请检查网络后重试。'
    Write-Host ''
    exit 1
  }
} else {
  Write-Ok '[2/3] 依赖已就绪：node_modules'
}

# ── 3. 本地 API（云同步用；纯本地背单词不需要）──
Write-Host '  [3/3] 启动本地 API（端口 3000）与前端...'
try {
  Start-Process -FilePath (Join-Path $PWD '启动本地API.cmd') -WindowStyle Minimized | Out-Null
  Write-Ok '本地 API 已在独立窗口启动（最小化；不需要可以关掉它）'
} catch {
  Write-Warn2 "本地 API 没起来（$($_.Exception.Message)）—— 不影响本地背单词，只是云同步用不了"
}

Write-Host ''
Write-Host '------------------------------------------------------------'
Write-Host '  前端地址：http://127.0.0.1:5173/'
Write-Host '  浏览器会自动打开；关掉这个窗口即停止程序。'
Write-Host '------------------------------------------------------------'
Write-Host ''

# --open：等 vite 真正监听成功后再开浏览器，避免「网页打不开」
# BSV_NO_OPEN=1 时不自动开浏览器（自检用，正常双击不会设这个变量）
$viteArgs = @('run', 'dev')
if ($env:BSV_NO_OPEN -ne '1') { $viteArgs += @('--', '--open') }
& npm @viteArgs

Write-Host ''
Write-Host '程序已停止。'
