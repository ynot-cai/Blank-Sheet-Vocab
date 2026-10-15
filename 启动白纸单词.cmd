@echo off
chcp 65001 >nul
title 白纸单词 —— 本地启动器
cd /d "%~dp0"

echo ============================================================
echo   白纸单词  blank-sheet-vocab  —— 本地启动器
echo ============================================================
echo.

rem ── 1. 检查 Node ──
where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 找不到 node 命令。
  echo        请先安装 Node.js 20.6 或更高版本：https://nodejs.org/
  echo.
  pause
  exit /b 1
)
for /f "delims=" %%v in ('node -v') do set NODEVER=%%v
echo [1/3] Node.js 已就绪：%NODEVER%

rem ── 2. 依赖 ──
if not exist "node_modules" (
  echo [2/3] 首次运行：正在安装依赖，可能要几分钟...
  call npm install
  if errorlevel 1 (
    echo.
    echo [错误] 依赖安装失败。请检查网络后重试。
    pause
    exit /b 1
  )
) else (
  echo [2/3] 依赖已就绪：node_modules
)

rem ── 3. 本地 API（云同步用；纯本地背单词不需要它，可以直接关掉那个窗口）──
echo [3/3] 启动本地 API（端口 3000）与前端...
start "白纸单词-API" /min "%~dp0启动本地API.cmd"

echo.
echo ------------------------------------------------------------
echo   前端地址：http://127.0.0.1:5173/
echo   浏览器会自动打开；关掉这个窗口即停止程序。
echo ------------------------------------------------------------
echo.

rem --open：等 vite 真正监听成功后再开浏览器，避免「网页打不开」
call npm run dev -- --open

echo.
echo 程序已停止。
pause
