#!/usr/bin/env pwsh
<#
.SYNOPSIS
    快速启动脚本 - 同时启动后端和前端

.DESCRIPTION
    这个脚本将同时启动后端 (FastAPI) 和前端 (Vite) 服务器

.EXAMPLE
    .\start-services.ps1

.NOTES
    确保在项目根目录运行此脚本
#>

param(
    [switch]$NoReload,     # 不使用 --reload 模式
    [int]$BackendPort = 8000,
    [int]$FrontendPort = 5173
)

function Test-PortFree {
    param([int]$Port)
    try {
        $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
        return -not $conn
    } catch {
        return $true
    }
}

function Ensure-EnvLocalBackendUrl {
    param([int]$Port)
    $envPath = Join-Path $PSScriptRoot ".env.local"
    if (-not (Test-Path $envPath)) { return }

    $lines = Get-Content $envPath -ErrorAction SilentlyContinue
    if (-not $lines) { $lines = @() }

    $key = "VITE_BACKEND_BASE_URL="
    $value = "VITE_BACKEND_BASE_URL=http://localhost:$Port"

    $updated = $false
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -like "$key*") {
            $lines[$i] = $value
            $updated = $true
            break
        }
    }
    if (-not $updated) {
        $lines += $value
    }
    $lines | Out-File -Encoding UTF8 $envPath
}

Write-Host "===========================================" -ForegroundColor Cyan
Write-Host "  数据完整性分析系统 - 快速启动脚本" -ForegroundColor Cyan
Write-Host "===========================================" -ForegroundColor Cyan
Write-Host ""

# 检查项目目录
if (-not (Test-Path "backend\app.py")) {
    Write-Host "❌ 错误: 请在项目根目录运行此脚本" -ForegroundColor Red
    exit 1
}

# 检查虚拟环境
if (-not (Test-Path ".\.venv\Scripts\Activate.ps1")) {
    Write-Host "❌ 错误: 虚拟环境不存在" -ForegroundColor Red
    Write-Host "请先运行: python -m venv .venv" -ForegroundColor Yellow
    exit 1
}

# 检查 .env.local
if (-not (Test-Path ".env.local")) {
    Write-Host "⚠️  警告: .env.local 不存在，创建默认配置..." -ForegroundColor Yellow
    @"
GEMINI_API_KEY=PLACEHOLDER_API_KEY
VITE_BACKEND_BASE_URL=http://localhost:$BackendPort
"@ | Out-File -Encoding UTF8 .env.local
    Write-Host "✅ 已创建 .env.local" -ForegroundColor Green
}

Write-Host ""
Write-Host "启动配置:" -ForegroundColor Cyan
Write-Host "  后端端口: $BackendPort"
Write-Host "  前端端口: $FrontendPort"
Write-Host "  Reload 模式: $(if ($NoReload) { '禁用' } else { '启用' })"
Write-Host ""

# 激活虚拟环境
Write-Host "📦 激活虚拟环境..." -ForegroundColor Yellow
& ".\.venv\Scripts\Activate.ps1"

# 固定使用虚拟环境的 Python，避免 PATH/Start-Process 导致启动到系统 Python（进而加载到旧代码/旧依赖）
$pythonExe = Join-Path $PSScriptRoot ".venv\\Scripts\\python.exe"
if (-not (Test-Path $pythonExe)) {
    Write-Host "❌ 错误: 未找到虚拟环境 Python：$pythonExe" -ForegroundColor Red
    exit 1
}
Write-Host "  Python: $pythonExe" -ForegroundColor DarkGray

# 检查依赖
Write-Host "🔍 检查依赖..." -ForegroundColor Yellow
& $pythonExe -c "import fastapi, pandas, uvicorn; print('✅ 所有依赖就绪')" 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Host "❌ 缺少依赖，安装中..." -ForegroundColor Red
    & $pythonExe -m pip install -r backend/requirements.txt
}

Write-Host ""
Write-Host "🚀 启动后端服务..." -ForegroundColor Green
Write-Host "   URL: http://localhost:$BackendPort" -ForegroundColor Cyan
Write-Host ""

# 检查端口占用并尝试释放（避免旧进程占用端口导致“看似重启但仍在运行旧版本”）
# 说明：uvicorn --reload 在 Windows 下可能存在 reloader/worker 多进程；这里按端口查找所有监听进程并 taskkill /T 终止进程树。
Write-Host "🔍 释放端口 $BackendPort（彻底终止占用进程）..." -ForegroundColor Yellow
try {
    $conns = Get-NetTCPConnection -LocalPort $BackendPort -State Listen -ErrorAction SilentlyContinue
    $pids = @($conns | ForEach-Object { [int]$_.OwningProcess } | Sort-Object -Unique)
    foreach ($procId in $pids) {
        if ($procId -le 0) { continue }
        Write-Host "⚠️  端口 $BackendPort 占用 PID=$procId，执行 taskkill /T..." -ForegroundColor Yellow
        & taskkill /PID $procId /F /T *> $null
    }
    if ($pids.Count -gt 0) { Start-Sleep -Seconds 1 }

    $remaining = Get-NetTCPConnection -LocalPort $BackendPort -State Listen -ErrorAction SilentlyContinue
    if ($remaining) {
        Write-Host "⚠️  端口 $BackendPort 仍被占用，将自动切换到可用端口..." -ForegroundColor Yellow
    }
} catch {
    Write-Host "⚠️  端口释放失败，请手动结束占用 $BackendPort 的进程后重试。" -ForegroundColor Yellow
}

# 若端口仍被占用，自动选择下一个可用端口（避免你卡在“怎么都杀不干净”）
if (-not (Test-PortFree -Port $BackendPort)) {
    $originalPort = $BackendPort
    for ($p = $BackendPort + 1; $p -le ($BackendPort + 20); $p++) {
        if (Test-PortFree -Port $p) {
            $BackendPort = $p
            break
        }
    }
    if ($BackendPort -eq $originalPort) {
        Write-Host "❌ 未找到可用后端端口（$originalPort~$($originalPort+20) 均被占用）。" -ForegroundColor Red
        exit 1
    }
    Write-Host "✅ 后端端口已自动切换：$originalPort -> $BackendPort" -ForegroundColor Green
    Ensure-EnvLocalBackendUrl -Port $BackendPort
}

# 启动后端
$backendArgs = @(
    "-m", "uvicorn",
    "backend.app:app",
    "--app-dir", $PSScriptRoot,
    "--host", "0.0.0.0",
    "--port", $BackendPort.ToString(),
    "--reload-dir", $PSScriptRoot
)

if (-not $NoReload) {
    $backendArgs += "--reload"
}

# 创建日志文件
$logFile = "backend.log"

# 使用 Start-Process 在后台启动后端,重定向输出
$backendProcess = Start-Process `
    -FilePath $pythonExe `
    -ArgumentList $backendArgs `
    -PassThru `
    -WorkingDirectory $PSScriptRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput $logFile `
    -RedirectStandardError "backend.error.log"

Write-Host "✅ 后端已启动 (PID: $($backendProcess.Id))"
Write-Host "   日志文件: $logFile"
Write-Host ""

# 若 uvicorn 因端口占用/启动失败而退出，及时提示（避免误判“已重启”）
Start-Sleep -Seconds 1
if ($backendProcess.HasExited) {
    Write-Host "❌ 后端进程已退出，可能启动失败（常见原因：端口占用或依赖缺失）。" -ForegroundColor Red
    Write-Host "   请查看 backend.error.log / backend.log 获取详细信息。" -ForegroundColor Yellow
}

# 等待后端启动
Write-Host "⏳ 等待后端服务启动..." -ForegroundColor Yellow
Start-Sleep -Seconds 3

# 检查后端是否正常
try {
    $response = Invoke-WebRequest -Uri "http://localhost:$BackendPort/health" -UseBasicParsing -ErrorAction SilentlyContinue
    if ($response.StatusCode -eq 200) {
        Write-Host "✅ 后端服务正常 (/health: OK)" -ForegroundColor Green
    } else {
        Write-Host "⚠️  后端未准备好,查看日志: tail -f $logFile" -ForegroundColor Yellow
    }
}
catch {
    Write-Host "⚠️  无法连接后端,查看日志: tail -f $logFile" -ForegroundColor Yellow
}

try {
    $openapi = Invoke-WebRequest -Uri "http://localhost:$BackendPort/openapi.json" -UseBasicParsing -ErrorAction SilentlyContinue
    if ($openapi.StatusCode -eq 200 -and ($openapi.Content -match '\"/api/local-sync/snapshot\"')) {
        Write-Host "✅ 本地同步接口已加载 (/api/local-sync/snapshot)" -ForegroundColor Green
    } else {
        Write-Host "⚠️  未检测到本地同步接口 (/api/local-sync/snapshot)。" -ForegroundColor Yellow
        Write-Host "   这通常表示后端仍在运行旧版本代码，请确认已更新并彻底重启后端进程。" -ForegroundColor Yellow
    }
} catch {
    Write-Host "⚠️  无法读取 /openapi.json，跳过本地同步接口检查。" -ForegroundColor Yellow
}

try {
    $dbg = Invoke-WebRequest -Uri "http://localhost:$BackendPort/api/debug/runtime" -UseBasicParsing -ErrorAction SilentlyContinue
    if ($dbg.StatusCode -eq 200) {
        Write-Host "🔎 后端运行时信息: $($dbg.Content)" -ForegroundColor DarkGray
    }
} catch { }

Write-Host ""
Write-Host "🚀 启动前端开发服务器..." -ForegroundColor Green
Write-Host "   URL: http://localhost:$FrontendPort" -ForegroundColor Cyan
Write-Host "   提示: Ctrl+C 将同时停止前后端服务" -ForegroundColor Yellow
Write-Host ""

# 注册退出清理
$cleanup = {
    Write-Host ""
    Write-Host "🛑 清理资源..." -ForegroundColor Yellow
    try {
        $conns = Get-NetTCPConnection -LocalPort $BackendPort -State Listen -ErrorAction SilentlyContinue
        $pids = @($conns | ForEach-Object { [int]$_.OwningProcess } | Sort-Object -Unique)
        foreach ($procId in $pids) {
            if ($procId -le 0) { continue }
            & taskkill /PID $procId /F /T *> $null
        }
    } catch { }
    Write-Host "✅ 已停止后端服务"
}
Register-EngineEvent -SourceIdentifier PowerShell.Exiting -Action $cleanup | Out-Null

try {
    # 启动前端（在当前窗口）
    npm run dev
}
finally {
    # 清理后端进程
    & $cleanup
}
