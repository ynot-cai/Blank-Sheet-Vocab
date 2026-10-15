@echo off
chcp 65001 >nul
title 白纸单词 —— 本地 API（可关闭）
cd /d "%~dp0"

echo ============================================================
echo   白纸单词 本地 API（云同步用，端口 3000）
echo   —— 纯本地背单词不需要它；关掉这个窗口不影响本地功能。
echo ============================================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 找不到 node 命令，请先安装 Node.js。
  pause
  exit /b 1
)

call npm run api

echo.
echo 本地 API 已停止。
pause
