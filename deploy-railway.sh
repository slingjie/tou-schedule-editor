#!/bin/bash
# Railway 快速部署脚本
# 在推送到 GitHub 后执行

echo "🚂 Railway 后端部署脚本"
echo ""
echo "请确保已完成以下步骤："
echo "  1. 代码已推送到 GitHub"
echo "  2. 访问 https://railway.app 并登录"
echo ""

# 检查 GitHub remote
if git remote get-url origin &> /dev/null; then
    echo "✅ GitHub Remote:"
    git remote get-url origin
    echo ""
    echo "📋 Railway 部署步骤："
    echo "   1. 访问 https://railway.app/new"
    echo "   2. 选择 'Deploy from GitHub repo'"
    echo "   3. 选择此仓库"
    echo "   4. 在 Variables 中添加 GEMINI_API_KEY"
    echo "   5. 等待部署完成"
    echo ""
    echo "🔗 打开 Railway..."
    
    # 尝试打开浏览器
    if command -v open &> /dev/null; then
        open https://railway.app/new
    elif command -v start &> /dev/null; then
        start https://railway.app/new
    elif command -v xdg-open &> /dev/null; then
        xdg-open https://railway.app/new
    else
        echo "请手动访问: https://railway.app/new"
    fi
else
    echo "❌ 未配置 GitHub Remote"
    echo "   请先执行: git remote add origin <your-github-url>"
    echo "   然后执行: git push -u origin main"
fi
