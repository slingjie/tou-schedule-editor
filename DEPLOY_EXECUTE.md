# 🚀 云端部署执行指南

## ⚡ 立即执行

在终端中运行：

```bash
./deploy-cloud.sh
```

然后按提示操作即可。

---

## 📋 详细步骤

### 步骤 1: 推送到 GitHub

#### 选项 A - 自动推送（推荐）
```bash
./deploy-cloud.sh
# 选择选项 1 或 2，按提示输入信息
```

#### 选项 B - 手动推送
```bash
# 1. 在浏览器中创建仓库
# 访问: https://github.com/new
# 仓库名称: tou-schedule-editor
# 不要勾选 README

# 2. 配置并推送
git remote add origin https://github.com/YOUR_USERNAME/tou-schedule-editor.git
git branch -M main
git push -u origin main
```

### 步骤 2: 部署后端

运行 `./deploy-cloud.sh` 选择以下任一平台：

#### 🚂 Railway（推荐）
- 自动打开浏览器到 railway.app
- 选择 "Deploy from GitHub repo"
- 添加环境变量: `GEMINI_API_KEY=你的API密钥`
- 等待部署，复制 URL

#### 🎨 Render
- 自动打开浏览器到 render.com
- 配置 Python 3 环境
- 添加环境变量
- 部署

#### 🚀 Fly.io
- 需要安装 flyctl
- 命令行部署

### 步骤 3: 自动完成

脚本会自动：
1. 更新 `.env.local` 中的 API 地址
2. 重新构建前端
3. 部署到 Cloudflare Pages

---

## 🎯 一键命令总结

```bash
# 完整云端部署（交互式）
./deploy-cloud.sh

# 或分步执行：

# 1. 推送到 GitHub
git remote add origin https://github.com/YOUR_USERNAME/tou-schedule-editor.git
git push -u origin main

# 2. 部署后端（选择平台）
./deploy-backend.sh

# 3. 更新并重新部署前端
echo "VITE_BACKEND_BASE_URL=https://your-backend-url.com" > .env.local
npm run deploy
```

---

## 🔗 部署后访问

| 服务 | 地址 | 说明 |
|------|------|------|
| 前端 | https://4c5ac2be.tou-schedule-editor.pages.dev | 已在线 |
| 后端 | 部署后获得 | AI功能需要GEMINI_API_KEY |
| API文档 | /docs | FastAPI自动生成 |

---

## ⚠️ 重要提示

1. **API密钥**: 部署后端时记得设置 `GEMINI_API_KEY`
2. **CORS配置**: 如果前端无法访问后端，检查 CORS 设置
3. **部署时间**: 首次部署可能需要 2-5 分钟
4. **费用**: Railway 和 Render 都有免费额度

---

## 🆘 故障排除

### 推送失败
```bash
# 检查远程地址
git remote -v

# 如果需要更新
git remote set-url origin https://github.com/YOUR_USERNAME/tou-schedule-editor.git
```

### 后端部署失败
- 检查 `Procfile` 是否存在
- 检查 `backend/requirements.txt` 是否完整
- 查看平台日志（Dashboard → Logs）

### 前端无法连接后端
- 检查 `.env.local` 中的 URL 是否正确
- 检查后端 CORS 配置是否允许前端域名
- 重新构建并部署: `npm run deploy`

---

## ✅ 部署检查清单

- [ ] 代码推送到 GitHub
- [ ] 后端部署到 Railway/Render/Fly.io
- [ ] 环境变量 GEMINI_API_KEY 已设置
- [ ] 获取后端 URL
- [ ] 前端 API 地址已更新
- [ ] 前端重新部署
- [ ] 测试访问正常

---

**执行脚本**: `./deploy-cloud.sh`
