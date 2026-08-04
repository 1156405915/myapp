@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist node_modules (
  echo 正在安装依赖，请稍候...
  call npm install
  if errorlevel 1 goto :error
)
call npm run package:win
if errorlevel 1 goto :error
echo.
echo 打包完成，安装包位于 release 目录。
pause
exit /b 0
:error
echo.
echo 打包失败，请查看上方错误信息。
pause
exit /b 1
