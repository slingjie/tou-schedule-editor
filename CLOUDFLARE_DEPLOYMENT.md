# TOU Schedule Editor 完整部署文档

## 部署架构概览

```
┌─────────────────────────────────────────────────────────────────┐
│                        Cloudflare                                │
│  ┌─────────────────────┐    ┌──────────────────────────────┐  │
│  │   Cloudflare Pages  │    │    Cloudflare Workers        │  │
│  │   (前端 React)      │    │    (Python FastAPI 后端)     │  │
│  │                     │    │                              │  │
│  │ pages.dev/...       │───►│ workers.dev/api/...          │  │
│  └─────────────────────┘    └──────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

## 目录

- [前置要求](#前置要求)
- [1. 安装依赖](#1-安装依赖)
- [2. 配置 Cloudflare](#2-配置-cloudflare)
- [3. 部署后端 (Workers Python)](#3-部署后端-workers-python)
- [4. 部署前端 (Pages)](#4-部署前端-pages)
- [5. 验证部署](#5-验证部署)
- [6. 环境变量配置](#6-环境变量配置)
- [常见问题](#常见问题)

---

## 前置要求

### 必需工具

| 工具 | 版本要求 | 安装方式 |
|------|----------|----------|
| Node.js | >= 18 | [官网下载](https://nodejs.org/) |
| Python | >= 3.11 | [官网下载](https://www.python.org/) |
| npm | 随 Node 安装 | - |
| uv | 最新 | `pip install uv` |
| Wrangler | >= 3.0 | `npm install -g wrangler` |
| Git | 任意 | [官网下载](https://git-scm.com/) |

### Cloudflare 账号

1. 注册 [Cloudflare 账号](https://cloudflare.com/)
2. 完成邮箱验证

---

## 1. 安装依赖

### 1.1 克隆项目

```bash
git clone <your-repo-url>
cd dist_package
```

### 1.2 安装前端依赖

```bash
npm install
```

### 1.3 安装 uv (Python 包管理器)

```bash
# Windows (PowerShell)
powershell -Command "irm https://astral.sh/uv/install.ps1 | iex"

# Mac/Linux
curl -LsSf https://astral.sh/uv/install.sh | sh
```

### 1.4 安装后端依赖

```bash
cd workers-backend
uv sync
cd ..
```

### 1.5 登录 Cloudflare

```bash
npx wrangler login
```

这会打开浏览器让你授权。

---

## 2. 配置 Cloudflare

### 2.1 创建 Workers 项目

首次部署时会自动创建，无需手动创建。

### 2.2 配置 CORS

后端已预配置允许的前端域名：

```python
# workers-backend/src/entry.py
allow_origins = [
    "https://4c5ac2be.tou-schedule-editor.pages.dev",  # 你的 Pages URL
    "https://tou-schedule-editor.pages.dev",           # 自定义域名(如有)
    "http://localhost:5173",                            # 本地开发
    "http://localhost:4173",                            # 本地预览
]
```

**注意**: 首次部署后需要将实际的 Pages URL 添加到此列表。

---

## 3. 部署后端 (Workers Python)

### 3.1 部署命令

```bash
cd workers-backend
npx wrangler deploy
```

### 3.2 记录后端 URL

部署成功后，输出类似：
```
Uploaded tou-schedule-backend (3.25 sec)
Published tou-schedule-backend (3.25 sec)
https://tou-schedule-backend.your-account.workers.dev
```

**保存这个 URL**，后面配置前端需要用到。

### 3.3 设置环境变量 (可选)

如果后端需要 API 密钥：

```bash
# 例如设置 Gemini API Key
npx wrangler secret put GEMINI_API_KEY
# 输入你的 API 密钥
```

---

## 4. 部署前端 (Pages)

### 4.1 配置后端 URL

在项目根目录创建 `.env.production` 文件：

```bash
# 替换为你的 Workers URL (不带末尾斜杠)
VITE_BACKEND_BASE_URL=https://tou-schedule-backend.your-account.workers.dev
```

### 4.2 构建并部署

```bash
# 部署到生产环境
npm run deploy
```

### 4.3 部署到 Staging (测试环境)

```bash
# 部署到 staging 分支
npm run deploy:staging
```

---

## 5. 验证部署

### 5.1 检查后端健康

```bash
# 替换为你的后端 URL
curl https://tou-schedule-backend.your-account.workers.dev/health
```

预期响应：
```json
{
  "status": "healthy",
  "service": "tou-schedule-backend", 
  "version": "1.0.0"
}
```

### 5.2 检查前端

访问 `https://tou-schedule-editor.pages.dev`

### 5.3 测试完整流程

1. 在前端上传负荷文件
2. 触发分析功能
3. 检查是否正常返回结果

---

## 6. 环境变量配置

### 前端环境变量

| 变量名 | 描述 | 示例 |
|--------|------|------|
| `VITE_BACKEND_BASE_URL` | 后端 API 地址 | `https://tou-schedule-backend.xxx.workers.dev` |

**重要**: Cloudflare Pages 部署时需要在 Cloudflare Dashboard 中设置：

1. 打开 [Cloudflare Dashboard](https://dash.cloudflare.com)
2. 进入 **Workers & Pages** → 你的项目 → **设置** → **环境变量**
3. 添加 `VITE_BACKEND_BASE_URL`

### 后端环境变量

| 变量名 | 描述 | 是否必需 |
|--------|------|----------|
| `GEMINI_API_KEY` | Gemini AI API 密钥 | 可选 |

---

## 部署命令速查

```bash
# ============ 后端 ============

# 本地开发
cd workers-backend
uv run pywrangler dev

# 部署后端
cd workers-backend
npx wrangler deploy

# 查看后端日志
npx wrangler tail

# 设置密钥
npx wrangler secret put GEMINI_API_KEY

# ============ 前端 ============

# 本地开发 (后端需要单独启动)
npm run dev

# 本地预览生产构建
npm run preview

# 部署前端
npm run deploy

# 部署到 staging
npm run deploy:staging
```

---

## 常见问题

### Q1: 部署后 CORS 错误

**问题**: 前端调用 API 时出现 CORS 错误

**解决**: 
1. 确认后端 `allow_origins` 包含你的 Pages URL
2. 重新部署后端: `cd workers-backend && npx wrangler deploy`

### Q2: 前端找不到后端 API

**问题**: 前端显示 "后端不支持此功能"

**解决**:
1. 确认 `.env.production` 中 `VITE_BACKEND_BASE_URL` 正确
2. 在 Cloudflare Dashboard 中也设置该环境变量
3. 重新部署前端

### Q3: 首次部署需要等待

**问题**: 部署后 502/503 错误

**解决**: 等待 1-2 分钟全球节点同步

### Q4: Python 包安装失败

**问题**: uv sync 失败

**解决**:
```bash
# 确保 Python 3.11+
python --version

# 清理缓存重试
rm -rf .venv
uv sync
```

### Q5: 如何回滚版本

```bash
# 查看部署历史
npx wrangler deployments list

# 回滚到指定版本
npx wrangler rollback [deployment-id]
```

---

## 项目结构

```
dist_package/
├── frontend/                    # 前端 React 应用
│   ├── src/
│   │   ├── components/         # React 组件
│   │   ├── hooks/              # 自定义 hooks
│   │   ├── api.ts              # 配置管理 API (localStorage)
│   │   ├── loadApi.ts          # 负荷分析 API
│   │   ├── storageApi.ts       # 储能分析 API
│   │   └── ...
│   ├── package.json
│   └── vite.config.ts
│
├── workers-backend/             # Cloudflare Workers Python 后端
│   ├── src/
│   │   └── entry.py            # FastAPI 应用入口
│   ├── pyproject.toml          # Python 依赖
│   └── wrangler.toml           # Workers 配置
│
├── functions/                   # Cloudflare Pages Functions (可选)
│   └── api/
│
└── package.json                  # 前端 npm 配置
```

---

## 注意事项

1. **VITE_BACKEND_BASE_URL 为空**: Cloudflare Pages 部署时此变量应为空字符串，因为 Pages Functions 与前端同源

2. **Workers 限制**:
   - 无文件系统 (如需文件存储用 R2)
   - 内存限制 128MB
   - 执行时间限制 30秒 (免费版)

3. **免费额度**:
   - Workers: 100,000 请求/天
   - Pages: 500 请求/天
   - 超出后按量收费

---

## 技术支持

- [Cloudflare Workers 文档](https://developers.cloudflare.com/workers/)
- [Cloudflare Pages 文档](https://developers.cloudflare.com/pages/)
- [FastAPI on Workers](https://developers.cloudflare.com/workers/languages/python/packages/fastapi/)
