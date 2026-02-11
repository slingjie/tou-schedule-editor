# 手动部署到 Cloudflare Workers

## 由于环境磁盘空间不足，请使用以下手动方法：

### 方法 1: 使用 Wrangler CLI（推荐）

在你的 CMD 或 PowerShell 中执行：

```cmd
cd D:\Desktop\ai\dist_package\workers-backend

:: 登录 Cloudflare
npx wrangler login

:: 部署
npx wrangler deploy

:: 设置环境变量（如果需要）
npx wrangler secret put GEMINI_API_KEY
```

### 方法 2: 使用 Cloudflare Dashboard（网页操作）

1. **访问 Dashboard**
   - 打开: https://dash.cloudflare.com
   - 登录你的账号

2. **创建 Workers 项目**
   - 点击左侧菜单 "Workers & Pages"
   - 点击 "Create application"
   - 选择 "Create Worker"
   - 名称: `tou-schedule-backend`

3. **上传代码**
   - 点击 "Edit code"
   - 选择 "Upload"
   - 上传 `workers-backend/src/entry.py`

4. **配置环境变量**
   - 点击 "Settings" 标签
   - 点击 "Variables"
   - 添加: `GEMINI_API_KEY` = 你的API密钥

5. **部署**
   - 点击 "Save and deploy"
   - 复制 Workers URL

### 方法 3: 使用 Git 集成

1. 确保代码已推送到 GitHub（已完成 ✅）

2. 在 Cloudflare Dashboard:
   - Workers & Pages → Create application
   - 选择 "Connect to Git"
   - 选择 `slingjie/tou-schedule-editor` 仓库
   - 构建命令: 留空
   - 部署命令: 留空
   - 选择 `workers-backend/` 目录

3. 自动部署

---

## 📝 部署后更新前端

获取 Workers URL 后（格式：`https://tou-schedule-backend.xxx.workers.dev`）：

```cmd
cd D:\Desktop\ai\dist_package

:: 更新 API 地址
echo VITE_BACKEND_BASE_URL=https://tou-schedule-backend.xxx.workers.dev> .env.local

:: 重新构建
npm run build

:: 重新部署前端
npm run deploy
```

---

## 🔗 测试后端

部署完成后测试：

```bash
# 健康检查
curl https://your-worker-url.workers.dev/health

# 服务信息
curl https://your-worker-url.workers.dev/

# 配置信息
curl https://your-worker-url.workers.dev/api/config
```

---

## ⚠️ 注意事项

1. **Workers 限制**:
   - 免费版: 10万次请求/天
   - 单次请求: 最多 30 秒
   - 内存: 128MB

2. **不支持的功能**:
   - 文件上传（Excel）
   - 本地文件读写
   - Pandas/NumPy 完整功能

3. **如果需要完整功能**，建议使用 Railway：
   ```bash
   ./deploy-backend.sh
   # 选择 Railway
   ```

---

## 💡 快速部署命令总结

```cmd
:: 1. 进入目录
cd D:\Desktop\ai\dist_package\workers-backend

:: 2. 登录并部署
npx wrangler login
npx wrangler deploy

:: 3. 获取 URL 后更新前端
cd ..
echo VITE_BACKEND_BASE_URL=https://xxx.workers.dev> .env.local
npm run deploy
```

**有问题随时告诉我！**
