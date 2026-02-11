#!/bin/bash
# 简化版 Cloudflare Workers 部署（无需本地构建）

echo "🚀 Cloudflare Workers 部署（简化版）"
echo "======================================"
echo ""

# 由于环境限制，我们使用 wrangler 直接部署
echo "📦 方法：使用 wrangler CLI 直接部署"
echo ""

cd workers-backend

# 检查 wrangler
echo "🔍 检查 wrangler..."
if ! npx wrangler --version &> /dev/null; then
    echo "❌ wrangler 未安装"
    echo "正在安装..."
    npm install -g wrangler
fi

# 检查登录
echo ""
echo "🔐 检查 Cloudflare 登录..."
npx wrangler whoami &> /dev/null
if [ $? -ne 0 ]; then
    echo "⚠️  需要登录 Cloudflare"
    echo "执行: npx wrangler login"
    npx wrangler login
fi

# 部署
echo ""
echo "🚀 部署 Workers..."
npx wrangler deploy

echo ""
echo "✅ 部署命令已执行"
echo ""
echo "如果部署成功，你会看到 URL"
echo "如果失败，请检查："
echo "  1. 是否已登录 Cloudflare"
echo "  2. 网络连接是否正常"
echo ""

# 设置密钥
echo "📝 设置环境变量..."
read -p "是否设置 GEMINI_API_KEY? (y/n): " set_key
if [[ $set_key == "y" || $set_key == "Y" ]]; then
    read -s -p "请输入 GEMINI_API_KEY: " api_key
    echo ""
    echo "$api_key" | npx wrangler secret put GEMINI_API_KEY
fi

echo ""
echo "🎉 完成！"
echo ""
echo "查看 Dashboard: https://dash.cloudflare.com"
