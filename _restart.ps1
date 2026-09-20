# Clean restart for Arena Bridge.
# Keep this file ASCII-only: Windows PowerShell 5.1 reads .ps1 using the ANSI
# codepage (gb2312 on zh-CN), so UTF-8 non-ASCII comments would be decoded
# into a parse error.
#
# Paths derive from this script's own location, so it works on any machine
# and user account.
$ErrorActionPreference = "SilentlyContinue"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Output "--- stop old instance ---"
Get-CimInstance Win32_Process -Filter "Name='electron.exe'" |
  Where-Object { $_.ExecutablePath -like "$root*" } |
  ForEach-Object { Write-Output ("  kill " + $_.ProcessId); Stop-Process -Id $_.ProcessId -Force }
Get-Process cloudflared -ErrorAction SilentlyContinue | ForEach-Object { Write-Output ("  kill cloudflared " + $_.Id); Stop-Process -Id $_.Id -Force }

Start-Sleep -Seconds 3

Write-Output "--- confirm port released ---"
$busy = Get-NetTCPConnection -LocalPort 8788 -State Listen -ErrorAction SilentlyContinue
if ($busy) { Write-Output "  8788 still busy, forcing"; Stop-Process -Id $busy.OwningProcess -Force; Start-Sleep -Seconds 2 }
else { Write-Output "  8788 free" }

Write-Output "--- start new instance ---"
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
Set-Location $root
Start-Process -FilePath "$root\node_modules\electron\dist\electron.exe" -ArgumentList "desktop\app" -WorkingDirectory $root
Write-Output "  started"
