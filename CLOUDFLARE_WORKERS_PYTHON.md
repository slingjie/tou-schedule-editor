# Cloudflare Workers Python 部署方案

## 🎉 好消息

Cloudflare Workers 现已原生支持 **Python + FastAPI**！

### 优势
- ✅ **原生支持** Python (Pyodide/WebAssembly)
- ✅ **支持 FastAPI** 框架
- ✅ **冷启动比 AWS Lambda 快 2.4 倍**
- ✅ **全球 330+ 边缘节点**
- ✅ **免费额度**: 10万次请求/天
- ✅ **零配置** HTTPS + 自定义域名

---

## 快速部署步骤

### 1. 安装 pywrangler CLI

```bash
# 安装 uv (Python 包管理器)
curl -LsSf https://astral.sh/uv/install.sh | sh

# 或使用 pip
pip install uv

# 验证安装
uv --version
```

### 2. 创建 Workers 项目

```bash
# 创建新项目
mkdir cf-workers-backend
cd cf-workers-backend

# 创建 pyproject.toml
cat > pyproject.toml << 'EOF'
[project]
name = "tou-schedule-backend"
version = "0.1.0"
description = "TOU Schedule Editor Backend on Cloudflare Workers"
requires-python = ">=3.12"
dependencies = [
    "fastapi>=0.111.0",
    "httpx>=0.27.0",
]

[dependency-groups]
dev = [
    "workers-py",
    "workers-runtime-sdk",
]
EOF

# 创建入口文件
mkdir -p src
cat > src/entry.py << 'EOF'
from workers import WorkerEntrypoint
from fastapi import FastAPI
import asgi

app = FastAPI()

@app.get("/")
async def root():
    return {"message": "TOU Schedule Backend on Cloudflare Workers"}

@app.get("/health")
async def health():
    return {"status": "healthy"}

class Default(WorkerEntrypoint):
    async def fetch(self, request):
        return await asgi.fetch(app, request, self.env)
EOF

# 创建 wrangler 配置
cat > wrangler.toml << 'EOF'
name = "tou-schedule-backend"
main = "src/entry.py"
compatibility_flags = ["python_workers"]
compatibility_date = "2026-02-11"

[vars]
API_HOST = "api.example.com"

# 添加密钥（部署后设置）
# wrangler secret put GEMINI_API_KEY
EOF
```

### 3. 本地测试

```bash
# 安装依赖
uv sync

# 启动开发服务器
uv run pywrangler dev

# 测试访问
# http://localhost:8787
# http://localhost:8787/health
```

### 4. 部署到 Cloudflare

```bash
# 登录 Cloudflare
npx wrangler login

# 部署
uv run pywrangler deploy

# 设置环境变量（API 密钥等）
wrangler secret put GEMINI_API_KEY
```

### 5. 获取部署地址

部署成功后会显示：
```
✨ Successfully deployed!
🌎 https://tou-schedule-backend.your-subdomain.workers.dev
```

---

## 迁移现有 FastAPI 代码

### 主要改动

1. **入口文件** - 使用 Workers 入口类
2. **ASGI 适配** - 使用 `asgi.fetch()`
3. **环境变量** - 使用 `self.env`
4. **文件上传** - 需要考虑 Workers 限制

### 示例：迁移数据加载 API

```python
from workers import WorkerEntrypoint
from fastapi import FastAPI, UploadFile, File, HTTPException
import asgi
import pandas as pd
from io import BytesIO

app = FastAPI()

# 原有的 API 端点
@app.post("/api/load-data")
async def load_data(file: UploadFile = File(...)):
    try:
        contents = await file.read()
        df = pd.read_excel(BytesIO(contents))
        return {"data": df.to_dict()}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

@app.get("/health")
async def health():
    return {"status": "ok"}

# Workers 入口
class Default(WorkerEntrypoint):
    async def fetch(self, request):
        return await asgi.fetch(app, request, self.env)
```

---

## 限制和注意事项

### ⚠️ 当前限制（Python Workers Beta）

1. **文件系统访问受限** - 无法直接读写本地文件
2. **某些包不支持** - 纯 Python 包支持较好，C 扩展有限
3. **内存限制** - 每次请求有内存限制
4. **启动时间** - 首次冷启动可能有几百毫秒延迟

### 解决方案

1. **文件存储** - 使用 Cloudflare R2 代替本地文件
2. **数据库存储** - 使用 Cloudflare D1 (SQLite) 或外部数据库
3. **缓存** - 使用 Cloudflare KV

---

## 与前端集成

### 更新前端 API 地址

```bash
# .env.local
VITE_BACKEND_BASE_URL=https://tou-schedule-backend.your-subdomain.workers.dev
```

### CORS 配置

```python
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "https://4c5ac2be.tou-schedule-editor.pages.dev",
        "http://localhost:5173",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
```

---

## 完整部署命令

我已为你准备了一键部署脚本：

```bash
# 运行部署脚本
./deploy-cloudflare-workers.sh
```

或手动执行：

```bash
cd backend
cp -r ../backend/* src/
uv sync
uv run pywrangler deploy
```

---

## 对比其他方案

| 方案 | 部署复杂度 | 性能 | 成本 | 维护 |
|------|-----------|------|------|------|
| **Cloudflare Workers** | ⭐ 简单 | ⭐⭐⭐ 极好 | 免费/低价 | 无服务器 |
| Railway | ⭐⭐ 中等 | ⭐⭐ 好 | $5/月起 | 需管理 |
| Render | ⭐⭐ 中等 | ⭐⭐ 好 | 免费/慢 | 需管理 |
| Supabase Edge | ⭐⭐⭐ 复杂 | ⭐⭐ 好 | 免费/按量 | 需管理 |

---

## 🚀 推荐

如果你的应用：
- ✅ 主要是 API 请求
- ✅ 数据处理逻辑
- ✅ 需要全球低延迟

**Cloudflare Workers + Python 是最佳选择！**

---

**要我帮你创建完整的 Workers 配置文件吗？**
