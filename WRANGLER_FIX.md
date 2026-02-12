# Wrangler 登录错误修复指南

## 问题
Wrangler 4.50.0 版本存在登录 bug，需要升级到最新版。

## 解决方案

### 方案 1: 升级 Wrangler（推荐）

```bash
# 全局升级 wrangler
npm install -g wrangler@latest

# 验证版本
wrangler --version
# 应显示 4.64.0 或更高

# 重新登录
wrangler login
```

### 方案 2: 使用 npx 运行最新版

```bash
# 不安装全局，直接使用最新版
npx wrangler@latest login

# 部署时也使用最新版
npx wrangler@latest deploy
```

### 方案 3: 清除缓存后重试

```bash
# Windows
rmdir /s /q %LOCALAPPDATA%\.wrangler

# 然后重新登录
npx wrangler@latest login
```

### 方案 4: 使用 API Token 直接认证（绕过登录）

1. 访问 https://dash.cloudflare.com/profile/api-tokens
2. 点击 "Create Token"
3. 使用 "Edit Cloudflare Workers" 模板
4. 创建后复制 Token

```bash
# 设置环境变量（Windows CMD）
set CLOUDFLARE_API_TOKEN=你的token

# 然后直接部署，无需登录
npx wrangler deploy
```

---

## 推荐的快速修复

在 CMD 中执行：

```cmd
:: 1. 清理旧版本缓存
rmdir /s /q %LOCALAPPDATA%\.wrangler 2>nul

:: 2. 使用最新版登录
npx wrangler@latest login

:: 3. 进入项目目录部署
cd D:\Desktop\ai\dist_package\workers-backend
npx wrangler@latest deploy
```

---

## 如果还是不行

### 备选方案 A: 使用 Cloudflare Dashboard 部署

1. 访问 https://dash.cloudflare.com
2. Workers & Pages → Create application
3. 上传代码文件

### 备选方案 B: 改用 Railway 部署

```cmd
start https://railway.app/new
```
选择 GitHub 仓库，自动部署，无需 Wrangler。

---

## 验证修复

执行以下命令验证：

```cmd
npx wrangler@latest --version
:: 应显示 4.64.0

npx wrangler@latest whoami
:: 应显示你的账号信息
```

---

**请尝试方案 1 或方案 2，通常可以解决问题！**
