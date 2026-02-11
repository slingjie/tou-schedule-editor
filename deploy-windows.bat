:: Windows CMD 批处理脚本
:: 双击运行 deploy-windows.bat

@echo off
chcp 65001 >nul
echo.
echo 🚀 TOU Schedule Editor 部署脚本
echo =================================
echo.

:: 检查 Python
python --version >nul 2>&1
if errorlevel 1 (
    echo ❌ Python 未安装，请先安装 Python 3.11
    pause
    exit /b 1
)
echo ✅ Python 已安装

:: 检查 Node.js
node --version >nul 2>&1
if errorlevel 1 (
    echo ❌ Node.js 未安装，请先安装 Node.js
    pause
    exit /b 1
)
echo ✅ Node.js 已安装

echo.
echo 📦 正在构建前端...
call npm run build

if errorlevel 1 (
    echo ❌ 前端构建失败
    pause
    exit /b 1
)

echo.
echo ☁️  正在部署到 Cloudflare...
call npx wrangler pages deploy dist --project-name=tou-schedule-editor --branch=main

echo.
echo ✅ 部署完成！
echo.
echo 🔗 访问地址:
echo    前端: https://4c5ac2be.tou-schedule-editor.pages.dev
echo.
echo 📖 启动本地后端:
echo    1. 打开新终端
echo    2. 运行: .\start-backend.sh
echo    3. 访问: http://localhost:8000
echo.
pause
