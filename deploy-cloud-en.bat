@echo off
echo ===========================================
echo    Cloud Deployment Tool
echo ===========================================
echo.

cd /d %~dp0

echo Step 1/5: Checking Git...
where git >nul 2>nul
if %errorlevel% neq 0 (
    echo ERROR: Git not found. Please install Git first.
    pause
    exit /b 1
)
echo OK - Git found

echo.
echo Step 2/5: Opening GitHub to create repository...
echo Please create a new repository named: tou-schedule-editor
echo Do NOT initialize with README
start https://github.com/new
echo.
pause

echo.
echo Step 3/5: Pushing to GitHub...
set /p username="Enter your GitHub username: "
set repo_name=tou-schedule-editor

git remote remove origin 2>nul
git remote add origin https://github.com/%username%/%repo_name%.git
git branch -M main
git push -u origin main

if %errorlevel% neq 0 (
    echo ERROR: Push failed. Please check:
    echo  1. Repository created on GitHub
    echo  2. Username is correct
    echo  3. You have push permission
    pause
    exit /b 1
)

echo.
echo Step 4/5: Opening Railway for backend deployment...
echo.
echo Instructions:
echo  1. Click 'Deploy from GitHub repo'
echo  2. Select repository: %repo_name%
echo  3. Add environment variable: GEMINI_API_KEY
echo  4. Wait for deployment
echo.
start https://railway.app/new
echo.
set /p backend_url="After deployment, enter backend URL (e.g., https://xxx.up.railway.app): "

echo.
echo Step 5/5: Updating frontend config...
echo VITE_BACKEND_BASE_URL=%backend_url%> .env.local
echo OK - Config updated

echo.
echo Building frontend...
call npm run build
if %errorlevel% neq 0 (
    echo ERROR: Build failed
    pause
    exit /b 1
)

echo.
echo Deploying to Cloudflare...
call npx wrangler pages deploy dist --project-name=tou-schedule-editor --branch=main

echo.
echo ===========================================
echo    Deployment Complete!
echo ===========================================
echo.
echo Frontend: https://4c5ac2be.tou-schedule-editor.pages.dev
echo Backend: %backend_url%
echo.
pause
