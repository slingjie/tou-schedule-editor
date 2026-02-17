@echo off
REM 快速启动脚本 - Windows Batch 版本
REM 用法: 在项目根目录运行此脚本

setlocal enabledelayedexpansion

REM 强制使用 UTF-8 控制台编码以避免中文乱码（对新打开的 cmd 窗口也会生效）
chcp 65001 >nul
set PYTHONUTF8=1
set PYTHONIOENCODING=utf-8
set LANG=zh_CN.UTF-8

REM 若通过 Explorer 双击运行，通常等同于 cmd /c 执行；为了避免窗口瞬间关闭导致看不到报错，
REM 这里自动在一个保持打开的窗口里重新运行自身（不会影响你在已打开的 cmd 里手动执行）。
if /i "%~1" neq "__keep" (
    echo %cmdcmdline% | find /i "/c" >nul
    if %errorlevel% equ 0 (
        REM 让新的 cmd 实例在同一个窗口中保持打开（比 start 更不容易“闪退看不到输出”）
        cmd /k ""%~f0" __keep"
        exit /b 0
    )
)

REM 关键修复：无论从哪里启动，都切换到脚本所在目录，避免相对路径导致“找不到 .venv/.env.local”而提前退出
pushd "%~dp0" >nul 2>&1
if %errorlevel% neq 0 (
    echo 错误: 无法切换到脚本目录: "%~dp0"
    pause
    exit /b 1
)

REM 运行日志（用于排查“双击闪退/看不到输出”）
set "LOG_DIR=%~dp0logs"
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%" >nul 2>&1
set "LOG_FILE=%LOG_DIR%\start-services.latest.log"
> "%LOG_FILE%" echo ==========================================
>>"%LOG_FILE%" echo [%date% %time%] start-services.bat 启动
>>"%LOG_FILE%" echo 脚本路径: %~f0
>>"%LOG_FILE%" echo 当前目录: %cd%
>>"%LOG_FILE%" echo CMD 命令行: %cmdcmdline%
>>"%LOG_FILE%" echo ==========================================

echo.
echo ==========================================
echo   项目服务 - 前后端一键启动
echo ==========================================
echo.

REM 说明：此脚本会打开两个新窗口分别运行后端与前端。
REM       若你是通过双击运行，本窗口可能只用于打印提示信息。

REM 检查虚拟环境
if not exist ".venv\Scripts\activate.bat" (
    echo 错误: 虚拟环境不存在
    echo 请先运行: python -m venv .venv
    echo [%date% %time%] 错误: 未找到 .venv\Scripts\activate.bat>>"%LOG_FILE%"
    pause
    exit /b 1
)

REM 激活虚拟环境
call .venv\Scripts\activate.bat
set "PY_EXE=%~dp0.venv\Scripts\python.exe"
if not exist "%PY_EXE%" (
    echo 错误: 未找到虚拟环境 Python: %PY_EXE%
    pause
    exit /b 1
)

REM 检查 npm（前端启动依赖）
where npm >nul 2>&1
if %errorlevel% neq 0 (
    echo 错误: 未找到 npm，请先安装 Node.js（包含 npm）并确保已加入 PATH
    echo [%date% %time%] 错误: npm 不存在（where npm 失败）>>"%LOG_FILE%"
    pause
    exit /b 1
)

echo.
echo 启动后端服务...
echo 后端默认端口: 8000（若占用将自动调整）
echo.

REM 检查端口（默认 8000；若被占用则优先复用已在运行的后端，否则自动换端口）
set "SKIP_BACKEND_START="
set "PORT=8000"
set "TRY=0"
:CHECK_PORT
set /a TRY+=1
set "PID="
for /f "tokens=5" %%a in ('netstat -ano ^| findstr /R /C:":%PORT% .*LISTENING"') do (
    set "PID=%%a"
)
if defined PID (
    REM 若该端口已经有可用后端（/health OK），则直接复用，避免端口漂移导致前端代理连不上
    where curl >nul 2>&1
    if !errorlevel! equ 0 (
        curl -s http://localhost:%PORT%/health >nul 2>&1
        if !errorlevel! equ 0 (
            set "SKIP_BACKEND_START=1"
            echo 端口 %PORT% 已有后端在运行（PID=!PID!），将直接复用。
            echo [%date% %time%] 复用已运行后端: PORT=%PORT% PID=!PID!>>"%LOG_FILE%"
            goto PORT_SELECTED
        )
    )

    echo 端口 %PORT% 已被占用（PID=!PID!），自动尝试下一个端口...
    echo [%date% %time%] 端口占用: PORT=%PORT% PID=!PID!（自动换端口）>>"%LOG_FILE%"
    if %TRY% GEQ 20 (
        echo 错误: 无法找到可用端口（从 8000 起尝试了 20 个）
        echo [%date% %time%] 错误: 端口扫描失败（8000 起 20 个均占用）>>"%LOG_FILE%"
        pause
        exit /b 1
    )
    set /a PORT+=1
    goto CHECK_PORT
)

:PORT_SELECTED

REM 确保 .env.local 存在，并同步后端端口（避免前端仍指向旧端口导致“启动了但用不了”）
call :ENSURE_ENV_LOCAL %PORT%
echo.
echo 后端 URL: http://localhost:%PORT%
echo.

if defined SKIP_BACKEND_START (
    echo 后端已在端口 %PORT% 运行，跳过启动。
    echo [%date% %time%] 跳过启动后端（复用已运行实例）: PORT=%PORT%>>"%LOG_FILE%"
) else (
    REM 启动后端（关键：直接执行 venv 的 python.exe，避免误把 python.exe 当脚本文件解析）
    echo [%date% %time%] 启动后端窗口: PORT=%PORT%>>"%LOG_FILE%"
    set "BACKEND_LOG=backend.log"
    set "BACKEND_ERR=backend.error.log"

    REM 兼容：若日志文件被旧后端进程占用（例如你开了多个后端），会导致重定向失败。
    REM 这种情况下自动降级为 logs\backend.<port>.log，保证“能启动优先”。
    type nul > "%BACKEND_LOG%" 2>nul
    if !errorlevel! neq 0 (
        set "BACKEND_LOG=logs\backend.%PORT%.log"
    )
    type nul > "%BACKEND_ERR%" 2>nul
    if !errorlevel! neq 0 (
        set "BACKEND_ERR=logs\backend.%PORT%.error.log"
    )

    echo [%date% %time%] 后端日志: %BACKEND_LOG%>>"%LOG_FILE%"
    echo [%date% %time%] 后端错误日志: %BACKEND_ERR%>>"%LOG_FILE%"
    echo [%date% %time%] 后端命令: "%PY_EXE%" -X utf8 -m uvicorn backend.app:app --app-dir . --host 127.0.0.1 --port %PORT% --reload-dir . --reload>>"%LOG_FILE%"
    start "backend-service" cmd /c "chcp 65001>nul && cd /d ""%~dp0"" && ""%PY_EXE%"" -X utf8 -m uvicorn backend.app:app --app-dir . --host 127.0.0.1 --port %PORT% --reload-dir . --reload 1> ""%BACKEND_LOG%"" 2> ""%BACKEND_ERR%"""
)

REM 等待后端启动
echo 等待后端启动...
ping -n 4 127.0.0.1 >nul

REM 尝试测试后端
where curl >nul 2>&1
if %errorlevel% equ 0 (
    set "HEALTH_OK="
    for /l %%i in (1,1,8) do (
        if not defined HEALTH_OK (
            curl -s http://localhost:%PORT%/health >nul 2>&1
            if !errorlevel! equ 0 (
                set "HEALTH_OK=1"
            ) else (
                ping -n 2 127.0.0.1 >nul
            )
        )
    )
    if defined HEALTH_OK (
        echo 后端服务正常
        echo [%date% %time%] /health 检查通过: PORT=%PORT%>>"%LOG_FILE%"
    ) else (
        echo 警告: 后端可能未启动，请查看 %BACKEND_ERR%
        echo [%date% %time%] 警告: /health 检查失败: PORT=%PORT%>>"%LOG_FILE%"
    )
) else (
    echo 提示: 未检测到 curl，跳过 /health 自检
    echo [%date% %time%] 提示: curl 不存在，跳过自检>>"%LOG_FILE%"
)

REM 检查本地同步接口是否已加载（避免后端仍在运行旧版本导致 404）
where curl >nul 2>&1
if %errorlevel% equ 0 (
    curl -s http://localhost:%PORT%/openapi.json | findstr /C:"/api/local-sync/snapshot" >nul 2>&1
    if %errorlevel% equ 0 (
        echo 本地同步接口已加载 ^(/api/local-sync/snapshot^)
    ) else (
        echo 警告: 未检测到本地同步接口 ^(/api/local-sync/snapshot^)；请确认后端已更新并彻底重启
    )
)

echo.
echo 启动前端开发服务器...
echo 前端 URL: http://localhost:5173
echo.

REM 启动前端（在新 cmd 窗口运行：切换到脚本目录、设置 UTF-8）
echo [%date% %time%] 启动前端窗口: npm run dev>>"%LOG_FILE%"
start "frontend-dev" cmd /k "cd /d ""%~dp0"" && chcp 65001>nul && npm run dev"

echo.
echo ✅ 已启动服务：
echo   - 后端窗口: backend-service（端口 %PORT%）
echo   - 前端窗口: frontend-dev（端口 5173）
echo.
echo 停止方式：在对应窗口按 Ctrl+C，或直接关闭窗口。
echo.
echo 日志文件: %LOG_FILE%
pause
popd >nul 2>&1
exit /b 0

:ENSURE_ENV_LOCAL
set "NEWPORT=%~1"
set "ENV_FILE=%~dp0.env.local"
set "ENV_TMP=%~dp0.env.local.tmp"

if not exist "%ENV_FILE%" (
    echo 创建 .env.local...
    (
        echo GEMINI_API_KEY=PLACEHOLDER_API_KEY
        echo VITE_BACKEND_BASE_URL=http://localhost:%NEWPORT%
    ) > "%ENV_FILE%"
    echo 已创建 .env.local
    exit /b 0
)

set "FOUND="
> "%ENV_TMP%" (
    for /f "usebackq delims=" %%L in ("%ENV_FILE%") do (
        set "LINE=%%L"
        echo(!LINE!| findstr /B /I "VITE_BACKEND_BASE_URL=" >nul
        if !errorlevel! equ 0 (
            echo VITE_BACKEND_BASE_URL=http://localhost:%NEWPORT%
            set "FOUND=1"
        ) else (
            echo(!LINE!
        )
    )
    if not defined FOUND echo VITE_BACKEND_BASE_URL=http://localhost:%NEWPORT%
)
move /y "%ENV_TMP%" "%ENV_FILE%" >nul
exit /b 0
