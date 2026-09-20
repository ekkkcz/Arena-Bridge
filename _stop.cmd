@echo off
taskkill /F /IM cloudflared.exe >nul 2>&1
for /f "tokens=2" %%P in ('tasklist /FI "IMAGENAME eq electron.exe" /FO LIST ^| findstr /C:"PID:"') do (
  for /f "tokens=*" %%C in ('wmic process where "ProcessId=%%P" get CommandLine /value 2^>nul ^| findstr /C:"arena-bridge"') do (
    taskkill /F /PID %%P >nul 2>&1
  )
)
exit /b 0
