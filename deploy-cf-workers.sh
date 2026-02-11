#!/bin/bash
# Cloudflare Workers Python 后端部署脚本

set -e

echo "🚀 Cloudflare Workers Python 部署脚本"
echo "======================================"
echo ""

# 颜色
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m'

cd "$(dirname "$0")"

# 检查 uv
if ! command -v uv &> /dev/null; then
    echo -e "${YELLOW}⚠️  uv 未安装，正在安装...${NC}"
    curl -LsSf https://astral.sh/uv/install.sh | sh
    export PATH="$HOME/.cargo/bin:$PATH"
fi

echo -e "${GREEN}✅ uv 已安装${NC}"

# 创建 Workers 项目结构
echo ""
echo -e "${BLUE}📁 创建 Cloudflare Workers 项目...${NC}"

WORKERS_DIR="cf-workers-backend"
mkdir -p "$WORKERS_DIR/src"

# 创建 pyproject.toml
cat > "$WORKERS_DIR/pyproject.toml" << 'PYEOF'
[project]
name = "tou-schedule-backend"
version = "0.1.0"
description = "TOU Schedule Editor Backend on Cloudflare Workers"
requires-python = ">=3.12"
dependencies = [
    "fastapi>=0.111.0",
    "httpx>=0.27.0",
    "pandas>=2.0.0",
    "numpy>=1.24.0",
    "openpyxl>=3.1.0",
    "python-multipart>=0.0.9",
]

[dependency-groups]
dev = [
    "workers-py",
    "workers-runtime-sdk",
]
PYEOF

# 创建入口文件
cat > "$WORKERS_DIR/src/entry.py" << 'PYEOF'
from workers import WorkerEntrypoint
from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.middleware.cors import CORSMiddleware
import asgi
import json

app = FastAPI(title="TOU Schedule Backend")

# CORS 配置
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # 生产环境应限制为前端域名
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/")
async def root():
    return {
        "message": "TOU Schedule Backend on Cloudflare Workers",
        "version": "0.1.0",
        "status": "running"
    }

@app.get("/health")
async def health():
    return {"status": "healthy", "service": "tou-schedule-backend"}

# 示例端点 - 需要迁移实际业务逻辑
@app.post("/api/analyze")
async def analyze_data(data: dict):
    """数据分析端点（示例）"""
    try:
        # TODO: 迁移实际的数据分析逻辑
        return {
            "success": True,
            "message": "Analysis endpoint ready",
            "received_data_keys": list(data.keys()) if data else []
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# Workers 入口点
class Default(WorkerEntrypoint):
    async def fetch(self, request):
        return await asgi.fetch(app, request, self.env)
PYEOF

# 创建 wrangler.toml
cat > "$WORKERS_DIR/wrangler.toml" << 'EOF'
name = "tou-schedule-backend"
main = "src/entry.py"
compatibility_flags = ["python_workers"]
compatibility_date = "2026-02-11"

# 环境变量（非敏感）
[vars]
ENVIRONMENT = "production"

# 密钥（敏感信息，部署后设置）
# [[secrets]]
# GEMINI_API_KEY = ""
EOF

# 创建 .gitignore
cat > "$WORKERS_DIR/.gitignore" << 'EOF'
__pycache__/
*.pyc
.env
.venv/
node_modules/
EOF

echo -e "${GREEN}✅ 项目结构创建完成${NC}"
echo ""

# 检查是否需要复制现有后端代码
if [ -d "backend" ]; then
    echo -e "${YELLOW}📦 发现现有后端代码，建议：${NC}"
    echo "  1. 手动将 backend/app.py 的业务逻辑迁移到 $WORKERS_DIR/src/entry.py"
    echo "  2. 注意 Workers 的限制（文件系统、部分包不支持）"
    echo ""
fi

# 安装依赖
echo -e "${BLUE}📦 安装依赖...${NC}"
cd "$WORKERS_DIR"
uv sync

echo -e "${GREEN}✅ 依赖安装完成${NC}"
echo ""

# 询问是否部署
read -p "是否立即部署到 Cloudflare? (y/n): " deploy_now

if [[ $deploy_now == "y" || $deploy_now == "Y" ]]; then
    echo ""
    echo -e "${BLUE}☁️  部署到 Cloudflare Workers...${NC}"
    
    # 检查登录状态
    if ! npx wrangler whoami &> /dev/null; then
        echo -e "${YELLOW}请先登录 Cloudflare:${NC}"
        npx wrangler login
    fi
    
    # 部署
    uv run pywrangler deploy
    
    echo ""
    echo -e "${GREEN}✅ 部署完成！${NC}"
    echo ""
    
    # 设置密钥
    read -p "是否设置 GEMINI_API_KEY? (y/n): " set_key
    if [[ $set_key == "y" || $set_key == "Y" ]]; then
        read -s -p "请输入 GEMINI_API_KEY: " api_key
        echo ""
        wrangler secret put GEMINI_API_KEY <<< "$api_key"
    fi
    
    echo ""
    echo -e "${GREEN}🎉 部署成功！${NC}"
    echo ""
    echo "查看你的 Workers  dashboard:"
    echo "  https://dash.cloudflare.com"
else
    echo ""
    echo -e "${BLUE}本地开发命令:${NC}"
    echo "  cd $WORKERS_DIR"
    echo "  uv run pywrangler dev"
    echo ""
    echo "部署命令:"
    echo "  cd $WORKERS_DIR"
    echo "  uv run pywrangler deploy"
fi

echo ""
echo -e "${GREEN}完成！${NC}"
