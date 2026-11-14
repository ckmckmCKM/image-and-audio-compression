@echo off
chcp 65001 >nul
cd /d "%~dp0"
"%~dp0runtime\node.exe" "%~dp0tools\build-desktop.cjs"
if errorlevel 1 (
  echo 打包失败，请查看上面的错误信息。
  pause
  exit /b 1
)
echo 免安装版已生成到 dist 文件夹，文件名为 MediaCompressor_版本号.exe。
pause
