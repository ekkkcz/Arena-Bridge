@echo off
rem 给 Electron 瘦身：删掉用不到的语言包、调试符号、许可文件。
rem 效果：约 370 MB -> 约 300 MB（locales 从 48MB 降到 2MB）
setlocal
cd /d "%~dp0.."
set "DIST=node_modules\electron\dist"

if not exist "%DIST%\electron.exe" (
  echo [错误] 找不到 Electron，请先运行 npm install
  exit /b 1
)

echo 正在瘦身 %DIST% ...

rem 1) 语言包：只保留中文与英文（省约 46 MB）
if exist "%DIST%\locales" (
  for %%F in ("%DIST%\locales\*.pak") do (
    echo %%~nF | findstr /I /C:"zh-CN" /C:"en-US" >nul || del /q "%%F"
  )
  echo   [OK] 语言包已精简
)

rem 2) 许可文件（开发时不需要，省约 19 MB）
del /q "%DIST%\LICENSES.chromium.html" 2>nul
echo   [OK] 许可文件已删除

rem 3) SwiftShader / Vulkan 软件渲染（有独显或集显时可省约 7 MB）
rem    注意：如果机器完全没有 GPU 支持，删了可能无法渲染，故默认保留。
rem del /q "%DIST%\vk_swiftshader.dll" 2>nul
rem del /q "%DIST%\vulkan-1.dll" 2>nul

echo.
echo 瘦身完成。
for /f "tokens=3" %%A in ('dir /s /-c "%DIST%" ^| findstr /C:"个文件"') do echo 当前大小: %%A 字节
endlocal
