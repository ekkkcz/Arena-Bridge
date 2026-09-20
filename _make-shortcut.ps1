# 创建桌面 + 开始菜单快捷方式，指向原生 exe
$ErrorActionPreference = "Stop"
$root = "%USERPROFILE%\Desktop\arena-bridge"
$exe  = Join-Path $root "desktop\launcher\Arena Bridge.exe"
$ico  = Join-Path $root "app.ico"

$targets = @(
  (Join-Path ([Environment]::GetFolderPath("Desktop")) "Arena Bridge.lnk"),
  (Join-Path ([Environment]::GetFolderPath("StartMenu")) "Programs\Arena Bridge.lnk")
)

$sh = New-Object -ComObject WScript.Shell
foreach ($lnk in $targets) {
  $dir = Split-Path $lnk -Parent
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  $s = $sh.CreateShortcut($lnk)
  $s.TargetPath = $exe
  $s.WorkingDirectory = $root
  $s.Description = "Arena Bridge"
  if (Test-Path $ico) { $s.IconLocation = $ico }
  $s.Save()
  Write-Output ("created: " + $lnk)
}
