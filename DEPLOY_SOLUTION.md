# 部署方案选择

## 当前问题

你的应用需要以下功能，但当前部署不支持：

❌ **文件上传** (Excel导入)
❌ **复杂数据分析** (Pandas处理)
❌ **完整 API 端点** (/api/load/analyze等)

## 推荐方案: Railway (完整后端)

### 为什么选 Railway？

✅ 支持完整 Python FastAPI 后端
✅ 支持文件上传和 Pandas
✅ 无需修改前端代码
✅ 自动部署，简单易用

### 部署步骤

```bash
# 1. 打开 Railway
start https://railway.app/new

# 2. 选择 GitHub 仓库: slingjie/tou-schedule-editor

# 3. 配置环境变量:
#    GEMINI_API_KEY = your_api_key

# 4. 部署完成后复制 URL (如: https://tou-schedule.up.railway.app)

# 5. 更新前端配置
echo "VITE_BACKEND_BASE_URL=https://tou-schedule.up.railway.app" > .env.local

# 6. 重新部署前端
npm run build
npm run deploy
```

### 费用

- 免费额度: $5/月
- 小型应用完全够用
- 超出后按需付费

## 备选方案: 纯前端版本

如果不需要后端计算，可以：

1. 禁用文件导入功能
2. 使用本地 JavaScript 计算
3. 数据存储在 localStorage

这样就不需要后端了。

## 建议

**强烈推荐使用 Railway**，因为：
1. 零代码改动
2. 功能完整
3. 部署简单
4. 成本低廉

---

需要我帮你完成 Railway 部署吗？
