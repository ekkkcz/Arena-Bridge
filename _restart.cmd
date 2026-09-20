@echo off
rem Restart Arena Bridge cleanly. Keep this file ASCII-only: cmd.exe reads
rem .cmd using the ANSI codepage, so non-ASCII text becomes garbage.
rem
rem Paths are derived from this script's own location (%~dp0) so the file
rem works on any machine and user account.
setlocal
cd /d "%~dp0"

rem Root without the trailing backslash, for prefix matching.
set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"

rem Stop only the electron processes belonging to this project.
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='electron.exe'\" | Where-Object { $_.ExecutablePath -like '%ROOT%\*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
taskkill /F /IM cloudflared.exe >nul 2>&1
timeout /t 2 /nobreak >nul

set "ELECTRON_RUN_AS_NODE="
start "" /b "node_modules\electron\dist\electron.exe" "desktop\app"
exit /b 0
