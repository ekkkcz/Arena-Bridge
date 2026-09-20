@echo off
rem 停掉本项目全部 electron（按可执行文件路径匹配，最可靠）
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='electron.exe'\" | Where-Object { $_.ExecutablePath -like '%USERPROFILE%\Desktop\arena-bridge\*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
taskkill /F /IM cloudflared.exe >nul 2>&1
timeout /t 2 /nobreak >nul
set "ELECTRON_RUN_AS_NODE="
cd /d "%USERPROFILE%\Desktop\arena-bridge"
start "" /b "node_modules\electron\dist\electron.exe" "desktop\app"
exit /b 0
