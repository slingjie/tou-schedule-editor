#!/bin/bash
# Cloudflare Workers Python 部署脚本
# 一键部署到 Cloudflare Workers

set -e

# 颜色
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${GREEN}============================================${NC}"
echo -e "${GREEN}  ☁️  Cloudflare Workers Python 部署${NC}"
echo -e "${GREEN}============================================${NC}"
echo ""

# 进入项目目录
cd "$(dirname "$0")/workers-backend"

# 检查 uv
if ! command -v uv &> /dev/null; then
    echo -e "${YELLOW}⚠️  uv 未安装，正在安装...${NC}"
    curl -LsSf https://astral.sh/uv/install.sh | sh
    export PATH="$HOME/.local/bin:$PATH"
fi

echo -e "${GREEN}✅ uv 已安装${NC}"

# 检查 Node.js 和 wrangler
if ! command -v npx &> /dev/null; then
    echo -e "${RED}❌ Node.js 未安装，请先安装 Node.js${NC}"
    exit 1
fi

# 安装依赖
echo ""
echo -e "${BLUE}📦 安装依赖...${NC}"
uv sync

echo -e "${GREEN}✅ 依赖安装完成${NC}"

# 检查 Cloudflare 登录
echo ""
echo -e "${BLUE}🔐 检查 Cloudflare 登录状态...${NC}"
if ! npx wrangler whoami &> /dev/null; then
    echo -e "${YELLOW}需要登录 Cloudflare${NC}"
    npx wrangler login
fi

echo -e "${GREEN}✅ 已登录 Cloudflare${NC}"

# 部署
echo ""
echo -e "${BLUE}🚀 部署到 Cloudflare Workers...${NC}"
uv run pywrangler deploy

# 获取部署信息
echo ""
echo -e "${GREEN}✅ 部署成功！${NC}"
echo ""

# 询问是否设置环境变量
echo -e "${YELLOW}⚙️  设置环境变量${NC}"
read -p "是否设置 GEMINI_API_KEY? (y/n): " set_key

if [[ $set_key == "y" || $set_key == "Y" ]]; then
    echo ""
    read -s -p "请输入 GEMINI_API_KEY: " api_key
    echo ""
    echo -e "${BLUE}正在设置密钥...${NC}"
    npx wrangler secret put GEMINI_API_KEY <<< "$api_key"
    echo -e "${GREEN}✅ 密钥已设置${NC}"
fi

# 显示完成信息
echo ""
echo -e "${GREEN}============================================${NC}"
echo -e "${GREEN}        🎉 部署完成！${NC}"
echo -e "${GREEN}============================================${NC}"
echo ""
echo -e "${BLUE}🔗 访问地址:${NC}"
echo "  你的 Workers 地址会在上面显示"
echo "  通常格式: https://tou-schedule-backend.xxx.workers.dev"
echo ""
echo -e "${BLUE}📊 管理面板:${NC}"
echo "  https://dash.cloudflare.com"
echo ""
echo -e "${YELLOW}⚠️  注意:${NC}"
echo "  首次部署可能需要 1-2 分钟全球生效"
echo "  如果遇到 502 错误，请等待几分钟后刷新"
echo ""

# 询问是否更新前端
echo -e "${YELLOW}📝 是否更新前端 API 地址？${NC}"
read -p "输入后端 URL 以更新前端配置 (或直接回车跳过): " backend_url

if [ ! -z "$backend_url" ]; then
    cd ..
    echo "VITE_BACKEND_BASE_URL=$backend_url" > .env.local
    echo -e "${BLUE}🔨 重新构建前端...${NC}"
    npm run build
    echo -e "${BLUE}☁️  重新部署前端...${NC}"
    npm run deploy
    echo -e "${GREEN}✅ 前端已更新${NC}"
fi

echo ""
echo -e "${GREEN}完成！${NC}"
