@echo off
rem ===========================================================================
rem  White Sheet Vocab - local API server (port 3000).
rem
rem  THIS FILE MUST STAY PURE ASCII - see the main launcher .cmd for the full reason.
rem  Cloud sync only; local study works fine without it.
rem ===========================================================================

cd /d "%~dp0"

echo ============================================================
echo   White Sheet Vocab - local API (port 3000)
echo   Cloud sync only. Local study works without it.
echo ============================================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [error] node not found. Install Node.js 20.6+ first.
  echo.
  pause
  exit /b 1
)

call npm run api
set RC=%ERRORLEVEL%

echo.
echo [api] stopped. exit code = %RC%
pause
