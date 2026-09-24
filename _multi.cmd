@echo off
rem ============================================================
rem  Arena Bridge - run another instance with its own profile.
rem
rem  Keep this file ASCII-only: cmd.exe reads .cmd using the ANSI
rem  codepage, and non-ASCII text becomes a parse error on zh-CN.
rem ============================================================
rem
rem  Why profiles: the product model is one client = one project.
rem  A profile gives an instance its OWN everything --
rem     MCP port / config file / log / Electron session (cookies)
rem  -- so two instances never overwrite each other.
rem
rem  Usage:
rem     _multi.cmd                open the first free slot (a, b, c ...)
rem     _multi.cmd work           open the profile named "work"
rem     _multi.cmd -list          show which profiles are in use
rem     _multi.cmd -stop work     stop ONLY the "work" profile
rem
rem  enableextensions is default; enabledelayedexpansion is required for the
rem  !F! expansions in :list (without it, !F! would print literally).
setlocal enabledelayedexpansion

cd /d "%~dp0"

set "ELECTRON=node_modules\electron\dist\electron.exe"
if not exist "%ELECTRON%" (
  echo [multi] Electron not found: %ELECTRON%
  echo [multi] run start-desktop.cmd once to install dependencies first.
  exit /b 1
)

set "A1=%~1"
set "A2=%~2"
if /i "%A1%"=="-list"   goto :list
if /i "%A1%"=="--list"  goto :list
if /i "%A1%"=="/list"   goto :list
if /i "%A1%"=="-stop"   goto :stop
if /i "%A1%"=="--stop"  goto :stop
if /i "%A1%"=="/stop"   goto :stop

rem ---- pick a slot name -------------------------------------------------
if not "%A1%"=="" (
  set "NAME=%A1%"
  goto :launch
)
for %%L in (a b c d e f g h) do (
  if not exist ".arena-bridge\config.%%L.json" (
    set "NAME=%%L"
    goto :launch
  )
)
echo [multi] slots a-h are all in use. Start one by name instead, e.g.:
echo         _multi.cmd work
exit /b 1

:launch
echo [multi] profile "%NAME%" - its own MCP port, config and Arena session.
echo [multi] next: in that window pick the project directory for THIS client.
rem Start-Process detaches the child properly. Plain "start /b" keeps the new
rem process attached to this console, so it can die when this window closes.
set "PROF=%NAME%"
set "ELECTRON_RUN_AS_NODE="
powershell -NoProfile -Command "Start-Process -FilePath '%CD%\%ELECTRON%' -ArgumentList 'desktop\app','--profile','%PROF%' -WorkingDirectory '%CD%'"
if errorlevel 1 (
  echo [multi] failed to start. Try running start-desktop.cmd once first.
  exit /b 1
)
exit /b 0

rem ---- stop one profile only -------------------------------------------
rem NOTE: _stop.cmd is a global stop (it kills every profile, including the
rem default one). This targets a single profile so the others keep running.
rem The matching logic lives in a .ps1: it needs regex with backslashes, and
rem cmd.exe mangles those when passed inline (that broke the first version).
:stop
if "%A2%"=="" (
  echo [multi] which profile? for example:  _multi.cmd -stop work
  exit /b 1
)
echo [multi] stopping profile "%A2%" only...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0_multi-stop.ps1" -ProfileName "%A2%"
exit /b %errorlevel%

rem ---- list -------------------------------------------------------------
:list
echo [multi] profiles in use (a config file exists for them):
set "FOUND="
for %%F in (".arena-bridge\config.*.json") do (
  set "F=%%~nxF"
  set "F=!F:config.=!"
  set "F=!F:.json=!"
  echo       !F!
  set "FOUND=1"
)
if not defined FOUND echo       (none yet - run _multi.cmd)
echo.
echo [multi] the default instance uses config.json and port 8788.
exit /b 0
