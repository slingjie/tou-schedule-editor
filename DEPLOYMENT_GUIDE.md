# TOU Schedule Editor - 部署与开发指南

## 📋 项目概述

全栈应用：React + TypeScript 前端 + Cloudflare Pages Functions 后端

### 技术栈
- **前端**: React 19 + Vite 6 + TypeScript
- **后端**: Cloudflare Pages Functions (JavaScript)
- **部署**: Cloudflare Pages (全托管)
- **代码托管**: GitHub

---

## 🏗️ 项目架构

```
dist_package/
├── 前端代码 (React + Vite)
│   ├── src/
│   ├── index.html
│   └── vite.config.ts
│
├── 后端 API (Pages Functions)
│   └── functions/
│       └── api/
│           ├── index.js          # 服务信息
│           ├── health.js         # 健康检查
│           ├── analyze.js        # 数据分析
│           ├── calculate-profit.js # 收益计算
│           └── config.js         # 配置信息
│
├── 构建输出
│   └── dist/                     # Vite 构建输出
│
└── 配置文件
    ├── wrangler.toml             # Cloudflare 配置
    ├── package.json
    └── .env.local                # 环境变量
```

---

## 🚀 部署流程

### 1. 开发环境准备

```bash
# 1. 克隆代码
git clone https://github.com/slingjie/tou-schedule-editor.git
cd tou-schedule-editor

# 2. 安装依赖
npm install

# 3. 本地开发
npm run dev
# 访问 http://localhost:5173
```

### 2. 前端部署 (Cloudflare Pages)

```bash
# 1. 构建
npm run build

# 2. 部署
npm run deploy
# 或
npx wrangler pages deploy dist --project-name=tou-schedule-editor
```

**部署后地址**: `https://[hash].tou-schedule-editor.pages.dev`

### 3. 后端部署 (自动)

Functions 目录 (`functions/`) 中的代码会自动随前端一起部署。

**无需单独部署后端！**

### 4. GitHub 集成 (可选但推荐)

```bash
# 推送代码
git add .
git commit -m "Your changes"
git push origin main
```

---

## ⚙️ 配置说明

### 环境变量 (.env.local)

```bash
# 后端 API 地址
VITE_BACKEND_BASE_URL=https://[your-domain].pages.dev

# Gemini API 密钥（如需 AI 功能）
GEMINI_API_KEY=your_api_key_here
```

### Cloudflare 配置 (wrangler.toml)

```toml
name = "tou-schedule-editor"
compatibility_date = "2026-02-11"

# 环境变量
[vars]
ENVIRONMENT = "production"

# 密钥（敏感信息）
# wrangler secret put GEMINI_API_KEY
```

### CORS 配置

已在 `functions/api/*.js` 中配置：

```javascript
headers: {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
}
```

---

## 📁 后端 API 开发

### 创建新端点

1. 在 `functions/api/` 目录创建 `.js` 文件
2. 使用命名导出 `onRequest` 或 `onRequestPost`

**示例** (`functions/api/example.js`):

```javascript
// GET 请求
export async function onRequest(context) {
  const { request, env } = context;
  
  return new Response(
    JSON.stringify({ message: "Hello from API" }),
    {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    }
  );
}

// POST 请求
export async function onRequestPost(context) {
  const { request } = context;
  const data = await request.json();
  
  // 处理数据...
  
  return new Response(
    JSON.stringify({ success: true, data }),
    {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    }
  );
}

// OPTIONS 请求（CORS 预检）
export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    }
  });
}
```

### 前端调用 API

```typescript
// api.ts
const API_BASE = import.meta.env.VITE_BACKEND_BASE_URL || '';

export async function analyzeData(data: any) {
  const response = await fetch(`${API_BASE}/api/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
  return response.json();
}
```

---

## 🔧 本地开发

### 启动开发服务器

```bash
# 前端开发服务器
npm run dev

# 访问 http://localhost:5173
```

**注意**: 本地开发时 Functions 不会自动运行，需要：

```bash
# 使用 wrangler 本地运行（包含 Functions）
npx wrangler pages dev dist
```

### 测试 API

```bash
# 健康检查
curl http://localhost:8788/api/health

# 数据分析
curl -X POST http://localhost:8788/api/analyze \
  -H "Content-Type: application/json" \
  -d '{"prices":[0.5,0.8,1.2]}'
```

---

## 🚀 部署工作流

### 标准部署流程

```bash
# 1. 开发完成，测试通过
npm run dev

# 2. 构建生产版本
npm run build

# 3. 部署到 Cloudflare
npm run deploy

# 4. 测试线上版本
# 访问 https://[hash].tou-schedule-editor.pages.dev

# 5. 提交代码到 GitHub
git add .
git commit -m "Deploy: feature description"
git push origin main
```

### 自动化部署 (推荐)

配置 GitHub Actions 实现自动部署：

1. 在 Cloudflare Dashboard 获取 API Token
2. 在 GitHub 仓库 Settings → Secrets 添加 `CLOUDFLARE_API_TOKEN`
3. 推送代码到 main 分支自动触发部署

---

## 📊 现有 API 端点

| 端点 | 方法 | 描述 | 输入 | 输出 |
|------|------|------|------|------|
| `/api/` | GET | 服务信息 | - | `{service, version, endpoints}` |
| `/api/health` | GET | 健康检查 | - | `{status, service}` |
| `/api/analyze` | POST | 数据分析 | `{prices, time_slots}` | 统计分析结果 |
| `/api/calculate-profit` | POST | 收益计算 | `{capacity_mwh, efficiency}` | 收益估算 |
| `/api/config` | GET | 配置信息 | - | 支持的特性列表 |

---

## ⚠️ 限制与注意事项

### Cloudflare Pages Functions 限制

1. **请求次数**
   - 免费版: 10万次/天
   - 付费版: 无限

2. **执行时间**
   - CPU 时间: 50ms/请求
   - 实际执行: 无限制（但需快速响应）

3. **不支持的功能**
   - 文件系统读写
   - 长时间计算（>30s）
   - WebSocket
   - 某些 Node.js 模块

4. **内存限制**
   - 每次请求 128MB

### 最佳实践

1. **API 设计**
   - 保持端点轻量级
   - 使用异步处理
   - 添加错误处理

2. **性能优化**
   - 启用 CDN 缓存
   - 压缩响应数据
   - 使用分页处理大数据

3. **安全性**
   - 验证所有输入
   - 使用 HTTPS
   - 敏感信息使用 wrangler secrets

---

## 🐛 故障排除

### 常见问题

#### 1. 构建失败

```bash
# 清理缓存
rm -rf node_modules dist
npm install
npm run build
```

#### 2. 部署失败

```bash
# 检查 wrangler 登录
npx wrangler whoami

# 重新登录
npx wrangler login

# 再部署
npm run deploy
```

#### 3. API 404 错误

- 检查 `functions/api/` 目录是否存在
- 确认文件命名正确（`[name].js`）
- 重新构建并部署

#### 4. CORS 错误

- 确保所有 API 响应包含 CORS headers
- 检查 `Access-Control-Allow-Origin` 设置

#### 5. 环境变量未生效

```bash
# 检查 .env.local 是否存在
ls .env.local

# 重新构建（环境变量在构建时注入）
npm run build
```

---

## 🔄 回滚部署

如果需要回滚到之前的版本：

```bash
# 查看部署历史
npx wrangler pages deployment list --project-name=tou-schedule-editor

# 回滚到指定版本
npx wrangler pages deployment tail --project-name=tou-schedule-editor

# 或在 Cloudflare Dashboard 手动回滚
# https://dash.cloudflare.com → Pages → tou-schedule-editor → Deployments
```

---

## 📝 开发检查清单

### 提交代码前

- [ ] 本地测试通过 (`npm run dev`)
- [ ] 构建成功 (`npm run build`)
- [ ] 无 TypeScript 错误
- [ ] 代码已格式化
- [ ] .env.local 未提交敏感信息

### 部署前

- [ ] 环境变量已更新
- [ ] API 端点已测试
- [ ] CORS 配置正确
- [ ] 生产构建成功

### 部署后

- [ ] 线上版本可访问
- [ ] API 响应正常
- [ ] 无控制台错误
- [ ] 移动端测试通过

---

## 🔗 有用链接

- **Cloudflare Dashboard**: https://dash.cloudflare.com
- **GitHub 仓库**: https://github.com/slingjie/tou-schedule-editor
- **生产环境**: https://eaf183da.tou-schedule-editor.pages.dev
- **本地开发**: http://localhost:5173

---

## 📚 参考文档

- [Cloudflare Pages Functions](https://developers.cloudflare.com/pages/functions/)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/)
- [Vite 部署指南](https://vitejs.dev/guide/static-deploy.html)
- [React 文档](https://react.dev/)

---

**最后更新**: 2026-02-12
**版本**: 1.0.0
**维护者**: slingjie
