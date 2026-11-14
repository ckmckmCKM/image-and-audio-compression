@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul

rem Run the most recently built portable EXE from this project's dist folder.
for /f "delims=" %%F in ('dir /b /a-d /o-d "%~dp0dist\MediaCompressor_*.exe" 2^>nul') do (
  start "" /d "%~dp0dist" "%~dp0dist\%%F"
  exit /b
)

echo 未找到已生成的桌面版 EXE。
echo 请先双击项目目录中的“生成桌面版.cmd”，打包完成后再运行本脚本。
pause
exit /b 1
