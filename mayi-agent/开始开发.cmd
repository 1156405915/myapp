@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist node_modules (
  echo 正在安装依赖，请稍候...
  call npm install
  if errorlevel 1 goto :error
)
call npm run dev
exit /b 0
:error
echo.
echo 安装失败，请检查 Node.js 版本和网络连接。
pause
exit /b 1
