# Railway MCP 部署指南

## 什么是 Railway MCP？

Railway MCP (Model Context Protocol) Server 允许你通过自然语言命令与 Railway 交互，自动完成：
- 创建项目
- 部署服务
- 管理环境变量
- 查看日志

## 安装 Railway MCP Server

### 方式 1: Cursor IDE（最简单）

1. 打开 Cursor
2. 点击右上角设置 → MCP
3. 点击 "Add MCP Server"
4. 粘贴以下配置：

```json
{
  "mcpServers": {
    "railway": {
      "command": "npx",
      "args": ["-y", "@railway/mcp-server"]
    }
  }
}
```

### 方式 2: VS Code

1. 安装 Claude 扩展
2. 在设置中添加 MCP：

```json
{
  "mcpServers": {
    "railway": {
      "command": "npx",
      "args": ["-y", "@railway/mcp-server"]
    }
  }
}
```

### 方式 3: Claude Code（命令行）

```bash
claude mcp add railway -- npx -y @railway/mcp-server
```

## 使用 Railway MCP 部署

安装完成后，你可以直接用自然语言命令：

```
"在 Railway 上部署我的 tou-schedule-editor 项目"
"设置环境变量 GEMINI_API_KEY"
"查看部署日志"
"获取部署后的 URL"
```

## 手动方式（备用）

如果你不想使用 MCP，可以直接使用 Railway CLI：

```bash
# 安装 Railway CLI
npm install -g @railway/cli

# 登录
railway login

# 初始化项目
railway init

# 部署
railway up

# 查看 URL
railway domain
```

## 推荐流程

1. **安装 Railway CLI**
   ```bash
   npm install -g @railway/cli
   railway login
   ```

2. **在 Cursor/VS Code 中添加 MCP 配置**

3. **告诉我**: "Railway 已配置好，帮我部署"

4. **我会使用 MCP 工具自动完成**：
   - 创建项目
   - 部署代码
   - 设置环境变量
   - 获取 URL

---

**你现在使用什么 IDE？我可以给你具体的配置步骤。**
