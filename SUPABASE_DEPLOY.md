# Supabase 部署方案

## 方案选择

### 方案 A: 使用 Supabase PostgreSQL + Railway/Render（推荐）
将数据存储迁移到 Supabase PostgreSQL，后端仍部署在 Railway/Render

### 方案 B: 重构为 Supabase Edge Functions
将 FastAPI 代码重写为 Supabase Edge Functions (TypeScript/Deno)

### 方案 C: 使用 Supabase Docker 部署
将整个 FastAPI 应用作为 Docker 容器部署到 Supabase

---

## 当前推荐: 方案 A（数据库迁移）

### 1. 创建 Supabase 项目

访问: https://supabase.com
1. 注册/登录
2. 创建新项目
3. 复制 Project URL 和 API Key

### 2. 配置环境变量

在 Railway/Render 的环境变量中添加：
```
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_KEY=your-anon-key
SUPABASE_SERVICE_KEY=your-service-role-key
```

### 3. 数据库迁移

Supabase 提供 PostgreSQL 数据库，可以：
- 使用 Supabase Dashboard 创建表
- 或使用 SQL 迁移文件

### 4. 更新后端代码

添加 Supabase 客户端连接数据库。

---

**请确认你想要的方案：**
- **A**: 保留 FastAPI，只用 Supabase 作为数据库
- **B**: 完全迁移到 Supabase Edge Functions（需要重写代码）
- **C**: 其他方式

回复 A、B 或 C，我将为你配置！
