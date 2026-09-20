# 干净重启 Arena Bridge：
#   1) 杀掉本项目所有 electron（按可执行文件路径精确匹配）
#   2) 杀掉 cloudflared
#   3) 重新启动一个实例
$ErrorActionPreference = "SilentlyContinue"
$root = "%USERPROFILE%\Desktop\arena-bridge"

Write-Output "--- 停止旧实例 ---"
Get-CimInstance Win32_Process -Filter "Name='electron.exe'" |
  Where-Object { $_.ExecutablePath -like "$root*" } |
  ForEach-Object { Write-Output ("  kill " + $_.ProcessId); Stop-Process -Id $_.ProcessId -Force }
Get-Process cloudflared | ForEach-Object { Write-Output ("  kill cloudflared " + $_.Id); Stop-Process -Id $_.Id -Force }

Start-Sleep -Seconds 3

Write-Output "--- 确认端口释放 ---"
$busy = Get-NetTCPConnection -LocalPort 8788 -State Listen
if ($busy) { Write-Output "  8788 仍被占用，强制释放"; Stop-Process -Id $busy.OwningProcess -Force; Start-Sleep -Seconds 2 }
else { Write-Output "  8788 已释放" }

Write-Output "--- 启动新实例 ---"
$env:ELECTRON_RUN_AS_NODE = $null
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
Set-Location $root
Start-Process -FilePath "$root\node_modules\electron\dist\electron.exe" -ArgumentList "desktop\app" -WorkingDirectory $root
Write-Output "  已启动"
