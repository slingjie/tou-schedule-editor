@echo off
REM ==================================================================
REM  install.bat — 一键安装依赖脚本
REM  首次使用时双击运行一次即可，之后不需要再运行
REM ==================================================================

setlocal enabledelayedexpansion
chcp 65001 >nul

pushd "%~dp0" >nul 2>&1

echo.
echo ==========================================
echo   一键安装依赖
echo ==========================================
echo.

REM ---- 检查 Python ----
echo [1/5] 检查 Python 是否已安装...
where python >nul 2>&1
if %errorlevel% neq 0 (
    echo.
    echo ❌ 未检测到 Python！
    echo.
    echo    请先安装 Python：
    echo    1. 打开浏览器访问 https://www.python.org/downloads/
    echo    2. 下载并安装（安装时务必勾选 "Add Python to PATH"）
    echo    3. 安装完成后重新运行本脚本
    echo.
    pause
    exit /b 1
)
for /f "tokens=*" %%v in ('python --version 2^>^&1') do echo   ✅ 已安装 %%v

REM ---- 检查 Node.js ----
echo.
echo [2/5] 检查 Node.js 是否已安装...
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo.
    echo ❌ 未检测到 Node.js！
    echo.
    echo    请先安装 Node.js：
    echo    1. 打开浏览器访问 https://nodejs.org/
    echo    2. 点击绿色的 LTS 按钮下载安装
    echo    3. 安装完成后重新运行本脚本
    echo.
    pause
    exit /b 1
)
for /f "tokens=*" %%v in ('node --version 2^>^&1') do echo   ✅ 已安装 Node.js %%v

REM ---- 创建 Python 虚拟环境 ----
echo.
echo [3/5] 创建 Python 虚拟环境...
if exist ".venv\Scripts\python.exe" (
    echo   ✅ 虚拟环境已存在，跳过
) else (
    python -m venv .venv
    if %errorlevel% neq 0 (
        echo   ❌ 创建虚拟环境失败，请检查 Python 是否正确安装
        pause
        exit /b 1
    )
    echo   ✅ 虚拟环境创建成功
)

REM ---- 安装后端依赖 ----
echo.
echo [4/5] 安装后端依赖（可能需要 1-2 分钟，请耐心等待）...
call .venv\Scripts\activate.bat
pip install -r backend\requirements-desktop.txt -i https://pypi.tuna.tsinghua.edu.cn/simple --quiet
if %errorlevel% neq 0 (
    echo   ⚠️ 使用国内镜像失败，尝试默认源...
    pip install -r backend\requirements-desktop.txt --quiet
)
if %errorlevel% neq 0 (
    echo   ❌ 后端依赖安装失败，请检查网络连接
    pause
    exit /b 1
)
echo   ✅ 后端依赖安装完成

REM ---- 安装前端依赖 ----
echo.
echo [5/5] 安装前端依赖（可能需要 2-3 分钟，请耐心等待）...
call npm install --registry=https://registry.npmmirror.com --loglevel=error
if %errorlevel% neq 0 (
    echo   ⚠️ 使用国内镜像失败，尝试默认源...
    call npm install --loglevel=error
)
if %errorlevel% neq 0 (
    echo   ❌ 前端依赖安装失败，请检查网络连接
    pause
    exit /b 1
)
echo   ✅ 前端依赖安装完成

REM ---- 生成环境变量文件 ----
if not exist ".env.local" (
    if exist ".env.local.example" (
        copy /y ".env.local.example" ".env.local" >nul
        echo.
        echo   ✅ 已生成环境变量文件 .env.local
    )
)

echo.
echo ==========================================
echo   ✅ 全部安装完成！
echo ==========================================
echo.
echo   现在可以关闭此窗口，
echo   然后双击 start-services.bat 启动应用。
echo.
echo ==========================================
echo.

popd >nul 2>&1
pause
