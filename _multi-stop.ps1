# Stop ONE Arena Bridge profile, leaving every other instance running.
#
# NOTE: keep this file ASCII-only. Windows PowerShell 5.1 reads .ps1 using the
# ANSI codepage (gb2312 on zh-CN), so UTF-8 non-ASCII text becomes a parse error.
#
# Why a separate file instead of an inline -Command: the matching needs regex
# with backslashes, and those get mangled by cmd.exe before PowerShell ever
# sees them (that broke the first version of this).
#
# The parameter is deliberately NOT named $Profile: that is a PowerShell
# automatic variable, and shadowing it is asking for trouble.
param([Parameter(Mandatory=$true)][string]$ProfileName)

$ErrorActionPreference = "SilentlyContinue"
$p = $ProfileName.ToLower()

if ($p -notmatch '^[a-z0-9_-]{1,20}$') {
  Write-Output ("[multi] invalid profile name: " + $ProfileName)
  exit 2
}

# An instance belongs to this profile if either
#   - its command line carries --profile <name>, or
#   - it uses the user-data-dir ending in arena-bridge-desktop.<name>
#
# Both patterns must anchor the END of the name, otherwise stopping "a" would
# also hit an instance running profile "ab" (same prefix).
#   user-data-dir: ...arena-bridge-desktop.a" or ...desktop.a (end of string)
#   --profile:     --profile a  /  --profile "a"  /  --profile "a" (end)
$esc = [regex]::Escape($p)
$profRe = '--profile\s+"?' + $esc + '"?\s*$'
$userRe = 'arena-bridge-desktop\.' + $esc + '(\\|"|\s|$)'

$all = @(Get-CimInstance Win32_Process -Filter "Name='electron.exe'")
$mine = @($all | Where-Object {
  $c = [string]$_.CommandLine
  ($c -match $profRe) -or ($c -match $userRe)
})

if ($mine.Count -eq 0) {
  Write-Output ("[multi] profile '" + $p + "' is not running.")
  exit 0
}

$ids = @($mine | Select-Object -ExpandProperty ProcessId)

# Only cloudflared whose parent is one of ours - the other instances' tunnels
# must keep running.
$cf = @(Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" |
        Where-Object { $ids -contains $_.ParentProcessId })
foreach ($c in $cf) { Stop-Process -Id $c.ProcessId -Force }

foreach ($id in $ids) { Stop-Process -Id $id -Force }

# Confirm, so a silent failure cannot masquerade as success.
Start-Sleep -Milliseconds 800
$left = @($ids | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })
if ($left.Count -gt 0) {
  Write-Output ("[multi] WARNING: " + $left.Count + " process(es) survived: " + ($left -join ', '))
  exit 1
}
Write-Output ("[multi] stopped profile '" + $p + "' (" + $ids.Count + " process(es), " + $cf.Count + " tunnel(s)).")
exit 0
