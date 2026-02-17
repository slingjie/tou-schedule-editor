# Windows PowerShell 部署脚本
# 以管理员身份运行 PowerShell，然后执行：
# .\deploy-windows.ps1

Write-Host "🚀 TOU Schedule Editor Windows 部署脚本" -ForegroundColor Green
Write-Host "==========================================" -ForegroundColor Green
Write-Host ""

# 检查 Python
$python = Get-Command python -ErrorAction SilentlyContinue
if (-not $python) {
    Write-Host "❌ Python 未安装，请先安装 Python 3.11" -ForegroundColor Red
    exit 1
}
Write-Host "✅ Python: $($python.Source)" -ForegroundColor Green

# 激活虚拟环境
if (Test-Path ".venv\Scripts\activate.ps1") {
    Write-Host "📦 激活虚拟环境..." -ForegroundColor Yellow
    . .venv\Scripts\activate.ps1
}

# 启动后端（后台任务）
Write-Host ""
Write-Host "🚀 启动后端服务..." -ForegroundColor Cyan
Write-Host "   地址: http://localhost:8000" -ForegroundColor Gray
Write-Host "   API文档: http://localhost:8000/docs" -ForegroundColor Gray
Write-Host ""

$backendJob = Start-Job -ScriptBlock {
    Set-Location backend
    python -m uvicorn app:app --host 127.0.0.1 --port 8000
}

# 等待后端启动
Write-Host "⏳ 等待后端启动 (5秒)..." -ForegroundColor Yellow
Start-Sleep -Seconds 5

# 检查后端是否启动
Write-Host ""
Write-Host "🔍 检查后端状态..." -ForegroundColor Yellow
try {
    $response = Invoke-WebRequest -Uri "http://localhost:8000/health" -Method GET -TimeoutSec 5
    Write-Host "✅ 后端启动成功!" -ForegroundColor Green
} catch {
    Write-Host "⚠️  后端可能还在启动中..." -ForegroundColor Yellow
}

Write-Host ""
Write-Host "📦 构建前端..." -ForegroundColor Cyan
npm run build

Write-Host ""
Write-Host "☁️  部署到 Cloudflare..." -ForegroundColor Cyan
Write-Host "   按提示操作..." -ForegroundColor Gray
Write-Host ""
npx wrangler pages deploy dist --project-name=tou-schedule-editor --branch=main

Write-Host ""
Write-Host "✅ 部署完成!" -ForegroundColor Green
Write-Host ""
Write-Host "🔗 访问地址:" -ForegroundColor Cyan
Write-Host "   前端: https://4c5ac2be.tou-schedule-editor.pages.dev" -ForegroundColor Blue
Write-Host "   后端: http://localhost:8000" -ForegroundColor Blue
Write-Host ""
Write-Host "⚠️  注意: 后端在本地运行，需要保持此窗口打开" -ForegroundColor Yellow
Write-Host ""

# 等待用户按键
Write-Host "按任意键停止后端服务并退出..." -ForegroundColor Gray
$null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")

# 停止后端
Write-Host ""
Write-Host "🛑 停止后端服务..." -ForegroundColor Red
Stop-Job $backendJob
Remove-Job $backendJob

Write-Host "✅ 已清理，退出" -ForegroundColor Green
