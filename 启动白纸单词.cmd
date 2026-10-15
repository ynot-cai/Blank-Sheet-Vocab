@echo off
rem ===========================================================================
rem  White Sheet Vocab - local launcher.
rem
rem  THIS FILE MUST STAY PURE ASCII.
rem  Do not put any Chinese in it - not even inside rem comments.
rem
rem  Why: cmd.exe reads .cmd files byte-by-byte using the SYSTEM ANSI CODEPAGE
rem  (936 / GBK on a Chinese Windows), NOT UTF-8. A UTF-8 Chinese character can
rem  end with a lead byte that swallows the following CR, merging two lines into
rem  one. That breaks if(...) blocks and the script aborts at once - the window
rem  flashes and disappears. (Hit for real on 2026-10-15.)
rem  `chcp 65001` only changes OUTPUT encoding; it cannot change how cmd reads
rem  the file itself, so it does not help.
rem
rem  All Chinese messages live in scripts\start-local.ps1, which is saved as
rem  UTF-8 WITH BOM so PowerShell 5.1 decodes it correctly.
rem ===========================================================================

cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-local.ps1"
set RC=%ERRORLEVEL%

echo.
if not "%RC%"=="0" echo [launcher] launcher exited with code %RC%
echo [launcher] You can close this window now.
pause
