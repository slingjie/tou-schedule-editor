@echo off
chcp 65001 >nul
echo.
echo ===========================================
echo    TOU Schedule Editor - 云端部署工具
echo ===========================================
echo.

:: 检查 Git
where git >nul 2>nul
if %errorlevel% neq 0 (
    echo [错误] Git 未安装，请先安装 Git
    pause
    exit /b 1
)

echo [1/5] 配置 GitHub 仓库...
echo.
echo 请选择在浏览器中创建仓库:
start https://github.com/new
echo.
echo 仓库名称建议: tou-schedule-editor
echo 不要勾选 "Add a README file"
echo.
pause

set /p username="请输入你的 GitHub 用户名: "
set repo_name=tou-schedule-editor

echo.
echo [2/5] 配置远程仓库...
git remote add origin https://github.com/%username%/%repo_name%.git 2>nul
git remote set-url origin https://github.com/%username%/%repo_name%.git 2>nul
git branch -M main

echo.
echo [3/5] 推送到 GitHub...
git push -u origin main
if %errorlevel% neq 0 (
    echo [错误] 推送失败，请检查:
    echo  1. 仓库是否已创建
    echo  2. GitHub 用户名是否正确
    pause
    exit /b 1
)

echo.
echo [4/5] 打开 Railway 部署页面...
echo.
echo 请在 Railway 中完成以下操作:
echo  1. 选择 'Deploy from GitHub repo'
echo  2. 选择仓库: %repo_name%
echo  3. 添加环境变量: GEMINI_API_KEY
echo  4. 等待部署完成
echo.
start https://railway.app/new
echo.
set /p backend_url="部署完成后，请输入后端 URL (如: https://xxx.up.railway.app): "

echo.
echo [5/5] 更新前端配置并重新部署...
echo VITE_BACKEND_BASE_URL=%backend_url%> .env.local
echo.

echo 正在构建前端...
call npm run build

echo.
echo 正在部署到 Cloudflare...
call npx wrangler pages deploy dist --project-name=tou-schedule-editor --branch=main

echo.
echo ===========================================
echo    部署完成！
echo ===========================================
echo.
echo 前端地址: https://4c5ac2be.tou-schedule-editor.pages.dev
echo 后端地址: %backend_url%
echo.
pause
