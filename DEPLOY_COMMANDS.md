# 完整部署执行手册
# COPY & PASTE 以下命令到你的终端执行

# ============================================
# 步骤 1: 创建 GitHub 仓库并推送
# ============================================

# 1.1 在浏览器中打开 GitHub 创建仓库页面
# https://github.com/new
# 仓库名称建议: tou-schedule-editor
# 不要勾选 "Initialize this repository with a README"

# 1.2 设置 Git 用户信息（如未设置）
git config user.email "your-email@example.com"
git config user.name "Your Name"

# 1.3 添加远程仓库（替换 YOUR_USERNAME 和 REPO_NAME）
git remote add origin https://github.com/YOUR_USERNAME/REPO_NAME.git

# 1.4 推送代码
git branch -M main
git push -u origin main

# ============================================
# 步骤 2: 部署后端到 Railway（自动）
# ============================================

# 2.1 访问 Railway 并部署
open https://railway.app/new
# 或
start https://railway.app/new

# 2.2 在 Railway 面板中：
# - 选择 "Deploy from GitHub repo"
# - 选择刚才创建的仓库
# - 添加环境变量: GEMINI_API_KEY=你的API密钥
# - 等待部署完成，复制 URL

# ============================================
# 步骤 3: 部署前端到 Cloudflare Pages
# ============================================

# 3.1 登录 Cloudflare
npx wrangler login

# 3.2 部署（确保在 dist 文件夹所在目录）
npx wrangler pages deploy dist --project-name=tou-schedule-editor --branch=main

# 或使用 Git 集成方式：
# 访问 https://dash.cloudflare.com → Pages → Create a project
# 连接 GitHub 仓库，自动部署

# ============================================
# 步骤 4: 更新 API 地址
# ============================================

# 4.1 修改环境变量文件
echo "VITE_BACKEND_BASE_URL=https://your-railway-url.up.railway.app" > .env.local

# 4.2 重新构建
npm run build

# 4.3 重新部署
git add . && git commit -m "Update API endpoint"
git push
npx wrangler pages deploy dist --project-name=tou-schedule-editor

# ============================================
# 备选方案: 直接拖拽部署（无需命令行）
# ============================================

# 1. 访问 https://dash.cloudflare.com
# 2. 点击左侧 Pages → Create a project
# 3. 选择 "Upload assets" 
# 4. 将 dist 文件夹压缩为 ZIP
# 5. 上传 ZIP 文件
# 6. 项目名: tou-schedule-editor
# 7. 部署完成！
