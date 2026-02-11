#!/bin/bash
# 后端部署选择器
# 支持: Railway, Render, Fly.io, Docker

echo "=========================================="
echo "   🚀 TOU Schedule Editor 后端部署"
echo "=========================================="
echo ""
echo "选择部署平台:"
echo ""
echo "  1) 🚂 Railway (推荐 - 简单快速)"
echo "  2) 🎨 Render (免费额度永久)"
echo "  3) 🚀 Fly.io (全球边缘部署)"
echo "  4) 🐳 Docker (自托管)"
echo "  5) 📖 查看部署文档"
echo ""

read -p "请输入选项 (1-5): " choice

case $choice in
  1)
    echo ""
    echo "🚂 Railway 部署"
    echo "==============="
    echo ""
    echo "由于 Railway CLI 需要交互式登录，请使用以下步骤:"
    echo ""
    echo "1. 访问: https://railway.app"
    echo "2. 点击 'New Project' → 'Deploy from GitHub repo'"
    echo "3. 选择你的 GitHub 仓库"
    echo "4. 在 Variables 中添加: GEMINI_API_KEY=你的API密钥"
    echo "5. 等待部署完成"
    echo ""
    echo "或者使用 Railway CLI (需要浏览器登录):"
    echo "   railway login"
    echo "   railway init"
    echo "   railway up"
    echo ""
    
    # 尝试打开浏览器
    if command -v open &> /dev/null; then
      open https://railway.app/new
    elif command -v start &> /dev/null; then
      start https://railway.app/new
    elif command -v xdg-open &> /dev/null; then
      xdg-open https://railway.app/new
    fi
    ;;
    
  2)
    echo ""
    echo "🎨 Render 部署"
    echo "==============="
    echo ""
    echo "Render 提供永久免费套餐!"
    echo ""
    echo "部署步骤:"
    echo "1. 访问: https://render.com"
    echo "2. 点击 'New +' → 'Web Service'"
    echo "3. 连接你的 GitHub 仓库"
    echo "4. 配置:"
    echo "   - Name: tou-schedule-editor-backend"
    echo "   - Runtime: Python 3"
    echo "   - Build Command: cd backend && pip install -r requirements.txt"
    echo "   - Start Command: cd backend && uvicorn app:app --host 0.0.0.0 --port \$PORT"
    echo "5. 添加环境变量: GEMINI_API_KEY"
    echo "6. 点击 'Create Web Service'"
    echo ""
    echo "或者使用 Blueprint (自动配置):"
    echo "   访问: https://render.com/blueprints"
    echo "   选择你的仓库，render.yaml 会自动配置"
    echo ""
    
    if command -v open &> /dev/null; then
      open https://dashboard.render.com/select-repo?type=web
    elif command -v start &> /dev/null; then
      start https://dashboard.render.com/select-repo?type=web
    elif command -v xdg-open &> /dev/null; then
      xdg-open https://dashboard.render.com/select-repo?type=web
    fi
    ;;
    
  3)
    echo ""
    echo "🚀 Fly.io 部署"
    echo "==============="
    echo ""
    echo "Fly.io 提供全球边缘部署，性能最佳!"
    echo ""
    echo "部署步骤:"
    echo "1. 安装 Fly.io CLI:"
    echo "   curl -L https://fly.io/install.sh | sh"
    echo ""
    echo "2. 登录:"
    echo "   flyctl auth login"
    echo ""
    echo "3. 部署:"
    echo "   flyctl launch"
    echo "   flyctl deploy"
    echo ""
    echo "配置文件 fly.toml 已创建!"
    echo ""
    
    # 检查是否已安装 flyctl
    if command -v flyctl &> /dev/null; then
      echo "✅ Fly.io CLI 已安装"
      read -p "是否现在部署? (y/n): " deploy_now
      if [[ $deploy_now == "y" || $deploy_now == "Y" ]]; then
        flyctl launch
      fi
    else
      echo "⚠️  Fly.io CLI 未安装"
      echo "   请先安装: https://fly.io/docs/hands-on/install-flyctl/"
    fi
    ;;
    
  4)
    echo ""
    echo "🐳 Docker 部署"
    echo "==============="
    echo ""
    echo "使用 Docker 自托管，完全控制!"
    echo ""
    echo "部署步骤:"
    echo ""
    echo "方式 1 - Docker Compose (推荐):"
    echo "   docker-compose up -d"
    echo ""
    echo "方式 2 - Docker 命令:"
    echo "   docker build -t tou-schedule-backend ."
    echo "   docker run -d -p 8080:8080 -e GEMINI_API_KEY=你的密钥 tou-schedule-backend"
    echo ""
    echo "方式 3 - 本地开发:"
    echo "   cd backend"
    echo "   pip install -r requirements.txt"
    echo "   uvicorn app:app --host 0.0.0.0 --port 8000"
    echo ""
    
    read -p "是否现在运行 Docker Compose? (y/n): " run_docker
    if [[ $run_docker == "y" || $run_docker == "Y" ]]; then
      if command -v docker-compose &> /dev/null; then
        docker-compose up -d
        echo "✅ Docker 容器已启动"
        echo "   访问: http://localhost:8080"
        echo "   API文档: http://localhost:8080/docs"
      else
        echo "❌ Docker Compose 未安装"
        echo "   安装指南: https://docs.docker.com/compose/install/"
      fi
    fi
    ;;
    
  5)
    echo ""
    echo "📖 部署文档"
    echo "==============="
    echo ""
    echo "可用文档:"
    echo "   - RAILWAY_DEPLOY.md     Railway 详细指南"
    echo "   - DEPLOY_COMMANDS.md    所有部署命令"
    echo "   - SSL_FIX.md           SSL 问题修复"
    echo "   - README-安装说明.md    安装说明"
    echo ""
    ;;
    
  *)
    echo "❌ 无效选项"
    exit 1
    ;;
esac
