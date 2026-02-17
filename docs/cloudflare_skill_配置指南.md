# Cloudflare Manager Skill 配置指南

## ✅ 安装状态

- **Skill 位置**: `C:\Users\linga\.gemini\antigravity\skills\cloudflare-manager`
- **Bun 运行时**: ✅ 已安装 (v1.3.9)
- **依赖包**: ✅ 已安装

## 📋 下一步：配置 API 密钥

### 1. 获取 Cloudflare API Token

1. 访问 [Cloudflare API Tokens 页面](https://dash.cloudflare.com/profile/api-tokens)
2. 点击 **"Create Token"** (创建令牌)
3. 选择 **"Edit Cloudflare Workers"** 模板，或创建自定义令牌

#### 所需权限：

- ✅ **Account > Workers Scripts > Edit** (编辑)
- ✅ **Account > Workers KV Storage > Edit** (编辑)
- ✅ **Account > Workers R2 Storage > Edit** (编辑)
- ✅ **Account > Cloudflare Pages > Edit** (编辑)
- ✅ **Zone > DNS > Edit** (编辑，如果使用自定义域名)

4. 创建后，**复制生成的 API Token**（只会显示一次）

### 2. 配置环境变量

在您的项目根目录创建 `.env` 文件：

```bash
# 在项目根目录 (d:\Desktop\ai\dist_package)
CLOUDFLARE_API_KEY=your_api_token_here
CLOUDFLARE_ACCOUNT_ID=your_account_id  # 可选，会自动检测
```

**重要提示**：
- ⚠️ 将 `.env` 添加到 `.gitignore`，避免泄露密钥
- ⚠️ 不要在代码中硬编码 API 密钥
- ⚠️ 建议每 90 天轮换一次令牌

### 3. 验证配置

运行验证脚本检查 API 密钥和权限：

```powershell
# 使用完整路径运行
C:\Users\linga\.bun\bin\bun.exe C:\Users\linga\.gemini\antigravity\skills\cloudflare-manager\scripts\validate-api-key.ts
```

**预期输出**：
```
✅ API key is valid!
ℹ️ Token Status: active
ℹ️ Account: Your Account Name (abc123...)
🔑 Granted Permissions:
  ✅ Workers Scripts: Edit
  ✅ Workers KV Storage: Edit
  ✅ Workers R2 Storage: Edit
```

## 🚀 基本使用示例

### 部署 Worker

```powershell
# 部署一个新的 Worker
C:\Users\linga\.bun\bin\bun.exe C:\Users\linga\.gemini\antigravity\skills\cloudflare-manager\scripts\workers.ts deploy worker-name ./worker-script.js
```

### 创建 KV 命名空间

```powershell
# 创建 KV 存储命名空间
C:\Users\linga\.bun\bin\bun.exe C:\Users\linga\.gemini\antigravity\skills\cloudflare-manager\scripts\kv-storage.ts create-namespace my-cache

# 写入数据
C:\Users\linga\.bun\bin\bun.exe C:\Users\linga\.gemini\antigravity\skills\cloudflare-manager\scripts\kv-storage.ts write <namespace-id> "key1" "value1"
```

### 创建 R2 存储桶

```powershell
# 创建 R2 bucket
C:\Users\linga\.bun\bin\bun.exe C:\Users\linga\.gemini\antigravity\skills\cloudflare-manager\scripts\r2-storage.ts create-bucket my-media

# 上传文件
C:\Users\linga\.bun\bin\bun.exe C:\Users\linga\.gemini\antigravity\skills\cloudflare-manager\scripts\r2-storage.ts upload my-media ./file.png file.png
```

### 部署 Pages 项目

```powershell
# 创建 Pages 项目
C:\Users\linga\.bun\bin\bun.exe C:\Users\linga\.gemini\antigravity\skills\cloudflare-manager\scripts\pages.ts deploy my-app ./dist
```

## 📚 更多资源

- **Skill 文档**: `C:\Users\linga\.gemini\antigravity\skills\cloudflare-manager\SKILL.md`
- **使用示例**: `C:\Users\linga\.gemini\antigravity\skills\cloudflare-manager\examples.md`
- **Cloudflare API 文档**: https://developers.cloudflare.com/api/
- **Workers 文档**: https://developers.cloudflare.com/workers/

## 🔧 故障排除

### 问题：找不到 bun 命令

**解决方案**：使用完整路径或重启终端
```powershell
C:\Users\linga\.bun\bin\bun.exe --version
```

### 问题：API 密钥未找到

**解决方案**：确保 `.env` 文件在项目根目录
```powershell
# 检查文件是否存在
Get-Content .env | Select-String "CLOUDFLARE_API_KEY"
```

### 问题：权限不足

**解决方案**：在 Cloudflare Dashboard 更新令牌权限
- 访问 https://dash.cloudflare.com/profile/api-tokens
- 编辑您的令牌，添加所需权限

## 💡 最佳实践

1. **安全性**
   - 永远不要提交 `.env` 文件到 Git
   - 使用基于令牌的身份验证（不是 API 密钥）
   - 定期轮换令牌

2. **性能**
   - Workers 在边缘运行，延迟最小
   - KV 适合频繁读取的数据（不适合频繁写入）
   - R2 适合大文件（KV 每个键限制 25MB）

3. **命名规范**
   - Workers: 使用描述性名称（如 `user-auth-worker`）
   - KV 命名空间: 包含用途（如 `app-sessions`）
   - R2 buckets: 使用小写和连字符（如 `media-assets-prod`）

---

**安装完成时间**: 2026-02-17
**Bun 版本**: 1.3.9
**Skill 版本**: 1.0.0
