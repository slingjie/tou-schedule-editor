# Deploy to Railway

## 1. 注册 Railway 账号
- 访问 https://railway.app
- 使用 GitHub 账号登录

## 2. 创建新项目
- 点击 "New Project"
- 选择 "Deploy from GitHub repo"
- 选择你的代码仓库

## 3. 配置环境变量
在 Railway 面板中，点击 Variables，添加以下环境变量：

```
GEMINI_API_KEY=your_gemini_api_key_here
```

## 4. 部署
Railway 会自动检测 Procfile 并部署你的应用。

部署完成后，你会得到一个类似 `https://your-app.up.railway.app` 的 URL。

## 5. 更新前端 API 地址
部署成功后，将前端代码中的 API 地址更新为 Railway 提供的 URL。

在 `.env.local` 文件中：
```
VITE_BACKEND_BASE_URL=https://your-app.up.railway.app
```
