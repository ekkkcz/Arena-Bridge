@echo off
rem ============================================================
rem  Arena Bridge - desktop app (built-in browser + MCP)
rem  NOTE: intentionally pure ASCII. cmd.exe reads .cmd as GBK on
rem        zh-CN Windows, so UTF-8 Chinese here becomes garbage.
rem ============================================================
setlocal
cd /d "%~dp0"
set "ELECTRON_RUN_AS_NODE="

if not exist "node_modules\electron\dist\electron.exe" (
  echo [1/2] First run - installing Electron runtime, please wait...
  call npm install
  if errorlevel 1 (
    echo [ERROR] npm install failed.
    pause
    exit /b 1
  )
)

echo [2/2] Starting Arena Bridge...
start "" "node_modules\electron\dist\electron.exe" "desktop\app" %*
exit /b 0
