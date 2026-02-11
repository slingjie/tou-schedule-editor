#!/bin/bash
# 完整部署脚本 - 需要手动执行
# 用法: chmod +x deploy.sh && ./deploy.sh

set -e

echo "🚀 开始部署 TOU Schedule Editor"
echo ""

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# 检查环境
echo "📋 检查环境..."
if ! command -v node &> /dev/null; then
    echo -e "${RED}❌ Node.js 未安装${NC}"
    exit 1
fi

if ! command -v git &> /dev/null; then
    echo -e "${RED}❌ Git 未安装${NC}"
    exit 1
fi

echo -e "${GREEN}✅ 环境检查通过${NC}"
echo ""

# 步骤1: GitHub 推送
echo "📦 步骤 1: 推送到 GitHub"
if ! git remote get-url origin &> /dev/null; then
    echo -e "${YELLOW}⚠️  请先在 GitHub 创建仓库并添加 remote${NC}"
    echo "   示例: git remote add origin https://github.com/USERNAME/REPO.git"
    exit 1
fi

git push -u origin main || true
echo -e "${GREEN}✅ 代码已推送到 GitHub${NC}"
echo ""

# 步骤2: 构建前端
echo "🔨 步骤 2: 构建前端"
npm run build
echo -e "${GREEN}✅ 前端构建完成${NC}"
echo ""

# 步骤3: 部署到 Cloudflare Pages
echo "☁️  步骤 3: 部署到 Cloudflare Pages"
echo -e "${YELLOW}⚠️  需要 Cloudflare API Token${NC}"
echo "   获取地址: https://dash.cloudflare.com/profile/api-tokens"
echo "   需要权限: Cloudflare Pages > Edit"
echo ""

if [ -z "$CLOUDFLARE_API_TOKEN" ]; then
    echo -e "${YELLOW}提示: 设置环境变量后重新运行${NC}"
    echo "   export CLOUDFLARE_API_TOKEN=your_token"
    echo ""
    echo "手动部署命令:"
    echo "   npx wrangler pages deploy dist --project-name=tou-schedule-editor"
else
    npx wrangler pages deploy dist --project-name=tou-schedule-editor --branch=main
    echo -e "${GREEN}✅ 前端部署完成${NC}"
fi
echo ""

# 步骤4: Railway 后端部署说明
echo "🚂 步骤 4: Railway 后端部署"
echo -e "${YELLOW}手动完成以下步骤:${NC}"
echo "   1. 访问 https://railway.app"
echo "   2. 点击 'New Project' → 'Deploy from GitHub repo'"
echo "   3. 选择你的仓库"
echo "   4. 添加环境变量: GEMINI_API_KEY"
echo "   5. 部署完成后复制 URL"
echo ""

# 步骤5: 更新前端 API 地址
echo "📝 步骤 5: 更新前端配置"
echo "   修改 .env.local 中的 VITE_BACKEND_BASE_URL"
echo "   重新构建并部署前端"
echo ""

echo -e "${GREEN}🎉 部署指南完成！${NC}"
echo ""
echo "📚 详细文档:"
echo "   - RAILWAY_DEPLOY.md - Railway 部署说明"
echo "   - .claude/deploy-config.md - Cloudflare 部署配置"
