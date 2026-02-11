#!/bin/bash
# 完整云端部署脚本
# 执行: ./deploy-cloud.sh

set -e

# 颜色
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${GREEN}============================================${NC}"
echo -e "${GREEN}     ☁️  云端部署脚本${NC}"
echo -e "${GREEN}============================================${NC}"
echo ""

# 检查 Git
if ! command -v git &> /dev/null; then
    echo -e "${RED}❌ Git 未安装${NC}"
    exit 1
fi

# 获取 GitHub 信息
echo -e "${YELLOW}📋 配置 GitHub 仓库${NC}"
echo ""
echo "请选择操作:"
echo "  1) 推送到已有仓库"
echo "  2) 创建新仓库并推送"
echo "  3) 仅显示命令（手动执行）"
echo ""

read -p "请输入选项 (1-3): " github_option

case $github_option in
    1)
        read -p "请输入 GitHub 仓库 URL (如: https://github.com/username/repo.git): " repo_url
        git remote add origin "$repo_url" 2>/dev/null || git remote set-url origin "$repo_url"
        echo -e "${GREEN}✅ Remote 配置完成${NC}"
        ;;
    2)
        read -p "请输入 GitHub 用户名: " username
        read -p "请输入仓库名称 (默认: tou-schedule-editor): " repo_name
        repo_name=${repo_name:-tou-schedule-editor}
        
        echo -e "${YELLOW}⚠️  请在浏览器中创建仓库:${NC}"
        echo -e "   ${BLUE}https://github.com/new${NC}"
        echo "   仓库名称: $repo_name"
        echo "   不要初始化 README"
        echo ""
        read -p "按回车键继续（创建完成后）..."
        
        repo_url="https://github.com/$username/$repo_name.git"
        git remote add origin "$repo_url" 2>/dev/null || git remote set-url origin "$repo_name"
        echo -e "${GREEN}✅ Remote 配置完成: $repo_url${NC}"
        ;;
    3)
        echo -e "${YELLOW}📖 手动执行命令:${NC}"
        echo ""
        echo "# 1. 在浏览器中创建仓库"
        echo "# 访问: https://github.com/new"
        echo "# 仓库名称: tou-schedule-editor"
        echo "# 不要勾选 README"
        echo ""
        echo "# 2. 配置 remote 并推送"
        echo "git remote add origin https://github.com/YOUR_USERNAME/tou-schedule-editor.git"
        echo "git branch -M main"
        echo "git push -u origin main"
        echo ""
        exit 0
        ;;
    *)
        echo -e "${RED}❌ 无效选项${NC}"
        exit 1
        ;;
esac

# 推送到 GitHub
echo ""
echo -e "${YELLOW}📤 推送到 GitHub...${NC}"
git branch -M main

if git push -u origin main 2>&1; then
    echo -e "${GREEN}✅ 推送成功!${NC}"
else
    echo -e "${RED}❌ 推送失败${NC}"
    echo "请检查:"
    echo "  1. GitHub 仓库是否存在"
    echo "  2. 是否有推送权限"
    echo "  3. 是否需要配置 SSH 密钥"
    exit 1
fi

# 显示仓库 URL
repo_url=$(git remote get-url origin)
echo ""
echo -e "${GREEN}🔗 仓库地址: $repo_url${NC}"
echo ""

# 后端部署选择
echo -e "${YELLOW}🚀 选择后端部署平台${NC}"
echo ""
echo "  1) 🚂 Railway (推荐 - 简单快速)"
echo "  2) 🎨 Render (免费永久)"
echo "  3) 🚀 Fly.io (全球边缘)"
echo "  4) 跳过后端部署"
echo ""

read -p "请输入选项 (1-4): " platform

case $platform in
    1)
        echo ""
        echo -e "${YELLOW}🚂 Railway 部署${NC}"
        echo "==============="
        echo ""
        echo "部署步骤:"
        echo "1. 访问: https://railway.app/new"
        echo "2. 选择 'Deploy from GitHub repo'"
        echo "3. 选择仓库: $(basename $repo_url .git)"
        echo "4. 添加环境变量: GEMINI_API_KEY=你的API密钥"
        echo "5. 等待部署完成"
        echo ""
        echo -e "${BLUE}正在打开 Railway...${NC}"
        
        if command -v open &> /dev/null; then
            open "https://railway.app/new"
        elif command -v start &> /dev/null; then
            start "https://railway.app/new"
        elif command -v xdg-open &> /dev/null; then
            xdg-open "https://railway.app/new"
        fi
        
        echo ""
        read -p "部署完成后，请输入后端 URL (如: https://xxx.up.railway.app): " backend_url
        ;;
        
    2)
        echo ""
        echo -e "${YELLOW}🎨 Render 部署${NC}"
        echo "==============="
        echo ""
        echo "部署步骤:"
        echo "1. 访问: https://dashboard.render.com/select-repo?type=web"
        echo "2. 选择你的 GitHub 仓库"
        echo "3. 配置:"
        echo "   - Name: tou-schedule-editor-backend"
        echo "   - Runtime: Python 3"
        echo "   - Build Command: cd backend && pip install -r requirements.txt"
        echo "   - Start Command: cd backend && uvicorn app:app --host 0.0.0.0 --port \$PORT"
        echo "4. 添加环境变量: GEMINI_API_KEY"
        echo "5. 点击 'Create Web Service'"
        echo ""
        echo -e "${BLUE}正在打开 Render...${NC}"
        
        if command -v open &> /dev/null; then
            open "https://dashboard.render.com/select-repo?type=web"
        elif command -v start &> /dev/null; then
            start "https://dashboard.render.com/select-repo?type=web"
        elif command -v xdg-open &> /dev/null; then
            xdg-open "https://dashboard.render.com/select-repo?type=web"
        fi
        
        echo ""
        read -p "部署完成后，请输入后端 URL (如: https://xxx.onrender.com): " backend_url
        ;;
        
    3)
        echo ""
        echo -e "${YELLOW}🚀 Fly.io 部署${NC}"
        echo "==============="
        echo ""
        echo "安装 Fly.io CLI:"
        echo "  curl -L https://fly.io/install.sh | sh"
        echo ""
        echo "部署命令:"
        echo "  flyctl auth login"
        echo "  flyctl launch"
        echo "  flyctl deploy"
        echo ""
        read -p "部署完成后，请输入后端 URL (如: https://xxx.fly.dev): " backend_url
        ;;
        
    4)
        echo ""
        echo -e "${YELLOW}⏭️  跳过后端部署${NC}"
        exit 0
        ;;
        
    *)
        echo -e "${RED}❌ 无效选项${NC}"
        exit 1
        ;;
esac

# 更新前端配置
echo ""
echo -e "${YELLOW}📝 更新前端 API 配置...${NC}"
echo "VITE_BACKEND_BASE_URL=$backend_url" > .env.local
echo -e "${GREEN}✅ 已更新 .env.local${NC}"

# 重新构建和部署前端
echo ""
echo -e "${YELLOW}🔨 重新构建前端...${NC}"
npm run build

echo ""
echo -e "${YELLOW}☁️  部署前端到 Cloudflare...${NC}"
npm run deploy

echo ""
echo -e "${GREEN}============================================${NC}"
echo -e "${GREEN}     ✅ 云端部署完成!${NC}"
echo -e "${GREEN}============================================${NC}"
echo ""
echo -e "${BLUE}🔗 访问地址:${NC}"
echo -e "   前端: https://4c5ac2be.tou-schedule-editor.pages.dev"
echo -e "   后端: $backend_url"
echo ""
echo -e "${YELLOW}⚠️  注意:${NC}"
echo "   首次部署可能需要 2-3 分钟后端才能完全启动"
echo "   如果遇到 CORS 错误，请检查后端 CORS 配置"
echo ""
