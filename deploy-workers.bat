@echo off
echo ===========================================
echo   Cloudflare Workers Python Deployment
echo ===========================================
echo.

cd /d "%~dp0\workers-backend"

:: 检查 uv
where uv >nul 2>nul
if %errorlevel% neq 0 (
    echo Installing uv...
    powershell -Command "irm https://astral.sh/uv/install.ps1 | iex"
    set PATH=%PATH%;%USERPROFILE%\.local\bin
)

echo.
echo [1/4] Installing dependencies...
call uv sync
if %errorlevel% neq 0 (
    echo ERROR: Failed to install dependencies
    pause
    exit /b 1
)

echo.
echo [2/4] Checking Cloudflare login...
npx wrangler whoami >nul 2>nul
if %errorlevel% neq 0 (
    echo Please login to Cloudflare...
    npx wrangler login
)

echo.
echo [3/4] Deploying to Cloudflare Workers...
call uv run pywrangler deploy
if %errorlevel% neq 0 (
    echo ERROR: Deployment failed
    pause
    exit /b 1
)

echo.
echo [4/4] Deployment completed!
echo.
echo Next steps:
echo  1. Check the URL displayed above
echo  2. Visit Cloudflare Dashboard: https://dash.cloudflare.com
echo  3. Set GEMINI_API_KEY if needed: npx wrangler secret put GEMINI_API_KEY
echo.
pause
