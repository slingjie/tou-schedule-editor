#!/bin/bash
# 本地启动后端服务脚本

echo "🚀 启动本地后端服务"
echo "===================="
echo ""

# 检查 Python
if ! command -v python &> /dev/null && ! command -v python3 &> /dev/null; then
    echo "❌ Python 未安装"
    exit 1
fi

PYTHON_CMD=$(command -v python || command -v python3)
echo "✅ Python: $PYTHON_CMD"

# 激活虚拟环境（如果存在）
if [ -d ".venv" ]; then
    echo "📦 激活虚拟环境..."
    source .venv/Scripts/activate 2>/dev/null || source .venv/bin/activate 2>/dev/null
fi

# 检查依赖
cd backend

echo ""
echo "🔍 检查依赖..."
if ! python -c "import fastapi" 2>/dev/null; then
    echo "📦 安装依赖..."
    pip install -r requirements.txt
fi

echo ""
echo "🎯 启动后端服务..."
echo "   地址: http://localhost:8000"
echo "   API文档: http://localhost:8000/docs"
echo "   健康检查: http://localhost:8000/health"
echo ""
echo "按 Ctrl+C 停止服务"
echo ""

# 启动服务
uvicorn app:app --host 127.0.0.1 --port 8000 --reload
