# Cloudflare Workers Python 后端

## 项目结构

```
workers-backend/
├── src/
│   └── entry.py          # Workers 入口文件
├── pyproject.toml        # Python 依赖配置
├── wrangler.toml         # Cloudflare Workers 配置
└── README.md            # 本文件
```

## 快速开始

### 前置要求

- Node.js (>= 18)
- Python (>= 3.11)
- uv (Python 包管理器)

### 安装 uv

```bash
# Windows
powershell -Command "irm https://astral.sh/uv/install.ps1 | iex"

# Mac/Linux
curl -LsSf https://astral.sh/uv/install.sh | sh
```

### 本地开发

```bash
# 进入项目目录
cd workers-backend

# 安装依赖
uv sync

# 启动开发服务器
uv run pywrangler dev

# 访问 http://localhost:8787
```

### 部署到 Cloudflare

```bash
# 方法 1: 使用脚本（推荐）
cd ..
./deploy-workers.sh          # Mac/Linux
# 或
deploy-workers.bat           # Windows

# 方法 2: 手动部署
cd workers-backend
uv run pywrangler deploy

# 设置环境变量（API密钥等）
npx wrangler secret put GEMINI_API_KEY
```

## API 端点

### GET /
服务信息

### GET /health
健康检查

### POST /api/analyze
分析电价 schedule

请求体：
```json
{
  "schedule_data": {
    "time_slots": [...],
    "prices": [0.5, 0.8, 1.2, ...],
    "metadata": {}
  },
  "analysis_type": "basic"
}
```

### POST /api/calculate-profit
计算储能收益（简化版）

### GET /api/config
获取配置信息

## Workers 限制

### ⚠️ 已知限制

1. **无文件系统** - 不能读写本地文件
   - 解决方案：使用 Cloudflare R2 存储文件
   
2. **部分包不支持** - C 扩展包可能无法使用
   - 当前使用：FastAPI, Pydantic, httpx（纯 Python）
   
3. **内存限制** - 单次请求有 128MB 内存限制
   - 建议：处理大数据时分批处理

4. **执行时间** - 单次请求最多 30 秒（免费版）
   - 建议：长时间计算使用 Durable Objects 或队列

### 支持的包

✅ FastAPI
✅ Pydantic
✅ httpx
✅ 纯 Python 包

❌ Pandas（部分功能受限）
❌ NumPy（部分功能受限）
❌ 需要 C 编译的包

## 与前端集成

部署成功后，获取 Workers URL（如：`https://tou-schedule-backend.xxx.workers.dev`）

更新前端配置：

```bash
cd ..
echo "VITE_BACKEND_BASE_URL=https://tou-schedule-backend.xxx.workers.dev" > .env.local
npm run build
npm run deploy
```

## 监控和日志

### 查看日志

```bash
# 实时日志
npx wrangler tail

# 或在 Cloudflare Dashboard 查看
# https://dash.cloudflare.com → Workers & Pages → tou-schedule-backend
```

### 性能指标

在 Cloudflare Dashboard 中查看：
- 请求次数
- 错误率
- CPU 使用时间
- 内存使用

## 故障排除

### 部署失败

1. 检查 Cloudflare 登录状态：`npx wrangler whoami`
2. 检查依赖是否安装：`uv sync`
3. 查看详细错误：`uv run pywrangler deploy --verbose`

### 502/503 错误

- 首次部署后等待 1-2 分钟全球生效
- 检查 Workers 日志：`npx wrangler tail`

### CORS 错误

- 确保 CORS 配置正确（已在 entry.py 中配置）
- 检查前端 URL 是否在 allow_origins 列表中

## 资源

- [Cloudflare Workers Python 文档](https://developers.cloudflare.com/workers/languages/python/)
- [FastAPI on Workers](https://developers.cloudflare.com/workers/languages/python/packages/fastapi/)
- [Workers 限制](https://developers.cloudflare.com/workers/platform/limits/)
