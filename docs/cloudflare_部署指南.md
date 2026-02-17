# Cloudflare Pages 部署指南

本文档记录了将项目部署到 Cloudflare Pages 的完整流程和常见问题解决方法。

## 前置条件

1. **已安装 Node.js 和 npm**
2. **已登录 Cloudflare Wrangler CLI**（首次使用需执行 `wrangler login`）
3. **已在 Cloudflare 创建 Pages 项目**（项目名：`tou-schedule-editor`）

## 快速部署

### 方式一：使用 npm 脚本（推荐）

```bash
# 生产环境部署
npm run deploy

# 或部署到 staging 分支
npm run deploy:staging
```

### 方式二：手动分步部署

```bash
# 1. 构建前端
npm run build

# 2. 部署到 Cloudflare Pages
wrangler pages deploy dist --project-name=tou-schedule-editor
```

## 常见问题与解决方法

### 问题 1：Git 未提交更改警告

**现象**：
```
▲ [WARNING] Warning: Your working directory is a git repo and has uncommitted changes
```

**原因**：工作区有未提交的 Git 更改

**解决方法**：
```bash
# 方法 1：提交更改后再部署
git add .
git commit -m "描述你的更改"
wrangler pages deploy dist --project-name=tou-schedule-editor

# 方法 2：使用 --commit-dirty 参数强制部署
wrangler pages deploy dist --project-name=tou-schedule-editor --commit-dirty=true
```

### 问题 2：构建失败或超时

**现象**：`npm run build` 失败或卡住不动

**解决方法**：
```bash
# 清理缓存后重试
rm -rf node_modules/.vite
npm run build

# 如果仍失败，清理并重装依赖
rm -rf node_modules
npm install
npm run build
```

### 问题 3：部署后页面显示 404

**原因**：可能是路由配置或 Functions 路径问题

**检查项**：
- 确认 `functions/` 目录结构正确
- 检查 `wrangler.toml` 中的 `pages_build_output_dir = "dist"` 配置
- 查看 Cloudflare Dashboard 的 Functions 日志

### 问题 4：环境变量未生效

**解决方法**：在 Cloudflare Dashboard 中配置环境变量
1. 进入 Pages 项目设置
2. 点击 "Settings" → "Environment variables"
3. 添加所需环境变量（如 API keys）
4. 重新部署触发更新

## 部署验证

部署成功后，访问部署 URL 验证：

```bash
# 部署输出会显示类似信息：
✨ Deployment complete! Take a peek over at https://[hash].tou-schedule-editor.pages.dev
```

**验证步骤**：
1. 访问部署 URL
2. 测试关键功能（如负荷分析、储能测算）
3. 检查 Functions 是否正常工作（如 `/api/storage/cycles`）
4. 对比本地和线上计算结果是否一致

## 生产部署vs预览部署

- **生产部署**：`npm run deploy` - 部署到主分支，使用生产域名
- **预览部署**：`npm run deploy:staging` - 部署到 staging 分支，获得预览 URL
- **自动部署**：连接 GitHub 后，每次 push 自动触发部署

## 回滚操作

如需回滚到之前的版本：

1. 进入 Cloudflare Dashboard → Pages 项目
2. 点击 "Deployments" 查看历史部署
3. 选择目标版本，点击 "Rollback to this deployment"

## 查看日志

```bash
# 查看实时日志（需要 wrangler tail 命令）
wrangler pages deployment tail

# 或在 Cloudflare Dashboard 查看：
# Pages 项目 → Functions → 选择部署 → View logs
```

## 相关文档

- [Cloudflare Pages 官方文档](https://developers.cloudflare.com/pages/)
- [Wrangler CLI 文档](https://developers.cloudflare.com/workers/wrangler/)
- 项目配置文件：`wrangler.toml`
- 部署脚本：`package.json` (scripts 部分)
